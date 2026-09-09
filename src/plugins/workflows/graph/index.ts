/**
 * ── Workflow graph ───────────────────────────────────────────────────────────
 *
 * A workflow is a NODE GRAPH: typed nodes joined by edges that leave a named
 * output PORT.
 *
 * Two decisions shape everything under this directory.
 *
 * CONTROL FLOW IS ONLY EVER EDGES. There is no per-node condition. A guard
 * hidden on a node would make the drawn graph lie about what runs, which defeats
 * the point of a canvas — so "run this only if…" is a `branch` node with two
 * legs, and the two legs rejoin on a shared successor. The scheduler's join rule
 * (../workflow-scheduler.ts) makes that successor run exactly once whichever leg
 * was taken, so putting the decision on screen costs nothing.
 *
 * REPETITION IS CONTAINMENT, NOT BACK-EDGES. A `loop` node OWNS its body: body
 * nodes carry `parentId = loop.id` and the loop spawns them once per iteration.
 * The alternative — an edge from the body's tail back to the loop — makes the
 * graph cyclic, and then validation has to decide which cycles are legal and
 * which are bugs. With containment every container is a strict DAG, so cycle
 * detection is a plain Kahn sweep per container with no special cases at all.
 *
 * Node POSITIONS live here and are round-tripped, but the engine never reads
 * them: moving a node on the canvas cannot change what runs.
 *
 * A DIRECTORY, and this is the barrel. It was one 1,038-line file with six
 * banner-separated sections, and unlike its neighbour `workflow-runs.ts` — which
 * is a state machine whose sections call each other in a ring — these form a
 * DAG: limits ← types ← {completeness, ports, compiled, validate}. Splitting a
 * DAG costs nothing and splitting a ring costs six modules importing each other,
 * which is the whole difference (docs/STRUCTURE_REVIEW.md H-02).
 *
 **/

export * from './limits.js'
export * from './types.js'
export * from './completeness.js'
export * from './ports.js'
export * from './compiled.js'
export * from './validate.js'
