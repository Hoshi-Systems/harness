import { tool as aiTool, type ToolSet } from 'ai'
/**
 *
 * `z` through the tool-authoring module rather than a direct dependency: the
 * ai SDK matches schemas by IDENTITY, so a second copy of zod in this workspace
 * would typecheck and then reject every argument at runtime.
 *
 **/
import { z } from '../define-tool.js'

import { listArchetypes } from '../../kernel/index.js'
import {
  awaitEngagement,
  cancelEngagement,
  engagementSummary,
  getEngagement,
  resumeEngagement,
  startEngagement,
} from './engagements.js'
import { parseEngagementPlan, type Engagement } from './graph.js'

/**
 * ── The manager's planning tools ─────────────────────────────────────────────
 *
 * `team_plan` states the whole shape of a job — who does what, and who hands
 * their result to whom — and runs it. `team_resume` answers a checkpoint it
 * stopped at.
 *
 * These are NOT a replacement for the library's `task` tool, and the
 * descriptions below say so: one specialist for one job, decided in the moment,
 * is what `task` is for and it stays the right choice. This is for the case
 * `task` cannot express — two things that could happen at once, or a result
 * that should go to a colleague rather than back through the manager.
 *
 * They are contributed by the plugin rather than by a shared tool aggregate
 * because they need the kernel: sessions, turns, the event bus. A tool that
 * reached those through a capability object would be plumbing a seam that only
 * exists for tools which must stay ignorant of the machine, and these are the
 * machine.
 */

const PLAN_NODE = z.object({
  key: z.string().describe('Short slug naming this step — how other steps reference it in dependsOn'),
  kind: z
    .string()
    .optional()
    .describe('"assignment" (default) for a specialist, or "checkpoint" to stop and hand the decision back to you'),
  role: z.string().optional().describe("Freeform role label when no archetype fits, e.g. 'market-analyst'"),
  archetype: z.string().optional().describe('Archetype to instantiate — the specialists this machine knows'),
  brief: z
    .string()
    .optional()
    .describe(
      "An assignment's complete brief: goal, constraints, what is in scope, done-criteria, and the report format you expect back. Do NOT restate what a dependency will report — that arrives verbatim.",
    ),
  question: z.string().optional().describe("A checkpoint's question: what you are being called back to decide"),
  readOnly: z.boolean().optional().describe("Deny every mutating tool (defaults to the archetype's own setting)"),
  model: z
    .string()
    .optional()
    .describe(
      'provider/model to run this step on. Omit it (or say "inherit") to run it on the model you are on — which is usually right; name one only to deliberately spend more or less on a particular step.',
    ),
  dependsOn: z
    .array(z.string())
    .optional()
    .describe(
      'Keys of the steps that must finish first. Their reports are handed to this step verbatim, so a result flows specialist-to-specialist without passing through you. Empty (the default) means it starts immediately, in parallel with every other empty one.',
    ),
  reportToManager: z
    .boolean()
    .optional()
    .describe(
      "Also return this step's report to you, even though a colleague consumed it. End steps always come back.",
    ),
})

/** One tool result for both tools — they end in the same three places
 *  (finished, parked on a checkpoint, or failed). */
function describe(engagement: Engagement) {
  const summary = engagementSummary(engagement)
  const lines: string[] = []

  if (summary.checkpoint) {
    lines.push(
      `The engagement is waiting on YOU at checkpoint "${summary.checkpoint.key}": ${summary.checkpoint.question}`,
      '',
      'Reports so far:',
    )
  } else {
    lines.push(`Engagement "${engagement.title}" ${summary.status}.`, '')
  }

  for (const report of summary.reports) lines.push('', `### ${report.role} (${report.key})`, '', report.report)
  if (!summary.reports.length) lines.push('(no reports yet)')

  if (summary.failures.length) {
    lines.push('', 'Failed steps:')
    for (const failure of summary.failures) lines.push(`- ${failure.key}: ${failure.error}`)
  }

  lines.push(
    '',
    summary.checkpoint
      ? `Decide, then call team_resume { engagement: "${engagement.id}", node: "${summary.checkpoint.key}", decision: … } — your decision is handed to the steps that depend on it, so write it for them.`
      : 'These reports are for you, not the user: review them, and write the user-facing summary yourself.',
  )

  return {
    title: summary.checkpoint ? `${engagement.title} — your decision` : `${engagement.title} — ${summary.status}`,
    output: lines.join('\n'),
    metadata: {
      hoshi: {
        engagement: {
          id: engagement.id,
          status: engagement.status,
          steps: engagement.nodes.map((node) => ({
            key: node.key,
            kind: node.kind,
            label: node.kind === 'checkpoint' ? node.question : node.role,
            status: engagement.runs[node.key]?.status ?? 'blocked',
            sessionId: engagement.runs[node.key]?.sessionId ?? null,
            dependsOn: node.dependsOn,
          })),
        },
      },
    },
  }
}

