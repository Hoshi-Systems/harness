import { defineEventHandler } from 'h3'
import { apiError, requireAuth, readJsonBody, removeCheckoutMetaByDirectory, removeCheckout } from '../kernel/index.js'

/** Bulk-remove checkout directories on machine teardown — the on-disk
 *  counterpart to the Platform destroying a machine. The static driver shares one
 *  `/workspace` across a user's machines and can't wipe a volume, so a torn-down
 *  machine's checkout dirs would otherwise resurface as untracked on the next
 *  scan. The Platform passes exactly the deleted machine's directories; we remove
 *  only those (each guarded by `isCheckoutDir`) — never a blind tree wipe. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{ directories?: unknown }>(event)
  const directories = Array.isArray(body.directories)
    ? body.directories.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
    : null
  if (!directories) {
    apiError(400, 'workspace.directoriesRequired', 'A list of checkout directories is required.')
  }
  for (const directory of directories) {
    try {
      await removeCheckout(directory.trim())
      await removeCheckoutMetaByDirectory(directory.trim())
    } catch (error) {
      /**
       *
       * Best-effort teardown: a path that isn't a valid checkout, or is already
       * gone, must not abort the rest of the wipe.
       *
       **/
      console.error(`[workspace] cleanup failed for ${directory}:`, error)
    }
  }
  return { ok: true }
})
