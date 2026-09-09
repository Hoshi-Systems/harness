import { ports } from './host.js'
import { createCachedStore, keepLatest, publishMachineEvent, getPreferences } from '../../kernel/index.js'

/**
 * ── Closed-loop CI ───────────────────────────────────────────────────────────
 *
 * Job 03 stopped at "opened": the agent pushed a branch, opened a pull request,
 * and moved on. CI went red four minutes later and nothing happened until a
 * human noticed — so the user's mental model ("I asked for the thing, it said
 * it did the thing") was wrong, and they found out at review time.
 *
 * This module is the missing wire. The Platform routes a CI verdict here
 * (apps/api/services/integrations/ci.ts) and everything that decides whether to
 * ACT lives on this side, because this side is the only one that can see the
 * git state the decision depends on.
 *
 * The rule, kept narrow and boring on purpose:
 *
 *   Act only when the branch is one THIS machine opened, the loop is enabled,
 *   the head commit is one the agent itself pushed, and the attempt cap has
 *   room. Otherwise do nothing, and say why.
 *
 * Five guards, in the order they run. Each one is a way of NOT starting a run:
 *
 *   1. **Not ours.** No watch for (forge, repo, branch) ⇒ drop. The watch is
 *      written by `openPullRequest`, so a pull request the machine did not open
 *      has no row and can never be touched.
 *   2. **A human pushed.** The verdict's head sha is not one the agent pushed
 *      ⇒ stop this branch's loop permanently. The moment a person starts
 *      working on a branch, the agent must take its hands off it — and a
 *      "stopped" loop never restarts, even if the next push happens to be ours
 *      again, because we cannot know what the human intended.
 *   3. **The org forbids it.** An `unattended-deny` (or outright `deny`) rule
 *      naming the `ci_fix` tool refuses the run, and the refusal names the rule.
 *   4. **The budget is spent.** Refuse to START; never abort anything in flight
 *      (utils/budget.ts's standing rule — a spending decision is not a reason to
 *      take someone's work away).
 *   5. **No progress.** The same failure twice means the attempt achieved
 *      nothing; spending the second one on it is theatre. Bail early.
 *
 * And two shapes of ending: green ⇒ ONE `complete` alert, ever; out of attempts
 * (or any of the refusals above) ⇒ ONE `error` alert that says which check
 * failed, what was tried, and where the run is. A "couldn't fix it" with no
 * detail is worse than silence — the human then has to reconstruct everything
 * the agent already knew.
 *
 * NOTHING HERE POLLS. The webhook is the trigger; `readPullRequest`'s on-demand
 * fetch stays exactly what it was, for the human-initiated panel view.
 *
 **/

/** How many branches the ledger remembers. Settled rows age out oldest-first;
 *  a machine does not have hundreds of live proposals. */
const MAX_WATCHES = 100

/** Failing log tail handed to the agent. The failing assertion is nearly always
 *  at the end, and a full CI log is tens of thousands of lines — pasting it
 *  would blow the context window for nothing. */
export const CI_LOG_TAIL_LINES = 120
export const CI_LOG_TAIL_CHARS = 6_000

/** Reruns spent on verdicts that never reached one (cancelled, timed out),
 *  counted SEPARATELY from the code attempts — a cancelled run says nothing
 *  about the code, so charging it to the fix budget would spend an attempt on
 *  no information. One is enough: a second cancellation is infrastructure, not
 *  something an agent can fix. */
const MAX_RERUNS = 1

/** The tool name an org policy rule names to govern this loop. Not a real
 *  OpenCode tool — policy rules are free-form tool ids (apps/api
 *  db/agent-policy.ts), and this is the id under which "may an agent push a
 *  commit because CI went red, with nobody watching?" is expressible at all. */
const CI_FIX_TOOL = 'ci_fix'

export type CiForge = 'github' | 'gitlab'

/** What the loop is doing, as a client renders it.
 *   • `watching`  — registered, nothing has failed.
 *   • `fixing`    — a fix run is out; `attempts` says which one.
 *   • `escalated` — gave up and told the human. Terminal.
 *   • `green`     — went green after a fix. Terminal until the next failure.
 *   • `stopped`   — a human pushed. Terminal, permanently, for this branch. */
