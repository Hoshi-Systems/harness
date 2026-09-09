import { bindTools, defineHoshiTool, z, type HoshiToolSet } from '../define-tool.js'
import type { PluginToolContext } from '../define.js'
import { machineToolContext } from '../tool-context.js'
import { readLink } from './links.js'

/**
 *
 * `context_open` — the half of a link that a quote cannot have.
 *
 * A link arrives in the conversation as one short line naming its source and a
 * preview of the passage. That is the point: it costs almost nothing to carry.
 * This is how the receiving turn spends more, and only when the rest turns out
 * to matter — it returns the WHOLE turn the passage came out of, not the
 * passage again, because an agent calling this has already read the excerpt and
 * found it insufficient.
 *
 * Scoped to the session the link was passed to. The store is machine-wide, so
 * without that check an id would be the only thing standing between one
 * conversation's transcript and another's.
 *
 **/
const factories = {
  context_open: defineHoshiTool({
    description: [
      'Open a context link that was passed into this conversation, to read the whole turn its',
      'passage came from. Use it when the excerpt you were given is not enough to answer.',
      'The id looks like lnk_… and appears in the message that carried it.',
    ].join(' '),
    args: {
      id: z.string().describe('The context link id, as it appears in the message (lnk_…).'),
    },
    async execute({ id }, context) {
      const result = await readLink(id, context.sessionId)
      if ('error' in result) {
        return { title: 'Context link', output: result.error, metadata: { id, ok: false } }
      }
      /**
       *
       * A dead source is SAID rather than shown as a shorter answer. The model
       * asked for more and is getting the recorded passage back; without the
       * note it would read that as the whole turn and conclude the source said
       * very little.
       *
       **/
      const note = result.gone
        ? '\n\n(The source conversation is gone; this is the passage as it was recorded when it was passed.)'
        : ''
      return {
        title: `Context from "${result.title}"`,
        output: `${result.turn}${note}`,
        metadata: { id, title: result.title, gone: result.gone, excerpt: result.excerpt },
      }
    },
  }),
}

export function contextTools(context: PluginToolContext): HoshiToolSet {
  return bindTools(factories, machineToolContext(context))
}

export function contextToolNames(): string[] {
  return Object.keys(factories)
}
