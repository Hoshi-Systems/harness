/**
 * ── The machine wire, as types ───────────────────────────────────────────────
 *
 * What a Hoshi client and one machine say to each other. `docs/MACHINE_WIRE.md`
 * is the contract these implement; this file is what stops four clients from
 * each re-deriving it. The CLIENT that speaks them is ./machine-client.ts —
 * split for the same reason the Platform half is `types.ts` + `client.ts`: a
 * consumer that only needs the vocabulary (the machine itself does, to answer
 * in it) should not pull in a fetch wrapper to get it (docs/STRUCTURE_REVIEW.md
 * P-05).
 *
 * There were four readings of this wire: the web app, desktop, mobile and the
 * TUI, each with its own composable wrapping the previous runtime's SDK and its
 * own idea of what a session was. That worked while the machine WAS that
 * runtime. It is ours now, and a wire that only exists as four independent
 * readings of it is not a contract — the first thing that drifted was what a
 * scope meant, which is how a session could be invisible from one client and
 * present in another.
 *
 * Framework-agnostic on purpose (packages/shared's whole remit): the TUI and
 * the SSH gateway are not Nuxt apps, and the wire is the same for them.
 *
 * Two rules the shape enforces:
 *   • **Machine-wide is the only question.** No scope parameter anywhere. A
 *     listing is everything on the machine, because the alternative — an
 *     optional scope every caller must remember to pass to be told the truth —
 *     is what made sessions vanish.
 *   • **Nothing polls.** Live state arrives on the two streams (`events` for
 *     the machine, `stream` for one turn in flight). The plain GETs exist to
 *     hydrate once, not to be put on a timer.
 *
 **/

export interface MachineSession {
  id: string
  /** Where this session's work happens: the workspace root, or a checkout. */
  directory: string
  title: string | null
  createdAt: string
  updatedAt: string
  /** The session that spawned this one — a delegated specialist's thread names
   *  the conversation it was sent from. Absent on an ordinary session. */
  parentId?: string | null
  /** A chat: a session that stays a leaf — it spawns nothing, carries no goal,
   *  and runs read-only. A task is a TREE of sessions; a chat is one session
   *  with no tree under it, which is what a client reads to decide whether a
   *  conversation belongs in the task list or on the chat rail. */
  chat?: boolean
  /** What this conversation has cost so far. Present on listings, where it is
   *  folded in from the machine's spend ledger; `unpricedTurns` above zero
   *  means `cost` is a floor, because some turn ran on a model nobody
   *  published a price for. */
  spend?: { cost: number; unpricedTurns: number }
}

/** How a context link is delivered into the conversation it was passed to.
 *
 *  `quote` inlines the passage; `link` leaves a handle the receiving turn opens
 *  with `context_open` only if the excerpt turns out to be insufficient. Which
 *  one was chosen is a property of the link, not a rendering choice a client
 *  makes — the machine expands it, so every client and the transcript agree. */
export type ContextLinkGrade = 'link' | 'quote'

/** A passage of one conversation, carried into another.
 *
 *  It ADDRESSES rather than copies, which is what makes the edge answerable
 *  from both ends: the receiver asks where this came from, the source asks what
 *  came of it. `excerpt` is stored anyway so a deleted source degrades the link
 *  to a quote rather than to nothing. */
export interface ContextLink {
  id: string
  from: {
    /** Any session on the machine — a sub-agent's included. A client's chip
     *  shows the TASK's name while this holds the session's id: the task is the
     *  name a person knows it by, the session is what can be reopened. */
    session: string
    turn: string
    /** Character range within the turn's text, as [start, end). */
    range: [number, number]
  }
  to: string
  grade: ContextLinkGrade
  excerpt: string
  createdAt: string
}

export type SessionState = 'idle' | 'busy' | 'retrying'

/** What a session is DOING, as opposed to merely that it is doing something.
 *
 *  Both halves are readable only from inside a session's transcript — plan
 *  progress lives in a `todowrite` call, the step in flight is an unfinished
 *  tool call — so the machine reports them rather than every client loading
 *  forty transcripts to work them out. `directory` is what attributes the
 *  session to a project; a client maps it to a checkout itself. */
export interface SessionProgress {
  /** The newest plan's completed/total, or null when there is no live plan. A
   *  finished plan reports null: "7/7" pinned to a row forever says nothing. */
  plan: { done: number; total: number } | null
  /**
   *
   * The call in flight — WHAT it is, not a sentence about it. Null between calls
   * and once the turn settles; a plan outlives the step that ran inside it.
   *
   * Structured rather than pre-worded because the machine has no locale and four
   * clients read this: web, desktop, mobile and the TUI. A machine that sent
   * "Editing useMachineUrl.ts" would be writing English into the wire and every
   * non-English client would show it. It sends the tool and its subject; each
   * client phrases them — with the SAME vocabulary its chat already uses for a
   * running tool, which is why `field` travels too: the phrase is keyed on which
   * argument this is, not only on its value.
   *
   **/
  step: { tool: string; subject: string | null; field: string | null } | null
  /** The session's working folder, or null when the machine does not know it. */
  directory?: string | null
}

