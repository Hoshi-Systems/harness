/**
 * ── Context path resolution ──────────────────────────────────────────────────
 *
 * The one dot-path resolver every workflow layer reads context through:
 * utils/workflow-template.ts interpolating `{{a.b.c}}`, utils/workflow-condition.ts
 * evaluating `a.b.c == "x"`, and utils/workflow-mapping.ts pulling values for a
 * transform. It used to be copy-pasted into the first two, which is how both
 * copies ended up walking the prototype chain.
 *
 * Resolution is OWN-PROPERTY ONLY. Plain bracket access reaches `__proto__`,
 * `constructor` and everything hanging off `Object.prototype`, so `{{x.constructor.name}}`
 * resolved to "Object" instead of nothing. That was merely untidy while paths
 * were read-only — but the mapping DSL WRITES keys chosen by a workflow
 * definition, and a workflow definition can be published org-wide and installed
 * on someone else's machine (utils/org-assets.ts). An `object` mapping with a
 * `__proto__` entry is prototype pollution with a supply chain. So the denylist
 * below is enforced at validation time and `Object.hasOwn` at resolution time —
 * belt and braces, because only one of the two survives a future refactor.
 *
 **/

/** Segments that may never appear in a path or be written as an object key.
 *  Rejected at validation time (utils/workflow-mapping.ts, utils/workflow-graph.ts)
 *  so a bad definition never reaches disk, and never reaches another machine. */
export const UNSAFE_PATH_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

export function hasUnsafeSegment(path: string): boolean {
  return path.split('.').some((segment) => UNSAFE_PATH_SEGMENTS.has(segment))
}

/** Walk `path` through `context`, returning `undefined` the moment a segment
 *  isn't an own property of a live object. Total: never throws, whatever shape
 *  the context turns out to hold. Array indices work because an array's indices
 *  (and `length`) really are own properties. */
export function resolvePath(context: unknown, path: string): unknown {
  let current: unknown = context
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    if (!Object.hasOwn(current, segment)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}
