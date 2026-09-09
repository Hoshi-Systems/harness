import { Agent, type SubagentCatalog } from '@openharness/core'
import type { LanguageModel } from 'ai'
import { listArchetypes, type Archetype } from './archetypes.js'
import { buildModel, tierModelRef } from './model.js'
import type { ReasoningEffort } from './reasoning.js'
import { buildApprover, buildTools, readOnlyTools } from './tools.js'

/**
 * ── Delegation ───────────────────────────────────────────────────────────────
 *
 * Handing part of a job to a specialist.
 *
 * The engine's library owns the mechanism: an Agent given `subagents` grows a
 * `task` tool, runs the child loop, streams its events back, and can cancel it.
 * This module supplies only what the library cannot know — WHICH specialists
 * this machine has, which is Hoshi's own content (engine/archetypes.ts).
 *
 * That split is the whole point of the rebuild. What used to live here was 893
 * lines driving another runtime's session API by hand: create a child session
 * with a parentID, post a message into it, poll it, forward an abort. None of
 * it was Hoshi's idea — it was the cost of not owning the loop.
 *
 * A CATALOGUE rather than a fixed list, because archetypes are files a user
 * edits: `resolve` reads at delegation time, so adding a specialist takes
 * effect on the next turn instead of after a restart.
 *
 **/

/**
 * ── Which model a specialist runs on ─────────────────────────────────────────
 *
 * The library's `task` tool takes `{ agent, prompt }` — there is no model
 * argument, and adding one would be the wrong shape anyway. WHICH model a role
 * deserves is a property of the ROLE, not of the sentence that hands it a job:
 * an architect needs the machine's best model whoever asks it and whatever
 * they ask, and a scribe does not.
 *
 * So the archetype declares a tier and the machine maps it (kernel/model.ts).
 * Every seeded archetype has declared one since they were written — `heavy` on
 * the architect, `light` on the scribe, `standard` on the rest — and nothing
 * read them: the catalogue handed every specialist the model its PARENT was
 * built with, so the whole three-tier scheme, the `task_route` tool that sizes
 * work for it, and the two extra models the owner configured in preferences
 * were decoration. Routing suggested a tier, the prompt explained the tiers,
 * and every specialist ran on one model.
 *
 * Inheriting stays the fallback, and stays the right answer for an archetype
 * with no tier: a specialist run on the model the conversation is already on
 * is never a surprise.
 *
 **/
async function specialistModel(
  archetype: Archetype,
  parent: { model: LanguageModel; modelRef: string; effort: ReasoningEffort },
): Promise<LanguageModel> {
  if (!archetype.tier) return parent.model
  const ref = await tierModelRef(archetype.tier)
  /**
   *
   * Nothing configured for that tier, or the tier resolves to what the parent
   * is already on: inherit, and build nothing.
   *
   **/
  if (!ref || ref === parent.modelRef) return parent.model
  try {
    return (await buildModel(ref, { effort: parent.effort })).model
  } catch (error) {
    /**
     *
     * A tier pointing at a model this machine cannot use — withdrawn by the
     * provider, or its key removed since the preference was set — must cost the
     * ROUTING, never the delegation. The specialist runs on the parent's model
     * and the reason is said once, here, because the alternative is a `task`
     * call that fails with a model error the agent cannot act on.
     *
     **/
    console.warn(
      `[harness] ${archetype.name} declares tier "${archetype.tier}" → ${ref}, which this machine cannot build ` +
        `(${error instanceof Error ? error.message : String(error)}). Running it on ${parent.modelRef} instead.`,
    )
    return parent.model
  }
}

export function archetypeCatalog(options: {
  /** What the delegating turn is running on — the model a specialist inherits
   *  when its archetype names no tier of its own. */
  model: LanguageModel
  /** The same thing as a `provider/model` reference. The built model cannot be
   *  compared or reported on, so routing needs the name beside it. */
  modelRef: string
  /** How hard the parent was asked to think, so a specialist built on another
   *  model is asked for the same rather than silently dropping to the
   *  provider's default. */
  effort: ReasoningEffort
  sessionId: string
  directory: string
}): SubagentCatalog {
  return {
    async list() {
      return (await listArchetypes()).map((archetype) => ({
        name: archetype.name,
        description: archetype.description,
      }))
    },

    async resolve(name) {
      const archetype = (await listArchetypes()).find((entry) => entry.name === name)
      if (!archetype) return undefined

      /**
       *
       * A read-only specialist gets read-only tools — enforced by what it is
       * HANDED, not by asking it nicely in a prompt. "Investigate and report"
       * is only a guarantee if the investigator cannot write.
       *
       **/
      const tools = archetype.readOnly
        ? readOnlyTools(options.directory)
        : await buildTools(options.sessionId, options.directory)

      return new Agent({
        name: archetype.name,
        description: archetype.description,
        model: await specialistModel(archetype, options),
        systemPrompt: archetype.prompt,
        tools,
        /**
         *
         * A specialist answers to the same permission rules as its parent. A
         * delegated `bash` is still bash on the user's machine, and routing
         * around the gate by spawning a helper would make the gate a
         * formality.
         *
         **/
        approve: buildApprover(options.sessionId, options.directory),
        instructions: false,
      })
    },
  }
}
