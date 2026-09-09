import { describe, expect, it } from 'vitest'

import { compileGraph, validateWorkflowGraph, type CompiledGraph } from './graph/index.js'
import {
  buildRunContext,
  collectLoopIteration,
  deadlockedNodeRun,
  ensureNodeRun,
  findNodeRun,
  loopBodyPath,
  loopIterationActive,
  pathChain,
  pickReadyNodeRun,
  promoteFinishedLoops,
  pruneNodeRun,
  readyNodeRuns,
  runIsIdle,
  settleNodeRun,
  spawnLoopIteration,
  type SchedulerRun,
  type WorkflowRunNodeRun,
} from './workflow-scheduler.js'

/**
 * ── Harness ─────────────────────────────────────────────────────────────────
 *
 **/

const node = (id: string, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  key: id,
  name: id,
  kind,
  position: { x: 0, y: 0 },
  parentId: null,
  join: 'all',
  ...extra,
})
const agent = (id: string, extra: Record<string, unknown> = {}) => node(id, 'agent', { prompt: 'go', ...extra })
const edge = (source: string, target: string, sourcePort = 'out') => ({
  id: `${source}:${sourcePort}->${target}`,
  source,
  sourcePort,
  target,
  targetPort: 'in',
})

const build = (nodes: unknown[], edges: unknown[]): { run: SchedulerRun; graph: CompiledGraph } => {
  const graph = compileGraph(validateWorkflowGraph({ nodes, edges }))
  const run: SchedulerRun = { nodeRuns: [], state: {}, input: null }
  ensureNodeRun(run, graph, graph.start.id, '')
  return { run, graph }
}

/** Settle a node run as `done` on `port`, the way the executor would. */
const complete = (
  run: SchedulerRun,
  graph: CompiledGraph,
  nodeRun: WorkflowRunNodeRun,
  port = 'out',
  text = '',
): void => {
  nodeRun.status = 'done'
  nodeRun.text = text
  settleNodeRun(run, graph, nodeRun, port)
}

const statusOf = (run: SchedulerRun, nodeId: string, path = ''): string | undefined =>
  findNodeRun(run, nodeId, path)?.status

describe('the frontier', () => {
  it('starts with only the start node ready, and derives the frontier from status', () => {
    const { run, graph } = build(
      [node('start', 'start'), agent('work'), node('end', 'end')],
      [edge('start', 'work'), edge('work', 'end')],
    )
    expect(readyNodeRuns(run).map((entry) => entry.nodeId)).toEqual(['start'])

    complete(run, graph, findNodeRun(run, 'start', '')!)
    expect(readyNodeRuns(run).map((entry) => entry.nodeId)).toEqual(['work'])
    /**
     *
     * The successor was created lazily, on arrival — not up front.
     *
     **/
    expect(run.nodeRuns.map((entry) => entry.nodeId)).toEqual(['start', 'work'])
  })

  it('picks deterministically by creation order, stable across a JSON round-trip', () => {
    const { run, graph } = build(
      [node('start', 'start'), agent('a'), agent('b'), node('end', 'end')],
      [edge('start', 'a'), edge('start', 'b'), edge('a', 'end'), edge('b', 'end')],
    )
    complete(run, graph, findNodeRun(run, 'start', '')!)
    expect(readyNodeRuns(run)).toHaveLength(2)

    const first = pickReadyNodeRun(run)!.nodeId
    const revived: SchedulerRun = JSON.parse(JSON.stringify(run))
    expect(pickReadyNodeRun(revived)!.nodeId).toBe(first)
  })
})

