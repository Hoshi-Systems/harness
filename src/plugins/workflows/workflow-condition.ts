/**
 * ── Workflow step conditions ─────────────────────────────────────────────────
 *
 * The branching half of a workflow: a step's optional `when` expression is
 * evaluated against the SAME context utils/workflow-template.ts renders over
 * ({trigger.*, input, steps.<key>.text/.output}), and a step whose condition is
 * false is recorded `skipped` — not failed — so the pipeline continues.
 *
 * The language is deliberately tiny: paths, literals, presence, equality,
 * comparison, `contains`, and boolean combination. It is NOT a JS evaluator and
 * must never become one — a workflow definition can be published org-wide (the
 * org asset library), so its expressions run on someone else's machine and must
 * not be an arbitrary-code channel. Everything here is a hand-written tokenizer
 * plus a recursive-descent parser over a closed operator set; there is no
 * `Function`, no `eval`, no property access beyond the dot paths the template
 * layer already resolves, and no regular-expression operator (a published
 * definition would then carry a catastrophic-backtracking DoS).
 *
 * Evaluation is total: a path that resolves to nothing is falsy, and comparing
 * values of different shapes is false rather than an error. A condition can
 * only ever decide "run this step or skip it"; it can never fail a run.
 *
 **/

import { resolvePath } from './workflow-path.js'

/** Parse errors carry no position — the editor shows the message next to the
 *  field, and a caret index into a one-line expression adds nothing. */
export class WorkflowConditionError extends Error {}

const MAX_CONDITION_LENGTH = 500
/** Guards a pathological `((((…))))` from recursing the parser to death. */
const MAX_DEPTH = 20

/**
 * ── Tokenizer ────────────────────────────────────────────────────────────────
 *
 **/

type TokenType = 'path' | 'string' | 'number' | 'operator' | 'paren'

interface Token {
  type: TokenType
  value: string
}

/** Word-shaped operators, so `status == "done" and severity` reads as prose.
 *  Symbolic aliases exist for everyone who types `&&` by reflex. */
const WORD_OPERATORS = new Set(['and', 'or', 'not', 'contains'])
/** Literal keywords — tokenized as paths, resolved as values at eval time. */
const KEYWORDS = new Set(['true', 'false', 'null', 'empty'])

const SYMBOL_OPERATORS = ['==', '!=', '>=', '<=', '&&', '||', '>', '<', '!']

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const char = source[i]!
    if (/\s/.test(char)) {
      i++
      continue
    }
    if (char === '(' || char === ')') {
      tokens.push({ type: 'paren', value: char })
      i++
      continue
    }
    if (char === '"' || char === "'") {
      const end = source.indexOf(char, i + 1)
      if (end === -1) throw new WorkflowConditionError(`Unterminated string starting at ${char}.`)
      tokens.push({ type: 'string', value: source.slice(i + 1, end) })
      i = end + 1
      continue
    }
    const symbol = SYMBOL_OPERATORS.find((candidate) => source.startsWith(candidate, i))
    if (symbol) {
      tokens.push({ type: 'operator', value: symbol })
      i += symbol.length
      continue
    }
    /**
     *
     * A number, but only when it really is one: `2fa` is a path segment.
     *
     **/
    const number = /^-?\d+(\.\d+)?(?![\w.-])/.exec(source.slice(i))
    if (number) {
      tokens.push({ type: 'number', value: number[0] })
      i += number[0].length
      continue
    }
    /**
     *
     * A dot path — the same shape workflow-template.ts interpolates.
     *
     **/
    const path = /^[A-Za-z_][\w-]*(?:\.[\w-]+)*/.exec(source.slice(i))
    if (path) {
      const word = path[0].toLowerCase()
      tokens.push({
        type: WORD_OPERATORS.has(word) ? 'operator' : 'path',
        value: WORD_OPERATORS.has(word) ? word : path[0],
      })
      i += path[0].length
      continue
    }
    throw new WorkflowConditionError(`Unexpected character "${char}".`)
  }
  return tokens
}

/**
 * ── AST ──────────────────────────────────────────────────────────────────────
 *
 **/

type Node =
  | { kind: 'literal'; value: unknown }
  | { kind: 'path'; path: string }
  | { kind: 'not'; operand: Node }
  | { kind: 'and' | 'or'; left: Node; right: Node }
  | { kind: 'compare'; op: CompareOp; left: Node; right: Node }

