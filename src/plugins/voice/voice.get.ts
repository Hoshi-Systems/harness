import { defineEventHandler } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { ttsEngineWarm } from './tts-engine.js'
import { TTS_MODEL_ID, ttsModelsPresent } from './tts-models.js'
import { voiceEngineWarm } from './stt-engine.js'
import { VOICE_MODEL_ID, voiceModelsPresent } from './stt-models.js'

/** Voice capability probe — dictation (stt) and read-aloud (tts) share this
 *  one route: the web app checks it once per machine and hides the affordance
 *  on a 404 (a machine image predating voice support). `ready` distinguishes
 *  "instant" from "first use will download or load the model".
 *
 *  Deliberately a PURE READ — it must never warm an engine. It used to
 *  (CYB-86, chasing the TTS autoplay-gesture window), which meant every
 *  machine the web app so much as OPENED paid the STT recognizer's ~1.3 GB
 *  of resident RAM whether or not voice was ever used — on a 2 GB machine
 *  that starved OpenCode into timeouts and ended in the kernel OOM-killing
 *  the sidecar (observed live in production). Engines now load on first real
 *  use (the mic press / the read-aloud call — both already stream a warm-up
 *  state to the client) and the STT engine unloads itself after idling. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return {
    stt: {
      available: true,
      model: VOICE_MODEL_ID,
      ready: voiceEngineWarm() || (await voiceModelsPresent()),
    },
    tts: {
      available: true,
      model: TTS_MODEL_ID,
      ready: ttsEngineWarm() || (await ttsModelsPresent()),
    },
  }
})
