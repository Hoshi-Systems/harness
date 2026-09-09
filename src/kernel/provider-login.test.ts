import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./secrets.js', () => ({ setSecret: vi.fn(async () => undefined) }))
vi.mock('./machine-state.js', () => ({ publishProvidersChanged: vi.fn(async () => undefined) }))

import { setSecret } from './secrets.js'
import { publishProvidersChanged } from './machine-state.js'
import { subscribeMachineEvents, type MachineEvent } from './events.js'
import { cancelProviderLogin, providerLoginPending, startProviderLogin, ProviderLoginError } from './provider-login.js'

/**
 *
 * The device flow as the machine runs it: ask for a code, hand it over, then
 * keep asking GitHub until the person has answered. What these pin is the
 * polling — that it honours the interval and `slow_down`, that every way the
 * flow can end is announced on the bus with its own name, and that the token
 * reaches the vault under the provider's own env var rather than somewhere a
 * key would not be found.
 *
 **/

type Answer = { access_token: string } | { error: string; error_description?: string }

let answers: Answer[]
let polls: number
let deviceCodeStatus: number

function stubFetch() {
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.href
    if (url.endsWith('/login/device/code')) {
      if (deviceCodeStatus !== 200) return Promise.resolve(new Response('no', { status: deviceCodeStatus }))
      expect(JSON.parse(init!.body as string)).toMatchObject({ scope: 'read:user' })
      return Promise.resolve(
        Response.json({
          device_code: 'device-1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 1,
        }),
      )
    }
    if (url.endsWith('/login/oauth/access_token')) {
      polls += 1
      expect(JSON.parse(init!.body as string)).toMatchObject({
        device_code: 'device-1',
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      })
      return Promise.resolve(Response.json(answers.shift() ?? { error: 'authorization_pending' }))
    }
    throw new Error(`unexpected fetch ${url}`)
  })
}

let events: MachineEvent[]
let unsubscribe: () => void

beforeEach(() => {
  answers = []
  polls = 0
  deviceCodeStatus = 200
  events = []
  vi.useFakeTimers()
  stubFetch()
  unsubscribe = subscribeMachineEvents((event) => {
    if (event.type === 'provider.login') events.push(event)
  })
})

afterEach(() => {
  cancelProviderLogin('github-copilot')
  unsubscribe()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.clearAllMocks()
})

const statuses = () => events.map((event) => event.properties.status)

/** Let one scheduled poll fire and settle. */
async function tick(ms = 2_000) {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('startProviderLogin', () => {
  it('hands back the code and where to type it, and says a login is pending', async () => {
    const start = await startProviderLogin('github-copilot', 'GITHUB_TOKEN')
    expect(start).toMatchObject({ code: 'ABCD-1234', url: 'https://github.com/login/device' })
    expect(Date.parse(start.expiresAt)).toBeGreaterThan(Date.now())
    expect(providerLoginPending('github-copilot')).toBe(true)
    expect(statuses()).toEqual(['pending'])
  })

  it('refuses in words when GitHub will not start one', async () => {
    deviceCodeStatus = 503
    await expect(startProviderLogin('github-copilot', 'GITHUB_TOKEN')).rejects.toBeInstanceOf(ProviderLoginError)
    expect(providerLoginPending('github-copilot')).toBe(false)
  })

  it('stores the token under the provider’s env var once approved, and announces it', async () => {
    answers = [{ error: 'authorization_pending' }, { access_token: 'gho_secret' }]
    await startProviderLogin('github-copilot', 'GITHUB_TOKEN')
    await tick()
    await tick()
    expect(polls).toBe(2)
    expect(setSecret).toHaveBeenCalledWith('GITHUB_TOKEN', 'gho_secret')
    expect(publishProvidersChanged).toHaveBeenCalledWith('github-copilot')
    expect(statuses()).toEqual(['pending', 'connected'])
    expect(providerLoginPending('github-copilot')).toBe(false)
  })

  it('backs off when GitHub asks it to', async () => {
    answers = [{ error: 'slow_down' }, { error: 'authorization_pending' }]
    await startProviderLogin('github-copilot', 'GITHUB_TOKEN')
    await tick(2_000)
    expect(polls).toBe(1)
    /**
     *
     * The interval grew by five seconds: the next poll is not at +2s any more.
     *
     **/
    await tick(2_000)
    expect(polls).toBe(1)
    await tick(5_000)
    expect(polls).toBe(2)
  })

  it('names a refusal and an expiry differently, and stores nothing', async () => {
    answers = [{ error: 'access_denied' }]
    await startProviderLogin('github-copilot', 'GITHUB_TOKEN')
    await tick()
    expect(statuses()).toEqual(['pending', 'denied'])

    events = []
    answers = [{ error: 'expired_token' }]
    await startProviderLogin('github-copilot', 'GITHUB_TOKEN')
    await tick()
    expect(statuses()).toEqual(['pending', 'expired'])
    expect(setSecret).not.toHaveBeenCalled()
  })

  it('stops polling when cancelled, and says so', async () => {
    await startProviderLogin('github-copilot', 'GITHUB_TOKEN')
    expect(cancelProviderLogin('github-copilot')).toBe(true)
    await tick(10_000)
    expect(polls).toBe(0)
    expect(statuses()).toEqual(['pending', 'cancelled'])
    expect(cancelProviderLogin('github-copilot')).toBe(false)
  })

  it('replaces an earlier code for the same provider rather than polling two', async () => {
    await startProviderLogin('github-copilot', 'GITHUB_TOKEN')
    await startProviderLogin('github-copilot', 'GITHUB_TOKEN')
    await tick()
    expect(polls).toBe(1)
    expect(statuses()).toEqual(['pending', 'cancelled', 'pending'])
  })
})