describe('branches and pruning', () => {
  const branchGraph = () =>
    build(
      [
        node('start', 'start'),
        node('pick', 'branch', { cases: [{ id: 'c1', when: 'input.hot' }] }),
        agent('hot'),
        agent('cold'),
        node('end', 'end'),
      ],
      [
        edge('start', 'pick'),
        edge('pick', 'hot', 'case:c1'),
        edge('pick', 'cold', 'else'),
        edge('hot', 'end'),
        edge('cold', 'end'),
      ],
    )

  it('takes one leg and prunes the other — pruned is a decision, not an error', () => {
    const { run, graph } = branchGraph()
    complete(run, graph, findNodeRun(run, 'start', '')!)
    complete(run, graph, findNodeRun(run, 'pick', '')!, 'case:c1')

    expect(statusOf(run, 'hot')).toBe('pending')
    expect(statusOf(run, 'cold')).toBe('pruned')
  })

  it('runs the join exactly once, on the leg that survived', () => {
    const { run, graph } = branchGraph()
    complete(run, graph, findNodeRun(run, 'start', '')!)
    complete(run, graph, findNodeRun(run, 'pick', '')!, 'case:c1')

    /**
     *
     * The pruned leg already resolved its edge into `end`; the live one hasn't.
     *
     **/
    expect(statusOf(run, 'end')).toBe('blocked')
    complete(run, graph, findNodeRun(run, 'hot', '')!)

    expect(statusOf(run, 'end')).toBe('pending')
    expect(run.nodeRuns.filter((entry) => entry.nodeId === 'end')).toHaveLength(1)
  })

  it('cascades a prune transitively, so a dead path never strands a node as blocked', () => {
    const { run, graph } = build(
      [
        node('start', 'start'),
        node('pick', 'branch', { cases: [{ id: 'c1', when: 'input.hot' }] }),
        agent('a'),
        agent('b'),
        agent('c'),
        node('end', 'end'),
      ],
      [
        edge('start', 'pick'),
        edge('pick', 'a', 'case:c1'),
        edge('pick', 'b', 'else'),
        edge('b', 'c'),
        edge('a', 'end'),
        edge('c', 'end'),
      ],
    )
    complete(run, graph, findNodeRun(run, 'start', '')!)
    complete(run, graph, findNodeRun(run, 'pick', '')!, 'case:c1')

    expect(statusOf(run, 'b')).toBe('pruned')
    expect(statusOf(run, 'c')).toBe('pruned')
    expect(deadlockedNodeRun(run)).toBeUndefined()
  })

  it('prunes the join too when every leg dies', () => {
    const { run, graph } = branchGraph()
    complete(run, graph, findNodeRun(run, 'start', '')!)
    /**
     *
     * A branch that matched no case and has no `else` edge wired settles with a
     * port nothing listens on — every downstream path is dead.
     *
     **/
    complete(run, graph, findNodeRun(run, 'pick', '')!, 'nonexistent')

    expect(statusOf(run, 'hot')).toBe('pruned')
    expect(statusOf(run, 'cold')).toBe('pruned')
    expect(statusOf(run, 'end')).toBe('pruned')
    expect(runIsIdle(run)).toBe(true)
  })

  it('lets a guard diamond skip one node without stalling the rest of the run', () => {
    /**
     *
     * "Run this node only if X" has no hidden condition field in v3 — it is a
     * branch whose `else` leg hops straight to the same successor. This is the
     * shape that makes that idiom cost nothing.
     *
     **/
    const { run, graph } = build(
      [
        node('start', 'start'),
        node('guard', 'branch', { cases: [{ id: 'c1', when: 'input.go' }] }),
        agent('guarded'),
        node('end', 'end'),
      ],
      [
        edge('start', 'guard'),
        edge('guard', 'guarded', 'case:c1'),
        edge('guard', 'end', 'else'),
        edge('guarded', 'end'),
      ],
    )
    complete(run, graph, findNodeRun(run, 'start', '')!)
    complete(run, graph, findNodeRun(run, 'guard', '')!, 'else')

    /**
     *
     * The guarded node is skipped and the run carries on to `end`.
     *
     **/
    expect(statusOf(run, 'guarded')).toBe('pruned')
    expect(statusOf(run, 'end')).toBe('pending')
  })
})

