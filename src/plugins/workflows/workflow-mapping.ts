/**
 * ── Workflow value mappings ──────────────────────────────────────────────────
 *
 * How a v3 node computes a VALUE, as opposed to a prompt (utils/workflow-template.ts,
 * which produces text) or a decision (utils/workflow-condition.ts, which produces
 * a boolean). Five node kinds need one: `transform` reshapes data, `state` writes
 * run variables, `end` produces the run's output, `loop` resolves the array it
 * iterates, and an approval renders what the human is shown.
 *
 * This is a small JSON DSL, NOT an expression language, and that is the whole
 * design decision. The obvious alternative was to grow workflow-condition.ts —
 * already a hand-written tokenizer and recursive-descent parser — into something
 * that returns values. Three reasons not to:
 *
 *   1. That parser is a PREDICATE language and total by construction: every
 *      operator returns a boolean and a nonsense comparison is `false`, never an
 *      error. Making it yield values means arithmetic, string ops, array ops,
 *      precedence for all of them, and a real error semantics — at which point
 *      "deliberately tiny" has stopped being true. A workflow definition is
 *      publishable org-wide (utils/org-assets.ts) and therefore runs on OTHER
 *      PEOPLE'S machines, which is the same argument that file's own header
 *      makes for staying small. A DSL adds no parser at all.
 *   2. Validation is a structural walk with a depth cap: no precedence bugs, no
 *      parser depth-bomb, no new syntax to attack.
 *   3. It renders as canvas UI. A transform inspector is rows of `key ← value`,
 *      and the common case (`title ← nodes.fetch.output.title`) is one `path` or
 *      `template` op behind a plain text field. Structured ops only appear when
 *      the user asks for one.
 *
 * Evaluation is TOTAL, like every other workflow layer: a wrong shape yields
 * null plus a stable warning code, never a throw, so a transform can't take down
 * a run over a surprise in an HTTP response. Absolutely no `eval`, no
 * `new Function`, and no RegExp built from user input.
 *
 * SECRETS ARE NOT AVAILABLE HERE, deliberately. `{{secrets.X}}` resolves in agent
 * prompts and HTTP requests, where the value goes straight out and only a
 * redacted twin is persisted (utils/workflow-secrets.ts). A mapping's result is
 * stored — in run state, in a node's output, in the run's output — so resolving
 * a secret into one would persist it in clear. A `secrets.` path in a mapping
 * therefore resolves to nothing and reports `missing-path:secrets.X`.
 *
 **/

import { hasUnsafeSegment, resolvePath, UNSAFE_PATH_SEGMENTS } from './workflow-path.js'
import { evaluateWorkflowCondition, parseWorkflowCondition, WorkflowConditionError } from './workflow-condition.js'
import { renderTemplate } from './workflow-template.js'

export class WorkflowMappingError extends Error {}

const MAX_DEPTH = 8
const MAX_NODES = 200
const MAX_TEMPLATE = 8_000
const MAX_PATH = 200
const MAX_SEPARATOR = 64
const MAX_ENTRIES = 64
const MAX_ITEMS = 64
/** A mapping's result is persisted in the run file and pushed to clients on
 *  every transition, so it needs the same kind of ceiling a step's reply has. */
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_LITERAL_BYTES = 8 * 1024

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type Mapping =
  /** A dot path into the run context — the 90% case. */
  | { op: 'path'; path: string }
  | { op: 'literal'; value: JsonValue }
  /** `{{a.b}}` interpolation, producing a STRING. Single-pass, like every other
   *  render: an inserted value containing `{{…}}` is never re-processed. */
  | { op: 'template'; template: string }
  | { op: 'object'; entries: MappingEntry[] }
  | { op: 'array'; items: Mapping[] }
  /** `value`, or `fallback` when it resolves to null/undefined/''. */
  | { op: 'default'; value: Mapping; fallback: Mapping }
  | { op: 'json'; value: Mapping }
  | { op: 'stringify'; value: Mapping }
  | { op: 'number'; value: Mapping }
  | { op: 'length'; value: Mapping }
  | { op: 'join'; value: Mapping; separator: string }
  | { op: 'split'; value: Mapping; separator: string }
  | { op: 'slice'; value: Mapping; start: number; end: number | null }
  | { op: 'first'; value: Mapping }
  | { op: 'last'; value: Mapping }
  /** Keep the array entries whose condition holds over `{ item, index }`. */
  | { op: 'filter'; value: Mapping; when: string }
  /** Rewrite each array entry through `item`, over `{ item, index }`. */
  | { op: 'map'; value: Mapping; item: Mapping }

