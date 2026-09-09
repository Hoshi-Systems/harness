import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
/**
 *
 * `unbzip2-stream` ships no types, and a `.d.ts` beside this file is invisible
 * to consumers that typecheck this package's SOURCE through their own tsconfig
 * (every Nuxt/Nitro app here does). Requiring it with an explicit signature is
 * the one form that types identically from either side.
 *
 **/
const bz2 = createRequire(import.meta.url)('unbzip2-stream') as () => Transform
import tarStream from 'tar-stream'
import { createRequire } from 'node:module'
import type { Transform } from 'node:stream'
import { hoshiFile } from '../../kernel/index.js'

/**
 *
 * Supertonic-3 (Supertone/supertonic-3 upstream, sherpa-onnx's int8 export) —
 * one offline multi-speaker model covering 31 languages, including Ukrainian
 * and Polish alongside English. Unlike the STT
 * model (a per-file Hugging Face mirror, see utils/voice/models.ts), sherpa-onnx
 * only ships this one as a single .tar.bz2 GitHub release asset — verified
 * against https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models and
 * https://k2-fsa.github.io/sherpa/onnx/tts/supertonic.html (2026-07). Decompressed
 * and extracted in pure JS (unbzip2-stream + tar-stream) — this code runs both
 * inside the Debian machine image and on a bare macOS dev host, so it can't
 * shell out to an OS tar/bzip2 binary that may not be there (same reasoning as
 * the STT model's own comment).
 *
 **/

export const TTS_MODEL_ID = 'supertonic-3'

const ARCHIVE_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2'

const FILES = [
  'duration_predictor.int8.onnx',
  'text_encoder.int8.onnx',
  'vector_estimator.int8.onnx',
  'vocoder.int8.onnx',
  'tts.json',
  'unicode_indexer.bin',
  'voice.bin',
] as const

const FIELD_BY_FILE = {
  'duration_predictor.int8.onnx': 'durationPredictor',
  'text_encoder.int8.onnx': 'textEncoder',
  'vector_estimator.int8.onnx': 'vectorEstimator',
  'vocoder.int8.onnx': 'vocoder',
  'tts.json': 'ttsJson',
  'unicode_indexer.bin': 'unicodeIndexer',
  'voice.bin': 'voiceStyle',
} as const satisfies Record<(typeof FILES)[number], string>

export interface TtsModelPaths {
  durationPredictor: string
  textEncoder: string
  vectorEstimator: string
  vocoder: string
  ttsJson: string
  unicodeIndexer: string
  voiceStyle: string
}

function ttsModelDir(): string {
  return hoshiFile(path.join('models', `${TTS_MODEL_ID}-int8`))
}

function ttsModelPaths(): TtsModelPaths {
  const dir = ttsModelDir()
  const paths = {} as TtsModelPaths
  for (const name of FILES) paths[FIELD_BY_FILE[name]] = path.join(dir, name)
  return paths
}

async function fileSize(file: string): Promise<number | null> {
  try {
    const info = await stat(file)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

export async function ttsModelsPresent(): Promise<boolean> {
  const dir = ttsModelDir()
  const sizes = await Promise.all(FILES.map((name) => fileSize(path.join(dir, name))))
  return sizes.every((size) => size !== null && size > 0)
}

/** Download, decompress, and extract the Supertonic-3 archive if it isn't
 *  already on disk, reporting download progress in [0, 1] (extraction itself
 *  is fast enough not to need its own share). Lands in a `.part`-suffixed
 *  directory and renames into place atomically, so a killed download never
 *  leaves a partial directory that passes the presence check — the same
 *  on-disk safety property as the STT model's per-file `.part`-then-rename. */
export async function ensureTtsModels(onProgress: (fraction: number) => void): Promise<TtsModelPaths> {
  if (await ttsModelsPresent()) {
    onProgress(1)
    return ttsModelPaths()
  }

  const dir = ttsModelDir()
  const partDir = `${dir}.part`
  await rm(partDir, { recursive: true, force: true })
  await mkdir(partDir, { recursive: true })

  try {
    const res = await fetch(ARCHIVE_URL)
    if (!res.ok || !res.body) throw new Error(`Supertonic-3 model download failed (${res.status})`)
    const totalBytes = Number(res.headers.get('content-length')) || 0
    let doneBytes = 0

    const extract = tarStream.extract()
    const seen = new Set<string>()

    extract.on('entry', (header, entryStream, next) => {
      const name = path.basename(header.name)
      if (header.type !== 'file' || !(FILES as readonly string[]).includes(name)) {
        entryStream.resume()
        next()
        return
      }
      seen.add(name)
      const out = createWriteStream(path.join(partDir, name))
      entryStream.pipe(out)
      out.on('finish', next)
      out.on('error', (err) => extract.destroy(err))
    })

    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    source.on('data', (chunk: Buffer) => {
      doneBytes += chunk.byteLength
      if (totalBytes > 0) onProgress(Math.min(0.99, doneBytes / totalBytes))
    })

    await pipeline(source, bz2(), extract)

    const missing = FILES.filter((name) => !seen.has(name))
    if (missing.length > 0) {
      throw new Error(`Supertonic-3 archive missing expected file(s): ${missing.join(', ')}`)
    }
  } catch (err) {
    await rm(partDir, { recursive: true, force: true })
    throw err
  }

  await rm(dir, { recursive: true, force: true })
  await rename(partDir, dir)
  onProgress(1)
  return ttsModelPaths()
}
