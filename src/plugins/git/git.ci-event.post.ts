import { defineEventHandler } from 'h3'
import { readJsonBody, apiError, requireAuth } from '../../kernel/index.js'
import { applyCiVerdict, type CiForge, type CiVerdictInput } from './ci-loop.js'
import { forgeCiAccess } from './git.js'

const FORGES: CiForge[] = ['github', 'gitlab']
const VERDICTS: CiVerdictInput['verdict'][] = ['failed', 'passed', 'retryable']

function text(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

/** One CI verdict, relayed by the Platform from a signed forge webhook (job 14).
 *
 *  Authenticated exactly like every other Machine API route — the Platform mints
 *  a short-lived machine token for the branch's OWNER and presents it as a
 *  bearer, so `requireAuth`'s owner lock is what stops one person's CI driving
 *  another person's machine. No new public entrance: the machine's only
 *  unauthenticated surface stays the id+secret webhook firing endpoint.
 *
 *  The body is a HINT, not an instruction. Nothing here is trusted to decide
 *  that a fix run should happen — `applyCiVerdict` re-reads whose branch this
 *  is, which commits the agent actually pushed, what the org policy says and
 *  what the budget is, and refuses on any of them. That matters most for
 *  GitLab, whose webhook signature is a shared secret and therefore proves the
 *  sender but not the payload.
 *
 *  Always 200 with an outcome. A verdict we deliberately ignore is the common
 *  case (most CI in an org runs on branches no agent opened), and answering an
 *  error would make the Platform log a failure for the system working. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<Record<string, unknown>>(event)

  const forge = body.provider
  if (typeof forge !== 'string' || !FORGES.includes(forge as CiForge)) {
    apiError(400, 'validation.ciProvider', 'provider must be github or gitlab.')
  }

  const verdict = body.verdict
  if (typeof verdict !== 'string' || !VERDICTS.includes(verdict as CiVerdictInput['verdict'])) {
    apiError(400, 'validation.ciVerdict', 'verdict must be failed, passed or retryable.')
  }

  const repo = text(body.repo)
  const branch = text(body.branch)
  if (!repo || !branch) apiError(400, 'validation.ciBranch', 'repo and branch are required.')

  return applyCiVerdict(
    {
      forge: forge as CiForge,
      repo,
      branch,
      verdict: verdict as CiVerdictInput['verdict'],
      checkName: text(body.checkName, 120),
      runUrl: text(body.runUrl, 500),
      runId: text(body.runId, 100),
      headSha: text(body.headSha, 100),
      prNumber: typeof body.prNumber === 'number' && Number.isInteger(body.prNumber) ? body.prNumber : null,
      prUrl: text(body.prUrl, 500),
    },
    forgeCiAccess,
  )
})
