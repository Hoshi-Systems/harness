import { describe, expect, it } from 'vitest'

import {
  compileGraph,
  graphProblems,
  nodeProblems,
  requireRunnableGraph,
  outputPorts,
  retriesFor,
  validateWorkflowGraph,
  type WorkflowBranchNode,
  type WorkflowNode,
} from './graph/index.js'

/**
 * ── Builders ─────────────────────────────────────────────────────────────────
 *
 * Graphs are verbose by nature; these keep each test to the one thing it is
 * about. Ids are explicit so edges can name them.
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

const start = (id = 'start') => node(id, 'start')
const end = (id = 'end') => node(id, 'end')
const agent = (id: string, extra: Record<string, unknown> = {}) => node(id, 'agent', { prompt: 'do it', ...extra })
const branch = (id: string, cases: Array<{ id: string; when: string }>) => node(id, 'branch', { cases })
const loop = (id: string, extra: Record<string, unknown> = {}) =>
  node(id, 'loop', { mode: 'foreach', source: { op: 'path', path: 'input.items' }, maxIterations: 10, ...extra })

const edge = (source: string, target: string, sourcePort = 'out'): Record<string, unknown> => ({
  id: `${source}->${target}:${sourcePort}`,
  source,
  sourcePort,
  target,
  targetPort: 'in',
})

/** The smallest legal workflow: start → agent → end. */
const linear = (): { nodes: unknown[]; edges: unknown[] } => ({
  nodes: [start(), agent('work'), end()],
  edges: [edge('start', 'work'), edge('work', 'end')],
})

const expectRejected = (graph: { nodes: unknown[]; edges: unknown[] }, code: string): void => {
  try {
    validateWorkflowGraph(graph)
  } catch (error) {
    expect((error as { data?: { code?: string } }).data?.code).toBe(code)
    return
  }
  throw new Error(`expected the graph to be rejected with ${code}`)
}

