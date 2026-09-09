import { listPendingWidgets as listFromEngine, respondToWidget as respondInEngine } from './ui-tools.js'
import { apiError } from '../../kernel/index.js'

/**
 * ── Widgets ──────────────────────────────────────────────────────────────────
 *
 * A `ui_ask` tool call blocked waiting on the user, and the answer that
 * releases it.
 *
 * This file used to be an HTTP CLIENT. The tools ran inside another process, so
 * the only way to unblock one was for the plugin to bind a loopback listener
 * (127.0.0.1:4097) and for the sidecar to forward every answer to it — with all
 * the failure modes that implies: a bridge that was not reachable, a bridge that
 * had never started, two processes fighting over the port. Three of the five
 * error cases below existed only to describe the pipe.
 *
 * The tools are in this process now, so answering is a function call. What is
 * left is the part that was always real: an answer can arrive for a widget that
 * has already been answered, or for one that is gone.
 *
 * And they are in this DIRECTORY now (./ui-tools.ts) rather than reached through
 * a package boundary, which is what the last hop of that shortening looks like
 * (docs/STRUCTURE_REVIEW.md H-08). What stays here is the HTTP shape — an
 * `apiError` per outcome — because a route needs one and a tool does not.
 *
 **/

export interface PendingWidget {
  id: string
  kind: string
  sessionId: string
}

/** Deliver a user's answer to the blocked tool call. */
export function respondToWidget(id: string, response: Record<string, unknown>): void {
  const outcome = respondInEngine(id, response)
  if (outcome === 'already-answered') apiError(409, 'widgets.alreadyAnswered', 'This widget was already answered.')
  if (outcome === 'unknown') apiError(404, 'widgets.expired', 'This widget is no longer waiting for a response.')
}

/** Every widget currently waiting — the client's replay source when a
 *  refreshed tab has to recover one. */
export function listPendingWidgets(): PendingWidget[] {
  return listFromEngine()
}
