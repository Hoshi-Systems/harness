import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseConnectorFrame, RelayCalls, type CallHandlers } from './protocol.js'

/**
 *
 * The multiplexer is the part of the relay a unit can prove: one socket
 * carries every in-flight request, so the failure modes worth pinning are the
 * cross-stream ones — interleaved chunks staying with their ids, an error
 * costing only its own request, a reply for a request nobody sent costing
 * nothing at all.
 *
 **/

function recording(): { handlers: CallHandlers; events: string[] } {
  const events: string[] = []
  return {
    events,
    handlers: {
      onResponse: (status) => events.push(`res:${status}`),
      onChunk: (bytes) => events.push(`chunk:${Buffer.from(bytes).toString()}`),
      onEnd: () => events.push('end'),
      onError: (message) => events.push(`err:${message}`),
    },
  }
}

const b64 = (text: string): string => Buffer.from(text).toString('base64')

describe('parseConnectorFrame', () => {
  it('accepts each frame the connector may send', () => {
    expect(
      parseConnectorFrame(
        JSON.stringify({
          t: 'hello',
          connector: { name: 'mac', version: '1' },
          endpoints: [{ id: 'ollama', name: 'Ollama' }],
        }),
      ),
    ).toEqual({ t: 'hello', connector: { name: 'mac', version: '1' }, endpoints: [{ id: 'ollama', name: 'Ollama' }] })
    expect(
      parseConnectorFrame(JSON.stringify({ t: 'res', id: 1, status: 200, headers: { 'content-type': 'a' } })),
    ).toEqual({
      t: 'res',
      id: 1,
      status: 200,
      headers: { 'content-type': 'a' },
    })
    expect(parseConnectorFrame(JSON.stringify({ t: 'pong' }))).toEqual({ t: 'pong' })
  })

  it('answers null for anything malformed, never a throw', () => {
    expect(parseConnectorFrame('not json')).toBeNull()
    expect(parseConnectorFrame(JSON.stringify({ t: 'res', id: '1', status: 200, headers: {} }))).toBeNull()
    expect(parseConnectorFrame(JSON.stringify({ t: 'chunk', id: 1 }))).toBeNull()
    expect(parseConnectorFrame(JSON.stringify({ t: 'hello', connector: {}, endpoints: [] }))).toBeNull()
    expect(
      parseConnectorFrame(JSON.stringify({ t: 'hello', connector: { name: 'x', version: '1' }, endpoints: [{}] })),
    ).toBeNull()
    expect(parseConnectorFrame(JSON.stringify({ t: 'nonsense' }))).toBeNull()
    expect(parseConnectorFrame(42 as unknown as string)).toBeNull()
  })
})

describe('RelayCalls', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps interleaved streams with their own requests', () => {
    const calls = new RelayCalls()
    const a = recording()
    const b = recording()
    const idA = calls.begin(a.handlers)
    const idB = calls.begin(b.handlers)

    calls.handle({ t: 'res', id: idA, status: 200, headers: {} })
    calls.handle({ t: 'res', id: idB, status: 200, headers: {} })
    calls.handle({ t: 'chunk', id: idB, b64: b64('b1') })
    calls.handle({ t: 'chunk', id: idA, b64: b64('a1') })
    calls.handle({ t: 'chunk', id: idB, b64: b64('b2') })
    calls.handle({ t: 'end', id: idB })
    calls.handle({ t: 'chunk', id: idA, b64: b64('a2') })
    calls.handle({ t: 'end', id: idA })

    expect(a.events).toEqual(['res:200', 'chunk:a1', 'chunk:a2', 'end'])
    expect(b.events).toEqual(['res:200', 'chunk:b1', 'chunk:b2', 'end'])
    expect(calls.pending()).toBe(0)
  })

  it('an error mid-stream ends that request and only that request', () => {
    const calls = new RelayCalls()
    const failing = recording()
    const fine = recording()
    const idFailing = calls.begin(failing.handlers)
    const idFine = calls.begin(fine.handlers)

    calls.handle({ t: 'res', id: idFailing, status: 200, headers: {} })
    calls.handle({ t: 'err', id: idFailing, message: 'runtime died' })
    calls.handle({ t: 'chunk', id: idFailing, b64: b64('late') })
    calls.handle({ t: 'res', id: idFine, status: 200, headers: {} })
    calls.handle({ t: 'end', id: idFine })

    expect(failing.events).toEqual(['res:200', 'err:runtime died'])
    expect(fine.events).toEqual(['res:200', 'end'])
  })

  it('ignores a reply for a request nobody sent', () => {
    const calls = new RelayCalls()
    expect(() => {
      calls.handle({ t: 'res', id: 99, status: 200, headers: {} })
      calls.handle({ t: 'chunk', id: 99, b64: b64('x') })
      calls.handle({ t: 'end', id: 99 })
    }).not.toThrow()
    expect(calls.pending()).toBe(0)
  })

  it('a cancelled request hears nothing more', () => {
    const calls = new RelayCalls()
    const call = recording()
    const id = calls.begin(call.handlers)
    expect(calls.cancel(id)).toBe(true)
    expect(calls.cancel(id)).toBe(false)
    calls.handle({ t: 'chunk', id, b64: b64('late') })
    expect(call.events).toEqual([])
  })

  it('failAll fails every pending request once — the socket died under them', () => {
    const calls = new RelayCalls()
    const one = recording()
    const two = recording()
    calls.begin(one.handlers)
    calls.begin(two.handlers)
    calls.failAll('connector disconnected')
    calls.failAll('again')
    expect(one.events).toEqual(['err:connector disconnected'])
    expect(two.events).toEqual(['err:connector disconnected'])
    expect(calls.pending()).toBe(0)
  })

  it('a request no frame reaches is failed after the idle window, and frames push the window out', () => {
    vi.useFakeTimers()
    const calls = new RelayCalls()
    const silent = recording()
    const streaming = recording()
    const idSilent = calls.begin(silent.handlers, 1_000)
    const idStreaming = calls.begin(streaming.handlers, 1_000)

    vi.advanceTimersByTime(700)
    calls.handle({ t: 'res', id: idStreaming, status: 200, headers: {} }, 1_000)
    vi.advanceTimersByTime(700)

    expect(silent.events).toEqual(['err:The connector stopped answering this request.'])
    expect(streaming.events).toEqual(['res:200'])
    expect(calls.pending()).toBe(1)
    expect(calls.cancel(idStreaming)).toBe(true)
    expect(calls.cancel(idSilent)).toBe(false)
  })
})
