import { defineEventHandler, setResponseHeader } from 'h3'
import { apiError, requireAuth, readJsonBody } from '../../kernel/index.js'
import { ttsSynthesize } from './tts-engine.js'
import { encodeWav } from './wav.js'

const MAX_TEXT = 4000

/** Read-aloud — synthesize one message's plain text with Supertonic-3 and hand
 *  back a WAV file. One-shot per click, not a stream: the whole message is
 *  short enough (a few paragraphs, capped below) that non-streaming synthesis
 *  is a sub-few-seconds wait, not worth the complexity of chunked/incremental
 *  audio for this first pass. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{ text?: unknown; lang?: unknown }>(event)

  if (typeof body.text !== 'string' || !body.text.trim()) {
    apiError(400, 'voice.textRequired', 'text must be a non-empty string.')
  }
  const text = (body.text as string).trim()
  if (text.length > MAX_TEXT) {
    apiError(400, 'voice.textTooLong', `text must be at most ${MAX_TEXT} characters.`, { max: MAX_TEXT })
  }

  const lang = typeof body.lang === 'string' && body.lang.trim() ? body.lang.trim() : undefined

  const audio = await ttsSynthesize(text, lang)
  const wav = encodeWav(audio.samples, audio.sampleRate)

  setResponseHeader(event, 'content-type', 'audio/wav')
  setResponseHeader(event, 'content-length', wav.byteLength)
  return wav
})
