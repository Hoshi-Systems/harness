import { defineEventHandler } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { servicesSnapshot } from './services.js'

/** Every service declared on this machine, with its live runtime resolved, plus
 *  the running processes nothing declares yet. The Services panel hydrates once
 *  from here and then only listens to `services.changed` — same shape on both
 *  sides, so there is nothing to keep in sync.
 *
 *  Machine-wide on purpose: the resource limits and the port namespace are per
 *  MACHINE, so a project-only response could never honestly answer "who took
 *  3000". Scoping to the open project is the client's job (and its default). */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return servicesSnapshot()
})