export type CiLoopStatus = 'watching' | 'fixing' | 'escalated' | 'green' | 'stopped'

export interface CiWatch {
  /** `<forge>:<repo>:<branch>` — the routing key, and the store's own id. */
  id: string
  forge: CiForge
  /** `owner/repo`, as the forge's CLI addresses it. */
  repo: string
  branch: string
  /** The checkout this branch lives in — where the fix run is scoped and where
   *  the forge CLI is invoked from. */
  directory: string
  prNumber: number | null
  prUrl: string | null
  /** Commits the AGENT pushed, newest last. The human-pushed guard is a set
   *  membership test against this and nothing else — no forge round-trip, no
   *  author-name heuristic. Capped: a branch with more commits than this has
   *  long since stopped being one turn's proposal. */
  agentShas: string[]
  status: CiLoopStatus
  /** Code-fix attempts spent (cap is the machine's `ciMaxAttempts`). */
  attempts: number
  /** Reruns spent on verdicts that never reached one. */
  reruns: number
  /** Fingerprint of the failure the last attempt was started for — check name
   *  plus the normalized log tail. Equal twice running means no progress. */
  lastFailureKey: string | null
  lastCheckName: string | null
  lastRunUrl: string | null
  /** Why the loop stopped, when it stopped for a reason worth showing. */
  stoppedReason: CiStopReason | null
  createdAt: string
  updatedAt: string
}

/** Why a loop is not running, in a form a client can localize. Codes rather
 *  than prose for the same reason the git routes carry codes: the machine does
 *  not know what language its owner reads. */
export type CiStopReason =
  'humanPushed' | 'attemptsSpent' | 'noProgress' | 'budgetExceeded' | 'policyDenied' | 'rerunsSpent' | 'disabled'

interface CiLoopStore {
  watches: CiWatch[]
}

const store = createCachedStore<CiLoopStore>('ci-loop.json', (stored) => {
  const parsed = stored as CiLoopStore | null
  if (!parsed || !Array.isArray(parsed.watches)) return { watches: [] }
  for (const watch of parsed.watches) {
    watch.agentShas = Array.isArray(watch.agentShas) ? watch.agentShas.filter((s) => typeof s === 'string') : []
    watch.attempts ??= 0
    watch.reruns ??= 0
    watch.lastFailureKey ??= null
    watch.lastCheckName ??= null
    watch.lastRunUrl ??= null
    watch.stoppedReason ??= null
  }
  return parsed
})

function ciWatchId(forge: CiForge, repo: string, branch: string): string {
  return `${forge}:${repo}:${branch}`
}

/** Wait for every queued ledger write to land. Tests only — the request path
 *  deliberately never waits on a persist (utils/json-store.ts). */
export function flushCiLedger(): Promise<void> {
  return store.flush()
}

/** How many commits back the human-pushed guard remembers. A rebase or an
 *  amend replaces shas, so the list has to hold more than "the last one" — but
 *  a proposal older than this has been superseded by human work regardless. */
const MAX_AGENT_SHAS = 50

function touch(watch: CiWatch): void {
  watch.updatedAt = new Date().toISOString()
}

/** Publish the branch's state so the Computer's Proposed scope re-reads it.
 *  Rides `git.changed` rather than a new event on purpose: the panel already
 *  refetches `GET /git/status` on it, and that response now carries the loop's
 *  own state — one event, one round trip, no client timer. */
function publish(watch: CiWatch): void {
  publishMachineEvent('git.changed', { directory: watch.directory })
}

/**
 * ── Registration ─────────────────────────────────────────────────────────────
 *
 **/

/** Record a commit the agent itself just made, so a later CI verdict on it is
 *  recognizable as ours. Called from `gitCommit` — which is the path both the
 *  `git_commit` plugin tool and the Changes panel go through, so the only way
 *  to make a commit this misses is to shell out to raw `git`. That direction is
 *  deliberate: an unrecorded commit reads as a human push and STOPS the loop,
 *  which is the safe failure. */
