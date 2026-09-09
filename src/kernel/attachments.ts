import type { ModelMessage } from 'ai'

/**
 * ── Files a person attached to a message ─────────────────────────────────────
 *
 * The composer has always let people attach files, shown them in the bubble,
 * and then dropped them: the machine's message route took `text` and nothing
 * else. The model went looking for the document on disk, did not find it, and
 * said so — which reads as the agent ignoring you.
 *
 * A file arrives as a data URL, because that is what a browser has after a
 * file picker and it needs no upload endpoint, no storage, and no cleanup for
 * something whose whole life is one request.
 *
 **/

/** What a client sends alongside the text. */
export interface OutgoingFile {
  filename: string
  mime: string
  /** `data:<mime>;base64,<payload>` — inline, self-contained. */
  url: string
}

/**
 * ── What actually limits an attachment ───────────────────────────────────────
 *
 * There used to be one number for everything: 4MB, whatever the file was and
 * whatever the model could take. It measured nothing. 4MB of PNG is an ordinary
 * retina screenshot that most models read without blinking; 4MB of log is
 * roughly a million tokens and fits in no context window that exists. One cap
 * was simultaneously too mean for pictures and far too generous for text.
 *
 * So the two are limited by the thing that actually constrains each:
 *
 *   TEXT   goes INTO the prompt, so its limit is the model's context window —
 *          which the machine already knows per model. A file is refused when it
 *          would eat more of the window than the conversation could survive,
 *          and a bigger model genuinely accepts a bigger file.
 *   IMAGES are bounded by the provider, not by us. The strictest real limit
 *          among the majors is 5MB per image; the others allow far more. We use
 *          the strict one as the default because a refusal we explain beats a
 *          provider error nobody can act on — and it is overridable, because an
 *          operator who knows their provider takes 20MB should not be argued
 *          with by a constant in our source.
 *
 * Refused loudly either way, never truncated: half a document answers the wrong
 * question.
 *
 **/

/** Bytes per token, near enough for a budget check: about four for ordinary
 *  prose, fewer for dense code or non-Latin text.
 *
 *  Guessing LOW is the mistake to avoid. A pessimistic figure does not make the
 *  machine safer — the provider is the one that enforces the real window — it
 *  just refuses documents that would have fitted, which is the whole complaint
 *  this replaced. Over-estimating costs at worst one provider error; under-
 *  estimating costs the feature. */
const BYTES_PER_TOKEN = 4

/** How much of the model's window one message's text attachments may claim.
 *  The rest is for the conversation, the system prompt and the answer — a file
 *  that fills the window leaves no room to reply to it. */
const WINDOW_SHARE = 0.5

/** Per image. Overridable: `HOSHI_MAX_IMAGE_BYTES=20971520` for a provider that
 *  takes more than the strictest of the majors. */
export const MAX_IMAGE_BYTES = Number(process.env.HOSHI_MAX_IMAGE_BYTES) || 5 * 1024 * 1024

/** The ceiling on text when the model's window is unknown — a custom endpoint
 *  that publishes no context length. Generous, because "unknown" must not mean
 *  "assume the worst": the provider will say if it is too much. */
const TEXT_FALLBACK_BYTES = 4 * 1024 * 1024

/** How many bytes of text this model can be handed in one message. */
export function textBudgetFor(contextLimit: number | undefined): number {
  if (!contextLimit) return TEXT_FALLBACK_BYTES
  return Math.floor(contextLimit * WINDOW_SHARE * BYTES_PER_TOKEN)
}

/** The window said the way a person talks about it. */
function model_window(contextLimit: number): string {
  return contextLimit >= 1000 ? `a ${Math.round(contextLimit / 1000)}k context window` : `${contextLimit} tokens`
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

export class AttachmentTooLargeError extends Error {}

/** Anything whose bytes are text a model can simply read. Inlined rather than
 *  handed over as a file part: every provider understands text, while file
 *  parts are a capability that varies by model, and a document silently
 *  dropped by the provider is the exact failure this whole change exists to
 *  remove. */
function isTextual(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    /^application\/(json|xml|yaml|x-yaml|toml|javascript|typescript|sql|x-sh)$/.test(mime) ||
    /\+(json|xml)$/.test(mime)
  )
}

