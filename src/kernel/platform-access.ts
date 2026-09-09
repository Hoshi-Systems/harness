import { ports } from './host-ports.js'

/**
 * ── Reaching the Platform ────────────────────────────────────────────────────
 *
 * A machine calls the Platform API as its OWNER: the provisioner injects that
 * user's PAT. Every org capability check on the far side therefore applies to
 * the owner — which is what makes "only an admin can publish to the org
 * library" true without this plugin knowing anything about roles.
 *
 * Read through the kernel's port rather than the environment: whether this
 * machine belongs to an organization at all is exactly the fact a plugin must
 * not assume (kernel/ports.ts).
 *
 * This lives in the kernel because nine plugins needed it and the plugin
 * contract forbids them importing each other — so each had grown a
 * byte-identical copy, and the rule was being kept by duplication
 * (docs/STRUCTURE_REVIEW.md H-03). The barrel exports these two accessors and
 * still withholds `ports()` itself, which is the seam that mattered.
 *
 **/
export function platform() {
  return ports().platform?.() ?? null
}

export async function readPlatformErrorMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { statusMessage?: unknown; message?: unknown }
    const message = body?.statusMessage ?? body?.message
    return typeof message === 'string' && message.trim() ? message.trim() : null
  } catch {
    return null
  }
}
