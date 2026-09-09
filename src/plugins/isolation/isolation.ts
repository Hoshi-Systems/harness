import type { IsolationReading, IsolationResult, MicrovmVerdict } from '../../wire/index.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * ── What this machine's host can isolate ─────────────────────────────────────
 *
 * `hoshi-probe-isolation` ships in the machine image and answers two questions
 * about the host underneath: whether Landlock can back an in-machine sandbox,
 * and whether the host could give each machine its own kernel
 * (`openspec/specs/deployment/spec.md`).
 *
 * It has always been runnable — by opening a shell inside a machine and knowing
 * the command exists. That is not a reading anybody making an infrastructure
 * decision was ever going to get, so the probe's own answer sat unused while
 * the decision it exists to settle stayed open. This serves it.
 *
 * A READ, and only a read. The probe writes nothing outside a temp directory
 * and every restriction it installs dies with the child that installed it — but
 * the reason this is a GET rather than an action is simpler: an admin asking
 * "can my hosts do this?" is asking a question, and a question should not be a
 * button that changes something.
 *
 **/

/** Where the machine image puts it (infra/machine/Dockerfile). Absolute rather
 *  than resolved through PATH: this runs what the image installed, never
 *  whatever a workspace happens to have named the same thing. */
const PROBE = '/usr/local/bin/hoshi-probe-isolation'

/**
 *
 * Parse what the probe printed.
 *
 * Separate from running it because this is the half worth testing on a host
 * that cannot run the probe at all — which is every host this repo's own suites
 * run on. A `verdict` outside the four the probe can emit is rejected rather
 * than passed through: it would reach a client as an unrenderable tone and a
 * missing sentence, and "the probe said something we do not understand" is a
 * better failure than a blank card.
 *
 **/
const VERDICTS = new Set<MicrovmVerdict>(['no-hardware', 'no-kvm-module', 'nested-off', 'ready'])

export function parseReading(stdout: string): IsolationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { available: false, reason: 'The isolation probe did not return readable output.' }
  }
  const reading = parsed as Partial<IsolationReading>
  const verdict = reading?.microvm?.verdict
  if (!verdict || !VERDICTS.has(verdict)) {
    return { available: false, reason: 'The isolation probe returned a reading this machine does not understand.' }
  }
  return { available: true, reading: reading as IsolationReading }
}

/** Run the probe and read its answer. Bounded: it forks a child and does a
 *  handful of syscalls, so anything past a few seconds is a hang, not work. */
export async function measureIsolation(): Promise<IsolationResult> {
  try {
    const { stdout } = await run(PROBE, ['--json'], { timeout: 15_000, maxBuffer: 1024 * 1024 })
    return parseReading(stdout)
  } catch (error) {
    const code = (error as { code?: string | number }).code
    if (code === 'ENOENT') {
      return {
        available: false,
        reason: 'This machine does not ship the isolation probe, so it cannot measure its host.',
      }
    }
    return {
      available: false,
      reason: `The isolation probe could not run here: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
