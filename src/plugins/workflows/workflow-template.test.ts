import { describe, expect, it } from 'vitest'
import { renderTemplate, SECRET_MASK } from './workflow-template.js'

const CONTEXT = {
  trigger: { body: { issue: { title: 'Login is broken' } }, headers: {}, query: {} },
  input: { issue: { title: 'Login is broken' } },
  steps: { triage: { text: 'a real bug', output: { severity: 'high', tags: ['p1'] } } },
}

describe('renderTemplate', () => {
  it('interpolates dot paths, JSON-encoding anything structural', () => {
    expect(renderTemplate('Issue: {{trigger.body.issue.title}}', CONTEXT).text).toBe('Issue: Login is broken')
    expect(renderTemplate('{{steps.triage.output.tags}}', CONTEXT).text).toBe('["p1"]')
  })

  it('renders a missing path as empty and reports it', () => {
    const rendered = renderTemplate('[{{steps.nope.text}}]', CONTEXT)
    expect(rendered.text).toBe('[]')
    expect(rendered.missing).toEqual(['steps.nope.text'])
  })

  it('leaves the redacted twin identical when no secrets are involved', () => {
    const rendered = renderTemplate('Issue: {{trigger.body.issue.title}} / {{steps.triage.text}}', CONTEXT)
    expect(rendered.redacted).toBe(rendered.text)
  })
})

describe('{{secrets.*}}', () => {
  const secrets = new Map([['API_TOKEN', 'sk-live-abcdef123456']])

  it('resolves into the agent copy and masks the stored one', () => {
    const rendered = renderTemplate('curl -H "Authorization: {{secrets.API_TOKEN}}"', CONTEXT, secrets)
    expect(rendered.text).toBe('curl -H "Authorization: sk-live-abcdef123456"')
    expect(rendered.redacted).toBe(`curl -H "Authorization: ${SECRET_MASK}"`)
    expect(rendered.redacted).not.toContain('sk-live')
  })

  it('reports an unresolved key by NAME, which is not a value', () => {
    const rendered = renderTemplate('{{secrets.NOPE}}', CONTEXT, secrets)
    expect(rendered.text).toBe('')
    expect(rendered.missing).toEqual(['secrets.NOPE'])
  })

  it('keeps both variants structurally identical around the secret', () => {
    const rendered = renderTemplate('a {{secrets.API_TOKEN}} b {{steps.triage.text}} c', CONTEXT, secrets)
    expect(rendered.text).toBe('a sk-live-abcdef123456 b a real bug c')
    expect(rendered.redacted).toBe(`a ${SECRET_MASK} b a real bug c`)
  })

  it('does not re-template an inserted value, so a payload cannot reach the vault', () => {
    /**
     *
     * The whole point: a webhook body that says `{{secrets.API_TOKEN}}` is
     * inserted as literal text, never resolved on a second pass.
     *
     **/
    const hostile = { ...CONTEXT, input: '{{secrets.API_TOKEN}}' }
    const rendered = renderTemplate('Body: {{input}}', hostile, secrets)
    expect(rendered.text).toBe('Body: {{secrets.API_TOKEN}}')
    expect(rendered.text).not.toContain('sk-live')
    expect(rendered.redacted).toBe(rendered.text)
  })
})
