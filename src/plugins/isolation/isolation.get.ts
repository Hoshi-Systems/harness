import { defineEventHandler } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { measureIsolation } from './isolation.js'

/** What this machine's host can isolate — the probe's own reading, served.
 *
 *  Answers 200 whether or not the probe could run: "this machine cannot
 *  measure" is a reading too, and the surface that shows it needs to say so
 *  rather than render an error. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return await measureIsolation()
})
