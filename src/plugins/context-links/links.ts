import { randomUUID } from 'node:crypto'
import { createCachedStore, getSession, readMessages, type MessagePart } from '../../kernel/index.js'

/**
 * ── A passage of one conversation, carried into another ──────────────────────
 *
 * A chat exists so a question can be asked without spending the task's context
 * on it. That is only worth having if a piece of the task can get INTO the
 * chat, and the answer can get back — and copy-paste cannot do either. It moves
 * the text and loses everything else: which session it came from, which turn,
 * whether there is more, and whether anybody ever answered. A pasted string
 * cannot be followed in either direction.
 *
 * So a link ADDRESSES rather than copies: a session, a turn, and a range within
 * that turn. Both ends are plain session ids and session ids are machine-wide,
 * so a link crosses projects with no special case — and nothing fences it,
 * which is a decision rather than an oversight.
 *
 * `excerpt` is stored anyway, and that redundancy is the point: a chat can
 * outlive the task it came from, and a pure pointer would degrade to NOTHING on
 * the day the source is deleted. Keeping the text means it degrades to a quote
 * instead — the reader still sees what was said, and only "open the rest of it"
 * stops working.
 *
 **/

/** How a link is delivered into the receiving conversation.
 *
 *  The two exist because the whole reason to pass context rather than continue
 *  in place is what it COSTS. A `quote` is the text, inlined once, with nothing
 *  to resolve and nothing more to reach. A `link` is a handle: a short line the
 *  receiving turn can expand with `context_open` only if the rest turns out to
 *  matter. Which one was chosen is a property of the link, not a rendering
 *  choice a client makes later. */
export type LinkGrade = 'link' | 'quote'

export interface ContextLink {
  id: string
  from: {
    /** Any session on the machine — including a sub-agent's, buried inside
     *  another task's tree. Which is why a client's chip says the TASK's name
     *  while this holds the session's id: the task is the name a person knows
     *  it by, the session is the thing that can actually be reopened. */
    session: string
    turn: string
    /** Character range within the turn's text, as [start, end). */
    range: [number, number]
  }
  to: string
  grade: LinkGrade
  excerpt: string
  createdAt: string
}

interface LinkFile {
  links: ContextLink[]
}

/** Longer than this and the excerpt stops being a quote and starts being a
 *  copy of the transcript — which is the thing a link exists not to be. */
const EXCERPT_MAX = 2_000

const store = createCachedStore<LinkFile>('context-links.json', (stored) => {
  const links = (stored as LinkFile | null)?.links
  return { links: Array.isArray(links) ? links.filter(isLink) : [] }
})

function isLink(value: unknown): value is ContextLink {
  const link = value as ContextLink | null
  return (
    !!link &&
    typeof link.id === 'string' &&
    typeof link.to === 'string' &&
    typeof link.excerpt === 'string' &&
    !!link.from &&
    typeof link.from.session === 'string' &&
    typeof link.from.turn === 'string' &&
    Array.isArray(link.from.range)
  )
}

/** A turn as one string, which is what a character range is a range INTO.
 *
 *  Text and reasoning only. A range that could land inside a tool call's output
 *  would address bytes the person never saw on screen and could not have
 *  selected, so the offsets a client sends and the offsets this reads have to
 *  be over the same thing. */
