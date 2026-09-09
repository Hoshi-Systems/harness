import { defineEventHandler } from 'h3'
import { listStarters, requireAuth } from '../kernel/index.js'

/** The three things worth trying first on this machine, from its preset. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { starters: await listStarters() }
})
