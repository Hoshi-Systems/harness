import { ensureVoiceEngine, onVoiceProgress, retainVoiceEngine } from './stt-engine.js'
import { Utterance } from './utterance.js'

/** Everything a dictation stream emits back to its client, as JSON events.
 *  The wire framing around them lives in routes/voice/stream.ts. */
export type VoiceStreamEvent =
  | { type: 'progress'; fraction: number; stage: 'downloading' }
  | { type: 'ready' }
  | { type: 'listening' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'idle' }
  | { type: 'error'; message: string }

/** One client's dictation lifecycle: engine warm-up (with download progress),
 *  then at most one live Utterance at a time, re-armed by each `start`. The
 *  engine (model + decode worker) itself is shared by all sessions; only the
 *  utterance is per-connection state. Transport-agnostic — the WS route feeds
 *  in commands/audio and forwards emitted events. */
export class VoiceStreamSession {
  private utterance: Utterance | null = null
  /** Keeps the shared engine loaded for this connection's lifetime — the
   *  idle-unload sweep only counts once every live mic has released. */
  private readonly releaseEngine = retainVoiceEngine()

  constructor(private readonly emit: (event: VoiceStreamEvent) => void) {}

  /** An utterance is live — audio frames are worth decoding right now. */
  get listening(): boolean {
    return this.utterance !== null
  }

  async start(): Promise<void> {
    this.utterance?.cancel()
    this.utterance = null

    /**
     *
     * First use downloads the model (~640 MB) — stream that to the client the
     * way the desktop sidecar does, so the composer can show it.
     *
     **/
    const unsubscribe = onVoiceProgress((fraction) => this.emit({ type: 'progress', fraction, stage: 'downloading' }))
    try {
      await ensureVoiceEngine()
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : 'voice engine unavailable' })
      return
    } finally {
      unsubscribe()
    }
    this.emit({ type: 'ready' })

    this.utterance = new Utterance({
      onPartial: (text) => this.emit({ type: 'partial', text }),
      onError: (message) => {
        this.utterance = null
        this.emit({ type: 'error', message })
      },
    })
    this.emit({ type: 'listening' })
  }

  async stop(): Promise<void> {
    const utterance = this.utterance
    this.utterance = null
    if (!utterance) {
      this.emit({ type: 'final', text: '' })
      return
    }
    try {
      this.emit({ type: 'final', text: await utterance.stop() })
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : 'transcription failed' })
    }
  }

  append(samples: Float32Array): void {
    this.utterance?.append(samples)
  }

  /** The client's explicit `cancel` — acknowledged with `idle`. */
  cancel(): void {
    this.utterance?.cancel()
    this.utterance = null
    this.emit({ type: 'idle' })
  }

  /** Connection teardown — same cleanup as cancel, but nobody left to tell. */
  dispose(): void {
    this.utterance?.cancel()
    this.utterance = null
    this.releaseEngine()
  }
}
