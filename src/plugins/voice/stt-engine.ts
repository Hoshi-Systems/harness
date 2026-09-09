import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import { ensureVoiceModels } from './stt-models.js'
import { VOICE_WORKER_SOURCE } from './worker-source.js'

/**
 *
 * One recognizer per machine, shared by every dictation connection: the model
 * costs ~1.3 GB of RESIDENT RAM once onnxruntime materializes the int8
 * tensors, and a second to load; an utterance costs nothing. Lives on
 * globalThis so Nitro dev reloads don't leak workers (same trick as the
 * platform API's DB handle).
 *
 * That 1.3 GB is why the engine UNLOADS itself: on a 2 GB machine, a
 * recognizer left resident starves OpenCode + ollama into cgroup memory
 * pressure — event-loop stalls (every runtime call times out) and finally the
 * kernel OOM-killing the sidecar (observed live: `Memory cgroup out of
 * memory: Killed process (node) anon-rss:1318580kB`). After IDLE_UNLOAD_MS
 * with no live dictation connection and no decode, the worker is terminated —
 * worker teardown runs the addon's env cleanup, releasing the onnxruntime
 * arenas — and the next dictation boots it fresh from the on-disk model
 * (seconds, streamed to the client as the existing warm-up progress).
 *
 **/

interface DecodeJob {
  resolve: (text: string) => void
  reject: (err: Error) => void
}

interface EngineState {
  worker: Worker | null
  readiness: Promise<void> | null
  jobs: Map<number, DecodeJob>
  nextJobId: number
  progressListeners: Set<(fraction: number) => void>
  /** Live dictation connections — the engine never idles out under one. */
  retained: number
  /** Last decode / warm-up, for the idle-unload verdict. */
  lastUsedAt: number
  idleTimer: ReturnType<typeof setInterval> | null
}

const IDLE_UNLOAD_MS = 10 * 60_000
const IDLE_SWEEP_MS = 60_000

const g = globalThis as typeof globalThis & { __hoshiVoiceEngine?: EngineState }
const state: EngineState = (g.__hoshiVoiceEngine ??= {
  worker: null,
  readiness: null,
  jobs: new Map(),
  nextJobId: 1,
  progressListeners: new Set(),
  retained: 0,
  lastUsedAt: 0,
  idleTimer: null,
})

/** Whether dictation can start instantly (models on disk, worker warm). */
export function voiceEngineWarm(): boolean {
  return state.worker !== null
}

/** Follow model-download progress while the engine spins up. */
export function onVoiceProgress(listener: (fraction: number) => void): () => void {
  state.progressListeners.add(listener)
  return () => state.progressListeners.delete(listener)
}

function broadcastProgress(fraction: number): void {
  for (const listener of state.progressListeners) listener(fraction)
}

/** Hold the engine loaded while a dictation connection is live — the idle
 *  sweep never unloads a retained engine, however quiet the mic. Returns the
 *  release; releasing starts the idle clock. */
export function retainVoiceEngine(): () => void {
  state.retained++
  let released = false
  return () => {
    if (released) return
    released = true
    state.retained = Math.max(0, state.retained - 1)
    state.lastUsedAt = Date.now()
  }
}

function sweepIdle(): void {
  if (!state.worker || state.retained > 0 || state.jobs.size > 0) return
  if (Date.now() - state.lastUsedAt < IDLE_UNLOAD_MS) return
  /**
   *
   * The worker's exit handler resets `state` (worker/readiness) and rejects
   * stray jobs — the guard above means there are none.
   *
   **/
  console.log('[voice] recognizer idle — unloading to release its memory')
  void state.worker.terminate()
}

/** Download models if needed and boot the decode worker. Concurrent callers
 *  share one attempt; a failed attempt clears so the next start can retry. */
export function ensureVoiceEngine(): Promise<void> {
  state.lastUsedAt = Date.now()
  state.readiness ??= boot().catch((err) => {
    state.readiness = null
    throw err
  })
  return state.readiness
}

async function boot(): Promise<void> {
  const paths = await ensureVoiceModels(broadcastProgress)
  /**
   *
   * Leave one core for the sidecar itself; the model saturates quickly anyway.
   *
   **/
  const numThreads = Math.max(1, Math.min(4, availableParallelism() - 1))
  /**
   *
   * `sherpa-onnx-node` is NOT a dependency of this package, deliberately: it is
   * a ~100 MB native addon, and a workspace install is not the place to put one.
   * The machine image installs it beside the harness
   * (`npm install --prefix /app` in infra/machine/Dockerfile), which is what
   * this resolution walks up to find. A checkout without it resolves nothing —
   * so dictation is a feature of a real machine, not of `pnpm dev:machine`, and
   * this throws rather than degrading silently. It used to resolve in a
   * developer's tree only because the retired Nitro shim declared it.
   *
   **/
  const sherpaEntry = createRequire(import.meta.url).resolve('sherpa-onnx-node')

  const worker = new Worker(VOICE_WORKER_SOURCE, {
    eval: true,
    workerData: { sherpaEntry, paths, numThreads },
  })
  worker.unref()

  await new Promise<void>((resolve, reject) => {
    worker.once('error', reject)
    worker.on('message', (msg: { type: string; id?: number; text?: string; error?: string; message?: string }) => {
      if (msg.type === 'ready') {
        resolve()
        return
      }
      if (msg.type === 'fatal') {
        reject(new Error(msg.message ?? 'voice worker failed to start'))
        return
      }
      if (msg.type === 'result' && msg.id !== undefined) {
        const job = state.jobs.get(msg.id)
        if (!job) return
        state.jobs.delete(msg.id)
        if (msg.error) job.reject(new Error(msg.error))
        else job.resolve(msg.text ?? '')
      }
    })
    worker.once('exit', () => {
      /**
       *
       * Whatever was in flight is lost; the next start boots a fresh worker.
       *
       **/
      if (state.worker === worker) {
        state.worker = null
        state.readiness = null
        if (state.idleTimer) {
          clearInterval(state.idleTimer)
          state.idleTimer = null
        }
      }
      const pending = [...state.jobs.values()]
      state.jobs.clear()
      for (const job of pending) job.reject(new Error('voice worker exited'))
    })
  })

  state.worker = worker
  state.lastUsedAt = Date.now()
  state.idleTimer ??= setInterval(sweepIdle, IDLE_SWEEP_MS)
  state.idleTimer.unref?.()
}

/** Transcribe one span of 16 kHz mono Float32 samples. Jobs are answered in
 *  order — the worker is single-threaded by construction.
 *
 *  `Float32Array<ArrayBuffer>`, not a bare `Float32Array`: the transfer list
 *  below takes `Transferable`, and a bare one's `.buffer` widens to
 *  `ArrayBufferLike`, which admits SharedArrayBuffer — not transferable. */
export async function voiceDecode(samples: Float32Array<ArrayBuffer>): Promise<string> {
  await ensureVoiceEngine()
  state.lastUsedAt = Date.now()
  const worker = state.worker
  if (!worker) throw new Error('voice worker unavailable')
  return new Promise<string>((resolve, reject) => {
    const id = state.nextJobId++
    state.jobs.set(id, { resolve, reject })
    worker.postMessage({ type: 'decode', id, samples }, [samples.buffer])
  })
}
