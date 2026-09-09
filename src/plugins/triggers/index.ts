import { definePlugin } from '../define.js'
import { detachWorkflowFromTriggers, listSchedules, listWebhooks } from './triggers.js'
import { rememberContext } from './context.js'
import { scheduleTicker } from './scheduler.js'
import route_triggers_schedules_id_delete from './triggers.schedules.id.delete.js'
import route_triggers_schedules_id_patch from './triggers.schedules.id.patch.js'
import route_triggers_schedules_id_run_post from './triggers.schedules.id.run.post.js'
import route_triggers_schedules_index_get from './triggers.schedules.get.js'
import route_triggers_schedules_index_post from './triggers.schedules.post.js'
import route_triggers_webhooks_id_delete from './triggers.webhooks.id.delete.js'
import route_triggers_webhooks_id_patch from './triggers.webhooks.id.patch.js'
import route_triggers_webhooks_id_secret_post from './triggers.webhooks.id.secret.post.js'
import route_triggers_webhooks_id_regenerate_post from './triggers.webhooks.id.regenerate.post.js'
import route_triggers_webhooks_id_signing_delete from './triggers.webhooks.id.signing.delete.js'
import route_triggers_webhooks_id_signing_post from './triggers.webhooks.id.signing.post.js'
import route_triggers_webhooks_index_get from './triggers.webhooks.get.js'
import route_triggers_webhooks_index_post from './triggers.webhooks.post.js'

export default definePlugin({
  name: 'triggers',
  description: 'Schedules and webhooks — the machine firing work at itself',

  setup(host) {
    rememberContext(host.unattended)
    host.provide({ detachTriggersForWorkflow: detachWorkflowFromTriggers })

    /**
     *
     * A machine with an armed schedule or a live webhook must not be suspended:
     * the scheduler runs HERE, so a suspended machine simply does not fire its
     * 03:00 digest, and a webhook to a suspended machine is a 502 and a lost
     * event. The hero says "it runs on schedules and triggers" — this is the
     * line that keeps that true rather than aspirational.
     *
     * Disabled ones do not count. Somebody who turned a schedule off has said
     * it should not run, and holding a machine awake for it would charge them
     * for the decision to stop.
     *
     **/
    host.provide((current) => ({
      ...current,
      keepAwake: async () => {
        const reasons = [...((await current.keepAwake?.()) ?? [])]
        const [schedules, webhooks] = await Promise.all([listSchedules(), listWebhooks()])
        if (schedules.some((schedule) => schedule.enabled)) reasons.push('schedule')
        if (webhooks.some((webhook) => webhook.enabled)) reasons.push('webhook')
        return reasons
      },
    }))
    const ticker = scheduleTicker(host.unattended)
    host.jobs.every(ticker.every, ticker.tick)
    host.routes.delete('/triggers/schedules/:id', route_triggers_schedules_id_delete)
    host.routes.patch('/triggers/schedules/:id', route_triggers_schedules_id_patch)
    host.routes.post('/triggers/schedules/:id/run', route_triggers_schedules_id_run_post)
    host.routes.get('/triggers/schedules', route_triggers_schedules_index_get)
    host.routes.post('/triggers/schedules', route_triggers_schedules_index_post)
    host.routes.delete('/triggers/webhooks/:id', route_triggers_webhooks_id_delete)
    host.routes.patch('/triggers/webhooks/:id', route_triggers_webhooks_id_patch)
    host.routes.post('/triggers/webhooks/:id/:secret', route_triggers_webhooks_id_secret_post)
    host.routes.post('/triggers/webhooks/:id/regenerate', route_triggers_webhooks_id_regenerate_post)
    host.routes.delete('/triggers/webhooks/:id/signing', route_triggers_webhooks_id_signing_delete)
    host.routes.post('/triggers/webhooks/:id/signing', route_triggers_webhooks_id_signing_post)
    host.routes.get('/triggers/webhooks', route_triggers_webhooks_index_get)
    host.routes.post('/triggers/webhooks', route_triggers_webhooks_index_post)
  },
})
