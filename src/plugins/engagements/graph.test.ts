import { describe, expect, it } from 'vitest'

import {
  deriveEngagementStatus,
  isActive,
  kickoffMessage,
  managerReport,
  parseEngagementPlan,
  readyNodes,
  settleUnreachable,
  sinkKeys,
  type Engagement,
  type EngagementNode,
  type EngagementNodeRun,
  type EngagementNodeStatus,
} from './graph.js'

// ── Harness ──────────────────────────────────────────────────────────────────

const ARCHETYPES = ['researcher', 'implementer', 'reviewer']

function plan(nodes: Array<Record<string, unknown>>): EngagementNode[] {
  return parseEngagementPlan({ nodes }, ARCHETYPES)
}

function assignment(key: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}) {
  return { key, role: key, brief: `Do ${key}.`, model: 'inherit', dependsOn, ...extra }
}

/** An engagement with every node blocked — the shape `startEngagement` builds. */
function engagementOf(nodes: EngagementNode[], statuses: Record<string, EngagementNodeStatus> = {}): Engagement {
  const runs: Record<string, EngagementNodeRun> = {}
  for (const node of nodes) {
    runs[node.key] = {
      key: node.key,
      status: statuses[node.key] ?? 'blocked',
      sessionId: `ses_${node.key}`,
      archetype: node.kind === 'assignment' ? node.role : null,
      report: statuses[node.key] === 'done' ? `report from ${node.key}` : null,
      error: null,
      startedAt: null,
      endedAt: null,
    }
  }
  return {
    id: 'eng_test',
    parentSessionId: 'ses_parent',
    directory: null,
    title: 'Test',
    status: 'running',
    nodes,
    runs,
    createdAt: 1,
    updatedAt: 1,
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

describe('parseEngagementPlan', () => {
  it('normalizes an assignment and defaults its optional fields', () => {
    const [node] = plan([{ key: 'Research', archetype: 'researcher', brief: 'Find the facts.', model: 'inherit' }])
    expect(node).toMatchObject({
      kind: 'assignment',
      key: 'research',
      role: 'researcher',
      archetype: 'researcher',
      readOnly: false,
      model: null,
      dependsOn: [],
      reportToManager: false,
    })
  })

  it('parses a provider/model reference and rejects a malformed one', () => {
    const [node] = plan([assignment('build', [], { model: 'anthropic/claude-sonnet-4-5' })])
    expect(node).toMatchObject({ model: 'anthropic/claude-sonnet-4-5' })
    expect(() => plan([assignment('build', [], { model: 'sonnet' })])).toThrow(/not a provider\/model reference/)
  })

  it('refuses a plan the scheduler could not run', () => {
    expect(() => plan([])).toThrow(/at least one node/)
    expect(() => plan([assignment('a'), assignment('a')])).toThrow(/duplicate key/)
    expect(() => plan([assignment('a', ['ghost'])])).toThrow(/depends on "ghost"/)
    expect(() => plan([assignment('a', ['a'])])).toThrow(/cannot depend on itself/)
    expect(() => plan([{ key: 'a', brief: 'x', model: 'inherit' }])).toThrow(/archetype or a freeform role/)
    expect(() => plan([{ key: 'a', role: 'analyst', model: 'inherit' }])).toThrow(/brief is required/)
    expect(() => plan([assignment('a', [], { archetype: 'astronaut' })])).toThrow(/unknown archetype/)
  })

  it('refuses a cycle, naming the nodes stuck in it', () => {
    expect(() => plan([assignment('a', ['c']), assignment('b', ['a']), assignment('c', ['b'])])).toThrow(
      /circle and can never start: a, b, c/,
    )
  })

  it('takes a checkpoint only with a question and something to review', () => {
    const nodes = plan([
      assignment('research'),
      { key: 'go', kind: 'checkpoint', question: 'Ship it?', dependsOn: ['research'] },
    ])
    expect(nodes[1]).toMatchObject({ kind: 'checkpoint', key: 'go', question: 'Ship it?', dependsOn: ['research'] })
    expect(() => plan([assignment('a'), { key: 'go', kind: 'checkpoint', dependsOn: ['a'] }])).toThrow(
      /needs a "question"/,
    )
    expect(() => plan([{ key: 'go', kind: 'checkpoint', question: 'Ship it?' }])).toThrow(
      /must depend on at least one node/,
    )
  })
})

// ── The frontier ─────────────────────────────────────────────────────────────

describe('readyNodes', () => {
  it('opens every independent node at once — this is where parallelism comes from', () => {
    const engagement = engagementOf(
      plan([assignment('research'), assignment('design'), assignment('build', ['research', 'design'])]),
    )
    expect(readyNodes(engagement).map((n) => n.key)).toEqual(['research', 'design'])
  })

  it('holds a join until its LAST dependency is done, then opens it', () => {
    const nodes = plan([assignment('research'), assignment('design'), assignment('build', ['research', 'design'])])
    const half = engagementOf(nodes, { research: 'done', design: 'running' })
    expect(readyNodes(half).map((n) => n.key)).toEqual([])

    const whole = engagementOf(nodes, { research: 'done', design: 'done' })
    expect(readyNodes(whole).map((n) => n.key)).toEqual(['build'])
  })

  it('never re-opens a node that already started', () => {
    const engagement = engagementOf(plan([assignment('research')]), { research: 'running' })
    expect(readyNodes(engagement)).toEqual([])
  })
})

describe('settleUnreachable', () => {
  it('cancels the whole chain downstream of a failure, so the run can settle', () => {
    const engagement = engagementOf(
      plan([assignment('research'), assignment('build', ['research']), assignment('review', ['build'])]),
      { research: 'error' },
    )
    expect(settleUnreachable(engagement)).toEqual(['build', 'review'])
    expect(isActive(engagement)).toBe(false)
    expect(deriveEngagementStatus(engagement)).toBe('error')
  })

  it('leaves a sibling branch that can still finish alone', () => {
    const engagement = engagementOf(
      plan([assignment('research'), assignment('build', ['research']), assignment('docs')]),
      { research: 'error', docs: 'running' },
    )
    settleUnreachable(engagement)
    expect(engagement.runs.docs!.status).toBe('running')
    expect(deriveEngagementStatus(engagement)).toBe('running')
  })
})

describe('deriveEngagementStatus', () => {
  it('reports a waiting checkpoint as its own state, not as finished or failed', () => {
    const engagement = engagementOf(
      plan([assignment('research'), { key: 'go', kind: 'checkpoint', question: 'Ship?', dependsOn: ['research'] }]),
      { research: 'done', go: 'waiting' },
    )
    expect(deriveEngagementStatus(engagement)).toBe('checkpoint')
  })

  it('is done only once every node has settled cleanly', () => {
    const nodes = plan([assignment('research'), assignment('build', ['research'])])
    expect(deriveEngagementStatus(engagementOf(nodes, { research: 'done', build: 'done' }))).toBe('done')
    expect(deriveEngagementStatus(engagementOf(nodes, { research: 'done', build: 'running' }))).toBe('running')
  })
})

// ── Report routing ───────────────────────────────────────────────────────────

describe('kickoffMessage', () => {
  it('hands a worker its predecessors reports directly, not just its brief', () => {
    const nodes = plan([assignment('research'), assignment('design'), assignment('build', ['research', 'design'])])
    const engagement = engagementOf(nodes, { research: 'done', design: 'done' })
    const message = kickoffMessage(engagement, nodes[2]!)
    expect(message).toContain('report from research')
    expect(message).toContain('report from design')
    expect(message).toContain('Do build.')
  })

  it('gives a node with no dependencies its bare brief', () => {
    const nodes = plan([assignment('research')])
    expect(kickoffMessage(engagementOf(nodes), nodes[0]!)).toBe('Do research.')
  })

  it('sends a checkpoint its question — the manager is answering, not working', () => {
    const nodes = plan([
      assignment('research'),
      { key: 'go', kind: 'checkpoint', question: 'Ship it?', dependsOn: ['research'] },
    ])
    expect(kickoffMessage(engagementOf(nodes, { research: 'done' }), nodes[1]!)).toBe('Ship it?')
  })

  it('marks a decision as coming from the manager, so a worker reads it as one', () => {
    const nodes = plan([
      assignment('research'),
      { key: 'go', kind: 'checkpoint', question: 'Ship it?', dependsOn: ['research'] },
      assignment('build', ['go']),
    ])
    const engagement = engagementOf(nodes, { research: 'done', go: 'done' })
    expect(kickoffMessage(engagement, nodes[2]!)).toContain("go (your manager's decision)")
  })
})

describe('managerReport', () => {
  it('returns the ends of the process, not every intermediate result', () => {
    const engagement = engagementOf(
      plan([assignment('research'), assignment('build', ['research']), assignment('docs', ['research'])]),
      { research: 'done', build: 'done', docs: 'done' },
    )
    expect(sinkKeys(engagement)).toEqual(['build', 'docs'])
    expect(managerReport(engagement).map((r) => r.key)).toEqual(['build', 'docs'])
  })

  it('adds a mid-graph node that asked to be seen', () => {
    const engagement = engagementOf(
      plan([assignment('research', [], { reportToManager: true }), assignment('build', ['research'])]),
      { research: 'done', build: 'done' },
    )
    expect(managerReport(engagement).map((r) => r.key)).toEqual(['research', 'build'])
  })

  it('reports a failure in place of the missing report rather than dropping the node', () => {
    const engagement = engagementOf(plan([assignment('research')]), { research: 'error' })
    engagement.runs.research!.error = 'the provider refused'
    expect(managerReport(engagement)).toEqual([{ key: 'research', role: 'research', report: 'the provider refused' }])
  })
})
