import { describe, expect, it } from 'vitest'
import { formatSnapshot, type PageElementInfo } from './tools.js'

/**
 * ── A password never reaches the model ───────────────────────────────────────
 *
 * `browser_read_page` and `browser_find` render this snapshot as their
 * model-facing OUTPUT, so anything in it is sent to the provider and written
 * into the transcript. Until 2026-08-26 that included the value of every
 * `<input>` that was not a checkbox — `type="password"` among them.
 *
 * Verified against a real Chromium before it was fixed: a page holding
 * `<input type="password" value="…">` produced `value="…"` verbatim.
 *
 * There are two gates, and this covers the second. The first redacts in the
 * PAGE, which is the right place and cannot be tested from here — it runs
 * inside `page.evaluate`. This one runs in node, and exists precisely because
 * a regression in the untestable half would otherwise be silent.
 *
 **/

const el = (over: Partial<PageElementInfo>): PageElementInfo => ({
  ref: 'ref_1',
  depth: 0,
  role: 'textbox',
  name: 'Password',
  tag: 'input',
  ...over,
})

describe('rendering a form back to the model', () => {
  it('never renders a password field’s value', () => {
    const out = formatSnapshot([el({ type: 'password', value: 'hunter2-the-real-secret' })])
    expect(out).not.toContain('hunter2')
    expect(out).toContain('value="')
  })

  it('still says the field is filled — the agent reads a form back to learn that', () => {
    const filled = formatSnapshot([el({ type: 'password', value: 'anything' })])
    const empty = formatSnapshot([el({ type: 'password' })])
    expect(filled).toContain('value=')
    expect(empty).not.toContain('value=')
  })

  it('leaves every other field alone', () => {
    /** Over-redaction is its own failure: an agent that cannot read back what it
     *  typed into an ordinary field will type it again. */
    const out = formatSnapshot([
      el({ ref: 'ref_1', type: 'email', name: 'Email', value: 'vlad@example.com' }),
      el({ ref: 'ref_2', tag: 'textarea', type: undefined, name: 'Notes', value: 'a note' }),
      el({ ref: 'ref_3', type: 'checkbox', name: 'Remember', checked: true }),
    ])
    expect(out).toContain('vlad@example.com')
    expect(out).toContain('a note')
    expect(out).toContain('checked=true')
  })

  it('redacts on the field’s declared TYPE, not on its name', () => {
    /** The page's own declaration is the rule. A field called "password" that
     *  is a plain text input is not a secret, and a secret in a field called
     *  something else still is. */
    const named = formatSnapshot([el({ type: 'text', name: 'password', value: 'not-actually-secret' })])
    expect(named).toContain('not-actually-secret')
  })
})
