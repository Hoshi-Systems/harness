import { existsSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 *
 * Checkouts are cloned to /workspace/<org-slug>/<project-slug> (Platform's
 * checkoutDirectory()). The env var overrides; otherwise /workspace (the durable
 * volume on a real machine image) — and when that doesn't exist (local native
 * dev), ~/.hoshi-workspace, so provisioning works outside a machine image.
 * Mirrored by the Platform's checkoutDirectory() (apps/api/services/checkouts.ts).
 *
 **/
export function defaultWorkspaceRoot(): string {
  return process.env.WORKSPACE_ROOT ?? (existsSync('/workspace') ? '/workspace' : path.join(homedir(), '.hoshi-workspace'))
}

/** Mutable only while the one process-wide harness is running. Exporting a
 * live binding keeps existing kernel modules honest about the configured root. */
export let WORKSPACE_ROOT = defaultWorkspaceRoot()

export function configureWorkspaceRoot(root: string): void {
  WORKSPACE_ROOT = path.resolve(root)
}

export function resetWorkspaceRoot(): void {
  WORKSPACE_ROOT = defaultWorkspaceRoot()
}

/** A project directory that physically exists on this machine. `directory` is
 *  the join key back to the Platform's checkout rows. */
export interface MachineProject {
  directory: string
  name: string
  org: string
  git: boolean
  mtime: number
}

/** The authoritative list of projects on this machine: a two-level scan of the
 *  workspace tree (`<org>/<project>`). This — not OpenCode's project list — is
 *  the source of truth, because provisioning clones a directory without ever
 *  registering a worktree with OpenCode. A missing root means a fresh machine
 *  with no checkouts yet, which is an empty list, not a failure. */
export async function scanWorkspace(): Promise<MachineProject[]> {
  const orgs = await listDirs(WORKSPACE_ROOT)
  const projects: MachineProject[] = []
  for (const org of orgs) {
    const orgPath = path.join(WORKSPACE_ROOT, org)
    for (const name of await listDirs(orgPath)) {
      const directory = path.join(orgPath, name)
      projects.push({
        directory,
        name,
        org,
        git: await exists(path.join(directory, '.git')),
        mtime: await mtimeMs(directory),
      })
    }
  }
  return projects
}

/** Immediate sub-directory names, skipping dotfiles. ENOENT → []. */
async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function mtimeMs(target: string): Promise<number> {
  try {
    return (await stat(target)).mtimeMs
  } catch {
    return 0
  }
}

/** The resolved workspace root — the personal scope's own working folder. */
export function workspaceRoot(): string {
  return path.resolve(WORKSPACE_ROOT)
}

/** A path is a removable checkout only when it's exactly `<root>/<org>/<project>`
 *  — a two-level child of the workspace root. This refuses path traversal,
 *  absolute paths elsewhere, and the org/root directories themselves. */
export function isCheckoutDir(target: string): boolean {
  const root = path.resolve(WORKSPACE_ROOT)
  const resolved = path.resolve(target)
  if (!resolved.startsWith(root + path.sep)) return false
  const rel = path.relative(root, resolved)
  return !rel.startsWith('..') && rel.split(path.sep).length === 2
}

/** Remove a checkout directory from the workspace. Refuses anything that isn't a
 *  two-level checkout dir; a missing directory is a no-op (already gone). */
export async function removeCheckout(directory: string): Promise<void> {
  if (!isCheckoutDir(directory)) {
    throw new Error('Refusing to remove a path that is not a checkout directory.')
  }
  await rm(directory, { recursive: true, force: true })
}
