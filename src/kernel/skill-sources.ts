import { randomUUID } from 'node:crypto'
import { hoshiFile, readHoshiJson, writeHoshiJson } from './store.js'
import { publishMachineEvent } from './events.js'
import { installSkillFiles, type Skill, type SkillFile } from './catalogue.js'

/**
 * ── Where skills come from ───────────────────────────────────────────────────
 *
 * A skill is a folder with a SKILL.md in it, and the world has thousands of
 * them — published to GitHub and indexed by directories like skills.sh. Until
 * now this machine could only be handed one by typing its prose into a box,
 * which is a fine way to write your own and a terrible way to get somebody
 * else's.
 *
 * Two kinds of source, because the ecosystem has two shapes:
 *
 *   DIRECTORY   an index that can be SEARCHED across many repositories.
 *               skills.sh is the default one, and its search answers with
 *               `owner/repo` + a skill id — a pointer, never the content.
 *   REPOSITORY  a GitHub repo that holds skills directly. Listable in full,
 *               which is what an org's own repository will be (and, next, a
 *               private one served by the Platform).
 *
 * Either way the CONTENT comes from GitHub, because that is where it lives:
 * the directory indexes repos, and `npx skills add owner/repo` — the convention
 * the whole ecosystem installs by — reads the same files this does.
 *
 * Both hosts are overridable by environment variable. Not for flexibility's
 * sake: a machine on a closed network needs a mirror, and the wire-level census
 * needs a fixture it can serve itself rather than a suite whose result depends
 * on GitHub being up.
 *
 **/

const SOURCES_FILE = () => hoshiFile('skill-sources.json')

const REGISTRY_URL = () => (process.env.HOSHI_SKILLS_REGISTRY_URL ?? 'https://www.skills.sh').replace(/\/+$/, '')
const GITHUB_API = () => (process.env.HOSHI_GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '')
const GITHUB_RAW = () => (process.env.HOSHI_GITHUB_RAW_URL ?? 'https://raw.githubusercontent.com').replace(/\/+$/, '')

export type SkillSourceKind = 'directory' | 'repository'

export interface SkillSource {
  id: string
  name: string
  kind: SkillSourceKind
  /** A directory's base URL, or `owner/repo` for a repository. */
  ref: string
  /** Shipped with the machine: removable like any other, but restored on the
   *  next boot, so a person who removes it has not broken discovery for good. */
  builtIn?: boolean
}

export class SkillSourceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** The source every machine starts with. Kept as data rather than a special
 *  case in the code: it is listed, searched and removed exactly like one a
 *  person adds, which is the only way to be sure that path works. */
function defaultSource(): SkillSource {
  return { id: 'skills-sh', name: 'skills.sh', kind: 'directory', ref: REGISTRY_URL(), builtIn: true }
}

export async function listSkillSources(): Promise<SkillSource[]> {
  const data = await readHoshiJson<{ sources?: SkillSource[]; removedBuiltIns?: string[] }>(SOURCES_FILE())
  const own = Array.isArray(data?.sources) ? data.sources : []
  const removed = new Set(Array.isArray(data?.removedBuiltIns) ? data.removedBuiltIns : [])
  const builtIns = [defaultSource()].filter((source) => !removed.has(source.id))
  return [...builtIns, ...own]
}

