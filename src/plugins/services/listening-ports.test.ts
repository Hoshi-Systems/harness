import { describe, expect, it } from 'vitest'
import { envUrlPort } from './listening-ports.js'

/**
 *
 * Every answer here lands in `reservedPorts()`, so a wrong one is silent in two
 * directions at once: it hides a user's dev server on the port it wrongly
 * reserves, and lets the daemon's real port fire a "port opened" notification.
 *
 **/
describe('envUrlPort', () => {
  const FALLBACK = 4096

  it('reads an explicit port', () => {
    expect(envUrlPort('http://127.0.0.1:4096', FALLBACK)).toBe(4096)
    expect(envUrlPort('https://host:4443', FALLBACK)).toBe(4443)
    expect(envUrlPort('ws://host:4097', FALLBACK)).toBe(4097)
  })

  it('falls back to the scheme default when no port is given', () => {
    expect(envUrlPort('http://host', FALLBACK)).toBe(80)
    expect(envUrlPort('https://host', FALLBACK)).toBe(443)
    expect(envUrlPort('wss://host', FALLBACK)).toBe(443)
  })

  it('reads a scheme-less host:port for what it means', () => {
    /**
     *
     * `new URL('localhost:11434')` does not throw — it reads `localhost:` as the
     * scheme — so this used to resolve to 80: port 80 reserved, 11434 not.
     *
     **/
    expect(envUrlPort('localhost:11434', FALLBACK)).toBe(11434)
    expect(envUrlPort('127.0.0.1:4097', FALLBACK)).toBe(4097)
    expect(envUrlPort('my-host.internal:8080', FALLBACK)).toBe(8080)
  })

  it('falls back rather than guessing, for anything unusable', () => {
    for (const value of [undefined, '', 'not a url', 'http://host:0', 'host:99999', 'http://', '://x']) {
      expect(envUrlPort(value, FALLBACK), `for ${JSON.stringify(value)}`).toBe(FALLBACK)
    }
  })

  it('never returns a port outside the valid range', () => {
    for (const value of ['http://h:0', 'h:0', 'h:65536', 'h:123456']) {
      const port = envUrlPort(value, FALLBACK)
      expect(port).toBeGreaterThan(0)
      expect(port).toBeLessThanOrEqual(65535)
    }
  })
})
