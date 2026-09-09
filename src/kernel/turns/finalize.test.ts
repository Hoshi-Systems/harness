import { describe, expect, it, vi } from 'vitest'
import { runTurnFinalization } from './finalize.js'

describe('turn finalization', () => {
  it('runs every cleanup step after synchronous and asynchronous failures', async () => {
    const completed: string[] = []
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const errors = await runTurnFinalization([
      {
        name: 'transcript',
        run: () => {
          throw new Error('disk full')
        },
      },
      {
        name: 'history',
        run: async () => {
          throw new Error('rename failed')
        },
      },
      { name: 'state', run: () => void completed.push('idle') },
      { name: 'event', run: () => void completed.push('completed') },
    ])

    expect(errors).toHaveLength(2)
    expect(completed).toEqual(['idle', 'completed'])
    expect(log).toHaveBeenCalledTimes(2)
    log.mockRestore()
  })
})
