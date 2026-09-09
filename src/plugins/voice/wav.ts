/**
 *
 * Sherpa-onnx hands back raw 32-bit float PCM (range [-1, 1]) plus a sample
 * rate; there's no existing WAV-writing code in this repo to reuse (the addon's
 * own `writeWave` only writes to disk, and the route needs an in-memory buffer
 * for the response body). A minimal 44-byte RIFF/WAVE header around 16-bit PCM
 * — the same float32→int16 scale/clamp sherpa-onnx's own Node examples use —
 * keeps the file small and playable by every browser's <audio>/Audio() without
 * a codec.
 *
 **/

const HEADER_BYTES = 44
const BITS_PER_SAMPLE = 16
const NUM_CHANNELS = 1

/** Encode mono float32 PCM as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const blockAlign = (NUM_CHANNELS * BITS_PER_SAMPLE) / 8
  const dataSize = samples.length * blockAlign
  const buffer = Buffer.alloc(HEADER_BYTES + dataSize)

  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')

  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16) // fmt chunk size
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(NUM_CHANNELS, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * blockAlign, 28) // byte rate
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34)

  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)

  let offset = HEADER_BYTES
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!))
    const value = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff)
    buffer.writeInt16LE(value, offset)
    offset += 2
  }

  return buffer
}
