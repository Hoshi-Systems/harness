import { isValidSecretKey, readSecretValue } from '../../kernel/index.js'
import { SECRET_MASK } from './workflow-template.js'
import type { WorkflowNode } from './graph/index.js'

/**
 * ── `{{secrets.NAME}}` in workflows ──────────────────────────────────────────
 *
 * A node's templates may reference the machine's vault (utils/secrets.ts) by KEY
 * NAME. The value is resolved at SEND time and nowhere else:
 *
 *   • the run record stores the REDACTED render (utils/workflow-template.ts
 *     produces both in one pass), so ~/.hoshi/workflow-runs.json never holds a
 *     secret and neither does the `workflow.run.updated` push the runs panel
 *     renders from;
 *   • a node's stored reply and error strings are redacted on the way in,
 *     because an agent can echo what it was handed;
 *   • nothing here is ever logged.
 *
 * A published workflow definition (the org asset library) therefore carries
 * secret NAMES only — the value lives in the installing user's own vault, or
 * nowhere, and a missing key renders empty with a `missing-secret:<KEY>`
 * warning rather than leaking whose machine it was authored on.
 *
 * Redaction is by VALUE, and the values are never persisted to do it: the keys
 * a node references are re-derived from its stored templates and read back out
 * of the vault, which also makes redaction survive a sidecar restart.
 *
 **/

/** The `secrets.` namespace inside the template's `{{dot.path}}` syntax.
 *  Deliberately one level deep — a secret is a flat env-style key. */
const SECRET_REFERENCE = /\{\{\s*secrets\.([A-Za-z_][\w]*)\s*\}\}/g

/** Vault keys a template references, deduped and in first-appearance order.
 *  Names that couldn't be vault keys at all are dropped here rather than
 *  round-tripping a bogus read. */
export function referencedSecretKeys(template: string): string[] {
  const keys: string[] = []
  for (const match of template.matchAll(SECRET_REFERENCE)) {
    const key = match[1]!
    if (isValidSecretKey(key) && !keys.includes(key)) keys.push(key)
  }
  return keys
}

/** Read the referenced keys out of the vault. Absent keys are simply missing
 *  from the map — the template layer reports them as `missing-secret:<KEY>`. */
export async function resolveSecrets(keys: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>()
  for (const key of keys) {
    const value = await readSecretValue(key)
    if (value !== null && value !== '') resolved.set(key, value)
  }
  return resolved
}

/** Every templated field of a node, as one blob to derive secret names from.
 *  This is the single definition of "what this node could interpolate a secret
 *  into", so redaction can never miss a field a new node kind added — which is
 *  why it lives here rather than being spelled out at the dispatch site. */
export function nodeSecretSources(node: WorkflowNode): string {
  switch (node.kind) {
    case 'agent':
      return node.prompt
    case 'http':
      return [node.http.url, ...Object.values(node.http.headers), node.http.body ?? ''].join('\n')
    case 'approval':
      return node.message
    /**
     *
     * Every other kind computes over the run context alone. Mappings
     * deliberately cannot resolve secrets at all (utils/workflow-mapping.ts):
     * their results are persisted, and a persisted secret is a leaked one.
     *
     **/
    default:
      return ''
  }
}

/** Strip resolved secret values out of text that is about to be stored or
 *  shown — a reply that quoted the token back, an error message that echoed the
 *  request. Longest value first so a secret that contains another still masks
 *  whole. */
export function redactSecrets(text: string, values: Iterable<string>): string {
  let redacted = text
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (!value) continue
    redacted = redacted.split(value).join(SECRET_MASK)
  }
  return redacted
}
