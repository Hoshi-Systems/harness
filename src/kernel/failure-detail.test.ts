import { describe, expect, it } from 'vitest'
import { describeFailure } from './turns.js'

/**
 * ── What a failed turn says happened ─────────────────────────────────────────
 *
 * A turn that fails is the moment a person most needs a sentence they can act
 * on, and it is exactly where the obvious code is wrong. A provider rejection
 * arrives as an SDK error whose `message` is the response body already flattened
 * to `[object Object]` — a non-empty string, so any "take the message" logic
 * stops there and the card reports those fifteen characters as the reason. The
 * real words ("model not found", "context length exceeded") are one field over,
 * in the body the SDK kept.
 *
 **/

describe('the reason a turn failed', () => {
  it('walks past a body that stringified itself into nothing', () => {
    const detail = describeFailure({
      name: 'AI_APICallError',
      message: '[object Object]',
      responseBody: '{"error":{"message":"model \'gemma-4\' is not loaded"}}',
    })
    expect(detail.message).toContain("model 'gemma-4' is not loaded")
    expect(detail.message).not.toContain('[object Object]')
  })

  it('leads with the status code, which changes what the words mean', () => {
    /**
     *
     * "Model not found" from a 404 is a name to fix; the same sentence from a
     * 500 is an endpoint that fell over.
     *
     **/
    const detail = describeFailure({
      name: 'AI_APICallError',
      statusCode: 404,
      message: 'model not found',
    })
    expect(detail.message).toBe('HTTP 404 · model not found')
  })

  it('does not repeat a status the provider already stated', () => {
    const detail = describeFailure({ statusCode: 429, message: '429 Too Many Requests' })
    expect(detail.message).toBe('429 Too Many Requests')
  })

  it('digs through nested causes to the one that knows something', () => {
    const inner = new Error('connect ECONNREFUSED 127.0.0.1:1234')
    const outer = new Error('[object Object]', { cause: inner })
    expect(describeFailure(outer).message).toBe('connect ECONNREFUSED 127.0.0.1:1234')
  })

  it('keeps the error name whatever the message turns out to be', () => {
    expect(describeFailure({ name: 'ProviderAuthError', message: 'bad key' }).name).toBe('ProviderAuthError')
    expect(describeFailure({ message: 'no name here' }).name).toBe('Error')
  })

  it('says so plainly when the provider really said nothing', () => {
    /**
     *
     * Better than an empty card: "it failed and would not say why" is itself
     * information, and it is the honest thing to report.
     *
     **/
    const detail = describeFailure({ name: 'Error', message: '[object Object]' })
    expect(detail.message).toContain('said nothing useful')
  })
})