export async function recordAgentCommit(directory: string, branch: string, sha: string): Promise<void> {
  const loaded = await store.load()
  for (const watch of loaded.watches) {
    if (watch.directory !== directory || watch.branch !== branch) continue
    if (watch.agentShas.includes(sha)) continue
    watch.agentShas = keepLatest([...watch.agentShas, sha], MAX_AGENT_SHAS)
    touch(watch)
  }
  store.persist()
}

export interface CiWatchRegistration {
  forge: CiForge
  repo: string
  branch: string
  directory: string
  prNumber: number | null
  prUrl: string | null
  /** The branch's head at the moment the pull request was opened. Seeds the
   *  agent-sha list, which matters for a branch whose commits were made by raw
   *  `git` before the PR existed. */
  headSha: string | null
}

/** Register (or refresh) a branch this machine has just opened a pull request
 *  for. Idempotent, and deliberately non-destructive on a re-open: the attempt
 *  ledger survives, so calling `git_pr` again cannot reset a spent budget.
 *
 *  A branch a human has pushed to stays `stopped`. Re-opening the pull request
 *  is not consent to start editing it again. */
export async function registerCiWatch(input: CiWatchRegistration): Promise<CiWatch> {
  const loaded = await store.load()
  const id = ciWatchId(input.forge, input.repo, input.branch)
  let watch = loaded.watches.find((entry) => entry.id === id)
  if (!watch) {
    watch = {
      id,
      forge: input.forge,
      repo: input.repo,
      branch: input.branch,
      directory: input.directory,
      prNumber: input.prNumber,
      prUrl: input.prUrl,
      agentShas: [],
      status: 'watching',
      attempts: 0,
      reruns: 0,
      lastFailureKey: null,
      lastCheckName: null,
      lastRunUrl: null,
      stoppedReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    loaded.watches.push(watch)
    loaded.watches = keepLatest(loaded.watches, MAX_WATCHES)
  }
  watch.directory = input.directory
  watch.prNumber = input.prNumber ?? watch.prNumber
  watch.prUrl = input.prUrl ?? watch.prUrl
  if (input.headSha && !watch.agentShas.includes(input.headSha)) {
    watch.agentShas = keepLatest([...watch.agentShas, input.headSha], MAX_AGENT_SHAS)
  }
  touch(watch)
  store.persist()
  return watch
}

/** The loop's state for a branch, or null when it isn't watched — what
 *  `GET /git/status` folds into its response so the Proposed panel renders the
 *  timeline without a second call and without ever polling. */
export async function ciWatchFor(directory: string, branch: string): Promise<CiWatch | null> {
  const loaded = await store.load()
  return loaded.watches.find((watch) => watch.directory === directory && watch.branch === branch) ?? null
}

/**
 * ── The verdict ──────────────────────────────────────────────────────────────
 *
 **/

export interface CiVerdictInput {
  forge: CiForge
  repo: string
  branch: string
  verdict: 'failed' | 'passed' | 'retryable'
  checkName: string | null
  runUrl: string | null
  runId: string | null
  headSha: string | null
  prNumber: number | null
  prUrl: string | null
}

/** What the route reports back. `acted` names the one thing that happened, so a
 *  test — and a log line — can tell "we started a fix run" from "we deliberately
 *  did nothing", which are otherwise both a 200. */
export interface CiVerdictOutcome {
  acted:
    | 'fix-dispatched'
    | 'rerun-requested'
    | 'green'
    | 'escalated'
    | 'ignored-unknown-branch'
    | 'ignored-settled'
    | 'ignored-disabled'
    | 'stopped-human-pushed'
  reason?: CiStopReason
  attempt?: number
}

/** How the machine reruns a failed pipeline. Injected so the tests can drive
 *  the whole loop without a forge; the real implementations live in
 *  utils/git.ts, which owns every `gh`/`glab` invocation. */
export interface CiForgeAccess {
  /** The failing job's log tail, or null when it can't be read. */
  failingLog(watch: CiWatch, runId: string | null): Promise<string | null>
  /** Ask the forge to run it again. Resolves false when it couldn't. */
  rerun(watch: CiWatch, runId: string | null): Promise<boolean>
}

/** Apply one CI verdict. Total: every path returns an outcome, and any failure
 *  inside is a refusal to act rather than an error to the caller — the Platform
 *  is relaying a webhook and has nothing useful to do with a 500. */
export async function applyCiVerdict(input: CiVerdictInput, forge: CiForgeAccess): Promise<CiVerdictOutcome> {
  const loaded = await store.load()
  const watch = loaded.watches.find((entry) => entry.id === ciWatchId(input.forge, input.repo, input.branch))

  /**
   *
   * Guard 1 — not ours. The one that makes "never fires on a PR the machine did
   * not open" structural: an unregistered branch simply has no row.
   *
   **/
  if (!watch) return { acted: 'ignored-unknown-branch' }

  if (input.prNumber !== null) watch.prNumber = input.prNumber
  if (input.prUrl) watch.prUrl = input.prUrl

  /**
   *
   * A branch a human took over stays taken over, and one that already escalated
   * does not re-escalate on every subsequent red build. Both are terminal.
   *
   **/
  if (watch.status === 'stopped' || watch.status === 'escalated') {
    return { acted: 'ignored-settled', reason: watch.stoppedReason ?? undefined }
  }

  if (input.verdict === 'passed') return settleGreen(watch)

  /**
   *
   * Guard 2 — a human pushed. Checked before the toggle so that turning the
   * loop off and on again cannot resurrect a branch somebody else now owns.
   * A verdict with no head sha at all is treated as unknown provenance, which
   * is the same answer: do not touch it.
   *
   **/
  if (!input.headSha || !watch.agentShas.includes(input.headSha)) {
    return stop(watch, 'humanPushed', { acted: 'stopped-human-pushed', reason: 'humanPushed' })
  }

  const prefs = await getPreferences()
  if (!prefs.ciFix) {
    /**
     *
     * Not a stop: the toggle is a preference, not a verdict about this branch.
     * Turning it back on resumes with the ledger intact.
     *
     **/
    return { acted: 'ignored-disabled', reason: 'disabled' }
  }

  watch.lastCheckName = input.checkName ?? watch.lastCheckName
  watch.lastRunUrl = input.runUrl ?? watch.lastRunUrl

  /**
   *
   * A verdict that never reached one: rerun once rather than editing code.
   * There is no failing assertion to hand the agent, so a code attempt would be
   * spent guessing — and the answer to "the runner was cancelled" is to run it
   * again. Counted separately from the two code attempts, per the job's own
   * recommendation, and capped so a permanently cancelled pipeline escalates
   * instead of ping-ponging.
   *
   **/
  if (input.verdict === 'retryable') {
    if (watch.reruns >= MAX_RERUNS) {
      return escalate(watch, 'rerunsSpent', input)
    }
    watch.reruns++
    touch(watch)
    store.persist()
    publish(watch)
    const ok = await forge.rerun(watch, input.runId)
    /**
     *
     * A rerun the forge refused is not worth escalating on its own — the next
     * verdict on this branch (a real failure, or green) is the honest signal.
     *
     **/
    if (!ok) console.error(`[ci-loop] could not rerun ${watch.id} (${input.runId ?? 'no run id'})`)
    return { acted: 'rerun-requested' }
  }

  /**
   *
   * Guard 3 — the org's floor. A rule naming `ci_fix` can switch this off for
   * the whole fleet, and `unattended-deny` is the natural mode: a CI fix run is
   * unattended by construction.
   *
   **/
  const decision = await ports().mayProceed?.({
    tool: CI_FIX_TOOL,
    subjects: [`${watch.repo}#${watch.branch}`, watch.repo, watch.branch],
  })
  if (decision?.effect === 'deny') {
    return escalate(watch, 'policyDenied', input, decision.ruleId)
  }

  /**
   *
   * Guard 4 — budget. Refuse to START. Nothing in flight is touched: an
   * exceeded budget is a spending decision, not a reason to abort work already
   * paid for (utils/budget.ts).
   *
   **/
  if (ports().spendBlocked?.()) {
    return escalate(watch, 'budgetExceeded', input)
  }

  const cap = prefs.ciMaxAttempts
  if (watch.attempts >= cap) return escalate(watch, 'attemptsSpent', input)

  const log = await forge.failingLog(watch, input.runId)
  const failureKey = failureFingerprint(input.checkName, log)

  /**
   *
   * Guard 5 — no progress. The attempt we already spent produced the identical
   * failure, so the next one would too. Bail early rather than burn it.
   *
   **/
  if (watch.attempts > 0 && watch.lastFailureKey && watch.lastFailureKey === failureKey) {
    return escalate(watch, 'noProgress', input)
  }

  watch.attempts++
  watch.status = 'fixing'
  watch.lastFailureKey = failureKey
  watch.stoppedReason = null
  touch(watch)
  store.persist()
  publish(watch)

  const dispatch = ports().dispatch
  if (!dispatch) return escalate(watch, 'policyDenied', input)
  await dispatch({
    source: 'ci',
    triggerId: watch.id,
    triggerName: `${watch.repo}#${watch.prNumber ?? watch.branch}`,
    prompt: ciFixPrompt(watch, input, log, watch.attempts, cap),
    projectId: null,
    /**
     *
     * Scoped to the checkout so the thread lands in that project's scope and
     * the agent's cwd is the repository it has to fix — the same reasoning the
     * inbox uses for the personal root.
     *
     **/
    directory: watch.directory,
  })

  return { acted: 'fix-dispatched', attempt: watch.attempts }
}

function settleGreen(watch: CiWatch): CiVerdictOutcome {
  /**
   *
   * Only a loop that actually did something announces going green. A branch
   * whose CI was green all along has nothing to tell anyone, and alerting on
   * every passing build would be the noisiest thing in the product.
   *
   **/
  const announce = watch.status === 'fixing'
  watch.status = 'green'
  watch.stoppedReason = null
  touch(watch)
  store.persist()
  publish(watch)
  if (announce) {
    void ports().notify?.({
      kind: 'complete',
      detail: `${watch.repo}#${watch.prNumber ?? watch.branch}`,
      dedupKey: `ci-green:${watch.id}:${watch.attempts}`,
    })
  }
  return { acted: 'green' }
}

function stop(watch: CiWatch, reason: CiStopReason, outcome: CiVerdictOutcome): CiVerdictOutcome {
  watch.status = 'stopped'
  watch.stoppedReason = reason
  touch(watch)
  store.persist()
  publish(watch)
  return outcome
}

/** Give up, and say exactly what happened. The alert carries the check that
 *  failed, how many attempts went into it and the link to the run — because a
 *  "couldn't fix it" with no detail leaves the human reconstructing everything
 *  the agent already knew. */
function escalate(
  watch: CiWatch,
  reason: CiStopReason,
  input: CiVerdictInput,
  ruleId: string | null = null,
): CiVerdictOutcome {
  watch.status = 'escalated'
  watch.stoppedReason = reason
  watch.lastCheckName = input.checkName ?? watch.lastCheckName
  watch.lastRunUrl = input.runUrl ?? watch.lastRunUrl
  touch(watch)
  store.persist()
  publish(watch)
  /**
   *
   * Why it stopped is in the dedup key, not just the text: the same pull
   * request escalating for a different reason is a different thing to be told
   * about, and collapsing the two would hide the second.
   *
   **/
  void ports().notify?.({
    kind: 'error',
    detail: `${watch.repo}#${watch.prNumber ?? watch.branch} — ${reason}${ruleId ? ` (${ruleId})` : ''}`,
    dedupKey: `ci-escalate:${watch.id}:${reason}:${watch.attempts}`,
  })
  return { acted: 'escalated', reason }
}

/**
 * ── The failure fingerprint ──────────────────────────────────────────────────
 *
 **/

/** "Is this the same failure as last time?" — the check's name plus its log
 *  tail with everything run-specific stripped out. Timestamps, durations, hex
 *  ids and absolute paths differ on every run of an identical failure, so
 *  comparing raw text would answer "different" every time and the no-progress
 *  guard would never fire.
 *
 *  Exported for the tests: this is the one heuristic in the module, and getting
 *  it wrong is silent — the loop simply spends its second attempt on a failure
 *  it already knows it cannot fix. */
export function failureFingerprint(checkName: string | null, log: string | null): string {
  const normalized = (log ?? '')
    .toLowerCase()
    /**
     *
     * Timestamps (ISO, and CI's own `12:03:41.123`), durations, byte counts.
     *
     **/
    .replace(/\d{4}-\d{2}-\d{2}t?[\d:.]*z?/g, '<t>')
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|secs|seconds|m|min|mins|bytes|kb|mb)\b/g, '<n>')
    /**
     *
     * Hex ids: shas, run ids, container ids, addresses.
     *
     **/
    .replace(/\b[0-9a-f]{7,}\b/g, '<hex>')
    /**
     *
     * Anything else numeric — line numbers move, counts move.
     *
     **/
    .replace(/\b\d+\b/g, '<n>')
    /**
     *
     * Absolute paths differ between runners.
     *
     **/
    .replace(/\/[\w./-]+/g, (match) => (match.length > 12 ? '<path>' : match))
    .replace(/\s+/g, ' ')
    .trim()
  return `${(checkName ?? '').toLowerCase()}|${normalized.slice(-1_500)}`
}

