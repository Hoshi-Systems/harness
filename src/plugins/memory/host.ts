import { hostBinding } from '../define.js'

/** This plugin's handle on the host it was started with — see `hostBinding`. */
export const { bind, ports } = hostBinding()
