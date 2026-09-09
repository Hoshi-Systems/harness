import type { H3Event } from 'h3'
import { readBody } from 'h3'
import { apiError } from './api-error.js'

/** readBody that never explodes: an empty or malformed JSON body becomes {},
 *  so route validation returns its intended 400 instead of a destructure 500. */
export async function readJsonBody<T extends object>(event: H3Event): Promise<Partial<T>> {
  const body = await readBody<T>(event).catch(() => null)
  return (body && typeof body === 'object' ? body : {}) as Partial<T>
}

/** An optional Platform checkout id riding along on a machine-side record
 *  (schedule, webhook, usage event). Opaque here — the machine has no DB to
 *  authorize it against; the Platform enforces access when the binding
 *  callback lands. */
export function optionalProjectId(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string') {
    apiError(400, 'validation.projectIdString', 'projectId must be a string.')
  }
  return value
}
