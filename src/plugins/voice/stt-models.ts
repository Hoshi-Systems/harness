import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { hoshiFile } from '../../kernel/index.js'

/**
 *
 * Parakeet TDT v3 (0.6B, int8 ONNX) — the same multilingual model the desktop
 * app runs through CoreML, here as sherpa-onnx's export. Downloaded per-file
 * from the sherpa-onnx Hugging Face mirror (the GitHub release ships a
 * .tar.bz2, and bzip2 isn't a given on the machine image) into ~/.hoshi —
 * /data on provisioned machines, so redeploys never re-download.
 *
 **/

export const VOICE_MODEL_ID = 'parakeet-tdt-0.6b-v3'

const MIRROR = 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main'
const FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']

export interface VoiceModelPaths {
  encoder: string
  decoder: string
  joiner: string
  tokens: string
}

function voiceModelDir(): string {
  return hoshiFile(path.join('models', `${VOICE_MODEL_ID}-int8`))
}

function voiceModelPaths(): VoiceModelPaths {
  const dir = voiceModelDir()
  return {
    encoder: path.join(dir, 'encoder.int8.onnx'),
    decoder: path.join(dir, 'decoder.int8.onnx'),
    joiner: path.join(dir, 'joiner.int8.onnx'),
    tokens: path.join(dir, 'tokens.txt'),
  }
}

async function fileSize(file: string): Promise<number | null> {
  try {
    const info = await stat(file)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

export async function voiceModelsPresent(): Promise<boolean> {
  const sizes = await Promise.all(FILES.map((name) => fileSize(path.join(voiceModelDir(), name))))
  return sizes.every((size) => size !== null && size > 0)
}

/** Download any missing model files, reporting overall progress in [0, 1].
 *  Byte-weighted across files (the encoder is ~97% of the total), sized by a
 *  HEAD pass first. Files land as `.part` and rename into place, so a killed
 *  download never leaves a truncated file that passes the presence check. */
export async function ensureVoiceModels(onProgress: (fraction: number) => void): Promise<VoiceModelPaths> {
  const dir = voiceModelDir()
  await mkdir(dir, { recursive: true })

  const pending: { name: string; bytes: number }[] = []
  for (const name of FILES) {
    const size = await fileSize(path.join(dir, name))
    if (size !== null && size > 0) continue
    const head = await fetch(`${MIRROR}/${name}`, { method: 'HEAD' })
    if (!head.ok) throw new Error(`Voice model file ${name} unavailable (${head.status})`)
    pending.push({ name, bytes: Number(head.headers.get('content-length')) || 0 })
  }

  const totalBytes = pending.reduce((sum, file) => sum + file.bytes, 0)
  let doneBytes = 0

  for (const file of pending) {
    const res = await fetch(`${MIRROR}/${file.name}`)
    if (!res.ok || !res.body) throw new Error(`Voice model download failed for ${file.name} (${res.status})`)

    const target = path.join(dir, file.name)
    const part = `${target}.part`
    let fileDone = 0
    const out = createWriteStream(part)
    /**
     *
     * Node's fetch body is async-iterable — count bytes for progress and
     * respect the writer's backpressure by hand.
     *
     **/
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      fileDone += chunk.byteLength
      if (totalBytes > 0) onProgress(Math.min(1, (doneBytes + fileDone) / totalBytes))
      if (!out.write(chunk)) await once(out, 'drain')
    }
    out.end()
    await finished(out)
    await rename(part, target)
    doneBytes += fileDone
  }

  onProgress(1)
  return voiceModelPaths()
}
