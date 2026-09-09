import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * ── Passing a passage without copying it ─────────────────────────────────────
 *
 * The two grades are the whole feature: a `quote` spends its excerpt into the
 * message, a `link` spends one line and leaves the rest behind `context_open`.
 * If those two came out the same size, there would be no reason for either to
 * exist — so the assertions here are about what actually reaches the model.
 *
 * The rest is the failures that would be silent: a link spent by a session it
 * was never passed to (the store is machine-wide, so an id is the only fence),
 * and a source deleted out from under a chat that outlived it.
 *
 **/

const HOME_PREFIX = 'hoshi-links-'

describe('context links', () => {
  let home = ''
  let previousHome: string | undefined
  let links: typeof import('./links.js')
  let sessions: typeof import('../../kernel/sessions.js')
  let messages: typeof import('../../kernel/messages.js')

  /** The turn a link addresses. Offsets below are ranges into exactly this. */
  const TURN_TEXT =
    'Connect onboarding is wired through services/billing.ts. ' +
    'The application-fee split still assumes a flat 2.9% and I have not found where the platform take is configured.'
  const RANGE: [number, number] = [57, TURN_TEXT.length]

  async function seed() {
    const task = await sessions.createSession(home, { title: 'Migrate billing to Connect' })
    await messages.appendMessage(task.id, {
      id: 'msg_turn',
      role: 'assistant',
      parts: [{ type: 'text', text: TURN_TEXT }],
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    })
    const chat = await sessions.createSession(home, { chat: true, title: 'Stripe fees' })
    return { task, chat }
  }

  beforeAll(async () => {
    previousHome = process.env.HOME
    home = await mkdtemp(path.join(tmpdir(), HOME_PREFIX))
    process.env.HOME = home
    links = await import('./links.js')
    sessions = await import('../../kernel/sessions.js')
    messages = await import('../../kernel/messages.js')
  })

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })

  it('reads the excerpt out of the source transcript, not out of the request', async () => {
    /**
     *
     * The failure this names: a caller naming its own excerpt could put words
     * in a task's mouth — the receiving conversation would show a quote
     * attributed to a session that never said it, with a range sitting beside
     * it proving otherwise.
     *
     **/
    const { task, chat } = await seed()
    const link = await links.createLink({
      fromSession: task.id,
      turn: 'msg_turn',
      range: RANGE,
      to: chat.id,
      grade: 'link',
    })
    expect(link.excerpt).toBe(TURN_TEXT.slice(...RANGE).trim())
    expect(link.from).toMatchObject({ session: task.id, turn: 'msg_turn' })
  })

  it('a reference costs a line where a quote costs the whole passage', async () => {
    /**
     *
     * Measured on a REAL passage — a few sentences of a turn, which is what
     * people actually pass. The grades exist because of this inequality: if the
     * cheap one were not meaningfully cheaper there would be no reason to offer
     * two, and no reason to default to it.
     *
     * A reference's floor is about 200 characters — naming the source, showing
     * a teaser, and saying how to open it — so the crossover sits around two
     * lines of prose. Below that a reference genuinely costs more than the text
     * it stands in for, which is not a defect to squash but the reason the
     * grade is a choice with its price on screen.
     *
     **/
    const { task, chat } = await seed()
    const long = `${TURN_TEXT} ${TURN_TEXT} ${TURN_TEXT}`
    await messages.appendMessage(task.id, {
      id: 'msg_long',
      role: 'assistant',
      parts: [{ type: 'text', text: long }],
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    })
    const base = { fromSession: task.id, turn: 'msg_long', range: [0, long.length] as [number, number], to: chat.id }
    const asLink = await links.createLink({ ...base, grade: 'link' })
    const asQuote = await links.createLink({ ...base, grade: 'quote' })

    const linked = await links.expandLinks(chat.id, [asLink.id])
    const quoted = await links.expandLinks(chat.id, [asQuote.id])
    if ('error' in linked || 'error' in quoted) throw new Error('expected both to expand')

    expect(quoted.text).toContain('application-fee split')
    expect(linked.text).toContain('context_open')
    expect(linked.text.length).toBeLessThan(quoted.text.length)
  })

  it('a reference does not grow with the passage; a quote does', async () => {
    /**
     *
     * The property that actually matters, and the one a length comparison on a
     * single passage cannot show: a quote's cost is the passage's cost, while a
     * reference's is flat. It is also where the honest boundary lies — below a
     * couple of lines a reference cannot be cheaper than the text it stands in
     * for, because naming the source costs more than saying it. That is why the
     * grade is a choice with its price on screen rather than something the
     * machine picks.
     *
     **/
    const { task, chat } = await seed()
    const sizes = [200, 4_000]
    const lengths: Record<string, number[]> = { link: [], quote: [] }
    for (const size of sizes) {
      const text = 'x'.repeat(size)
      const turnId = `msg_${size}`
      await messages.appendMessage(task.id, {
        id: turnId,
        role: 'assistant',
        parts: [{ type: 'text', text }],
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      })
      for (const grade of ['link', 'quote'] as const) {
        const link = await links.createLink({
          fromSession: task.id,
          turn: turnId,
          range: [0, size],
          to: chat.id,
          grade,
        })
        const expanded = await links.expandLinks(chat.id, [link.id])
        if ('error' in expanded) throw new Error(expanded.error)
        lengths[grade]!.push(expanded.text.length)
      }
    }
    expect(lengths.link![1]).toBe(lengths.link![0])
    expect(lengths.quote![1]).toBeGreaterThan(lengths.quote![0]! * 2)
  })

  it('names the source conversation, so the model knows whose words these are', async () => {
    const { task, chat } = await seed()
    const link = await links.createLink({
      fromSession: task.id,
      turn: 'msg_turn',
      range: RANGE,
      to: chat.id,
      grade: 'link',
    })
    const expanded = await links.expandLinks(chat.id, [link.id])
    if ('error' in expanded) throw new Error(expanded.error)
    expect(expanded.text).toContain('Migrate billing to Connect')
  })

  it('refuses a link that was passed to a different session', async () => {
    const { task, chat } = await seed()
    const stranger = await sessions.createSession(home, { chat: true })
    const link = await links.createLink({
      fromSession: task.id,
      turn: 'msg_turn',
      range: RANGE,
      to: chat.id,
      grade: 'quote',
    })
    expect(await links.expandLinks(stranger.id, [link.id])).toMatchObject({
      error: expect.stringContaining('not passed'),
    })
    expect(await links.readLink(link.id, stranger.id)).toMatchObject({ error: expect.stringContaining('not passed') })
  })

  it('refuses an id nobody minted, rather than expanding to nothing', async () => {
    const { chat } = await seed()
    expect(await links.expandLinks(chat.id, ['lnk_nope'])).toMatchObject({ error: expect.stringContaining('no such') })
  })

  it('expands to nothing when there is nothing to expand', async () => {
    const { chat } = await seed()
    expect(await links.expandLinks(chat.id, [])).toEqual({ text: '' })
  })

  it('degrades to its excerpt when the source is deleted, never to nothing', async () => {
    /**
     *
     * A chat outlives the task it came from. A pure pointer would empty itself
     * on the day the source is deleted; the stored excerpt is what makes that a
     * quote instead — and `gone` is what stops the model reading the shortened
     * answer as the whole turn.
     *
     **/
    const { task, chat } = await seed()
    const link = await links.createLink({
      fromSession: task.id,
      turn: 'msg_turn',
      range: RANGE,
      to: chat.id,
      grade: 'link',
    })
    await sessions.deleteSession(task.id)

    const read = await links.readLink(link.id, chat.id)
    if ('error' in read) throw new Error(read.error)
    expect(read.gone).toBe(true)
    expect(read.excerpt).toContain('application-fee split')
  })

  it('reads both ends of the edge, because both sides ask about it', async () => {
    const { task, chat } = await seed()
    const link = await links.createLink({
      fromSession: task.id,
      turn: 'msg_turn',
      range: RANGE,
      to: chat.id,
      grade: 'link',
    })
    expect((await links.linksForSession(chat.id)).map((l) => l.id)).toContain(link.id)
    expect((await links.linksForSession(task.id)).map((l) => l.id)).toContain(link.id)
  })

  it('refuses a range that addresses nothing', async () => {
    const { task, chat } = await seed()
    const base = { fromSession: task.id, turn: 'msg_turn', to: chat.id, grade: 'link' } as const
    await expect(links.createLink({ ...base, range: [10, 10] })).rejects.toBeInstanceOf(links.LinkInputError)
    await expect(links.createLink({ ...base, range: [-1, 5] })).rejects.toBeInstanceOf(links.LinkInputError)
    await expect(links.createLink({ ...base, turn: 'msg_missing', range: RANGE })).rejects.toBeInstanceOf(
      links.LinkInputError,
    )
  })
})