describe('joins', () => {
  const diamond = (join: 'all' | 'any') =>
    build(
      [node('start', 'start'), agent('a'), agent('b'), node('end', 'end', { join })],
      [edge('start', 'a'), edge('start', 'b'), edge('a', 'end'), edge('b', 'end')],
    )

  it("join 'all' waits for every leg that can still arrive", () => {
    const { run, graph } = diamond('all')
    complete(run, graph, findNodeRun(run, 'start', '')!)

    complete(run, graph, findNodeRun(run, 'a', '')!)
    expect(statusOf(run, 'end')).toBe('blocked')

    complete(run, graph, findNodeRun(run, 'b', '')!)
    expect(statusOf(run, 'end')).toBe('pending')
  })

  it("join 'any' fires on the first arrival and writes off the rest", () => {
    const { run, graph } = diamond('any')
    complete(run, graph, findNodeRun(run, 'start', '')!)
    complete(run, graph, findNodeRun(run, 'a', '')!)

    expect(statusOf(run, 'end')).toBe('pending')
    /**
     *
     * Recorded immediately, so a later arrival can't re-open a settled decision.
     *
     **/
    const end = findNodeRun(run, 'end', '')!
    expect(Object.values(end.inbound).filter((value) => value === 'pruned')).toHaveLength(1)
  })

  it('never overwrites an edge that already resolved', () => {
    const { run, graph } = diamond('any')
    complete(run, graph, findNodeRun(run, 'start', '')!)
    complete(run, graph, findNodeRun(run, 'a', '')!)
    const before = { ...findNodeRun(run, 'end', '')!.inbound }

    complete(run, graph, findNodeRun(run, 'b', '')!)
    expect(findNodeRun(run, 'end', '')!.inbound).toEqual(before)
  })
})

