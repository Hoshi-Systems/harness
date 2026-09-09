import { defineEventHandler } from 'h3'
import type { MachineProfile } from '../wire/index.js'
import { readMachinePreset, readProfileEmphasis, requireAuth } from '../kernel/index.js'

/** Who the agent on this machine is: the preset it was seeded with and the
 *  emphasis that preset wrote into the personal agent. What the first-run
 *  wizard's agent card is drawn from. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const [preset, emphasis] = await Promise.all([readMachinePreset(), readProfileEmphasis()])
  const profile: MachineProfile = { preset, emphasis }
  return { profile }
})
