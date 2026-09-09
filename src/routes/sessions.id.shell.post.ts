import { defineEventHandler, getRouterParam } from 'h3'
import { randomUUID } from 'node:crypto'
import { NodeShellProvider } from '@openharness/core'
import {
  apiError,
  requireAuth,
  readJsonBody,
  publishMachineEvent,
  appendMessage,
  getSession,
  touchSession,
} from '../kernel/index.js'

/** Run a shell command in a session's directory and put it in the conversation.
 *
 *  This is the composer's `!command`: the USER wants to run something, not to
 *  ask an agent to run something. So no model is called and no turn starts —
 *  which is the whole appeal, since it is immediate and costs nothing. The
 *  command and its output land in the transcript, so the next thing the model is
 *  asked has them in view, exactly as if they had been pasted in.
 *
 *  Deliberately NOT the bash tool's path, and so deliberately not subject to the
 *  tool permission levels: those exist to gate what an AGENT does unattended.
 *  A person typing a command into their own machine has already decided.
 *
 *  It is refused in a CHAT, and that is not the same rule. A chat promises to
 *  change nothing — which is why it needs no permissions and has no Computer
 *  dock to show a result in — and a promise the client keeps by not drawing a
 *  button is not a promise, because this route is one `curl` away. The composer
 *  hides `!` there (that is a courtesy); this is the guarantee. */
const TIMEOUT_MS = 120_000
const OUTPUT_MAX = 30_000

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const sessionId = getRouterParam(event, 'id') ?? ''
  const session = await getSession(sessionId)
  if (!session) apiError(404, 'session.notFound', 'No such session on this machine.')
  if (session.chat) apiError(409, 'shell.notOnChat', 'that session is a chat — a chat runs nothing.')

  const body = await readJsonBody<{ command?: unknown }>(event)
  const command = typeof body.command === 'string' ? body.command.trim() : ''
  if (!command) apiError(400, 'shell.commandRequired', 'command is required.')

  const shell = new NodeShellProvider({ cwd: session.directory })
  let output: string
  let exitCode: number
  try {
    const result = await shell.exec(command, { timeout: TIMEOUT_MS })
    output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    exitCode = result.exitCode ?? 0
  } catch (error) {
    /**
     *
     * A command that could not be started at all still belongs in the
     * transcript — "I ran this and nothing happened" is the confusing outcome.
     *
     **/
    output = error instanceof Error ? error.message : String(error)
    exitCode = -1
  }

  const clipped = output.length > OUTPUT_MAX ? `${output.slice(0, OUTPUT_MAX)}\n… (output truncated)` : output
  const messageId = `msg_${randomUUID().replace(/-/g, '')}`
  await appendMessage(sessionId, {
    id: messageId,
    role: 'user',
    parts: [{ type: 'text', text: transcript(command, clipped, exitCode) }],
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  })
  await touchSession(sessionId)
  publishMachineEvent('message.appended', { sessionId, messageId })

  return { messageId, exitCode, output: clipped }
})

/** How the command reads in the conversation. Fenced, with the exit code stated
 *  when it is not zero — a model shown only the output of a failed command has
 *  to guess whether it failed. */
function transcript(command: string, output: string, exitCode: number): string {
  const status = exitCode === 0 ? '' : `\n(exited ${exitCode})`
  return `\`\`\`sh\n$ ${command}\n\`\`\`\n\n\`\`\`\n${output || '(no output)'}\n\`\`\`${status}`
}