describe('validateWorkflowGraph', () => {
  it('accepts the smallest legal workflow and mints missing ids', () => {
    const graph = validateWorkflowGraph(linear())
    expect(graph.nodes).toHaveLength(3)
    expect(graph.edges).toHaveLength(2)
    expect(graph.edges.every((entry) => entry.targetPort === 'in')).toBe(true)
  })

  it('requires exactly one start and at least one end', () => {
    expectRejected({ nodes: [agent('work'), end()], edges: [edge('work', 'end')] }, 'workflow.startMissing')
    expectRejected(
      { nodes: [start('a'), start('b'), end()], edges: [edge('a', 'end'), edge('b', 'end')] },
      'workflow.startDuplicate',
    )
    expectRejected({ nodes: [start(), agent('work')], edges: [edge('start', 'work')] }, 'workflow.endMissing')
  })

  it('rejects a dangling edge, a self-edge and an unknown port', () => {
    expectRejected({ ...linear(), edges: [edge('start', 'ghost')] }, 'workflow.edgeDangling')
    expectRejected(
      { nodes: [start(), agent('work'), end()], edges: [edge('work', 'work'), edge('start', 'work')] },
      'workflow.edgeSelf',
    )
    expectRejected(
      { nodes: [start(), agent('work'), end()], edges: [edge('start', 'work', 'approved'), edge('work', 'end')] },
      'workflow.edgePortUnknown',
    )
  })

  it('refuses to connect anything into a start or a note', () => {
    expectRejected(
      { nodes: [start(), agent('work'), end()], edges: [edge('work', 'start'), edge('start', 'work')] },
      'workflow.edgeTargetClosed',
    )
  })

  it('rejects the same connection declared twice', () => {
    const graph = linear()
    expectRejected({ ...graph, edges: [...graph.edges, edge('start', 'work')] }, 'workflow.edgeDuplicate')
  })

  it('rejects a node that can never run, wired or not', () => {
    /**
     *
     * Dropped on the canvas and never connected.
     *
     **/
    expectRejected(
      { nodes: [start(), agent('work'), agent('stray'), end()], edges: [edge('start', 'work'), edge('work', 'end')] },
      'workflow.unreachable',
    )
    /**
     *
     * Wired to something, but that something is itself unreachable — one check
     * covers both, which is why there is no separate orphan rule.
     *
     **/
    expectRejected(
      {
        nodes: [start(), agent('work'), agent('a'), agent('b'), end()],
        edges: [edge('start', 'work'), edge('work', 'end'), edge('a', 'b')],
      },
      'workflow.unreachable',
    )
  })

  it('lets a note float free — it is canvas furniture, not a step', () => {
    const graph = validateWorkflowGraph({
      nodes: [start(), agent('work'), end(), node('n1', 'note', { body: 'context for later' })],
      edges: [edge('start', 'work'), edge('work', 'end')],
    })
    expect(graph.nodes.filter((entry) => entry.kind === 'note')).toHaveLength(1)
  })

  it('rejects a cycle — repetition is a loop node, not a back-edge', () => {
    expectRejected(
      {
        nodes: [start(), agent('a'), agent('b'), end()],
        edges: [edge('start', 'a'), edge('a', 'b'), edge('b', 'a'), edge('a', 'end')],
      },
      'workflow.cycle',
    )
  })

  it('keeps a branch honest: cases parse, and at least one exists', () => {
    expectRejected(
      {
        nodes: [start(), branch('pick', []), end()],
        edges: [edge('start', 'pick'), edge('pick', 'end', 'else')],
      },
      'workflow.branchCases',
    )
    expectRejected(
      {
        nodes: [start(), branch('pick', [{ id: 'c1', when: 'status ===' }]), end()],
        edges: [edge('start', 'pick'), edge('pick', 'end', 'else')],
      },
      'workflow.branchCaseInvalid',
    )
  })

  it('routes branch edges by case id, so relabelling never re-points an edge', () => {
    const graph = validateWorkflowGraph({
      nodes: [start(), branch('pick', [{ id: 'c1', when: 'input.urgent' }]), agent('hot'), end()],
      edges: [edge('start', 'pick'), edge('pick', 'hot', 'case:c1'), edge('pick', 'end', 'else'), edge('hot', 'end')],
    })
    const pick = graph.nodes.find((entry): entry is WorkflowBranchNode => entry.kind === 'branch')!
    expect(outputPorts(pick)).toEqual(['case:c1', 'else'])
  })

  it('holds a loop body inside the loop, and refuses an empty one', () => {
    const body = agent('inner', { parentId: 'each' })
    const ok = validateWorkflowGraph({
      nodes: [start(), loop('each'), body, end()],
      edges: [edge('start', 'each'), edge('each', 'inner', 'body'), edge('each', 'end', 'done')],
    })
    expect(ok.nodes.find((entry) => entry.id === 'inner')?.parentId).toBe('each')

    expectRejected(
      {
        nodes: [start(), loop('each'), end()],
        edges: [edge('start', 'each'), edge('each', 'end', 'done')],
      },
      'workflow.loopEmpty',
    )
  })

  it('refuses an edge that crosses a container boundary', () => {
    /**
     *
     * `inner` lives in the loop; wiring it straight to the top-level end would
     * let the body escape its iteration.
     *
     **/
    expectRejected(
      {
        nodes: [start(), loop('each'), agent('inner', { parentId: 'each' }), end()],
        edges: [
          edge('start', 'each'),
          edge('each', 'inner', 'body'),
          edge('inner', 'end'),
          edge('each', 'end', 'done'),
        ],
      },
      'workflow.edgeCrossesContainer',
    )
  })

  it('rejects a containment ring via the nesting-depth guard', () => {
    expectRejected(
      {
        nodes: [start(), loop('a', { parentId: 'b' }), loop('b', { parentId: 'a' }), end()],
        edges: [edge('start', 'end')],
      },
      'workflow.loopDepth',
    )
  })

  it('rejects a bad value mapping before it reaches disk', () => {
    expectRejected(
      {
        nodes: [start(), node('shape', 'transform', { mapping: { op: 'exec' } }), end()],
        edges: [edge('start', 'shape'), edge('shape', 'end')],
      },
      'workflow.mappingInvalid',
    )
  })

  it('keeps node keys unique and slug-shaped, but never asks a note for one', () => {
    expectRejected(
      {
        nodes: [start(), agent('work', { key: 'Work Step' }), end()],
        edges: [edge('start', 'work'), edge('work', 'end')],
      },
      'workflow.nodeKeyInvalid',
    )
    expectRejected(
      {
        nodes: [start(), agent('a', { key: 'same' }), agent('b', { key: 'same' }), end()],
        edges: [edge('start', 'a'), edge('a', 'b'), edge('b', 'end')],
      },
      'workflow.nodeKeyDuplicate',
    )

    const withNote = validateWorkflowGraph({
      nodes: [start(), agent('work'), end(), { ...node('n1', 'note', { body: 'why' }), key: undefined }],
      edges: [edge('start', 'work'), edge('work', 'end')],
    })
    expect(withNote.nodes.find((entry) => entry.kind === 'note')?.key).toBe('')
  })

  it('only lets a node that can fail transiently carry a retry policy', () => {
    const graph = validateWorkflowGraph({
      nodes: [
        start(),
        agent('work', { retries: { count: 2, backoffSeconds: 5 } }),
        node('shape', 'transform', { mapping: { op: 'literal', value: 1 } }),
        end(),
      ],
      edges: [edge('start', 'work'), edge('work', 'shape'), edge('shape', 'end')],
    })
    const byId = new Map(graph.nodes.map((entry) => [entry.id, entry] as const))
    expect(retriesFor(byId.get('work') as WorkflowNode)).toEqual({ count: 2, backoffSeconds: 5 })
    expect(retriesFor(byId.get('shape') as WorkflowNode)).toBeNull()
  })
})