function turnText(parts: MessagePart[]): string {
  return parts
    .filter((part): part is Extract<MessagePart, { type: 'text' | 'reasoning' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

/** Find a selected passage in the turn it came out of.
 *
 *  Exact first, then whitespace-insensitive — a selection crossing a rendered
 *  line break comes back with a space where the source has a newline, and
 *  refusing over that would make the feature fail on exactly the passages
 *  people most want to pass (the long ones). */
function locate(text: string, match: string): [number, number] | null {
  const needle = match.trim()
  if (!needle) return null

  const exact = text.indexOf(needle)
  if (exact !== -1) return [exact, exact + needle.length]

  const pattern = needle
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+')
  const loose = new RegExp(pattern).exec(text)
  return loose ? [loose.index, loose.index + loose[0].length] : null
}

export class LinkInputError extends Error {}

export interface CreateLinkInput {
  fromSession: string
  turn: string
  to: string
  grade: LinkGrade
  /** Where in the turn, as a character range into its text. */
  range?: [number, number]
  /** Or: the text a person actually selected, which the machine locates for
   *  itself.
   *
   *  Offered because a client CANNOT compute the range reliably. What is on
   *  screen is rendered markdown — a heading lost its hashes, a list gained
   *  bullets, a code fence became a block — so a character offset into the DOM
   *  is an offset into a different string than the one stored. Matching the
   *  text and deriving the range here keeps the address exact without asking
   *  the client to reverse the renderer.
   *
   *  It does NOT let a caller supply its own excerpt: the range is derived and
   *  the excerpt is still sliced out of the transcript, so a `match` that is not
   *  in the turn is refused rather than quoted. */
  match?: string
}

/**
 * Record a passage being passed from one session to another.
 *
 * The excerpt is read from the SOURCE TRANSCRIPT rather than accepted from the
 * caller. A client that could name its own excerpt could put words in a task's
 * mouth: the receiving conversation would show a quote attributed to a session
 * that never said it, and the link would point at a range proving otherwise.
 */
export async function createLink(input: CreateLinkInput): Promise<ContextLink> {
  if (!(await getSession(input.fromSession))) throw new LinkInputError('no such source session on this machine.')
  if (!(await getSession(input.to))) throw new LinkInputError('no such destination session on this machine.')

  const messages = await readMessages(input.fromSession)
  const turn = messages.find((message) => message.id === input.turn)
  if (!turn) throw new LinkInputError('no such turn in that session.')

  const text = turnText(turn.parts)
  const located = input.range ?? locate(text, input.match ?? '')
  if (!located) throw new LinkInputError('that passage is not in the source turn.')
  const [start, end] = located
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    throw new LinkInputError('range must be [start, end) with end greater than start.')
  }
  const excerpt = text.slice(start, Math.min(end, start + EXCERPT_MAX)).trim()
  if (!excerpt) throw new LinkInputError('that range is empty in the source turn.')

  const link: ContextLink = {
    id: `lnk_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    from: { session: input.fromSession, turn: input.turn, range: [start, end] },
    to: input.to,
    grade: input.grade,
    excerpt,
    createdAt: new Date().toISOString(),
  }

  const file = await store.load()
  file.links.push(link)
  store.persist()
  return link
}

/** Every link touching a session, from EITHER end.
 *
 *  Both directions on purpose: the receiving side asks "where did this come
 *  from", and the source side asks "what came of this" — and an edge that can
 *  only be read from one end is a paste with extra steps. */
export async function linksForSession(sessionId: string): Promise<ContextLink[]> {
  const { links } = await store.load()
  return links.filter((link) => link.to === sessionId || link.from.session === sessionId)
}

async function getLink(id: string): Promise<ContextLink | null> {
  const { links } = await store.load()
  return links.find((link) => link.id === id) ?? null
}

export async function deleteLink(id: string): Promise<boolean> {
  const file = await store.load()
  const before = file.links.length
  file.links = file.links.filter((link) => link.id !== id)
  if (file.links.length === before) return false
  store.persist()
  return true
}

/** Drop every link into or out of a session that no longer exists. Called when
 *  a session is deleted, so the store does not accumulate edges to nothing —
 *  the EXCERPT is what survives a deleted source, not the link itself. */
export async function forgetSession(sessionId: string): Promise<void> {
  const file = await store.load()
  const before = file.links.length
  file.links = file.links.filter((link) => link.to !== sessionId)
  if (file.links.length !== before) store.persist()
}

/**
 * What a message carrying links puts in front of its own text.
 *
 * Machine-side, so every client and the transcript agree on what the model was
 * actually shown. A `quote` spends its excerpt here and is done; a `link`
 * spends one line and leaves the rest behind `context_open`, which is the whole
 * difference the two grades exist to express.
 */
export async function expandLinks(toSessionId: string, ids: string[]): Promise<{ text: string } | { error: string }> {
  if (ids.length === 0) return { text: '' }

  const lines: string[] = []
  let anyReference = false
  for (const id of ids) {
    const link = await getLink(id)
    if (!link) return { error: `no such context link: ${id}` }
    /**
     *
     * A link may only be spent by the session it was passed to. Without this a
     * caller could name any link id and read a passage out of a conversation it
     * was never given — the store is machine-wide, so the id is the only thing
     * standing between one session's transcript and another.
     *
     **/
    if (link.to !== toSessionId) return { error: `context link ${id} was not passed to this session` }

    const source = await getSession(link.from.session)
    const title = source?.title ?? 'another conversation'
    if (link.grade === 'quote') {
      lines.push(`[context ${link.id} — quoted from "${title}"]\n> ${link.excerpt.split('\n').join('\n> ')}`)
    } else {
      anyReference = true
      lines.push(`[context ${link.id} — from "${title}": "${teaser(link.excerpt)}"]`)
    }
  }
  /**
   *
   * The instruction is written ONCE for the whole message, however many
   * references it carries. Repeating it per link is how a reference stopped
   * being the cheap grade: at a short passage the sentence explaining the
   * handle outweighed the passage it was standing in for, and a `link` cost
   * more than the `quote` it exists to be cheaper than.
   *
   **/
  if (anyReference) lines.push('(Read any of the above in full with context_open("<id>").)')
  return { text: `${lines.join('\n')}\n\n` }
}

/** Enough of the passage to recognise it, and no more.
 *
 *  A reference that previewed generously stopped being a reference: its cost
 *  grew with the passage, which is the one property it exists not to have. */
function teaser(excerpt: string): string {
  const flat = excerpt.replace(/\s+/g, ' ').trim()
  return flat.length > 72 ? `${flat.slice(0, 69)}…` : flat
}

/** The passage a link addresses, plus the whole turn it came out of.
 *
 *  The turn, not just the range, is what makes a link worth more than a quote:
 *  the receiving agent asked for this because the excerpt was not enough. */
export async function readLink(
  id: string,
  callerSessionId: string,
): Promise<{ excerpt: string; turn: string; title: string; gone: boolean } | { error: string }> {
  const link = await getLink(id)
  if (!link) return { error: `no such context link: ${id}` }
  if (link.to !== callerSessionId) return { error: `context link ${id} was not passed to this session` }

  const source = await getSession(link.from.session)
  if (!source) {
    /**
     *
     * The source is gone, and this is exactly the case the stored excerpt
     * exists for: the caller still gets what was said, and is TOLD there is no
     * more rather than being handed an empty string to interpret.
     *
     **/
    return { excerpt: link.excerpt, turn: link.excerpt, title: 'a deleted conversation', gone: true }
  }

  const messages = await readMessages(link.from.session)
  const turn = messages.find((message) => message.id === link.from.turn)
  if (!turn) return { excerpt: link.excerpt, turn: link.excerpt, title: source.title ?? 'a conversation', gone: true }

  return {
    excerpt: link.excerpt,
    turn: turnText(turn.parts),
    title: source.title ?? 'a conversation',
    gone: false,
  }
}