export interface MappingEntry {
  key: string
  value: Mapping
}

const OPS = new Set<string>([
  'path',
  'literal',
  'template',
  'object',
  'array',
  'default',
  'json',
  'stringify',
  'number',
  'length',
  'join',
  'split',
  'slice',
  'first',
  'last',
  'filter',
  'map',
])

/**
 * ── Validation ───────────────────────────────────────────────────────────────
 *
 * Runs at the API boundary (utils/workflow-graph.ts), so an unparseable mapping
 * never reaches disk and never reaches another machine through a published
 * definition — the same contract validateStepCondition held in v2.
 *
 **/

/** Validate and normalize one mapping. Throws `WorkflowMappingError`; the graph
 *  validator turns that into a 400 with a `workflow.mappingInvalid` code. */
export function validateMapping(raw: unknown): Mapping {
  const budget = { nodes: 0 }
  return walk(raw, 0, budget)
}

function walk(raw: unknown, depth: number, budget: { nodes: number }): Mapping {
  if (depth > MAX_DEPTH) throw new WorkflowMappingError(`A mapping may nest at most ${MAX_DEPTH} levels deep.`)
  if (++budget.nodes > MAX_NODES) throw new WorkflowMappingError(`A mapping may hold at most ${MAX_NODES} operations.`)

  const node = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const op = node.op
  if (typeof op !== 'string' || !OPS.has(op)) {
    throw new WorkflowMappingError(`"${String(op)}" is not a mapping operation.`)
  }

  const child = (value: unknown): Mapping => walk(value, depth + 1, budget)

  switch (op) {
    case 'path':
      return { op, path: validPath(node.path) }

    case 'literal':
      return { op, value: validLiteral(node.value) }

    case 'template': {
      const template = typeof node.template === 'string' ? node.template : ''
      if (template.length > MAX_TEMPLATE) {
        throw new WorkflowMappingError(`A template may be at most ${MAX_TEMPLATE} characters.`)
      }
      return { op, template }
    }

    case 'object': {
      const entriesRaw = Array.isArray(node.entries) ? node.entries : []
      if (entriesRaw.length > MAX_ENTRIES) {
        throw new WorkflowMappingError(`An object mapping may hold at most ${MAX_ENTRIES} keys.`)
      }
      const seen = new Set<string>()
      const entries = entriesRaw.map((entryRaw) => {
        const entry = (entryRaw && typeof entryRaw === 'object' ? entryRaw : {}) as Record<string, unknown>
        const key = typeof entry.key === 'string' ? entry.key.trim() : ''
        if (!key || key.length > 80) throw new WorkflowMappingError('Each object key must be 1–80 characters.')
        /**
         *
         * The reason utils/workflow-path.ts exists: this op is the one place a
         * workflow definition chooses a key that gets WRITTEN.
         *
         **/
        if (UNSAFE_PATH_SEGMENTS.has(key)) throw new WorkflowMappingError(`"${key}" is not an allowed object key.`)
        if (seen.has(key)) throw new WorkflowMappingError(`Object keys must be unique — "${key}" repeats.`)
        seen.add(key)
        return { key, value: child(entry.value) }
      })
      return { op, entries }
    }

    case 'array': {
      const itemsRaw = Array.isArray(node.items) ? node.items : []
      if (itemsRaw.length > MAX_ITEMS) {
        throw new WorkflowMappingError(`An array mapping may hold at most ${MAX_ITEMS} items.`)
      }
      return { op, items: itemsRaw.map(child) }
    }

    case 'default':
      return { op, value: child(node.value), fallback: child(node.fallback) }

    case 'json':
    case 'stringify':
    case 'number':
    case 'length':
    case 'first':
    case 'last':
      return { op, value: child(node.value) }

    case 'join':
    case 'split':
      return { op, value: child(node.value), separator: validSeparator(node.separator) }

    case 'slice': {
      const start = Math.trunc(Number(node.start ?? 0))
      const end = node.end == null ? null : Math.trunc(Number(node.end))
      if (!Number.isFinite(start) || (end !== null && !Number.isFinite(end))) {
        throw new WorkflowMappingError('Slice bounds must be whole numbers.')
      }
      return { op, value: child(node.value), start, end }
    }

    case 'filter':
      return { op, value: child(node.value), when: validCondition(node.when) }

    case 'map':
      return { op, value: child(node.value), item: child(node.item) }

    /* c8 ignore next 2 — OPS is the exhaustive guard above. */
    default:
      throw new WorkflowMappingError(`"${op}" is not a mapping operation.`)
  }
}