export function engagementTools(context: {
  sessionId: string
  directory: string
  agent: string
  /** What the MANAGER's turn is running on. Every step that says "inherit" —
   *  which is every step that says nothing — runs on this.
   *
   *  It was never passed. `Engagement.model` was documented as "the manager's
   *  own model ref, inherited by every step that names none", `parseModel`
   *  turned the literal "inherit" into null so it would fall through to it, and
   *  the one call that could have supplied it did not. So the whole chain fell
   *  past the machine's default too and every step ran on the first model the
   *  provider catalogue happened to list. */
  model?: string | null
}): ToolSet {
  return {
    team_plan: aiTool({
      description: [
        'Declare a whole job as a process — who does what, and who hands their result to whom — and run it.',
        'Use this INSTEAD of several `task` calls whenever two steps could happen at once, or one step needs what another produced.',
        'For a single hand-off, `task` is still the right tool.',
        'Steps with no dependencies start TOGETHER; a step with `dependsOn` starts the moment those finish and receives their reports verbatim, so results travel specialist-to-specialist instead of through you.',
        'A `checkpoint` step stops the run and hands the decision back to you mid-process; answer it with team_resume and the rest carries on.',
        "Returns when the process finishes or parks on a checkpoint, with the end steps' reports.",
      ].join(' '),
      inputSchema: z.object({
        title: z.string().describe('Short name for this engagement, e.g. "Competitor pricing review"'),
        nodes: z.array(PLAN_NODE).min(1).describe('The steps, in any order — the dependencies define the shape'),
      }),
      async execute({ title, nodes }, options: { abortSignal?: AbortSignal }) {
        const archetypes = (await listArchetypes()).map((archetype) => archetype.name)
        const parsed = parseEngagementPlan({ nodes }, archetypes)
        const engagement = await startEngagement({
          parentSessionId: context.sessionId,
          directory: context.directory,
          title,
          nodes: parsed,
          ...(context.model ? { model: context.model } : {}),
        })

        /**
         *
         * The manager's turn being stopped ends the ENGAGEMENT, not just this
         * wait — otherwise every specialist keeps generating for a report
         * nobody will read.
         *
         **/
        const stop = () => void cancelEngagement(engagement.id, context.sessionId).catch(() => undefined)
        options.abortSignal?.addEventListener('abort', stop, { once: true })
        try {
          await awaitEngagement(engagement, options.abortSignal)
          return describe((await getEngagement(engagement.id)) ?? engagement)
        } finally {
          options.abortSignal?.removeEventListener('abort', stop)
        }
      },
    }),

    team_resume: aiTool({
      description: [
        'Answer a checkpoint and let the process carry on — the other half of team_plan.',
        "Your decision becomes that step's report and is handed verbatim to every step that depends on it, so write it for them, not for the user.",
        'Blocks again until the engagement finishes or reaches the next checkpoint.',
      ].join(' '),
      inputSchema: z.object({
        engagement: z.string().describe('The engagement id from team_plan, e.g. eng_1a2b3c…'),
        node: z.string().describe('The checkpoint step you are answering'),
        decision: z.string().describe('The decision, written for the specialists downstream of it'),
      }),
      async execute({ engagement: id, node, decision }, options: { abortSignal?: AbortSignal }) {
        const resumed = await resumeEngagement(id, context.sessionId, node, decision)
        await awaitEngagement(resumed, options.abortSignal)
        return describe((await getEngagement(id)) ?? resumed)
      },
    }),
  } as ToolSet
}

export function engagementToolNames(): string[] {
  return ['team_plan', 'team_resume']
}
