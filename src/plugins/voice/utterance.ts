import { voiceDecode } from './stt-engine.js'

/**
 *
 * One dictation utterance: PCM in, live transcript out. Parakeet TDT is an
 * offline (whole-window) model, so streaming is windowed — the head of the
 * buffer is committed once it outgrows ~12 s (cut at the quietest spot, so a
 * word isn't split mid-syllable), and the still-volatile tail is re-decoded as
 * audio arrives. Decode cost therefore stays bounded no matter how long the
 * user talks; the worker serializes decodes across utterances.
 *
 **/

const SAMPLE_RATE = 16_000
/** Re-decode the tail once this much new audio has arrived (~1.2 s). */
const PARTIAL_MIN_NEW = SAMPLE_RATE * 1.2
/** Commit the head once the tail grows past this (~12 s)... */
const COMMIT_TRIGGER = SAMPLE_RATE * 12
/** ...cutting at the quietest 200 ms found between 9 s and 11.5 s. */
const CUT_SEARCH_START = SAMPLE_RATE * 9
const CUT_SEARCH_END = SAMPLE_RATE * 11.5
const CUT_WINDOW = Math.round(SAMPLE_RATE * 0.2)
const CUT_HOP = Math.round(SAMPLE_RATE * 0.05)
/** Hard cap per utterance — 15 minutes of 16 kHz Float32 is ~55 MB. */
const MAX_SAMPLES = SAMPLE_RATE * 60 * 15

export interface UtteranceEvents {
  onPartial(text: string): void
  onError(message: string): void
}

/** The quietest cut point inside the commit search range. */
function quietestCut(tail: Float32Array): number {
  const end = Math.min(CUT_SEARCH_END, tail.length) - CUT_WINDOW
  let best = Math.round((CUT_SEARCH_START + CUT_SEARCH_END) / 2)
  let bestEnergy = Infinity
  for (let start = CUT_SEARCH_START; start <= end; start += CUT_HOP) {
    let energy = 0
    for (let i = start; i < start + CUT_WINDOW; i++) energy += tail[i]! * tail[i]!
    if (energy < bestEnergy) {
      bestEnergy = energy
      best = start + CUT_WINDOW / 2
    }
  }
  return Math.round(best)
}

export class Utterance {
  private chunks: Float32Array[] = []
  private tailLength = 0
  private totalSamples = 0
  private committed: string[] = []
  private newSinceDecode = 0
  private pump: Promise<void> | null = null
  private closing = false

  constructor(private events: UtteranceEvents) {}

  append(samples: Float32Array): void {
    if (this.closing || samples.length === 0) return
    this.totalSamples += samples.length
    if (this.totalSamples > MAX_SAMPLES) {
      this.closing = true
      this.events.onError('Utterance too long — dictation stopped.')
      return
    }
    this.chunks.push(samples)
    this.tailLength += samples.length
    this.newSinceDecode += samples.length
    this.schedule()
  }

  /** Flush and return the full transcript. The utterance is spent after this. */
  async stop(): Promise<string> {
    this.closing = true
    await this.pump
    const tail = this.takeTail()
    if (tail.length > 0) {
      const text = await voiceDecode(tail)
      if (text) this.committed.push(text)
    }
    return this.committed.join(' ')
  }

  cancel(): void {
    this.closing = true
    this.chunks = []
    this.tailLength = 0
  }

  private schedule(): void {
    if (this.closing || this.pump) return
    if (this.tailLength < COMMIT_TRIGGER && this.newSinceDecode < PARTIAL_MIN_NEW) return
    this.pump = this.run().finally(() => {
      this.pump = null
      this.schedule()
    })
  }

  private async run(): Promise<void> {
    try {
      if (this.tailLength >= COMMIT_TRIGGER) await this.commitHead()
      this.newSinceDecode = 0
      const text = await voiceDecode(this.tailCopy())
      if (!this.closing) this.events.onPartial([...this.committed, text].filter(Boolean).join(' '))
    } catch (err) {
      if (!this.closing) {
        this.closing = true
        this.events.onError(err instanceof Error ? err.message : 'transcription failed')
      }
    }
  }

  private async commitHead(): Promise<void> {
    /**
     *
     * Snapshot-and-reset before the await: audio keeps arriving while the head
     * decodes, and those chunks must land *after* the preserved remainder.
     *
     **/
    const tail = this.takeTail()
    const cut = quietestCut(tail)
    const rest = tail.slice(cut)
    const text = await voiceDecode(tail.slice(0, cut))
    if (rest.length > 0) {
      this.chunks.unshift(rest)
      this.tailLength += rest.length
    }
    if (text) this.committed.push(text)
  }

  /** Concatenate and consume the tail buffer. Both tail helpers return the
   *  narrowed `Float32Array<ArrayBuffer>` a bare annotation would widen to
   *  `ArrayBufferLike` — voiceDecode transfers the buffer to its worker. */
  private takeTail(): Float32Array<ArrayBuffer> {
    const out = new Float32Array(this.tailLength)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    this.chunks = []
    this.tailLength = 0
    return out
  }

  /** Concatenate the tail without consuming it — partial decodes retry. */
  private tailCopy(): Float32Array<ArrayBuffer> {
    const out = new Float32Array(this.tailLength)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }
}
