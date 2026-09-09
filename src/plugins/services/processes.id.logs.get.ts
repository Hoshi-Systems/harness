import { defineEventHandler, getQuery, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { DEFAULT_TAIL_LINES, MAX_TAIL_LINES, getProcess, readProcessLogTail } from './processes.js'

/** Recent combined stdout+stderr output for one tracked process — `?tail=` caps
 *  how many trailing lines come back (default {@link DEFAULT_TAIL_LINES}, capped
 *  at {@link MAX_TAIL_LINES}). 404s when the id isn't tracked at all, so the
 *  Processes panel can tell "never existed" apart from "no output yet" (empty
 *  string). */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  const process = await getProcess(id)
  if (!process) {
    apiError(404, 'process.notFound', 'Process not found.')
  }

  const tailRaw = getQuery(event).tail
  let tail = DEFAULT_TAIL_LINES
  if (typeof tailRaw === 'string' && tailRaw.trim()) {
    const parsed = Number(tailRaw)
    if (!Number.isInteger(parsed) || parsed < 1) {
      apiError(400, 'process.tailInvalid', `tail must be a positive integer (max ${MAX_TAIL_LINES}).`)
    }
    tail = Math.min(parsed, MAX_TAIL_LINES)
  }

  return { process, logs: await readProcessLogTail(id, tail) }
})