function validPath(raw: unknown): string {
  const path = typeof raw === 'string' ? raw.trim() : ''
  if (!path || path.length > MAX_PATH) throw new WorkflowMappingError(`A path must be 1–${MAX_PATH} characters.`)
  if (!/^[A-Za-z_][\w-]*(?:\.[\w-]+)*$/.test(path)) throw new WorkflowMappingError(`"${path}" is not a valid path.`)
  if (hasUnsafeSegment(path)) throw new WorkflowMappingError(`"${path}" walks a reserved property.`)
  return path
}

function validCondition(raw: unknown): string {
  const when = typeof raw === 'string' ? raw.trim() : ''
  if (!when) throw new WorkflowMappingError('A filter needs a condition.')
  try {
    parseWorkflowCondition(when)
  } catch (error) {
    throw new WorkflowMappingError(
      `The filter condition is not valid: ${error instanceof WorkflowConditionError ? error.message : 'unrecognized expression'}`,
    )
  }
  return when
}

function validSeparator(raw: unknown): string {
  const separator = typeof raw === 'string' ? raw : ''
  if (separator.length > MAX_SEPARATOR) {
    throw new WorkflowMappingError(`A separator may be at most ${MAX_SEPARATOR} characters.`)
  }
  return separator
}

/** A literal is inert data, but it is still persisted and pushed, so it gets a
 *  size ceiling and a JSON-shape check rather than being trusted wholesale. */
function validLiteral(raw: unknown): JsonValue {
  let serialized: string
  try {
    serialized = JSON.stringify(raw ?? null)
  } catch {
    throw new WorkflowMappingError('A literal must be JSON-serializable.')
  }
  if (serialized === undefined) throw new WorkflowMappingError('A literal must be JSON-serializable.')
  if (serialized.length > MAX_LITERAL_BYTES) {
    throw new WorkflowMappingError(`A literal may be at most ${MAX_LITERAL_BYTES} characters.`)
  }
  return JSON.parse(serialized) as JsonValue
}

/**
 * ── Evaluation ───────────────────────────────────────────────────────────────
 *
 **/

export interface MappingResult {
  value: unknown
  /** Stable codes, joined with the run's other warnings:
   *  `missing-path:<path>`, `mapping-not-array:<op>`, `mapping-parse-failed`,
   *  `mapping-output-too-large`. */
  warnings: string[]
}

/** Evaluate a validated mapping against a run context. Never throws. */
export function evaluateMapping(mapping: Mapping, context: Record<string, unknown>): MappingResult {
  const warnings: string[] = []
  const value = evaluate(mapping, context, warnings)

  /**
   *
   * The ceiling is on the RESULT, not the mapping: `{ op: 'path', path: 'nodes' }`
   * is three tokens and could pull every node's full text into run state.
   *
   **/
  let size = 0
  try {
    size = JSON.stringify(value ?? null)?.length ?? 0
  } catch {
    return { value: null, warnings: [...warnings, 'mapping-output-too-large'] }
  }
  if (size > MAX_OUTPUT_BYTES) return { value: null, warnings: [...warnings, 'mapping-output-too-large'] }

  return { value, warnings }
}

