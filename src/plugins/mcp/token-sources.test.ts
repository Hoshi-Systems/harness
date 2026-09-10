import { describe, expect, it } from 'vitest'
import {
  bindTokenSource,
  clearTokenSources,
  InvalidTokenSourceError,
  resolveTokenSource,
  TokenSourceUnavailableError,
} from './token-sources.js'

describe('runtime connector token sources', () => {
  it('passes a connector and copied scopes to a bound resolver, but returns only its ephemeral token to the dialler', async () => {
    const calls: unknown[] = []
    const release = bindTokenSource('platform.google', async (input) => {
      calls.push(input)
      return { state: 'available', accessToken: 'short-lived-token' }
    })

    await expect(resolveTokenSource({ id: 'platform.google', scopes: ['drive.readonly'] }, 'google-drive')).resolves.toBe(
      'short-lived-token',
    )
    expect(calls).toEqual([{ name: 'google-drive', scopes: ['drive.readonly'] }])
    release()
  })

  it('turns absent, expired, revoked, and throwing resolvers into safe machine states', async () => {
    await expect(resolveTokenSource({ id: 'missing' }, 'connector')).rejects.toMatchObject({
      auth: 'needs-auth',
      message: 'The required connector token source is not available.',
    })

    for (const [id, result, auth] of [
      ['expired', { state: 'expired' }, 'expired'],
      ['revoked', { state: 'revoked' }, 'needs-auth'],
      ['unavailable', { state: 'unavailable' }, 'needs-auth'],
    ] as const) {
      const release = bindTokenSource(id, async () => result)
      await expect(resolveTokenSource({ id }, 'connector')).rejects.toBeInstanceOf(TokenSourceUnavailableError)
      await expect(resolveTokenSource({ id }, 'connector')).rejects.toMatchObject({ auth })
      release()
    }

    const release = bindTokenSource('throws', async () => {
      throw new Error('upstream response must not cross this boundary')
    })
    await expect(resolveTokenSource({ id: 'throws' }, 'connector')).rejects.toMatchObject({
      auth: 'needs-auth',
      message: 'The connector authorization is not available.',
    })
    release()
  })

  it('does not allow one plugin to replace another source, and clears registrations at shutdown', async () => {
    bindTokenSource('shared', async () => ({ state: 'available', accessToken: 'first' }))
    expect(() => bindTokenSource('shared', async () => ({ state: 'available', accessToken: 'second' }))).toThrow(
      InvalidTokenSourceError,
    )
    clearTokenSources()
    await expect(resolveTokenSource({ id: 'shared' }, 'connector')).rejects.toMatchObject({ auth: 'needs-auth' })
  })
})