type CompareOp = '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains'

const COMPARE_OPS = new Set<string>(['==', '!=', '>', '>=', '<', '<=', 'contains'])

/** A parsed `when` expression. Opaque on purpose — callers parse once
 *  (validation time) and evaluate many times (once per run). */
export interface WorkflowCondition {
  readonly root: Node
}

/**
 * ── Parser ───────────────────────────────────────────────────────────────────
 *
 * Precedence, loosest first: or → and → not → comparison → primary.
 *
 **/

class Parser {
  private index = 0

  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.parseOr(0)
    if (this.index < this.tokens.length) {
      throw new WorkflowConditionError(`Unexpected "${this.tokens[this.index]!.value}".`)
    }
    return node
  }

  private peek(): Token | undefined {
    return this.tokens[this.index]
  }

  private eatOperator(...values: string[]): string | null {
    const token = this.peek()
    if (token?.type === 'operator' && values.includes(token.value)) {
      this.index++
      return token.value
    }
    return null
  }

  private parseOr(depth: number): Node {
    let left = this.parseAnd(depth)
    while (this.eatOperator('or', '||')) {
      left = { kind: 'or', left, right: this.parseAnd(depth) }
    }
    return left
  }

  private parseAnd(depth: number): Node {
    let left = this.parseNot(depth)
    while (this.eatOperator('and', '&&')) {
      left = { kind: 'and', left, right: this.parseNot(depth) }
    }
    return left
  }

  private parseNot(depth: number): Node {
    if (this.eatOperator('not', '!')) return { kind: 'not', operand: this.parseNot(depth) }
    return this.parseComparison(depth)
  }

  private parseComparison(depth: number): Node {
    const left = this.parsePrimary(depth)
    const token = this.peek()
    if (token?.type === 'operator' && COMPARE_OPS.has(token.value)) {
      this.index++
      return { kind: 'compare', op: token.value as CompareOp, left, right: this.parsePrimary(depth) }
    }
    return left
  }

  private parsePrimary(depth: number): Node {
    if (depth >= MAX_DEPTH) throw new WorkflowConditionError('The condition nests too deeply.')
    const token = this.peek()
    if (!token) throw new WorkflowConditionError('The condition ends unexpectedly.')

    if (token.type === 'paren') {
      if (token.value === ')') throw new WorkflowConditionError('Unexpected ")".')
      this.index++
      const node = this.parseOr(depth + 1)
      const closing = this.peek()
      if (closing?.type !== 'paren' || closing.value !== ')') throw new WorkflowConditionError('Missing ")".')
      this.index++
      return node
    }
    this.index++
    if (token.type === 'string') return { kind: 'literal', value: token.value }
    if (token.type === 'number') return { kind: 'literal', value: Number(token.value) }
    if (token.type === 'path') {
      const keyword = token.value.toLowerCase()
      if (KEYWORDS.has(keyword)) {
        return { kind: 'literal', value: keyword === 'true' ? true : keyword === 'false' ? false : null }
      }
      return { kind: 'path', path: token.value }
    }
    throw new WorkflowConditionError(`Unexpected "${token.value}".`)
  }
}

/** Parse a `when` expression, or throw `WorkflowConditionError`. Called at the
 *  request boundary (utils/workflows.ts validation) so an unparseable condition
 *  never reaches disk, and again at run time on the stored snapshot. */
export function parseWorkflowCondition(source: string): WorkflowCondition {
  if (source.length > MAX_CONDITION_LENGTH) {
    throw new WorkflowConditionError(`A condition can be at most ${MAX_CONDITION_LENGTH} characters.`)
  }
  const tokens = tokenize(source)
  if (tokens.length === 0) throw new WorkflowConditionError('Enter a condition.')
  return { root: new Parser(tokens).parse() }
}

/**
 * ── Evaluation ───────────────────────────────────────────────────────────────
 *
 **/

/** Presence, the way a workflow author means it: absent, null, `false`, `0`,
 *  the empty string and an empty array/object are all "nothing here". */
function truthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number') return value !== 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as object).length > 0
  return Boolean(value)
}