describe('shape vs completeness', () => {
  /**
   *
   * The distinction that makes a half-built canvas savable: SHAPE is checked on
   * every write and can never be relaxed; COMPLETENESS is checked only when the
   * graph is about to run.
   *
   **/

  it('saves a node whose content is not written yet', () => {
    const graph = validateWorkflowGraph({
      nodes: [start(), agent('work', { prompt: '' }), end()],
      edges: [edge('start', 'work'), edge('work', 'end')],
    })
    expect(graph.nodes.find((entry) => entry.id === 'work')).toBeDefined()
  })

  it('still refuses a MALFORMED node — an unwritten field is not a broken one', () => {
    /**
     *
     * An empty condition is unwritten; an unparseable one is corrupt, and no
     * amount of "it's only a draft" makes it storable.
     *
     **/
    expectRejected(
      {
        nodes: [start(), branch('pick', [{ id: 'c1', when: 'status ===' }]), end()],
        edges: [edge('start', 'pick'), edge('pick', 'end', 'else')],
      },
      'workflow.branchCaseInvalid',
    )
  })

  it('reports what each unfinished kind is missing, and which field to point at', () => {
    const graph = validateWorkflowGraph({
      nodes: [
        start(),
        agent('a', { prompt: '' }),
        node('h', 'http', { http: { method: 'GET', url: '', headers: {} } }),
        branch('b', [{ id: 'c1', when: '' }]),
        node('l', 'loop', { mode: 'foreach', source: null, maxIterations: 5 }),
        node('inner', 'agent', { prompt: 'x', parentId: 'l' }),
        node('s', 'state', { assignments: [] }),
        node('ap', 'approval', { title: '' }),
        end(),
      ],
      edges: [
        edge('start', 'a'),
        edge('a', 'h'),
        edge('h', 'b'),
        edge('b', 'l', 'case:c1'),
        edge('b', 'end', 'else'),
        edge('l', 'inner', 'body'),
        edge('l', 's', 'done'),
        edge('s', 'ap'),
        edge('ap', 'end', 'approved'),
        edge('ap', 'end', 'rejected'),
      ],
    })
    expect(graphProblems(graph).map((entry) => [entry.nodeId, entry.field])).toEqual([
      ['a', 'prompt'],
      ['h', 'url'],
      ['b', 'case:c1'],
      ['l', 'source'],
      ['s', 'assignments'],
      ['ap', 'title'],
    ])
  })

  it('has nothing to say about a finished graph', () => {
    const graph = validateWorkflowGraph(linear())
    expect(graphProblems(graph)).toEqual([])
    expect(() => requireRunnableGraph(graph)).not.toThrow()
  })

  it('names the offending node when a run or publish is refused', () => {
    const graph = validateWorkflowGraph({
      nodes: [start(), agent('work', { name: 'Summarize', prompt: '' }), end()],
      edges: [edge('start', 'work'), edge('work', 'end')],
    })
    try {
      requireRunnableGraph(graph)
      throw new Error('expected requireRunnableGraph to refuse')
    } catch (error) {
      const data = (error as { data?: { code?: string; params?: Record<string, string> } }).data
      expect(data?.code).toBe('workflow.nodeIncomplete')
      /**
       *
       * The params are what lets a client select the node instead of shrugging
       * at a toast.
       *
       **/
      expect(data?.params?.nodeId).toBe('work')
      expect(data?.params?.field).toBe('prompt')
      expect((error as { statusMessage?: string }).statusMessage).toContain('Summarize')
    }
  })

  it('leaves a kind with nothing to fill in alone', () => {
    const graph = validateWorkflowGraph(linear())
    for (const kind of ['start', 'end']) {
      expect(nodeProblems(graph.nodes.find((entry) => entry.kind === kind)!)).toEqual([])
    }
  })
})

