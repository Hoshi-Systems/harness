import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import {
  requireAuth,
  isReasoningEffort,
  apiError,
  readJsonBody,
  getSession,
  ModelUnavailableError,
  AttachmentTooLargeError,
  sendMessage,
  setSessionActor,
  SpendBlockedError,
  TurnBusyError,
} from '../kernel/index.js'
import { ports } from '../kernel/host-ports.js'

/** Send a message. Answers 202 as soon as the turn is RUNNING — the reply
 *  arrives on the stream, never on this response. A call that blocked until the
 *  model finished could not show a token as it arrived and would tie the turn's
 *  life to one connection (docs/MACHINE_WIRE.md). */
export default defineEventHandler(async (event) => {
  const caller = await requireAuth(event)
  const id = getRouterParam(event, 'id') ?? ''
  if (!(await getSession(id))) apiError(404, 'session.notFound', 'No such session on this machine.')

  const body = await readJsonBody<{
    text?: unknown
    model?: unknown
    agent?: unknown
    effort?: unknown
    files?: unknown
    links?: unknown
  }>(event)
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  const model = typeof body.model === 'string' && body.model ? body.model : undefined
  const agent = typeof body.agent === 'string' && body.agent ? body.agent : undefined
  /**
   *
   * How hard to think, for THIS question. An unknown value is ignored rather
   * than refused: the effort is a preference about quality, and a turn is not
   * worth failing over one — the machine's own default takes over.
   *
   **/
  const effort = isReasoningEffort(body.effort) ? body.effort : undefined
  /**
   *
   * Attachments ride WITH the message: they are part of the question, and a
   * second request to upload them would leave a window where the turn has
   * started without them.
   *
   **/
  const files = Array.isArray(body.files)
    ? body.files
        .filter((file): file is Record<string, unknown> => !!file && typeof file === 'object')
        .map((file) => ({
          filename: typeof file.filename === 'string' ? file.filename : 'attachment',
          mime: typeof file.mime === 'string' ? file.mime : 'application/octet-stream',
          url: typeof file.url === 'string' ? file.url : '',
        }))
        .filter((file) => file.url.startsWith('data:'))
    : []

  /**
   *
   * Text OR files — an attachment on its own is a message. "Look at this" is a
   * complete thing to say, and the composer has always let a person send one:
   * it enables Send as soon as anything is staged. This route did not, so that
   * send came back 400 and the picture stayed on screen with no way to hand it
   * over — the client offering something the machine refuses.
   *
   **/
  if (!text && files.length === 0) {
    apiError(400, 'message.empty', 'A message needs text, a file, or both.')
  }

  /**
   *
   * WHO is prompting, recorded before the turn starts.
   *
   * The org audit trail stamps every action with the user who caused it, and
   * falls back to the machine's owner when it does not know. That fallback is
   * the whole reason this exists: a guest's prompt — and every tool call it
   * causes — attributed to the owner is worse than no trail, because it is
   * confidently wrong about the only question an audit is asked.
   *
   * It was written on every prompt the retired proxy admitted. The move into
   * this package left `setSessionActor` exported and uncalled, so the registry
   * was write-never/read-always and every guest action in the trail carried the
   * owner's name (docs/STRUCTURE_REVIEW.md H-10). Recorded for the owner too,
   * so a session an owner takes back stops attributing to the guest who last
   * touched it.
   *
   **/
  setSessionActor(id, caller.userId)

  /**
   *
   * Context links a person passed into this conversation, spent here.
   *
   * Expanded MACHINE-SIDE and prepended to the text, so the transcript and the
   * model see the same thing and no client has to be trusted to render it. What
   * that costs is the grade's business: a `quote` spends its excerpt now, a
   * `link` spends one line and leaves the rest behind `context_open`.
   *
   * Refused rather than dropped. A link the machine cannot expand — an unknown
   * id, or one passed to a different session — means the question is about
   * something this message will not contain, and sending it anyway asks the
   * model about a passage it was never shown.
   *
   **/
  const linkIds = Array.isArray(body.links) ? body.links.filter((id): id is string => typeof id === 'string') : []
  let prelude = ''
  if (linkIds.length > 0) {
    const expand = ports().contextLinks?.()
    if (!expand) apiError(501, 'link.unsupported', 'this machine does not carry context links.')
    const expanded = await expand.expand(id, linkIds)
    if ('error' in expanded) apiError(400, 'link.invalid', expanded.error)
    else prelude = expanded.text
  }

  try {
    const { messageId } = await sendMessage(id, { text: `${prelude}${text}`, model, agent, effort, files })
    setResponseStatus(event, 202)
    return { messageId }
  } catch (error) {
    if (error instanceof AttachmentTooLargeError) apiError(413, 'message.attachmentTooLarge', error.message)
    if (error instanceof TurnBusyError) apiError(409, 'session.busy', error.message)
    if (error instanceof SpendBlockedError) apiError(402, 'budget.exceeded', error.message)
    if (error instanceof ModelUnavailableError) {
      apiError(error.problem === 'needs-key' ? 400 : 404, `model.${error.problem}`, error.message)
    }
    throw error
  }
})