describe('loops', () => {
  const loopGraph = () =>
    build(
      [
        node('start', 'start'),
        node('each', 'loop', { mode: 'foreach', source: { op: 'path', path: 'input.items' }, maxIterations: 10 }),
        agent('inner', { parentId: 'each' }),
        node('end', 'end'),
      ],
      [edge('start', 'each'), edge('each', 'inner', 'body'), edge('each', 'end', 'done')],
    )

  it('spawns one execution of the body per iteration, each in its own scope', () => {
    const { run, graph } = loopGraph()
    complete(run, graph, findNodeRun(run, 'start', '')!)
    const loop = findNodeRun(run, 'each', '')!
    loop.status = 'running'
    loop.loop = { index: 0, total: 2, items: ['first', 'second'], results: [] }

    spawnLoopIteration(run, graph, loop, 0)
    expect(statusOf(run, 'inner', 'each#0')).toBe('pending')
    expect(loopIterationActive(run, loop, 0)).toBe(true)

    complete(run, graph, findNodeRun(run, 'inner', 'each#0')!, 'out', 'did first')
    expect(loopIterationActive(run, loop, 0)).toBe(false)

    spawnLoopIteration(run, graph, loop, 1)
    expect(statusOf(run, 'inner', 'each#1')).toBe('pending')
    /**
     *
     * Iteration 0's execution is untouched — separate rows, not a reset.
     *
     **/
    expect(statusOf(run, 'inner', 'each#0')).toBe('done')
  })

  it('becomes ready again once its iteration drains, instead of hanging forever', () => {
    const { run, graph } = loopGraph()
    complete(run, graph, findNodeRun(run, 'start', '')!)
    const loop = findNodeRun(run, 'each', '')!
    loop.status = 'running'
    loop.loop = { index: 0, total: 2, items: ['a', 'b'], results: [] }
    spawnLoopIteration(run, graph, loop, 0)

    /**
     *
     * Mid-iteration the loop must stay put — promoting it here would bank an
     * iteration that hasn't happened.
     *
     **/
    expect(promoteFinishedLoops(run)).toEqual([])
    expect(readyNodeRuns(run).map((entry) => entry.nodeId)).toEqual(['inner'])

    complete(run, graph, findNodeRun(run, 'inner', 'each#0')!)
    /**
     *
     * Nothing is ready and the loop is `running`: without promotion the run has
     * nothing to do, nothing in flight, and no deadlock either — a silent hang.
     *
     **/
    expect(promoteFinishedLoops(run).map((entry) => entry.nodeId)).toEqual(['each'])
    expect(readyNodeRuns(run).map((entry) => entry.nodeId)).toEqual(['each'])
  })

  it('closes an inner loop before the outer one hears about it', () => {
    const { run, graph } = build(
      [
        node('start', 'start'),
        node('outer', 'loop', { mode: 'foreach', source: { op: 'path', path: 'input.a' }, maxIterations: 5 }),
        node('inner', 'loop', {
          parentId: 'outer',
          mode: 'foreach',
          source: { op: 'path', path: 'input.b' },
          maxIterations: 5,
        }),
        agent('work', { parentId: 'inner' }),
        node('end', 'end'),
      ],
      [
        edge('start', 'outer'),
        edge('outer', 'inner', 'body'),
        edge('inner', 'work', 'body'),
        edge('outer', 'end', 'done'),
      ],
    )
    complete(run, graph, findNodeRun(run, 'start', '')!)
    const outer = findNodeRun(run, 'outer', '')!
    outer.status = 'running'
    outer.loop = { index: 0, total: 1, items: ['x'], results: [] }
    spawnLoopIteration(run, graph, outer, 0)

    const inner = findNodeRun(run, 'inner', 'outer#0')!
    inner.status = 'running'
    inner.loop = { index: 0, total: 1, items: ['y'], results: [] }
    spawnLoopIteration(run, graph, inner, 0)
    complete(run, graph, findNodeRun(run, 'work', 'outer#0/inner#0')!)

    /**
     *
     * Only the inner loop is ready: the outer one still has a live child.
     *
     **/
    expect(promoteFinishedLoops(run).map((entry) => entry.nodeId)).toEqual(['inner'])
  })

  it('never settles a loop into its own body — that is a spawn, not an edge', () => {
    const { run, graph } = loopGraph()
    complete(run, graph, findNodeRun(run, 'start', '')!)
    /**
     *
     * Settling the loop on `done` must reach `end` and leave the body alone.
     *
     **/
    complete(run, graph, findNodeRun(run, 'each', '')!, 'done')

    expect(statusOf(run, 'end')).toBe('pending')
    expect(findNodeRun(run, 'inner', '')).toBeUndefined()
  })

  it('collects each iteration keyed the way the context exposes it', () => {
    const { run, graph } = loopGraph()
    complete(run, graph, findNodeRun(run, 'start', '')!)
    const loop = findNodeRun(run, 'each', '')!
    loop.loop = { index: 0, total: 1, items: ['x'], results: [] }
    spawnLoopIteration(run, graph, loop, 0)

    const inner = findNodeRun(run, 'inner', 'each#0')!
    inner.output = { ok: true }
    complete(run, graph, inner, 'out', 'done it')

    expect(collectLoopIteration(run, loop, 0)).toEqual({ inner: { text: 'done it', output: { ok: true } } })
  })

  it('exposes the iteration item and index to the body', () => {
    const { run, graph } = loopGraph()
    complete(run, graph, findNodeRun(run, 'start', '')!)
    const loop = findNodeRun(run, 'each', '')!
    loop.loop = { index: 1, total: 2, items: [{ title: 'first' }, { title: 'second' }], results: [] }
    spawnLoopIteration(run, graph, loop, 1)

    const context = buildRunContext(run, graph, 'each#1')
    expect(context.loop).toEqual({ index: 1, item: { title: 'second' }, count: 2, first: false, last: true })
    expect((context.loops as Record<string, unknown>).each).toEqual(context.loop)
  })
})

