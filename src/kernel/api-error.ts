import { createError } from 'h3'

/** Throw an API failure that carries a STABLE machine-readable `code` (plus
 *  optional interpolation params) alongside a human English `message`.
 *
 *  The web client maps the code to a localized string (`errors.<code>`); the
 *  English `message` is the fallback for non-i18n clients and stays the single
 *  source of the wording. H3 serializes `data` into the response body, so the
 *  client reads the code at `error.data.data.code`. Duplicated from the Platform
 *  API on purpose — the two APIs are independently addressable and share no code. */
export function apiError(
  statusCode: number,
  code: string,
  message: string,
  params?: Record<string, string | number>,
): never {
  throw createError({ statusCode, statusMessage: message, data: params ? { code, params } : { code } })
}