function decode(url: string): { bytes: Buffer; mime: string } | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url)
  if (!match) return null
  const [, mime, base64, payload] = match
  const bytes = base64 ? Buffer.from(payload!, 'base64') : Buffer.from(decodeURIComponent(payload!), 'utf8')
  return { bytes, mime: mime || 'application/octet-stream' }
}

/** The user turn as the model receives it: the person's words, and their files
 *  as content parts beside them.
 *
 *  Returns a plain string when nothing is attached, so an ordinary turn is
 *  byte-for-byte what it was before this existed. */
export function buildUserMessage(
  text: string,
  files: OutgoingFile[],
  { acceptsImages = true, contextLimit }: { acceptsImages?: boolean; contextLimit?: number } = {},
): string | ModelMessage[] {
  if (files.length === 0) return text

  /** Text shares one budget across the message: three 2MB logs are 6MB of
   *  window whatever their individual sizes. Images are judged one at a time,
   *  because that is how the provider judges them. */
  let textBudget = textBudgetFor(contextLimit)
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; image: string }
    | { type: 'file'; data: Buffer; mediaType: string }
  > = []

  for (const file of files) {
    const decoded = decode(file.url)
    if (!decoded) continue
    const mime = file.mime || decoded.mime
    const size = decoded.bytes.byteLength

    if (mime.startsWith('image/') && size > MAX_IMAGE_BYTES) {
      throw new AttachmentTooLargeError(
        `${file.filename} is ${megabytes(size)}; images are limited to ${megabytes(MAX_IMAGE_BYTES)} — ` +
          'set HOSHI_MAX_IMAGE_BYTES if this provider accepts more.',
      )
    }
    if (!mime.startsWith('image/')) {
      textBudget -= size
      if (textBudget < 0) {
        throw new AttachmentTooLargeError(
          contextLimit
            ? `${file.filename} does not fit: this message may carry about ${megabytes(textBudgetFor(contextLimit))} ` +
                `of text into ${model_window(contextLimit)}, and the attachments together exceed it.`
            : `${file.filename} does not fit: a message may carry about ${megabytes(TEXT_FALLBACK_BYTES)} of text.`,
        )
      }
    }

    if (mime.startsWith('image/')) {
      /**
       *
       * A model that cannot be given a picture is told, in words, that one was
       * attached. Handing it the image part instead is not a degraded answer,
       * it is a REFUSED REQUEST: the provider rejects the message outright
       * ("unknown variant `image_url`, expected `text`"), and since the picture
       * then lives in the conversation, every following turn in that session
       * dies on the same error. One sentence keeps the session alive and lets
       * the model say what it cannot do, which is the honest answer anyway.
       *
       **/
      if (!acceptsImages) {
        content.push({
          type: 'text',
          text: `<file name="${file.filename}" type="${mime}">The user attached this image. This model cannot read images, so its contents are unavailable — say so rather than guessing at what it shows.</file>`,
        })
        continue
      }
      content.push({ type: 'image', image: file.url })
      continue
    }
    if (isTextual(mime)) {
      /**
       *
       * Named, because "what is in the file I attached" is a question about a
       * file: a model handed a bare wall of text cannot say where it came from.
       *
       **/
      content.push({ type: 'text', text: `<file name="${file.filename}">\n${decoded.bytes.toString('utf8')}\n</file>` })
      continue
    }
    content.push({ type: 'file', data: decoded.bytes, mediaType: mime })
  }

  if (content.length === 0) return text
  /**
   *
   * The words last: the attachments are context for the question, and a model
   * reading in order should meet the question after the material it is about.
   * Omitted entirely when there are none — a picture sent on its own is a
   * message, and an empty text part beside it is a blank line the model has to
   * interpret.
   *
   **/
  const words = text.trim()
  return [{ role: 'user', content: words ? [...content, { type: 'text', text }] : content }]
}
