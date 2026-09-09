/** The slug shape a name has to have to be usable as a key: an agent, an MCP
 *  server, a command, a skill, a provider id.
 *
 *  It began as "what the old runtime's config file accepts", which is why it
 *  lived in that module. It outlived it, because the constraint is real on its
 *  own terms — these names become filenames, JSON keys and URL segments, and
 *  every one of those has a different opinion about spaces, slashes and case. */
const CONFIG_KEY = /^[a-z0-9][a-z0-9-_]{0,63}$/

export function isConfigKey(value: string): boolean {
  return CONFIG_KEY.test(value)
}