function evaluate(mapping: Mapping, context: Record<string, unknown>, warnings: string[]): unknown {
  switch (mapping.op) {
    case 'path': {
      const resolved = resolvePath(context, mapping.path)
      if (resolved === undefined) {
        warnings.push(`missing-path:${mapping.path}`)
        return null
      }
      return resolved
    }

    case 'literal':
      return mapping.value

    case 'template': {
      /**
       *
       * No secrets map — see the header. A `{{secrets.X}}` here is reported
       * missing by name (a name, never a value) rather than resolved.
       *
       **/
      const rendered = renderTemplate(mapping.template, context)
      for (const path of rendered.missing) warnings.push(`missing-path:${path}`)
      return rendered.text
    }

    case 'object': {
      const out: Record<string, unknown> = {}
      for (const entry of mapping.entries) out[entry.key] = evaluate(entry.value, context, warnings)
      return out
    }

    case 'array':
      return mapping.items.map((item) => evaluate(item, context, warnings))

    case 'default': {
      const value = evaluate(mapping.value, context, warnings)
      if (value === null || value === undefined || value === '') return evaluate(mapping.fallback, context, warnings)
      return value
    }

    case 'json': {
      const value = evaluate(mapping.value, context, warnings)
      if (typeof value !== 'string') return value
      try {
        return JSON.parse(value)
      } catch {
        warnings.push('mapping-parse-failed')
        return null
      }
    }

    case 'stringify': {
      const value = evaluate(mapping.value, context, warnings)
      if (typeof value === 'string') return value
      try {
        return JSON.stringify(value ?? null) ?? ''
      } catch {
        warnings.push('mapping-parse-failed')
        return null
      }
    }

    case 'number': {
      const value = evaluate(mapping.value, context, warnings)
      const parsed = Number(typeof value === 'string' ? value.trim() : value)
      return Number.isFinite(parsed) ? parsed : null
    }

    case 'length': {
      const value = evaluate(mapping.value, context, warnings)
      if (typeof value === 'string' || Array.isArray(value)) return value.length
      if (value && typeof value === 'object') return Object.keys(value).length
      return 0
    }

    case 'join': {
      const value = arrayOf(evaluate(mapping.value, context, warnings), 'join', warnings)
      return value === null ? null : value.map((entry) => stringify(entry)).join(mapping.separator)
    }

    case 'split': {
      const value = evaluate(mapping.value, context, warnings)
      if (typeof value !== 'string') return []
      /**
       *
       * An empty separator splits into characters, matching String#split.
       *
       **/
      return value.split(mapping.separator)
    }

    case 'slice': {
      const value = evaluate(mapping.value, context, warnings)
      if (typeof value === 'string') return value.slice(mapping.start, mapping.end ?? undefined)
      const array = arrayOf(value, 'slice', warnings)
      return array === null ? null : array.slice(mapping.start, mapping.end ?? undefined)
    }

    case 'first':
    case 'last': {
      const value = arrayOf(evaluate(mapping.value, context, warnings), mapping.op, warnings)
      if (value === null || value.length === 0) return null
      return mapping.op === 'first' ? value[0] : value[value.length - 1]
    }

    case 'filter': {
      const value = arrayOf(evaluate(mapping.value, context, warnings), 'filter', warnings)
      if (value === null) return null
      let condition
      try {
        condition = parseWorkflowCondition(mapping.when)
      } catch {
        warnings.push('mapping-parse-failed')
        return value
      }
      return value.filter((item, index) => evaluateWorkflowCondition(condition, itemContext(context, item, index)))
    }

    case 'map': {
      const value = arrayOf(evaluate(mapping.value, context, warnings), 'map', warnings)
      if (value === null) return null
      return value.map((item, index) => evaluate(mapping.item, itemContext(context, item, index), warnings))
    }
  }
}

/** The child context a `filter`/`map` body sees: the run context plus the entry
 *  under consideration, so `item.title` and `index` read naturally next to
 *  `nodes.fetch.output`. */
function itemContext(context: Record<string, unknown>, item: unknown, index: number): Record<string, unknown> {
  return { ...context, item, index }
}

function arrayOf(value: unknown, op: string, warnings: string[]): unknown[] | null {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined) return []
  warnings.push(`mapping-not-array:${op}`)
  return null
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}
