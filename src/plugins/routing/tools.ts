import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { hoshiFile } from '../../kernel/index.js'
import {
  defineHoshiTool,
  MODEL_TIERS,
  z,
  type HoshiToolFactories,
  type MachineCapabilities,
  type ModelTier,
} from '../define-tool.js'

/**
 *
 * Hoshi's model-routing plugin: the `task_route` tool the personal agent calls
 * before recruiting (Phase 3, Q4/Q11/Q19). Sizes a request into
 * { complexity, archetype, tier } and resolves the tier to a concrete model
 * from the machine's preferences, through a fallback chain that never blocks a
 * turn:
 *
 *   1. local  — ollama inside the machine (MACHINE_ROUTER=local, the default;
 *               HOSHI_ROUTER_URL, HOSHI_ROUTER_MODEL), short timeout;
 *   2. cloud  — the machine's small_model via a throwaway OpenCode session;
 *   3. rubric — both unavailable: the tool answers with the tier definitions
 *               and tells the agent to size the task itself (the seeded prompt
 *               rubric is the final backstop).
 *
 * The router's output is a SUGGESTION the personal agent may override (spike
 * S2: a 0.6B router is fast but biased toward "heavy") — which is exactly why
 * routing is an inspectable tool call rather than invisible prompt machinery.
 *
 * The tiny frontmatter parsing for archetype names is duplicated from the
 * catalogue's on purpose — it reads two fields out of a file this tool already
 * has open, and a shared parser for that is more coupling than it saves.
 *
 **/

const archetypesDir = () => hoshiFile('archetypes')

const PERSONAL_AGENT = 'hoshi'

/** local = per-machine ollama (Q11); cloud = skip straight to small_model;
 *  off = no router calls at all (rubric only). The deployment-level escape
 *  hatch — flipping to cloud/off needs no image change. */
const ROUTER_MODE = (process.env.MACHINE_ROUTER ?? 'local') as 'local' | 'cloud' | 'off'
const ROUTER_URL = (process.env.HOSHI_ROUTER_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '')
/** S3's pick: 0.6B-class, ~522 MB on disk, lazy-loaded. */
const ROUTER_MODEL = process.env.HOSHI_ROUTER_MODEL ?? 'qwen3:0.6b'
/** The router must never block a turn: measured warm latency is ~0.5s and cold
 *  start ~1.2s, so 6s covers a cold load with margin; past that we fall back. */
const LOCAL_TIMEOUT_MS = 6_000
/** Keep the router model resident only briefly after a route (Q19 budget). */
const KEEP_ALIVE = '5m'

type Tier = ModelTier
/** The kernel's list, not a second copy of it: this tool reports which model a
 *  tier lands on, and a tier it knew about that the resolver did not would
 *  report a model that never gets used. */
const TIERS = MODEL_TIERS
const COMPLEXITIES = ['trivial', 'simple', 'standard', 'hard'] as const

interface RouteResult {
  complexity: (typeof COMPLEXITIES)[number]
  archetype: string | null
  tier: Tier
  /** Which rung of the fallback chain produced this. */
  source: 'local' | 'cloud'
}

/**
 * ── Machine model preferences (tier → concrete model) ────────────────────────
 *
 **/

interface TierModels {
  light: string | null
  standard: string | null
  heavy: string | null
}

/** Resolve the three tiers to concrete `provider/model` refs.
 *
 *  Through the machine rather than by reading its preferences file, which is
 *  what this did: a second parser for the same three keys, with its own idea of
 *  what counts as a model reference. The mapping belongs to ONE place
 *  (kernel/model.ts `tierModelRef`) because it is no longer only this tool's —
 *  the delegation path routes specialists by the same tiers, and two readers
 *  that disagree would send the router's advice and the actual recruit to
 *  different models. */
async function tierModels(machine: MachineCapabilities): Promise<TierModels> {
  const [light, standard, heavy] = await Promise.all(TIERS.map((tier) => machine.tierModel(tier)))
  return { light: light ?? null, standard: standard ?? null, heavy: heavy ?? null }
}

/** The archetype names seeded on this machine, for the router prompt's enum. */
async function archetypeNames(): Promise<string[]> {
  try {
    return (await readdir(archetypesDir()))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .sort()
  } catch {
    return []
  }
}

/**
 * ── The routing prompt (shared by the local and cloud rungs) ─────────────────
 *
 **/

function routerPrompt(request: string, archetypes: string[]): string {
  const archetypeList = archetypes.length ? archetypes.join('", "') : 'researcher'
  return [
    'You are a task router for a delegation system. Given a user request, output ONLY a JSON object — no prose, no markdown fences — with exactly these keys:',
    `- "complexity": one of "trivial" (a fact/one-liner), "simple" (a small mechanical change), "standard" (regular implementation work), "hard" (architecture, gnarly debugging, large refactors).`,
    `- "archetype": the best-fitting specialist from ["${archetypeList}"], or "none" when the request needs no delegation (trivial answers).`,
    `- "tier": the model size the task deserves — "light" (lookups, mechanical edits, summaries), "standard" (regular implementation), "heavy" (architecture-grade work only; do NOT default to heavy when unsure — prefer standard).`,
    '',
    `Request: ${request}`,
  ].join('\n')
}

