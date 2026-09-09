import { describe, expect, it } from 'vitest'
import { encodeWav } from './wav.js'

/**
 * ── The WAV a browser has to be able to play ─────────────────────────────────
 *
 * Speech leaves this machine as 32-bit float PCM and reaches an `<audio>` tag,
 * and the 44 bytes in between are the whole contract. Nothing downstream checks
 * them: a wrong byte rate or a mislabelled data size does not throw, it plays
 * at the wrong speed or plays silence, and the report comes back as "the voice
 * sounds broken" with nothing to look at.
 *
 * So the header is asserted field by field, and the clamp is asserted at the
 * edges — asymmetric on purpose, because two's complement is: −1 maps to
 * −32768 and +1 to +32767, and scaling both by 0x8000 overflows the positive
 * end into a click.
 *
 **/

const read = (wav: Buffer) => ({
  riff: wav.toString('ascii', 0, 4),
  size: wav.readUInt32LE(4),
  wave: wav.toString('ascii', 8, 12),
  fmt: wav.toString('ascii', 12, 16),
  fmtSize: wav.readUInt32LE(16),
  format: wav.readUInt16LE(20),
  channels: wav.readUInt16LE(22),
  sampleRate: wav.readUInt32LE(24),
  byteRate: wav.readUInt32LE(28),
  blockAlign: wav.readUInt16LE(32),
  bits: wav.readUInt16LE(34),
  data: wav.toString('ascii', 36, 40),
  dataSize: wav.readUInt32LE(40),
})

describe('encodeWav', () => {
  it('writes a RIFF/WAVE header that says what the body actually is', () => {
    const wav = encodeWav(new Float32Array([0, 0, 0, 0]), 16_000)
    expect(read(wav)).toEqual({
      riff: 'RIFF',
      size: 36 + 8,
      wave: 'WAVE',
      fmt: 'fmt ',
      fmtSize: 16,
      format: 1,
      channels: 1,
      sampleRate: 16_000,
      byteRate: 32_000,
      blockAlign: 2,
      bits: 16,
      data: 'data',
      dataSize: 8,
    })
    expect(wav).toHaveLength(44 + 8)
  })

  it('carries the sample rate it was given, because playback speed is that number', () => {
    expect(read(encodeWav(new Float32Array([0]), 22_050)).sampleRate).toBe(22_050)
    expect(read(encodeWav(new Float32Array([0]), 22_050)).byteRate).toBe(44_100)
  })

  it('scales the two signs differently, which is what two-s complement requires', () => {
    const wav = encodeWav(new Float32Array([-1, 1, 0]), 16_000)
    expect(wav.readInt16LE(44)).toBe(-32_768)
    expect(wav.readInt16LE(46)).toBe(32_767)
    expect(wav.readInt16LE(48)).toBe(0)
  })

  it('clamps rather than wrapping — an overshoot is a click, not a quiet sample', () => {
    const wav = encodeWav(new Float32Array([-4, 4]), 16_000)
    expect(wav.readInt16LE(44)).toBe(-32_768)
    expect(wav.readInt16LE(46)).toBe(32_767)
  })

  it('writes a header even for silence, so an empty answer is still a playable file', () => {
    const wav = encodeWav(new Float32Array([]), 16_000)
    expect(wav).toHaveLength(44)
    expect(read(wav).dataSize).toBe(0)
    expect(read(wav).size).toBe(36)
  })
})
