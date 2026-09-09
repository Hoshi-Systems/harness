import { hostBinding } from '../define.js'

/** This plugin's handle on the host it was started with — see `hostBinding`.
 *  `web-control/index.ts` binds it; anything in this directory reads through it. */
export const { bind, ports } = hostBinding()
