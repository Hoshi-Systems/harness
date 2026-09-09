import { tool as aiTool, type Tool } from 'ai'
import { z } from 'zod'
import { MODEL_TIERS, type ModelTier } from '../kernel/model.js'

/**
 * ── How a Hoshi tool is defined ──────────────────────────────────────────────
 *
 * The wrapper that gives a Hoshi tool its shape, and the sibling of ./define.ts:
 * that one says what a PLUGIN is, this one says what a TOOL is. `defineHoshiTool`
 * is the difference between an `ai`-SDK tool and one this product can render — a
 * `title` for the card, an `output` the model reads, and `metadata` the CLIENT
 * reads (a browser screenshot, what a memory write saved). `jsonish` accepts a
 * JSON string where an object was asked for, because models do that routinely
 * and refusing costs more than accepting. `bindTools` binds a group of factories
 * to one turn. What a bound tool RECEIVES is ./tool-context.ts.
 *
 * It is deliberately thin. `defineHoshiTool` takes the SAME shape
 * `@opencode-ai/plugin` took — a description, a record of zod schemas, an async
 * execute — so porting a tool was changing its import line, not rewriting it.
 * That was the whole point of owning the registration surface: 6000 lines of
 * working tool bodies had to survive the move out of a foreign process unchanged.
 *
 * IT USED TO BE A WORKSPACE, `@hoshi/machine-plugin`, and being one was the
 * problem. Every group — browser, git, process, image, router, user, internal,
 * ui — was aggregated there into one `hoshiTools()` and contributed by a SINGLE
 * plugin, `widgets`. So the plugin system's own rule, that a degraded plugin
 * contributes no tools, was defeated by placement: `machine.state` could report
 * `web-control: degraded — chromium is not installed` while the same machine
 * offered the model all eight `browser_*` tools anyway
 * (docs/STRUCTURE_REVIEW.md H-08). Each group lives with the plugin that owns
 * its domain now and is contributed through `host.tools.add`, so a missing
 * dependency WITHHOLDS its tools instead of merely being reported beside them.
 *
 * There is no aggregate left to keep in step, and no package boundary left to
 * cross — which is why this file is here rather than behind an import that
 * pretended the harness and its tools were separable products.
 *
 **/

export { z }

/** What every Hoshi tool returns.
 *
 *  `output` is what the MODEL reads. `title` is what a person sees on the tool
 *  card in the transcript, and `metadata` is structured data the UI renders
 *  from — the generative-UI surface is built on it. Keeping all three means a
 *  tool result can be useful to the model and legible to a person without
 *  either one being a parse of the other. */
export interface HoshiToolResult {
  title: string
  output: string
  metadata?: Record<string, unknown>
  /** Files the tool produced, for the client to render inline — a generated
   *  image, a rendered chart. Separate from `metadata` because these are
   *  CONTENT, not description: the transcript shows them, and stuffing a data
   *  URL into the model's `output` would spend thousands of tokens on bytes it
   *  cannot read. */
  attachments?: Array<{ type: 'file'; mime: string; url: string; filename: string }>
}

/** What the engine hands a tool about the turn it is running in.
 *
 *  `publish` is the reason this exists. A tool that has to reach the user
 *  mid-call — the generative-UI ask is the whole motivating case — used to have
 *  no way back: it ran in another process, so it opened a loopback HTTP server
 *  and the sidecar proxied to it. In-process, "tell the client something" is a
 *  function call. */
export interface HoshiToolContext {
  sessionId: string
  directory: string
  /** The git worktree root. Equal to `directory` for a checkout (a checkout IS
   *  a repo) — kept as its own field because tools validate it with rev-parse
   *  and fall back, rather than assuming either is a repository. */
  worktree: string
  /** Which agent is running. Some tools are the PERSONAL agent's alone —
   *  delegating another person's budget is not something a recruited
   *  specialist should be able to do on its own initiative. */
  agent: string
  /** The `provider/model` this turn is running on, or null outside a turn.
   *
   *  For the tools that start work of their own rather than only reporting on
   *  it: an engagement's steps are real sessions on this machine, and a step
   *  that says "inherit" means THIS model — not "whatever the machine would
   *  pick if nobody asked", which is what it silently meant while nothing
   *  handed the manager's model down. */
  model: string | null
  /** Emit on the machine's event bus, reaching every connected client. */
  publish: (type: string, properties: Record<string, unknown>) => void
  /** Operations a tool needs FROM the machine. Handed down rather than
   *  imported, so a tool body never learns how any of it works — the same
   *  reason `publish` is here. These used to be HTTP calls back into the
   *  runtime the tool was loaded into, which is exactly the coupling this
   *  migration was about. */
  machine: MachineCapabilities
  /** Aborted when the turn is stopped. A tool that waits on a person must
   *  watch this, or Stop leaves it waiting forever. */
  signal: AbortSignal
}

/** The tier vocabulary, so a tool that offers a choice between the three sizes
 *  spells them the same way the kernel that resolves them does. */
