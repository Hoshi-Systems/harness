import { defineEventHandler } from 'h3'
import { apiError, requireAuth, readJsonBody, publishMachineEvent } from '../../kernel/index.js'
import { createLink, LinkInputError, type LinkGrade } from './links.js'

/** Pass a passage of one conversation into another.
 *
 *  The excerpt is read from the source transcript, never taken from the body:
 *  a caller who could name its own excerpt could put words in a task's mouth,
 *  and the range would sit there proving otherwise. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{
    from?: { session?: unknown; turn?: unknown; range?: unknown; match?: unknown }
    to?: unknown
    grade?: unknown
  }>(event)

  const fromSession = typeof body.from?.session === 'string' ? body.from.session : ''
  const turn = typeof body.from?.turn === 'string' ? body.from.turn : ''
  const to = typeof body.to === 'string' ? body.to : ''
  const range = body.from?.range
  const match = typeof body.from?.match === 'string' ? body.from.match : undefined
  if (!fromSession || !turn || !to) apiError(400, 'link.incomplete', 'from.session, from.turn and to are required.')
  /**
   *
   * A range OR the selected text. A client rendering markdown cannot compute
   * the former — what is on screen is a different string from the one stored,
   * because a heading lost its hashes and a list gained its bullets — so it
   * sends what the person selected and the machine locates it. The excerpt is
   * still sliced out of the transcript either way.
   *
   **/
  const hasRange = Array.isArray(range) && range.length === 2
  if (!hasRange && !match) apiError(400, 'link.whereRequired', 'from.range or from.match is required.')

  /**
   *
   * `link` is the default, and that is the feature rather than a convenience:
   * the cheap grade is what a caller gets when it does not say, so the
   * expensive one has to be asked for on purpose.
   *
   **/
  const grade: LinkGrade = body.grade === 'quote' ? 'quote' : 'link'

  try {
    const link = await createLink({
      fromSession,
      turn,
      ...(hasRange ? { range: [Number(range[0]), Number(range[1])] as [number, number] } : { match }),
      to,
      grade,
    })
    /**
     *
     * Published so a view of the SOURCE already open grows its "referenced
     * elsewhere" marker without being reloaded — the edge is two-way, and a
     * client should not have to ask to find that out.
     *
     **/
    publishMachineEvent('context.linked', { link })
    return { link }
  } catch (error) {
    if (error instanceof LinkInputError) apiError(400, 'link.invalid', error.message)
    throw error
  }
})
