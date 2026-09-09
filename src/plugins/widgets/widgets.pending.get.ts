import { defineEventHandler } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { listPendingWidgets } from './widgets.js'

/** Widgets currently blocked waiting on the user — the client's replay source
 *  when a refreshed tab needs to recover a widget id that the message snapshot
 *  didn't carry. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { widgets: listPendingWidgets() }
})
