import { definePlugin } from '../define.js'
import stream from './voice.stream.all.js'
import route_voice_index_get from './voice.get.js'
import route_voice_speak_post from './voice.speak.post.js'

export default definePlugin({
  name: 'voice',
  description: 'Speech in and out, on the machine’s own CPU',

  setup(host) {
    /**
     *
     * Dictation is a websocket: audio in, text out, on this machine's own CPU.
     *
     **/
    host.routes.all('/voice/stream', stream)
    host.routes.get('/voice', route_voice_index_get)
    host.routes.post('/voice/speak', route_voice_speak_post)
  },
})
