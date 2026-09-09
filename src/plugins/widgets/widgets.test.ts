import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tool } from 'ai'
import { bindTools, type HoshiToolContext } from '../define-tool.js'
import { listPendingWidgets, respondToWidget, uiTools } from './ui-tools.js'

/**
 * ── The one tool that blocks on a person ─────────────────────────────────────
 *
 * `ui_ask` is the only Hoshi tool whose execute() does not return until a human
 * acts, so it is the only one that can strand a turn. Everything below is about
 * the ways it can fail to be released.
 *
 * The in-process map IS the bridge. Answering used to be an HTTP round-trip to
 * a loopback server the plugin bound at 127.0.0.1:4097, with all the failure
 * modes that implies; in one process it is a function call, and what is left to
 * get wrong is the bookkeeping: a widget answered twice, an answer for a widget
 * that is gone, and — the expensive one — a turn stopped while a card is on
 * screen, which must release the tool or the session hangs forever on a
 * question the user has already dismissed.
 *
 **/

const ORIGINAL_UUID = crypto.randomUUID

/** One ask surface: a form is the minimum an ask is allowed to be, because an
 *  ask the user cannot answer is a hang by construction. */
const ASK_DOCUMENT = {
  root: ['f'],
  nodes: {
    f: {
      type: 'form',
      props: {
        title: 'Pick a base branch',
        fields: [{ name: 'branch', label: 'Branch', kind: 'text' }],
      },
    },
  },
}

function askTool(overrides: Partial<HoshiToolContext> = {}): Tool {
  const context = {
    sessionId: 'ses_1',
    directory: '/w/acme/api',
    worktree: '/w/acme/api',
    agent: 'personal',
    model: null,
    publish: vi.fn(),
    machine: {
      complete: async () => '',
      providers: async () => [],
      tierModel: async () => null,
      providerKey: async () => null,
      createCommand: async () => undefined,
      createSkill: async () => undefined,
    },
    ...overrides,
  }
  return bindTools({ ui_ask: uiTools.ui_ask! }, context).ui_ask!
}

/** Run the tool and hand back the id it published, without waiting on it. */
async function ask(
  signal?: AbortSignal,
): Promise<{ id: string; done: Promise<unknown>; publish: ReturnType<typeof vi.fn> }> {
  const publish = vi.fn()
  const tool = askTool({ publish })
  const done = (tool.execute as (input: unknown, options: { abortSignal?: AbortSignal }) => Promise<unknown>)(
    ASK_DOCUMENT,
    { abortSignal: signal },
  )
  await vi.waitFor(() => expect(publish).toHaveBeenCalled())
  const asked = publish.mock.calls.find(([type]) => type === 'asked')
  return { id: (asked?.[1] as { id: string }).id, done, publish }
}

afterEach(() => {
  crypto.randomUUID = ORIGINAL_UUID
  for (const widget of listPendingWidgets()) respondToWidget(widget.id, {})
})

describe('a widget waiting for an answer', () => {
  it('is listed while it waits, so a refreshed tab can recover it', async () => {
    const { id, done } = await ask()
    expect(listPendingWidgets()).toEqual([{ id, kind: 'ask', sessionId: 'ses_1' }])
    respondToWidget(id, { branch: 'main' })
    await done
  })

  it('announces itself on the bus with the id, rather than making the client poll', async () => {
    const { id, done, publish } = await ask()
    expect(publish).toHaveBeenCalledWith('asked', expect.objectContaining({ id, kind: 'ask', sessionId: 'ses_1' }))
    respondToWidget(id, {})
    await done
  })

  it('releases the tool with the answer, and stops being pending', async () => {
    const { id, done } = await ask()
    expect(respondToWidget(id, { branch: 'main' })).toBe('answered')
    expect(listPendingWidgets()).toEqual([])
    expect(await done).toMatchObject({
      metadata: { hoshi: { widget: { id, status: 'answered', response: { branch: 'main' } } } },
    })
  })
})

describe('an answer that arrives too late', () => {
  it('tells a duplicate submit apart from an unknown id', async () => {
    /**
     *
     * The client turns these into different HTTP answers — 409 for a widget
     * already answered, 404 for one that is gone. Collapsing them makes a
     * double-click read as "this card expired", which is a lie the user then
     * acts on.
     *
     **/
    const { id, done } = await ask()
    expect(respondToWidget(id, {})).toBe('answered')
    await done
    expect(respondToWidget(id, {})).toBe('already-answered')
    expect(respondToWidget('never-existed', {})).toBe('unknown')
  })
})

describe('a turn stopped while the card is on screen', () => {
  it('releases the tool instead of leaving the session hanging', async () => {
    /**
     *
     * Without the abort listener the promise below never settles: the user
     * pressed Stop, the card is gone from their screen, and the session sits
     * on a question nobody can answer.
     *
     **/
    const controller = new AbortController()
    const { id, done, publish } = await ask(controller.signal)
    controller.abort()
    expect(await done).toMatchObject({ metadata: { hoshi: { widget: { status: 'cancelled' } } } })
    expect(publish).toHaveBeenCalledWith('cancelled', { id, sessionId: 'ses_1' })
    expect(listPendingWidgets()).toEqual([])
  })

  it('releases immediately when the turn was ALREADY stopped before the tool ran', async () => {
    /**
     *
     * A signal that is aborted before `addEventListener` never fires, so an
     * implementation that only listens waits forever on a turn that is over.
     *
     **/
    const { done } = await ask(AbortSignal.abort())
    expect(await done).toMatchObject({ metadata: { hoshi: { widget: { status: 'cancelled' } } } })
  })
})

describe('an ask the user could not answer', () => {
  it('is refused before it blocks, rather than becoming a hang', async () => {
    /**
     *
     * A surface with nothing submittable on it would wait forever by
     * construction. Failing the tool call is the only outcome the model can
     * recover from.
     *
     **/
    const tool = askTool()
    await expect(
      (tool.execute as (input: unknown, options: { abortSignal?: AbortSignal }) => Promise<unknown>)(
        { root: ['m'], nodes: { m: { type: 'markdown', props: { text: 'hello' } } } },
        { abortSignal: undefined },
      ),
    ).rejects.toThrow(/form node, choice node, or button with a submit action/)
    expect(listPendingWidgets()).toEqual([])
  })
})
