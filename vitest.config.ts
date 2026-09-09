import { defineConfig } from 'vitest/config'

/**
 *
 * The kernel's own unit tests, which came with it out of the Nitro host the
 * harness migration replaced.
 * `include` is explicit for the same reason the machine's config restricts its
 * own: anything else that ever lands under this package — an e2e harness, a
 * fixture — would otherwise be collected by a runner that cannot stand up what
 * it needs, and the suite would fail for a reason that is not about the code.
 *
 **/
/**
 *
 * What a test here is allowed to take, and why it is not vitest's defaults.
 *
 * These suites do real work on a real disk before they assert anything: a
 * scratch `HOME` per file, a git repo initialised, cloned, committed and pushed
 * (plugins/git/git-flow.test.ts), a JSON store written and read back. That is
 * the point of them — the code under test reads and writes files, and a fake
 * filesystem would test the fake — but it means their budget is spent on I/O
 * whose speed is not theirs to control.
 *
 * `pnpm verify` runs the workspaces at once (scripts/lib/host-jobs.mjs), so
 * that I/O happens on a saturated host, and the two defaults it lands on are
 * 5s per test and 10s per hook. Both lose: a clean tree with no diff at all
 * failed six suites in one gate run — `git-flow`, `memory/store`,
 * `context-links/links`, `sessions/tools`, `imageless-history`, `git/ci-loop` —
 * and a DIFFERENT set the run before, which is the signature of a budget
 * rather than a bug. Reproduced on demand by running four of them against 48
 * busy processes: 10 timeouts, none of them about the code.
 *
 * `hookTimeout` matters more than `testTimeout` here and was the one nobody
 * raised. Most of these files set up once in `beforeAll` and the failure lands
 * there, which fails the whole FILE and then buries the reason under whatever
 * the teardown does with the half-built fixture.
 *
 * This is the same argument apps/api/vitest.config.ts already made and settled
 * for its own cold module graph; the test budget matches it deliberately. A
 * genuinely hung test still fails — it fails later. What is gone is a red run
 * that says nothing about the change that triggered it.
 *
 * The hook budget is the larger of the two, which is not symmetry for its own
 * sake. Measured here: importing `kernel/index.js` through vite's transform is
 * **1.9s with the host completely idle** (`kernel/sessions.js` alone is 1.2s of
 * it — the graph is large and every test FILE is its own process, so each pays
 * it fresh). A hook then adds what the fixture needs on top: a scratch HOME, a
 * git repo initialised, cloned, committed and pushed through real subprocesses.
 * A test that runs after all that takes ~80ms. So the two numbers are not
 * measuring the same thing, and a hook failure costs the whole FILE rather than
 * one case — the expensive, high-blast-radius half deserves the wider margin.
 *
 * Where the edge actually is, since the next person to see this should not have
 * to rediscover it: against 12 busy processes pinning every core, these suites
 * still cleared 60s hooks; at 30s they did not. The real gate is far gentler
 * than that (CI sizes itself to ONE job on a two-core runner), and two full
 * `pnpm verify` runs are clean — the margin is for a developer's laptop that is
 * also doing something else, not for the gate's own load.
 *
 **/
const testTimeout = 30_000
const hookTimeout = 60_000

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout,
    hookTimeout,
  },
})
