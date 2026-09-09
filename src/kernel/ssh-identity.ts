import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * ── The machine's ambient SSH identity ───────────────────────────────────────
 *
 * One general-purpose key at a known path, applied machine-wide through
 * ~/.ssh/config so any clone that carries no more specific credential just
 * works — the way it would on a developer's own laptop. WHO writes it is not
 * the kernel's business (a control plane syncs the owner's account key into
 * it; a person could put their own there). Whether it EXISTS is a local fact
 * two areas decide by: a keyless `git@` clone is worth attempting only if
 * something will answer for it.
 *
 **/

const HOME = process.env.HOME ?? homedir()
export const SSH_DIR = path.join(HOME, '.ssh')
export const AMBIENT_SSH_IDENTITY_KEY = path.join(SSH_DIR, 'hoshi_identity')

/** Whether the machine has a durable, general-purpose SSH identity applied. */
export async function hasAmbientSshIdentity(): Promise<boolean> {
  try {
    await readFile(AMBIENT_SSH_IDENTITY_KEY)
    return true
  } catch {
    return false
  }
}