/** A piece of a message, in the order the turn produced them: the model's own
 *  reasoning (folded away by default), the tools it ran, the prose it wrote. */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  /** A file the person attached, kept beside the question it was asked about. */
  | { type: 'file'; filename: string; mime: string; url: string }
  | {
      type: 'tool'
      name: string
      callId?: string
      /** What the call was asked to do, what it produced, and why it failed —
       *  the durable account of the work, which is all a client that reloads
       *  ever sees. */
      state: { status: string; input?: unknown; output?: string; error?: string }
    }

export interface TokenUsage {
  inputTokens: number | undefined
  outputTokens: number | undefined
  totalTokens: number | undefined
  /** Thinking the model was billed for but never showed. Absent when the
   *  provider does not report it — which is not the same as none, so a client
   *  must not print a zero for it. */
  reasoningTokens?: number | undefined
  /** Input served from the provider's prompt cache: cheaper, and the reason a
   *  long conversation does not cost more every turn. */
  cachedInputTokens?: number | undefined
}

export interface MachineMessage {
  id: string
  role: 'user' | 'assistant'
  parts: MessagePart[]
  createdAt: string
  /** Null while the turn is still streaming. Presence of the message says
   *  nothing — the row exists from the moment the turn starts. */
  completedAt?: string | null
  error?: { name: string; message: string } | null
  usage?: TokenUsage | null
  /** Dollars for the turn; null when the price or the usage is unknown. Zero
   *  is a real answer — a free model. */
  cost?: number | null
  /** Why the model stopped: `stop` finished, `length` was cut off at the output
   *  cap, `tool-calls` ended a step to run a tool. The difference is otherwise
   *  invisible — a truncated answer reads as a complete one that trails off. */
  finishReason?: string | null
  /** Milliseconds the model spent generating, summed across the turn's steps —
   *  the denominator for tokens per second. Excludes tool time on purpose. */
  modelMs?: number | null
  /** How many times the provider had to be asked again before it answered. */
  retries?: number | null
  /** Set when the model's memory was folded during this turn. */
  compacted?: { tokensBefore: number; tokensAfter: number } | null
  /** `provider/model` as resolved — what actually answered, even when the turn
   *  named no model. */
  model?: string | null
}

/** A tool call waiting on a person. Unbounded by design: it waits as long as it
 *  takes, and it is answerable from any client, not the one that raised it. */
export interface PermissionAsk {
  id: string
  sessionId: string
  directory: string
  tool: string
  input: unknown
  /** The exact subject of this call — the narrowest scope an `always` can be
   *  granted at. */
  patterns: string[]
  /** A prefix glob one step wider (`echo *`, `src/app/*`): what makes a grant
   *  useful rather than a formality, since the exact string recurs once. */
  always: string[]
  createdAt: string
}

/**
 *
 * How an ask is answered — THE vocabulary, and the reason this is a runtime
 * array rather than a bare type: the machine validates against exactly this
 * list (`POST /permissions/:id`), so a client that invents a synonym gets a 400
 * and the turn it was answering waits forever.
 *
 * Which is what happened. Three readings of one endpoint shipped at once — the
 * machine's `allow|reject|always`, this file's `allow|always|deny`, and the
 * TUI's `once|always|reject` — because a rename ("they were once/reject") moved
 * the web clients half-way and never reached the TUI. Each client kept the two
 * values that happened to survive and lost the third: the web could not deny,
 * the TUI could not allow once. Both failed as a 400 the client read as "this
 * ask is already gone", so the button looked answered and the tool call stayed
 * blocked — `ask()` waits without a timeout, on purpose.
 *
 * `reject`, not `deny`, because {@link ToolLevel}'s `deny` is a DIFFERENT and
 * durable thing — the level a tool is pinned at. Answering one ask and pinning
 * a tool forever should not share a word.
 *
 * Anything that can only be checked at runtime — the machine's own validator,
 * a test asserting the two agree — reads {@link PERMISSION_ANSWERS}.
 *
 **/
export const PERMISSION_ANSWERS = ['allow', 'reject', 'always'] as const

export type PermissionAnswer = (typeof PERMISSION_ANSWERS)[number]

/** How an ask ENDED, as `permission.replied` reports it. A superset of
 *  {@link PermissionAnswer}: `cancelled` is not an answer anybody gave — the
 *  turn died under the question — and a client that treats it as one shows
 *  "denied" for something nobody decided. */