describe('node identity on failures', () => {
  /**
   *
   * A rejection that names no node leaves the reader hunting a canvas. Every
   * node-scoped code carries the offender so the builder can select it.
   *
   **/

  const identityOf = (graph: { nodes: unknown[]; edges: unknown[] }) => {
    try {
      validateWorkflowGraph(graph)
    } catch (error) {
      return (error as { data?: { params?: Record<string, string> } }).data?.params ?? {}
    }
    throw new Error('expected the graph to be rejected')
  }

  it('stamps the node onto a failure raised deep inside a validator', () => {
    /**
     *
     * `nodeSchemaInvalid` is thrown four calls down from validateNode, by a
     * helper that has no idea which node it is working on — which is the whole
     * reason identity is attached at the boundary instead of threaded through.
     *
     **/
    const params = identityOf({
      nodes: [start(), agent('work', { name: 'Summarize', outputSchema: '{not json' }), end()],
      edges: [edge('start', 'work'), edge('work', 'end')],
    })
    expect(params.nodeId).toBe('work')
    expect(params.nodeName).toBe('Summarize')
  })

  it('reads identity off the RAW input, since validation may fail before a node exists', () => {
    const params = identityOf({
      nodes: [start(), agent('work', { key: 'Not A Slug' }), end()],
      edges: [edge('start', 'work'), edge('work', 'end')],
    })
    expect(params.nodeId).toBe('work')
  })

  it("keeps the failure's own params alongside the identity", () => {
    const params = identityOf({
      nodes: [start(), agent('work', { retries: { count: 99 } }), end()],
      edges: [edge('start', 'work'), edge('work', 'end')],
    })
    expect(params.max).toBe(5)
    expect(params.nodeId).toBe('work')
  })

  it('names the node on a structural failure too', () => {
    const params = identityOf({
      nodes: [start(), agent('work'), agent('stray'), end()],
      edges: [edge('start', 'work'), edge('work', 'end')],
    })
    expect(params.nodeId).toBe('stray')
  })
})

describe('compileGraph', () => {
  it('indexes edges both ways and groups nodes by container', () => {
    const graph = validateWorkflowGraph({
      nodes: [start(), loop('each'), agent('inner', { parentId: 'each' }), end()],
      edges: [edge('start', 'each'), edge('each', 'inner', 'body'), edge('each', 'end', 'done')],
    })
    const compiled = compileGraph(graph)
    expect(compiled.start.kind).toBe('start')
    expect(
      compiled.outbound
        .get('each')
        ?.map((entry) => entry.sourcePort)
        .sort(),
    ).toEqual(['body', 'done'])
    expect(compiled.inbound.get('end')).toHaveLength(1)
    expect(compiled.containers.get('each')?.map((entry) => entry.id)).toEqual(['inner'])
    expect(compiled.containers.get('')?.map((entry) => entry.id)).toEqual(['start', 'each', 'end'])
  })
})