/**
 * ── The prompt ───────────────────────────────────────────────────────────────
 *
 **/

/** What the fix run actually reads. Three properties it has to have:
 *
 *   • **The log, not the word "failed".** The failing assertion is the whole
 *     value of this feature; a run told only that CI is red re-derives it by
 *     running the suite, which is slower and often impossible locally.
 *   • **Honest provenance.** The agent is told nobody is watching, which
 *     attempt this is, and that it may not merge — an unattended run that
 *     believes a human is present asks questions nobody will answer.
 *   • **A hard boundary on scope.** "Fix the failing check" is the task. A run
 *     that decides to refactor while it is in there is how a two-attempt budget
 *     becomes an unreviewable diff. */
function ciFixPrompt(watch: CiWatch, input: CiVerdictInput, log: string | null, attempt: number, cap: number): string {
  const forgeName = watch.forge === 'github' ? 'GitHub' : 'GitLab'
  const target = watch.prNumber ? `${watch.repo}#${watch.prNumber}` : `${watch.repo} (${watch.branch})`
  return [
    `[Continuous integration failed on ${target} — ${forgeName}]`,
    `[Branch: ${watch.branch} · check: ${input.checkName ?? 'unnamed'} · attempt ${attempt} of ${cap}]`,
    input.runUrl ? `[Run: ${input.runUrl}]` : null,
    '',
    'You opened this pull request and its CI is now failing. Nobody is watching this run.',
    '',
    log
      ? `The failing job's log ends like this:\n\n\`\`\`\n${log}\n\`\`\``
      : "The failing job's log could not be read from this machine — reproduce the failure locally instead (run the project's own test or lint command) rather than guessing from the diff.",
    '',
    'Fix the cause of THIS failure and nothing else:',
    `- Work on the existing \`${watch.branch}\` branch. Do not create another one.`,
    '- Make the smallest change that makes the check pass. No refactors, no unrelated cleanups, no version bumps.',
    '- Verify locally before you push, if the project has a way to.',
    '- Commit with `git_commit` and push with `git_pr` (it updates the existing pull request; it never opens a second).',
    `- Do NOT merge or close the pull request — landing is the human's decision.`,
    '',
    `You get ${cap} ${cap === 1 ? 'attempt' : 'attempts'} in total. If you cannot see what is wrong from the log, say so plainly in your final message instead of changing code speculatively — a wrong fix costs the next attempt too.`,
  ]
    .filter((line) => line !== null)
    .join('\n')
}
