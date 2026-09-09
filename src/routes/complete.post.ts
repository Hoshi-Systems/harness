import { defineEventHandler } from 'h3'
import { apiError, requireAuth, readJsonBody, complete, ModelUnavailableError } from '../kernel/index.js'

/** Ask a model one question. No session, no tools, no history, nothing kept.
 *
 *  For the places a client needs a model to write a sentence rather than to
 *  hold a conversation — drafting an agent's description, naming something.
 *  Those used to create a throwaway session, prompt it, read the reply and
 *  delete it again, which put a stray thread in the user's session list every
 *  time the cleanup failed. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{ prompt?: unknown; system?: unknown; model?: unknown }>(event)
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) apiError(400, 'complete.promptRequired', 'prompt is required.')

  try {
    return {
      text: await complete(prompt, {
        ...(typeof body.system === 'string' && body.system ? { system: body.system } : {}),
        ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
      }),
    }
  } catch (error) {
    if (error instanceof ModelUnavailableError) {
      apiError(error.problem === 'needs-key' ? 400 : 404, `model.${error.problem}`, error.message)
    }
    throw error
  }
})
