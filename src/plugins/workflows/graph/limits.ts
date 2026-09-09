/**
 * ── Limits ───────────────────────────────────────────────────────────────────
 *
 * Every ceiling in one place, because a limit is a promise to the person
 * drawing the canvas, and the two halves that enforce it — validation and the
 * builder's own inspector — have to be reading the same number.
 *
 * v2 capped a workflow at 20 steps. A graph spends nodes on structure (start,
 * end, branches, notes) that a list spent nothing on, so the ceiling rises —
 * but a run embeds its graph snapshot and pushes it to clients, so it stays a
 * ceiling rather than becoming unbounded.
 *
 **/

export const MAX_NODES = 60
export const MAX_EDGES = 160
export const MAX_NAME = 120
export const MAX_PROMPT = 8_000
export const MAX_SCHEMA = 4_000
export const MAX_NOTE = 4_000
export const MAX_URL = 2_000
export const MAX_HEADERS = 20
export const MAX_BRANCH_CASES = 8
export const MAX_STATE_KEYS = 32
export const MAX_NODE_RETRIES = 5
export const MIN_RETRY_BACKOFF_SECONDS = 1
export const MAX_RETRY_BACKOFF_SECONDS = 3_600
export const MAX_LOOP_ITERATIONS = 100
/** Nesting past two levels is unreadable on a canvas and multiplies the run
 *  file by the product of the iteration counts. */
export const MAX_LOOP_DEPTH = 2
export const MIN_APPROVAL_TIMEOUT_SECONDS = 60
export const MAX_APPROVAL_TIMEOUT_SECONDS = 30 * 24 * 60 * 60

/** How a node is addressed from a template: `nodes.<key>.output`. Slug-shaped
 *  so a path never needs quoting or escaping. */
export const NODE_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
