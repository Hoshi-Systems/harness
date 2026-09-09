import { describe, expect, it } from 'vitest'
import { createApp, toWebHandler } from 'h3'
import { SignJWT } from 'jose'
import route from './capabilities.get.js'
import { sessionSecret } from '../kernel/session-secret.js'

async function ownerToken(): Promise<string> {
  return await new SignJWT({ userId: 1, email: 'owner@example.com' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(sessionSecret()))
}

function request(headers?: HeadersInit): Promise<Response> {
  const app = createApp()
  app.use('/capabilities', route)
  return toWebHandler(app)(new Request('http://machine.test/capabilities', { headers }))
}

describe('GET /capabilities', () => {
  it('is owner-authenticated', async () => {
    expect((await request()).status).toBe(401)
  })

  it('returns a versioned Passport to an owner', async () => {
    const response = await request({ authorization: `Bearer ${await ownerToken()}` })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 1,
      capabilities: expect.arrayContaining([expect.objectContaining({ id: 'harness.kernel' })]),
    })
  })
})
