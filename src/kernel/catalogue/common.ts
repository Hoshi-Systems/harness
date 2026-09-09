import { hoshiFile } from '../store.js'

/**
 *
 * What the three catalogue kinds share: where they live, how they are scoped,
 * and one helper. Where the catalogue lives on disk. Each of the three kinds keeps a JSON file
 * of user patches and a directory of seeded markdown, and they are gathered
 * here because the commands and skills constants used to sit in the agents
 * section of one 656-line module — the kind of placement that happens when
 * everything is in one file and nothing says otherwise.
 *
 * Functions, not constants: `hoshiFile` resolves against the machine's state
 * directory, which the tests repoint per case.
 *
 **/

export const AGENTS_FILE = () => hoshiFile('agents.json')
export const AGENTS_DIR = () => hoshiFile('agents')
export const COMMANDS_FILE = () => hoshiFile('commands.json')
export const COMMANDS_DIR = () => hoshiFile('commands')
export const SKILLS_DIR = () => hoshiFile('skills')

/** Machine-wide, or brought by a checkout. All three kinds are scoped this way;
 *  it was declared inside the commands section, where agents and skills both
 *  reached for it across two ASCII banners. */
export type AssetScope = 'machine' | 'project'

/**
 *
 * Drop keys whose value is `undefined`, so a patch means "change these" rather
 * than "these are now unset". Generic because all three kinds patch the same
 * way — it used to be typed to agents alone, and `setCommand` reached it by
 * casting a `Partial<Command>` to `AgentPatch`, which is a lie the compiler was
 * asked to accept rather than a shared helper.
 *
 **/
export function stripUndefined<T extends object>(patch: T | undefined): Partial<T> {
  if (!patch) return {}
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>
}
