import { hoshiFile, readHoshiJson } from './store.js'

/**
 * ── Which integrations are worth offering THIS person ────────────────────────
 *
 * An ordered list of skill names, from the machine's preset. Not a catalogue and
 * not a permission: every pack the machine carries is still reachable from
 * Customize → Integrations. This answers a narrower question — when the product
 * offers to connect something unprompted, which one, and to whom.
 *
 * A preset that lists none is answering, not omitting. A developer's machine
 * should never be nudged toward Jira: its own tools (gh, glab, the cloud CLIs)
 * sign in through their own device flows and have no vault key at all, so there
 * is nothing here to suggest and the offer stays silent.
 *
 * Deliberately names skills rather than describing them. What a pack IS still
 * comes from its own SKILL.md front-matter, which is what made adding Jira a
 * content-only change (packages/machine-profile/README.md → Integration packs);
 * duplicating labels here would put the same fact in two places and let them
 * disagree.
 *
 **/
export async function listSuggestedIntegrations(): Promise<string[]> {
  const parsed = await readHoshiJson<unknown>(hoshiFile('integrations.json'))
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((name) => (typeof name === 'string' && name.trim() ? [name.trim()] : []))
}