describe('the run context', () => {
  it('exposes only completed nodes, so a pruned path reads as missing', () => {
    const { run, graph } = build(
      [
        node('start', 'start'),
        node('pick', 'branch', { cases: [{ id: 'c1', when: 'input.hot' }] }),
        agent('hot'),
        agent('cold'),
        node('end', 'end'),
      ],
      [
        edge('start', 'pick'),
        edge('pick', 'hot', 'case:c1'),
        edge('pick', 'cold', 'else'),
        edge('hot', 'end'),
        edge('cold', 'end'),
      ],
    )
    complete(run, graph, findNodeRun(run, 'start', '')!)
    complete(run, graph, findNodeRun(run, 'pick', '')!, 'case:c1')
    complete(run, graph, findNodeRun(run, 'hot', '')!, 'out', 'hot reply')

    const nodes = buildRunContext(run, graph, '').nodes as Record<string, unknown>
    expect(nodes.hot).toEqual({ text: 'hot reply', output: null })
    expect(nodes.cold).toBeUndefined()
  })

  it('lets a loop body see its own iteration first, then the outer graph', () => {
    const { run, graph } = build(
      [
        node('start', 'start'),
        agent('outer'),
        node('each', 'loop', { mode: 'foreach', source: { op: 'path', path: 'input.items' }, maxIterations: 5 }),
        agent('inner', { parentId: 'each' }),
        node('end', 'end'),
      ],
      [edge('start', 'outer'), edge('outer', 'each'), edge('each', 'inner', 'body'), edge('each', 'end', 'done')],
    )
    complete(run, graph, findNodeRun(run, 'start', '')!)
    complete(run, graph, findNodeRun(run, 'outer', '')!, 'out', 'outer reply')

    const loop = findNodeRun(run, 'each', '')!
    loop.loop = { index: 0, total: 1, items: ['x'], results: [] }
    spawnLoopIteration(run, graph, loop, 0)
    complete(run, graph, findNodeRun(run, 'inner', 'each#0')!, 'out', 'inner reply')

    const nodes = buildRunContext(run, graph, 'each#0').nodes as Record<string, { text: string }>
    expect(nodes.inner.text).toBe('inner reply')
    expect(nodes.outer.text).toBe('outer reply')
  })

  it('scopes paths innermost-first', () => {
    expect(pathChain('a#0/b#1')).toEqual(['a#0/b#1', 'a#0', ''])
    expect(pathChain('')).toEqual([''])
  })

  it('builds an iteration path that nests', () => {
    const outer = { nodeId: 'a', path: '' } as WorkflowRunNodeRun
    expect(loopBodyPath(outer, 2)).toBe('a#2')
    const inner = { nodeId: 'b', path: 'a#2' } as WorkflowRunNodeRun
    expect(loopBodyPath(inner, 0)).toBe('a#2/b#0')
  })
})

describe('deadlock detection', () => {
  it('stays quiet while anything is still runnable', () => {
    const { run, graph } = build(
      [node('start', 'start'), agent('work'), node('end', 'end')],
      [edge('start', 'work'), edge('work', 'end')],
    )
    complete(run, graph, findNodeRun(run, 'start', '')!)
    expect(deadlockedNodeRun(run)).toBeUndefined()
  })

  it('reports a node whose inbound edge never resolved, instead of closing the run as done', () => {
    const { run, graph } = build(
      [node('start', 'start'), agent('a'), agent('b'), node('end', 'end')],
      [edge('start', 'a'), edge('start', 'b'), edge('a', 'end'), edge('b', 'end')],
    )
    complete(run, graph, findNodeRun(run, 'start', '')!)
    complete(run, graph, findNodeRun(run, 'a', '')!)
    /**
     *
     * `b` goes missing without settling — the shape a bug in the engine leaves.
     *
     **/
    findNodeRun(run, 'b', '')!.status = 'error'

    /**
     *
     * Not idle: `end` is still blocked. Nothing can ever unblock it, though,
     * which is exactly the state v2 would have closed out as a successful run.
     *
     **/
    expect(runIsIdle(run)).toBe(false)
    expect(readyNodeRuns(run)).toHaveLength(0)
    expect(deadlockedNodeRun(run)?.nodeId).toBe('end')
  })

  it('is not fooled by a pruned node, which is settled rather than stuck', () => {
    const { run, graph } = build(
      [node('start', 'start'), agent('work'), node('end', 'end')],
      [edge('start', 'work'), edge('work', 'end')],
    )
    complete(run, graph, findNodeRun(run, 'start', '')!)
    pruneNodeRun(run, graph, findNodeRun(run, 'work', '')!)

    expect(statusOf(run, 'end')).toBe('pruned')
    expect(runIsIdle(run)).toBe(true)
    expect(deadlockedNodeRun(run)).toBeUndefined()
  })
})
