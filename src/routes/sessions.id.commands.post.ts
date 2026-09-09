import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import {
  apiError,
  requireAuth,
  readJsonBody,
  listCommands,
  getSession,
  ModelUnavailableError,
  sendMessage,
  TurnBusyError,
  isReasoningEffort,
} from '../kernel/index.js'

/** Run one of the machine's saved commands in a session.
 *
 *  The expansion happens HERE, not in the client. A command's template is the
 *  machine's — it can be edited from any client, published by an org, or shipped
 *  in a pack — and four clients each re-implementing `$ARGUMENTS` is four
 *  chances for `/review` to mean something slightly different depending on where
 *  you typed it. The client sends a name and the words after it; the machine
 *  decides what that means. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const sessionId = getRouterParam(event, 'id') ?? ''
  const session = await getSession(sessionId)
  if (!session) apiError(404, 'session.notFound', 'No such session on this machine.')

  const body = await readJsonBody<{
    command?: unknown
    arguments?: unknown
    model?: unknown
    agent?: unknown
    effort?: unknown
  }>(event)
  const name = typeof body.command === 'string' ? body.command.trim() : ''
  if (!name) apiError(400, 'command.nameRequired', 'command is required.')

  /**
   *
   * Resolved against the SESSION's checkout: a project's `/review` is the one
   * this session means, and running the machine's generic one instead would be
   * the wrong prompt under the right name.
   *
   **/
  const command = (await listCommands(session.directory)).find((entry) => entry.name === name)
  if (!command) apiError(404, 'command.notFound', `This machine has no "${name}" command.`)

  const args = typeof body.arguments === 'string' ? body.arguments.trim() : ''
  try {
    const { messageId } = await sendMessage(sessionId, {
      text: expand(command.template, args),
      /**
       *
       * The thread shows what was typed, not what it expanded to — the same
       * thing every client puts in the bubble the moment the command is sent,
       * so a reload does not rewrite the conversation into something the person
       * never wrote.
       *
       **/
      display: `/${name}${args ? ` ${args}` : ''}`,
      ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
      /**
       *
       * A command is a shortcut for a prompt, so it runs as whatever agent the
       * person has chosen — running it as the default instead would silently
       * give a command more (or less) than the agent beside it in the composer.
       *
       **/
      ...(typeof body.agent === 'string' && body.agent ? { agent: body.agent } : {}),
      /**
       *
       * And the same effort the composer had chosen — a command is a shortcut
       * for a prompt, so it should think exactly as hard as typing that prompt
       * would have.
       *
       **/
      ...(isReasoningEffort(body.effort) ? { effort: body.effort } : {}),
    })
    setResponseStatus(event, 202)
    return { messageId }
  } catch (error) {
    if (error instanceof TurnBusyError) apiError(409, 'session.busy', error.message)
    if (error instanceof ModelUnavailableError) {
      apiError(error.problem === 'needs-key' ? 400 : 404, `model.${error.problem}`, error.message)
    }
    throw error
  }
})

/** Substitute the words the user typed after the command name.
 *
 *  `$ARGUMENTS` where the template asks for them; appended on its own line when
 *  it doesn't, so a template written without the placeholder still receives what
 *  was typed rather than silently discarding it. */
function expand(template: string, args: string): string {
  if (template.includes('$ARGUMENTS')) return template.replaceAll('$ARGUMENTS', args)
  return args ? `${template}\n\n${args}` : template
}