export async function addSkillSource(input: {
  name?: string
  kind: SkillSourceKind
  ref: string
}): Promise<SkillSource> {
  const ref = input.ref.trim()
  if (!ref) throw new SkillSourceError('A source needs an address.')
  if (input.kind === 'repository' && !/^[\w.-]+\/[\w.-]+$/.test(ref)) {
    throw new SkillSourceError('A repository source is "owner/repo".')
  }
  if (input.kind === 'directory' && !/^https?:\/\//.test(ref)) {
    throw new SkillSourceError('A directory source is a URL.')
  }
  const existing = await listSkillSources()
  if (existing.some((source) => source.ref === ref)) {
    throw new SkillSourceError(`This machine already has "${ref}".`, 409)
  }
  const source: SkillSource = {
    id: `src_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    name: input.name?.trim() || ref,
    kind: input.kind,
    ref: input.kind === 'directory' ? ref.replace(/\/+$/, '') : ref,
  }
  const data = await readHoshiJson<{ sources?: SkillSource[]; removedBuiltIns?: string[] }>(SOURCES_FILE())
  await writeHoshiJson(SOURCES_FILE(), {
    sources: [...(data?.sources ?? []), source],
    removedBuiltIns: data?.removedBuiltIns ?? [],
  })
  publishMachineEvent('skill.sources.changed', { id: source.id })
  return source
}

export async function removeSkillSource(id: string): Promise<boolean> {
  const data = await readHoshiJson<{ sources?: SkillSource[]; removedBuiltIns?: string[] }>(SOURCES_FILE())
  const own = data?.sources ?? []
  const removed = new Set(data?.removedBuiltIns ?? [])
  const builtIn = [defaultSource()].find((source) => source.id === id)
  if (!builtIn && !own.some((source) => source.id === id)) return false
  /**
   *
   * A built-in is remembered as removed rather than deleted — there is no file
   * entry to delete. Without the record the next boot would put it back, which
   * reads as the machine ignoring you.
   *
   **/
  if (builtIn) removed.add(id)
  await writeHoshiJson(SOURCES_FILE(), {
    sources: own.filter((source) => source.id !== id),
    removedBuiltIns: [...removed],
  })
  publishMachineEvent('skill.sources.changed', { id })
  return true
}

/** One skill a source offers — a pointer, not the content. */
export interface SkillOffer {
  /** Stable id within its source: `owner/repo/skill`. */
  id: string
  name: string
  /** The GitHub repository the files come from. */
  repo: string
  /** How many machines have installed it, when the source counts. */
  installs?: number
  description?: string
}

/** What a source can offer, for a query.
 *
 *  A DIRECTORY is searched (its whole index is far too large to list, and the
 *  point of a directory is finding). A REPOSITORY is listed in full and the
 *  query filters what came back — a repo holds a handful of skills, and asking
 *  a person to search inside something that small is a search box that only
 *  ever hides things. */
export async function browseSkillSource(sourceId: string, query: string): Promise<SkillOffer[]> {
  const source = (await listSkillSources()).find((entry) => entry.id === sourceId)
  if (!source) throw new SkillSourceError('No such source on this machine.', 404)
  return source.kind === 'directory' ? searchDirectory(source, query) : listRepository(source, query)
}

async function searchDirectory(source: SkillSource, query: string): Promise<SkillOffer[]> {
  const term = query.trim()
  if (!term) return []
  const res = await fetch(`${source.ref}/api/search?q=${encodeURIComponent(term)}`, {
    headers: { accept: 'application/json' },
  }).catch(() => null)
  if (!res?.ok) throw new SkillSourceError(`${source.name} did not answer.`, 502)
  const body = (await res.json().catch(() => null)) as { skills?: unknown } | null
  const skills = Array.isArray(body?.skills) ? body.skills : []
  return skills
    .map((raw) => {
      const entry = (raw ?? {}) as Record<string, unknown>
      const repo = typeof entry.source === 'string' ? entry.source : ''
      const name = typeof entry.skillId === 'string' ? entry.skillId : typeof entry.name === 'string' ? entry.name : ''
      if (!repo || !name) return null
      return {
        id: typeof entry.id === 'string' ? entry.id : `${repo}/${name}`,
        name,
        repo,
        ...(typeof entry.installs === 'number' ? { installs: entry.installs } : {}),
        ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      }
    })
    .filter((offer): offer is SkillOffer => offer !== null)
}

async function listRepository(source: SkillSource, query: string): Promise<SkillOffer[]> {
  const term = query.trim().toLowerCase()
  const folders = await skillFolders(source.ref)
  return folders
    .map((folder) => ({ id: `${source.ref}/${folder.name}`, name: folder.name, repo: source.ref }))
    .filter((offer) => !term || offer.name.toLowerCase().includes(term))
}

/** Every skill folder in a repository, by name and path.
 *
 *  Found by looking for SKILL.md rather than by assuming a layout: repositories
 *  in the wild put them at the root, under `skills/`, and nested a level deeper
 *  still. A hard-coded path would work for the repository it was written
 *  against and silently find nothing in the next one. */
async function skillFolders(repo: string): Promise<Array<{ name: string; path: string }>> {
  const res = await fetch(`${GITHUB_API()}/repos/${repo}/git/trees/HEAD?recursive=1`, {
    headers: { accept: 'application/vnd.github+json' },
  }).catch(() => null)
  if (!res?.ok) {
    throw new SkillSourceError(
      res?.status === 404 ? `No such repository: ${repo}.` : `GitHub did not answer for ${repo}.`,
      res?.status === 404 ? 404 : 502,
    )
  }
  const body = (await res.json().catch(() => null)) as { tree?: Array<{ path?: unknown; type?: unknown }> } | null
  const paths = (body?.tree ?? [])
    .map((entry) => (typeof entry.path === 'string' ? entry.path : ''))
    .filter((entry) => entry.endsWith('SKILL.md'))
  return paths.map((file) => {
    const dir = file.slice(0, -'SKILL.md'.length).replace(/\/+$/, '')
    return { name: dir ? dir.split('/').pop()! : repo.split('/').pop()!, path: dir }
  })
}

/** Install one offered skill onto this machine.
 *
 *  Everything in its folder, not only the prose: a skill's SKILL.md routinely
 *  tells the model to run a script sitting beside it, so a copy without those
 *  is a set of instructions pointing at files that are not there. */
export async function installSkillFromSource(sourceId: string, offerId: string, rename?: string): Promise<Skill> {
  const source = (await listSkillSources()).find((entry) => entry.id === sourceId)
  if (!source) throw new SkillSourceError('No such source on this machine.', 404)

  /**
   *
   * `owner/repo/skill` — the id a directory hands back, and the same shape this
   * builds for a repository source, so one parser serves both.
   *
   **/
  const parts = offerId.split('/').filter(Boolean)
  if (parts.length < 3) throw new SkillSourceError('A skill is addressed as "owner/repo/skill".')
  const repo = `${parts[0]}/${parts[1]}`
  const wanted = parts.slice(2).join('/')

  const folder = (await skillFolders(repo)).find((entry) => entry.name === wanted || entry.path === wanted)
  if (!folder) throw new SkillSourceError(`"${wanted}" is not in ${repo}.`, 404)

  const files = await downloadFolder(repo, folder.path)
  if (!files.some((file) => file.path === 'SKILL.md')) {
    throw new SkillSourceError(`"${wanted}" has no SKILL.md to install.`, 502)
  }
  return await installSkillFiles(rename?.trim() || folder.name, files)
}

async function downloadFolder(repo: string, folder: string): Promise<SkillFile[]> {
  const res = await fetch(`${GITHUB_API()}/repos/${repo}/git/trees/HEAD?recursive=1`, {
    headers: { accept: 'application/vnd.github+json' },
  }).catch(() => null)
  if (!res?.ok) throw new SkillSourceError(`GitHub did not answer for ${repo}.`, 502)
  const body = (await res.json().catch(() => null)) as { tree?: Array<{ path?: unknown; type?: unknown }> } | null
  const prefix = folder ? `${folder}/` : ''
  const wanted = (body?.tree ?? [])
    .filter((entry) => entry.type === 'blob')
    .map((entry) => (typeof entry.path === 'string' ? entry.path : ''))
    .filter((path) => path.startsWith(prefix))

  const files: SkillFile[] = []
  for (const path of wanted) {
    const file = await fetch(`${GITHUB_RAW()}/${repo}/HEAD/${path}`).catch(() => null)
    if (!file?.ok) continue
    files.push({ path: path.slice(prefix.length), content: await file.text() })
  }
  return files
}
