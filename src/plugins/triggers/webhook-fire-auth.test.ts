import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ── The URL is the credential ────────────────────────────────────────────────
 *
 * `POST /triggers/webhooks/:id/:secret` is the machine's only unauthenticated
 * route: no session, no owner check, nothing but the id+secret pair in the path
 * standing between an anonymous caller and dispatched agent work. So the
 * comparison that admits them is the whole gate, and it used to be `!==`
 * (security/SECURITY_AUDIT.md L9).
 *
 * What is asserted here is the CONTRACT, not the timing — a wall-clock
 * measurement of a string compare is a flaky test on a shared runner, and it
 * would pin the implementation rather than the promise. What it does pin is
 * that the gate still refuses every near miss, including the two an early-exit
 * compare answers fastest (a wrong first byte, a right prefix), and that
 * `timingSafeEqual`'s length precondition did not turn a length mismatch into a
 * thrown 500 instead of a clean "no".
 *
 * Store paths are read from HOME at module load, so the scratch home goes in
 * before the dynamic import.
 *
 **/

const home = mkdtempSync(path.join(tmpdir(), 'webhook-fire-'))
process.env.HOME = home
mkdirSync(path.join(home, '.hoshi'), { recursive: true })

const { createWebhookTrigger, findWebhookForFire, updateWebhookTrigger } = await import('./triggers.js')

const hook = await createWebhookTrigger({ name: 'deploy', prompt: 'ship it', workflowId: null, projectId: null })

describe('findWebhookForFire', () => {
  it('admits the exact pair', async () => {
    expect((await findWebhookForFire(hook.id, hook.secret))?.id).toBe(hook.id)
  })

  it('refuses every near miss of the secret', async () => {
    const cases = {
      /** Differs at byte 0 — the case an early-exit compare rejects fastest. */
      'wrong first byte': `${'z'}${hook.secret.slice(1)}`,
      /** Differs at the last byte — the case it rejects slowest. That the two
       *  are indistinguishable from outside is the point of the change. */
      'wrong last byte': `${hook.secret.slice(0, -1)}z`,
      /** A correct PREFIX is what byte-at-a-time recovery is built out of. */
      'a correct prefix': hook.secret.slice(0, 8),
      /** Longer than the stored secret: `timingSafeEqual` throws on unequal
       *  lengths, so an unguarded call here would be a 500, not a refusal. */
      'the secret plus a suffix': `${hook.secret}z`,
      empty: '',
    }
    for (const [what, secret] of Object.entries(cases)) {
      expect(await findWebhookForFire(hook.id, secret), what).toBeUndefined()
    }
  })

  it('refuses a real secret against the wrong webhook id', async () => {
    expect(await findWebhookForFire(crypto.randomUUID(), hook.secret)).toBeUndefined()
  })

  it('refuses a disabled webhook holding the right secret', async () => {
    await updateWebhookTrigger(hook.id, { enabled: false })
    expect(await findWebhookForFire(hook.id, hook.secret)).toBeUndefined()
    await updateWebhookTrigger(hook.id, { enabled: true })
    expect(await findWebhookForFire(hook.id, hook.secret)).toBeDefined()
  })
})
