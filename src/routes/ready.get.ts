import { defineEventHandler } from 'h3'
/** Boot-readiness probe (CYB-94). Unauthenticated and deliberately minimal,
 *  like `/health` — a client checks this to know when a machine is genuinely
 *  enterable.
 *
 *  This route answering at all is now the whole answer. It used to also report
 *  whether a SEPARATE agent-runtime process was up and had finished warming its
 *  capability reads; the engine runs inside this process, so there is no second
 *  thing to be up. A machine with no API key yet is still ready — being able to
 *  go in and add one is the point. */
export default defineEventHandler(async () => ({ ok: true }))
