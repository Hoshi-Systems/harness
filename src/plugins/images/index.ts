import { bindTools } from '../define-tool.js'
import type { ToolSet } from 'ai'
import { definePlugin } from '../define.js'
import { machineToolContext } from '../tool-context.js'
import { imageTools } from './tools.js'

/**
 * ── Generating an image from a turn ───────────────────────────────────────
 *
 * `image_generate` drives whichever connected provider on this machine has an
 * image-output-capable model — so "can this machine make pictures?" is answered
 * by the same credentials the chat already runs on, and a machine with no such
 * model simply cannot.
 *
 * Its own plugin because it is its own capability, and because the tool that
 * used to carry it (`widgets`) has nothing to do with providers
 * (docs/STRUCTURE_REVIEW.md H-08).
 *
 **/
export default definePlugin({
  name: 'images',
  description: 'Generating an image from a turn',

  setup(host) {
    host.tools.add(
      (context): ToolSet => bindTools(imageTools, machineToolContext(context)),
      () => Object.keys(imageTools),
    )
  },
})