export type PermissionOutcome = PermissionAnswer | 'cancelled'

export interface FileEntry {
  name: string
  path: string
  absolute: string
  type: 'file' | 'directory'
  /** Build output and dotfiles. Present, but the panel dims them — a file you
   *  cannot see is a file you cannot ask about. */
  ignored: boolean
}

export type FileContent = { type: 'text'; content: string } | { type: 'binary'; content: string; encoding: 'base64' }

export interface ShellResult {
  messageId: string
  exitCode: number
  output: string
}

/** A shell running on the machine — a real pseudo-terminal, owned by the
 *  machine rather than by whichever tab happens to be watching it.
 *
 *  That ownership is the point, and it is why this is a wire type at all: the
 *  shell survives the socket, so a client asks the machine what is running
 *  rather than remembering what it opened. */
export interface TerminalInfo {
  id: string
  /** The command this shell is running — the user's own login shell by default. */
  shell: string
  /** Where it started. A shell can `cd` away; this is not re-read, because
   *  reading a live process's cwd is a platform-specific stunt and the answer
   *  would be stale the moment it was rendered. */
  directory: string
  /** Present when this shell is the one the AGENT runs its `bash` calls in, so
   *  a client can offer to attach rather than open a second one beside it. */
  agent?: boolean
  createdAt: string
}

/** What a tool is allowed to do without asking. */
export type ToolLevel = 'allow' | 'ask' | 'deny'

export interface ToolPermission {
  id: string
  /** Human name, from the machine's own registry. */
  label?: string
  /** The providing connector, for an MCP tool (`server:tool`). */
  server?: string
  level: ToolLevel
  /** True when the level is set rather than inherited from the default. */
  explicit?: boolean
  /** Exceptions scoped to the call's subject, checked before the level. */
  rules?: Array<{ pattern: string; level: ToolLevel }>
}

export interface MachineModel {
  providerID: string
  /** The provider's display name — a model list that shows only `modelID` makes
   *  the same model from two endpoints indistinguishable. */
  providerName: string
  modelID: string
  name: string
  contextLimit: number
  /** The provider charges nothing for this model. */
  free: boolean
  /** The provider is registered but has no resolved credential yet, so this
   *  model cannot run today. `GET /models` omits these unless asked with
   *  `?all=1` — a picker offers what works, discovery offers the rest. */
  needsKey: boolean
  /** The env var an "enter your key" prompt should write to, when known. */
  keyEnvVar: string | null
  /** Whether this model reasons. Null when the open catalogue does not say —
   *  a self-hosted endpoint, usually — which is not the same as "no". */
  reasoning?: boolean | null
  /** How its thinking is controlled: named levels, an on/off toggle, or a token
   *  budget. Null when the catalogue does not say. */
  reasoningMode?: 'effort' | 'toggle' | 'budget' | null
  /** The levels it publishes, verbatim — only for `effort` models. */
  reasoningEfforts?: string[] | null
  /** Floor for a `budget` model's thinking allowance. */
  reasoningBudgetMin?: number | null
}

export interface MachineAgent {
  name: string
  description: string
  prompt: string | null
  builtIn: boolean
  /** A built-in the user has edited. Neither purely theirs nor purely ours. */
  customised: boolean
  /** This agent is offered no tool that changes anything. Worth surfacing: it
   *  is the difference between an agent that has been asked not to touch your
   *  files and one that cannot. */
  readOnly?: boolean
  /** Tools switched off for this agent by name. Absent means offered. */
  tools?: Record<string, boolean>
  /** `provider/model` this agent pins, or null to use the machine's default. */
  model?: string | null
  /** Found in the checkout rather than on the machine — it overrides a machine
   *  agent of the same name, and a client says so. */
  scope?: 'project' | 'machine'
}

export interface MachineCommand {
  name: string
  description: string
  template: string
}

export interface MachineSkill {
  name: string
  description: string
}

/** The event union lives in `machine-events.ts` — one declaration of every
 *  frame the machine publishes, which the clients alias. (A loose
 *  `{ type: string; properties: … }` used to live here; three clients each
 *  kept their own strict copy beside it, and the copies drifted.) */

export class MachineError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message)
    this.name = 'MachineError'
  }
}

export interface MachineClientOptions {
  /** The machine's root origin. `/opencode` prefixes are gone: the sidecar's
   *  own routes are the machine's routes.
   *
   *  A function when the answer can change — a web client that switches
   *  machines resolves a different origin without rebuilding this. */
  baseUrl: string | (() => string)
  /** Bearer token — a platform session JWT, or a machine token. Read per call
   *  so a client that refreshes its token does not have to rebuild this. */
  token: () => string | Promise<string>
  fetch?: typeof globalThis.fetch
}