/** `==` across the shapes a run context actually holds. Numbers and strings
 *  compare loosely in one direction only — `"3" == 3` is true, because a
 *  step's JSON output routinely stringifies what a trigger sent as a number —
 *  but objects compare structurally, never by reference. */
function equals(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || left === undefined || right === undefined) return false
  if (typeof left === 'object' || typeof right === 'object') {
    try {
      return JSON.stringify(left) === JSON.stringify(right)
    } catch {
      return false
    }
  }
  return String(left) === String(right)
}

/** Ordering comparison. Numbers compare numerically, everything else compares
 *  as strings; a value that can't be ordered (object, null, absent) makes the
 *  whole comparison false rather than an error. */
function order(left: unknown, right: unknown): number | null {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (
    (typeof left === 'number' || typeof left === 'string') &&
    (typeof right === 'number' || typeof right === 'string') &&
    Number.isFinite(leftNumber) &&
    Number.isFinite(rightNumber) &&
    String(left).trim() !== '' &&
    String(right).trim() !== ''
  ) {
    return leftNumber - rightNumber
  }
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0
  return null
}

/** Substring for strings, membership for arrays, key presence for objects. */
function contains(haystack: unknown, needle: unknown): boolean {
  if (typeof haystack === 'string') return haystack.includes(String(needle))
  if (Array.isArray(haystack)) return haystack.some((entry) => equals(entry, needle))
  if (haystack && typeof haystack === 'object') return Object.hasOwn(haystack as object, String(needle))
  return false
}

function valueOf(node: Node, context: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value
    case 'path':
      return resolvePath(context, node.path)
    default:
      return evaluateNode(node, context)
  }
}

function evaluateNode(node: Node, context: Record<string, unknown>): boolean {
  switch (node.kind) {
    case 'literal':
      return truthy(node.value)
    case 'path':
      return truthy(resolvePath(context, node.path))
    case 'not':
      return !evaluateNode(node.operand, context)
    case 'and':
      return evaluateNode(node.left, context) && evaluateNode(node.right, context)
    case 'or':
      return evaluateNode(node.left, context) || evaluateNode(node.right, context)
    case 'compare': {
      const left = valueOf(node.left, context)
      const right = valueOf(node.right, context)
      switch (node.op) {
        case '==':
          return equals(left, right)
        case '!=':
          return !equals(left, right)
        case 'contains':
          return contains(left, right)
        default: {
          const delta = order(left, right)
          if (delta === null) return false
          return node.op === '>' ? delta > 0 : node.op === '>=' ? delta >= 0 : node.op === '<' ? delta < 0 : delta <= 0
        }
      }
    }
  }
}

/** Evaluate a parsed condition against a run context. Total by construction —
 *  never throws, so a condition can only decide "run" or "skip". */
export function evaluateWorkflowCondition(condition: WorkflowCondition, context: Record<string, unknown>): boolean {
  return evaluateNode(condition.root, context)
}

/** Parse-and-evaluate for the executor, which holds the stored source rather
 *  than a parsed tree — reporting a parse failure instead of guessing past it.
 *
 *  v2's `conditionHolds` answered `true` on an unparseable expression, reasoning
 *  that skipping work over a syntax error was the worse failure. That was right
 *  for a per-step guard with two outcomes, and it is WRONG for a branch node:
 *  `true` there silently selects the first of up to eight cases and sends the
 *  run down a path nobody chose. A branch treats a failed parse as `false` and
 *  records a warning, so an unparseable case falls through to `else` — visible,
 *  and never a fabricated decision. Definitions are parsed at the API boundary
 *  (utils/workflow-graph.ts), so reaching this at all means a hand-edited file. */
export function tryCondition(
  source: string,
  context: Record<string, unknown>,
): { value: boolean; error: string | null } {
  try {
    return { value: evaluateWorkflowCondition(parseWorkflowCondition(source), context), error: null }
  } catch (error) {
    return { value: false, error: error instanceof WorkflowConditionError ? error.message : 'unrecognized expression' }
  }
}

/** @deprecated v2's linear-guard entry point — deleted with the last `when`
 *  when utils/workflow-runs.ts becomes the graph engine. Use `tryCondition`. */
export function conditionHolds(source: string, context: Record<string, unknown>): boolean {
  try {
    return evaluateWorkflowCondition(parseWorkflowCondition(source), context)
  } catch {
    return true
  }
}
