import { createRequire } from 'node:module'
import { ensureTtsModels, type TtsModelPaths } from './tts-models.js'

/**
 *
 * Supertonic-3, one shared instance per machine — the model costs real RAM
 * and load time, a synthesis call costs nothing extra. Lives on globalThis so
 * Nitro dev reloads don't leak it (same trick as the STT recognizer and the
 * platform API's DB handle).
 *
 * Unlike STT's `decode()` — a synchronous native call that blocks the event
 * loop for seconds, which is why that engine hands decode jobs to a
 * worker_thread (see utils/voice/engine.ts) — sherpa-onnx-node's TTS binding
 * ships genuine async entry points, `OfflineTts.createAsync` /
 * `tts.generateAsync`, both documented "(non-blocking)" in the package's own
 * JSDoc. Verified empirically before choosing this over a worker: a 10 ms
 * `setInterval` kept firing on schedule throughout a ~2.5 s `generateAsync()`
 * call (230/248 expected ticks fired), but a same-length synchronous
 * `generate()` call produced zero ticks — the native async path really does
 * hand the work to libuv's thread pool instead of blocking. So this engine
 * calls the addon directly on the main thread; no worker needed.
 *
 * `sherpa-onnx-node` is a native addon and must never be statically imported
 * (Nitro's bundler can't trace/inline its platform-specific `.node` binary) —
 * `createRequire(import.meta.url)('sherpa-onnx-node')` is a runtime call, not
 * a literal `import`, so it survives `nitro build` untouched (verified: the
 * built chunk still calls it, unchanged, at runtime). Resolution then works
 * the same way it already does for the STT worker: infra/machine/Dockerfile
 * `npm install --prefix /app`s this same package straight into the running
 * container's `/app/node_modules`, one directory above `.output` — no Nitro
 * bundling/externals config involved, and no Dockerfile change needed here
 * since STT already carries that line for the identical package.
 *
 * Same OOM pressure STT's engine guards against (utils/voice/engine.ts) —
 * Supertonic-3's resident RAM is paid once loaded and never released on its
 * own, so a machine that reads just one message aloud keeps paying for it for
 * the rest of the sidecar's life. This engine has no worker_thread to
 * terminate (see above — it deliberately runs on the main thread), so
 * "unloading" means dropping the JS references to the native handle instead:
 * `sherpa-onnx-node`'s OfflineTts exposes no explicit `.free()`/`.dispose()`,
 * so releasing the wrapper is the only lever available, letting the native
 * addon's own finalizer reclaim the onnxruntime arena once V8 collects it.
 * Same idle constants and sweep cadence as STT so the two engines behave
 * identically from the outside.
 *
 **/

interface GeneratedAudio {
  samples: Float32Array
  sampleRate: number
}

interface OfflineTtsHandle {
  sampleRate: number
  numSpeakers: number
  generateAsync(args: { text: string; generationConfig: unknown }): Promise<GeneratedAudio>
}

interface SherpaOnnxTtsModule {
  OfflineTts: { createAsync(config: unknown): Promise<OfflineTtsHandle> }
  GenerationConfig: new (opts: Record<string, unknown>) => unknown
}

/** Default speaker (0) and generation params — matches the model's own
 *  command-line default (`--sid=0`) and the values sherpa-onnx's first-party
 *  Node/Python examples use for `numSteps` (a quality/speed tradeoff knob). */
const DEFAULT_SID = 0
const DEFAULT_SPEED = 1.0
const DEFAULT_NUM_STEPS = 8
const DEFAULT_LANG = 'en'

/** Mirrors utils/voice/engine.ts's identical constants — no live dictation
 *  connection concept exists for TTS (it's one-shot request/response, not a
 *  streaming session), so there's no retained-connection counter here, only
 *  the idle-since-last-use clock. */
const IDLE_UNLOAD_MS = 10 * 60_000
const IDLE_SWEEP_MS = 60_000

interface EngineState {
  tts: OfflineTtsHandle | null
  sherpa: SherpaOnnxTtsModule | null
  readiness: Promise<void> | null
  progressListeners: Set<(fraction: number) => void>
  /** Synthesis calls in flight — the idle sweep never unloads mid-call. */
  inFlight: number
  /** Last synthesis / warm-up, for the idle-unload verdict. */
  lastUsedAt: number
  idleTimer: ReturnType<typeof setInterval> | null
}

const g = globalThis as typeof globalThis & { __hoshiTtsEngine?: EngineState }
const state: EngineState = (g.__hoshiTtsEngine ??= {
  tts: null,
  sherpa: null,
  readiness: null,
  progressListeners: new Set(),
  inFlight: 0,
  lastUsedAt: 0,
  idleTimer: null,
})

/** Whether synthesis can start instantly (model on disk, engine warm). */
export function ttsEngineWarm(): boolean {
  return state.tts !== null
}

function broadcastProgress(fraction: number): void {
  for (const listener of state.progressListeners) listener(fraction)
}

function sweepIdle(): void {
  if (!state.tts || state.inFlight > 0) return
  if (Date.now() - state.lastUsedAt < IDLE_UNLOAD_MS) return
  console.log('[tts] engine idle — unloading to release its memory')
  state.tts = null
  state.sherpa = null
  state.readiness = null
  if (state.idleTimer) {
    clearInterval(state.idleTimer)
    state.idleTimer = null
  }
}

/** Download the model if needed and construct the TTS engine. Concurrent
 *  callers share one attempt; a failed attempt clears so the next call retries. */
function ensureTtsEngine(): Promise<void> {
  state.lastUsedAt = Date.now()
  state.readiness ??= boot().catch((err) => {
    state.readiness = null
    throw err
  })
  return state.readiness
}

function buildConfig(paths: TtsModelPaths) {
  return {
    model: {
      supertonic: {
        durationPredictor: paths.durationPredictor,
        textEncoder: paths.textEncoder,
        vectorEstimator: paths.vectorEstimator,
        vocoder: paths.vocoder,
        ttsJson: paths.ttsJson,
        unicodeIndexer: paths.unicodeIndexer,
        voiceStyle: paths.voiceStyle,
      },
      debug: false,
      numThreads: 2,
      provider: 'cpu',
    },
    maxNumSentences: 1,
  }
}

async function boot(): Promise<void> {
  const paths = await ensureTtsModels(broadcastProgress)
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as SherpaOnnxTtsModule
  state.sherpa = sherpa
  state.tts = await sherpa.OfflineTts.createAsync(buildConfig(paths))
  state.lastUsedAt = Date.now()
  state.idleTimer ??= setInterval(sweepIdle, IDLE_SWEEP_MS)
  state.idleTimer.unref?.()
}

/** Synthesize one utterance. `lang` is one of Supertonic-3's 31 ISO codes
 *  (falls back to English); anything the model doesn't recognize surfaces as
 *  a rejected promise from the native call. */
export async function ttsSynthesize(text: string, lang: string = DEFAULT_LANG): Promise<GeneratedAudio> {
  await ensureTtsEngine()
  state.lastUsedAt = Date.now()
  const { tts, sherpa } = state
  if (!tts || !sherpa) throw new Error('TTS engine unavailable')
  const generationConfig = new sherpa.GenerationConfig({
    sid: DEFAULT_SID,
    speed: DEFAULT_SPEED,
    numSteps: DEFAULT_NUM_STEPS,
    extra: { lang },
  })
  state.inFlight++
  try {
    return await tts.generateAsync({ text, generationConfig })
  } finally {
    state.inFlight--
  }
}
