import { defineEventHandler } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { listWorkflows } from './workflows.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { workflows: await listWorkflows() }
})
