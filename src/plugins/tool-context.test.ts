import { afterEach, describe, expect, it } from 'vitest'
import { subscribeMachineEvents, type MachineEvent } from '../kernel/events.js'
import { machineToolContext } from './tool-context.js'

let unsubscribe: (() => void) | undefined

afterEach(() => {
  unsubscribe?.()
  unsubscribe = undefined
})

describe('plugin tool event publication', () => {
  it('prefixes events with the owning plugin namespace', () => {
    const events: MachineEvent[] = []
    unsubscribe = subscribeMachineEvents((event) => events.push(event))
    const context = machineToolContext({
      sessionId: 'ses_1',
      directory: '/workspace',
      agent: 'personal',
      eventNamespace: 'widgets',
    })

    context.publish('asked', { id: 'widget_1' })
    context.publish('session.deleted', { sessionId: 'ses_other' })

    expect(events).toEqual([
      { type: 'widgets.asked', properties: { id: 'widget_1' } },
      { type: 'widgets.session.deleted', properties: { sessionId: 'ses_other' } },
    ])
  })
})