/** How hard a model is asked to think, on the wire.
 *
 *  A plain string, deliberately, and not a union of the levels we happen to know
 *  about: the vocabulary belongs to the MODEL. The open catalogue publishes each
 *  one's own levels — `gpt-5` takes a `minimal` that `o3` does not, and some
 *  models have a `max` above `high` — so a union here would make the type system
 *  refuse a value the model itself published, and would need a release every
 *  time a provider invented a level.
 *
 *  `auto` is the one value with a meaning of its own: the field is not sent at
 *  all, and the provider's default stands. */
export type ReasoningEffort = string

/**
 * ── Starters ─────────────────────────────────────────────────────────────────
 *
 * The three things worth trying first on a machine, from the preset it was
 * seeded with. `label` is the button; `prompt` is what is actually sent, and it
 * is deliberately much longer — a starter's job is to produce something real in
 * one turn, and "Build a landing page" as a prompt produces a conversation
 * about landing pages.
 *
 **/
export interface Starter {
  label: string
  prompt: string
}

/**
 * ── Who the agent on this machine is ─────────────────────────────────────────
 *
 * What the first-run wizard's agent card is drawn from, served at
 * `GET /profile`: the preset the machine was seeded with and the emphasis that
 * preset spliced into the personal agent's instructions — the paragraph that
 * says what kind of work this agent leans toward. The agent's chosen NAME is
 * not here: it is the reserved `assistant-identity` memory entry, read through
 * `/memory`, because it is the person's to edit and delete there.
 *
 **/
export interface MachineProfile {
  /** The preset this machine was last seeded with; null on an unseeded one. */
  preset: { name: string; version: string | null } | null
  /** The preset's emphasis paragraph, as written into the personal agent's
   *  instructions; null when the agent file is missing or carries no markers. */
  emphasis: string | null
}

/**
 * ── What a machine's host can isolate ────────────────────────────────────────
 *
 * The reading `hoshi-probe-isolation` produces, served by the machine so an
 * infrastructure decision can rest on a measurement instead of a table in a
 * plan document.
 *
 * Declared here because both sides read it: the machine shapes it, App:Web
 * renders it, and a field renamed on one side is then a compile error on the
 * other rather than a card that quietly goes blank.
 *
 **/

/** The four answers the probe can reach about backing a microVM. Kept in step
 *  with `MICROVM_READING` in infra/machine/probe-isolation.py, which is the one
 *  place each verdict's sentence is written. */
export type MicrovmVerdict = 'no-hardware' | 'no-kvm-module' | 'nested-off' | 'ready'

export interface IsolationReading {
  kernel: string
  arch: string
  seccomp: string
  lsms: string
  /** The in-machine sandbox half: can Landlock actually enforce here? */
  landlock: { abi: number | null; error: string | null; enforces: boolean; detail: string }
  userNamespace: { permitted: boolean; detail: string }
  microvm: {
    cpuVirt: string
    hardware: boolean
    isGuest: boolean
    /** `null` = no KVM module loaded, which is not the same as "says no". */
    nested: boolean | null
    nestedDetail: string
    kvmDevice: string
    verdict: MicrovmVerdict
    /** The sentence a person reads. Written by the probe, never assembled by a
     *  client — one place decides what a verdict means. */
    reading: string
  }
}

/**
 *
 * `available: false` is a reading, not an error, and the route answers 200 for
 * it. The probe is Linux-only by construction, so a developer machine on macOS
 * legitimately cannot answer — and so does any machine whose image predates the
 * probe. Answering 503 would be worse than unhelpful here: App:Web raises its
 * global maintenance overlay on a 503 from a machine.
 *
 **/
export type IsolationResult = { available: true; reading: IsolationReading } | { available: false; reason: string }

/**
 * ── Telling a machine-wide outage from one feature being absent ──────────────
 *
 * Both arrive as 503, and a client must not treat them alike.
 *
 * An outage comes from the INGRESS — the container is being replaced, updated,
 * or has just been woken — and its body is whatever the proxy writes. That is
 * the one a client should meet with its maintenance overlay: the machine is not
 * there.
 *
 * A 503 the machine's own handler produced carries our error envelope, and it
 * always means one part is unavailable while the rest of the machine works: a
 * degraded plugin (`<plugin>.unavailable`), a pty that would not open
 * (`terminal.unavailable`). Blacking out the whole app for one of those hides
 * the very reason it sent — and the call site usually already shows it.
 *
 **/
export function machineErrorCode(body: unknown): string | null {
  const code = (body as { data?: { code?: unknown } } | null | undefined)?.data?.code
  return typeof code === 'string' && code ? code : null
}