export { MODEL_TIERS }
export type { ModelTier }

export interface CatalogueModel {
  id: string
  name: string
  /** What the model can EMIT. Empty means the catalogue does not say — which
   *  is NOT "text only", so a tool looking for an image model must treat it as
   *  unusable rather than assume. */
  outputModalities: string[]
  releaseDate: string | null
  status: string | null
}

export interface CatalogueProvider {
  id: string
  name: string
  connected: boolean
  models: CatalogueModel[]
}

export interface MachineCapabilities {
  /** Ask a model one question. No session, no tools, no history, nothing
   *  persisted — for the times a tool needs a model to DECIDE something rather
   *  than to hold a conversation. */
  complete: (prompt: string, options?: { model?: string; system?: string }) => Promise<string>
  /** Every provider this machine knows, with live credential state. */
  providers: () => Promise<CatalogueProvider[]>
  /** The concrete `provider/model` this machine routes one size of work to, or
   *  null when its owner has configured none for that size.
   *
   *  Null rather than the default model's name: "no heavy model is set" and
   *  "the heavy model happens to be the default" are different answers, and a
   *  tool that collapses them reports a model nobody chose. */
  tierModel: (tier: ModelTier) => Promise<string | null>
  /** The API key this machine holds for one provider, or null.
   *
   *  Narrow on purpose — a provider id in, one key out — because a tool that
   *  calls a provider's REST API directly (`image_generate` does: the engine
   *  drops model-emitted image parts) needs the same credential the chat runs
   *  on, and has no other way to reach it. The key lives in the machine vault
   *  under the provider's env var, which is NOT in this process's environment,
   *  so reading `process.env` finds nothing — which is how `image_generate`
   *  came to report "no API key is set" on a machine where the user had
   *  connected one in Customize. */
  providerKey: (providerId: string) => Promise<string | null>
  /** Add or replace a slash command in the machine's catalogue. */
  createCommand: (name: string, command: { template: string; description?: string }) => Promise<void>
  /** Install a skill from its markdown. */
  createSkill: (name: string, markdown: string) => Promise<void>
}

export interface HoshiToolDefinition<A extends Record<string, z.ZodTypeAny>> {
  description: string
  args: A
  execute: (input: z.infer<z.ZodObject<A>>, context: HoshiToolContext) => Promise<HoshiToolResult>
}

/** Wrap a Hoshi tool as something the engine can call.
 *
 *  The engine's tool protocol wants one value back, while a Hoshi tool returns
 *  three fields with different audiences. The model is handed `output` — it is
 *  the only part it can act on — and the rest rides alongside for the client,
 *  rather than being flattened into the prompt where it would just be noise the
 *  model has to ignore. */
export function defineHoshiTool<A extends Record<string, z.ZodTypeAny>>(
  definition: HoshiToolDefinition<A>,
): (context: Omit<HoshiToolContext, 'signal'>) => Tool {
  return (context) =>
    aiTool({
      description: definition.description,
      inputSchema: z.object(definition.args),
      async execute(input: z.infer<z.ZodObject<A>>, options: { abortSignal?: AbortSignal }) {
        const result = await definition.execute(input, {
          ...context,
          /**
           *
           * The engine's own turn signal, so Stop reaches a tool that is
           * waiting on a person rather than only the model call around it.
           *
           **/
          signal: options.abortSignal ?? new AbortController().signal,
        })
        return {
          title: result.title,
          output: result.output,
          metadata: result.metadata ?? {},
          ...(result.attachments?.length ? { attachments: result.attachments } : {}),
        }
      },
    }) as Tool
}

/** A tool waiting for its turn's context. Modules export these; the engine
 *  binds them once per turn, which is why a tool can know its session without
 *  any module-level state to get stale. */
export type HoshiToolFactory = (context: Omit<HoshiToolContext, 'signal'>) => Tool

export type HoshiToolFactories = Record<string, HoshiToolFactory>
export type HoshiToolSet = Record<string, Tool>

export function bindTools(factories: HoshiToolFactories, context: Omit<HoshiToolContext, 'signal'>): HoshiToolSet {
  return Object.fromEntries(Object.entries(factories).map(([name, factory]) => [name, factory(context)]))
}

/**
 * ── Arguments a model actually sends ─────────────────────────────────────────
 *
 * Wrap an object/array argument so a JSON STRING is accepted where the object
 * itself was expected.
 *
 * Because models do this, routinely, and the cost of refusing is worse than the
 * cost of accepting. `memory_consolidate` was called with its `replace` array
 * full of JSON strings instead of objects; zod refused, the tool never ran, and
 * the model — reading a validation error it did not understand — told the user
 * their memory had been consolidated. A wrong answer delivered confidently,
 * from a mistake nobody could see.
 *
 * Deliberately narrow: it parses a string that is valid JSON of the right
 * shape, and otherwise hands the original value to the real schema so its error
 * message is the one the model gets. Nothing is guessed or repaired.
 */
export function jsonish<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }, schema)
}
