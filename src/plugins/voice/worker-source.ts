/**
 *
 * The decode worker's source, shipped as a string and started with
 * `new Worker(source, { eval: true })` — sherpa-onnx's `decode()` is a
 * synchronous native call that would otherwise block the sidecar's event loop
 * (SSE proxying, schedules) for seconds per window. A string survives Nitro's
 * bundling where a worker entry file would not; the native addon itself is
 * resolved by the parent at runtime and handed in via workerData (it is never
 * imported statically, so the bundler stays out of the picture).
 *
 **/

export const VOICE_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads')

let recognizer = null
try {
  const sherpa = require(workerData.sherpaEntry)
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: workerData.paths.encoder,
        decoder: workerData.paths.decoder,
        joiner: workerData.paths.joiner,
      },
      tokens: workerData.paths.tokens,
      numThreads: workerData.numThreads,
      provider: 'cpu',
      modelType: 'nemo_transducer',
    },
  })
  parentPort.postMessage({ type: 'ready' })
} catch (err) {
  parentPort.postMessage({ type: 'fatal', message: String((err && err.message) || err) })
}

parentPort.on('message', (msg) => {
  if (!msg || msg.type !== 'decode' || !recognizer) return
  try {
    const stream = recognizer.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples: msg.samples })
    recognizer.decode(stream)
    const result = recognizer.getResult(stream)
    parentPort.postMessage({ type: 'result', id: msg.id, text: ((result && result.text) || '').trim() })
  } catch (err) {
    parentPort.postMessage({ type: 'result', id: msg.id, text: '', error: String((err && err.message) || err) })
  }
})
`