/** Parse the first balanced {…} span of a model reply into a RouteResult,
 *  coercing unknown values to safe defaults rather than failing the route. */
function parseRoute(text: string, archetypes: string[], source: RouteResult['source']): RouteResult | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  const complexity = COMPLEXITIES.includes(parsed.complexity as never)
    ? (parsed.complexity as RouteResult['complexity'])
    : 'standard'
  const tier = TIERS.includes(parsed.tier as never) ? (parsed.tier as Tier) : 'standard'
  const archetype =
    typeof parsed.archetype === 'string' && archetypes.includes(parsed.archetype) ? parsed.archetype : null
  return { complexity, archetype, tier, source }
}

/**
 * ── Rung 1: local ollama ─────────────────────────────────────────────────────
 *
 **/

async function routeLocal(request: string, archetypes: string[]): Promise<RouteResult | null> {
  try {
    const res = await fetch(`${ROUTER_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: ROUTER_MODEL,
        prompt: routerPrompt(request, archetypes),
        stream: false,
        think: false,
        keep_alive: KEEP_ALIVE,
        options: { num_predict: 120, temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { response?: string }
    return typeof body.response === 'string' ? parseRoute(body.response, archetypes, 'local') : null
  } catch {
    return null
  }
}

/**
 * ── Rung 2: ask a small cloud model ──────────────────────────────────────────
 *
 * This used to create a session, post one message into it, read the reply and
 * delete the session again — three calls and a cleanup, because the old runtime
 * had no way to simply ask a model a question. Every failed cleanup left a
 * "Route" thread in the user's session list.
 *
 * Sizing a task is not a conversation, and now it does not pretend to be one.
 *
 **/

async function routeCloud(
  request: string,
  archetypes: string[],
  smallModel: string | null,
  complete: (prompt: string, options?: { model?: string; system?: string }) => Promise<string>,
): Promise<RouteResult | null> {
  try {
    const text = await complete(routerPrompt(request, archetypes), {
      ...(smallModel ? { model: smallModel } : {}),
      system: 'Answer with a single JSON object and nothing else.',
    })
    return parseRoute(text, archetypes, 'cloud')
  } catch {
    /**
     *
     * A router that cannot answer is not an error the user should see — the
     * tool falls through to the rubric and the agent sizes the task itself.
     *
     **/
    return null
  }
}

/**
 * ── The tool ─────────────────────────────────────────────────────────────────
 *
 **/

const RUBRIC_FALLBACK = [
  'No router is available right now — size the task yourself with the rubric:',
  '- "light": lookups, mechanical edits, one-line fixes, summaries, boilerplate.',
  '- "standard": regular implementation work, most day-to-day tasks.',
  '- "heavy": architecture, gnarly debugging, large refactors (only when getting it wrong is expensive).',
].join('\n')

const taskRoute = defineHoshiTool({
  description: [
    'Size a request before delegating: returns { complexity, archetype, tier, model } — which specialist this is work for, and the model this machine would run that size of work on.',
    'What you act on is the ARCHETYPE: pass it as `task { agent }`. The model is reported so you can see what the delegation will cost, not passed — a specialist runs on the model its own archetype asks for.',
    "The suggestion comes from this machine's router (local model or cloud fallback); treat it as advisory and override the archetype when your own judgment disagrees.",
    'When no router is reachable it returns the sizing rubric for you to apply yourself.',
  ].join(' '),
  args: {
    request: z.string().describe('The user request (or your restatement of the task) to size'),
  },
  async execute(args, context) {
    if (context.agent !== PERSONAL_AGENT) {
      throw new Error(`task_route belongs to the personal agent ("${PERSONAL_AGENT}").`)
    }

    const [archetypes, models] = await Promise.all([archetypeNames(), tierModels(context.machine)])

    let route: RouteResult | null = null
    if (ROUTER_MODE === 'local') route = await routeLocal(args.request, archetypes)
    if (!route && ROUTER_MODE !== 'off')
      route = await routeCloud(args.request, archetypes, models.light, context.machine.complete)

    if (!route) {
      return {
        title: 'Route: rubric',
        output: `${RUBRIC_FALLBACK}\n\nTier models on this machine: light=${models.light ?? 'inherit'}, standard=${models.standard ?? 'inherit'}, heavy=${models.heavy ?? 'inherit'} ("inherit" means that tier has no model of its own and runs on whatever you are running on).`,
        metadata: { hoshi: { route: { source: 'rubric' } } },
      }
    }

    const model = models[route.tier] ?? 'inherit'
    return {
      title: `Route: ${route.tier} (${route.source})`,
      output: JSON.stringify(
        {
          ...route,
          model,
          note: 'Suggestion — override the archetype if your judgment disagrees; small routers over-pick heavy. `model` is what this machine will run that archetype on, for your information: `task` takes no model.',
        },
        null,
        2,
      ),
      metadata: { hoshi: { route: { ...route, model } } },
    }
  },
})

export const routerTools: HoshiToolFactories = {
  task_route: taskRoute,
}
