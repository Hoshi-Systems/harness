import type { HoshiToolContext, MachineCapabilities } from './define-tool.js'
import type { PluginToolContext } from './define.js'
import {
  complete,
  installSkill,
  listProviderStatuses,
  publishMachineEvent,
  readSecretValue,
  setCommand,
  tierModelRef,
} from '../kernel/index.js'

/**
 *
 * The context Hoshi's own tools are bound to.
 *
 * `defineHoshiTool` bodies take the machine as a set of capabilities rather
 * than importing it: a tool stays ignorant of how `publish` reaches a client or
 * where the provider catalogue comes from, which is what let those tools move
 * out of a foreign process without being rewritten. That indirection needs
 * exactly one place that fills it in — this file — or every plugin
 * contributing Hoshi tools grows its own copy of the same wiring, which is how
 * the memory tools ended up with a private copy of the entire memory store
 * (docs/STRUCTURE_REVIEW.md H-08).
 *
 **/

const machineCapabilities: MachineCapabilities = {
  complete: (prompt, options) => complete(prompt, options),
  async providers() {
    return (await listProviderStatuses()).map((provider) => ({
      id: provider.id,
      name: provider.name,
      connected: provider.connected,
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        outputModalities: model.outputModalities,
        releaseDate: model.releaseDate,
        status: model.status,
      })),
    }))
  },
  tierModel: (tier) => tierModelRef(tier),
  async providerKey(providerId) {
    const provider = (await listProviderStatuses()).find((entry) => entry.id === providerId)
    return provider?.keyEnvVar ? await readSecretValue(provider.keyEnvVar) : null
  },
  async createCommand(name, command) {
    await setCommand(name, command)
  },
  async createSkill(name, markdown) {
    await installSkill(name, markdown)
  },
}

/** The turn a tool is being bound for. `worktree` follows `directory`: Hoshi's
 *  own tools run where the session runs. */
export function machineToolContext(
  context: PluginToolContext & { model?: string | null },
): Omit<HoshiToolContext, 'signal'> {
  return {
    sessionId: context.sessionId,
    directory: context.directory,
    worktree: context.directory,
    agent: context.agent,
    model: context.model ?? null,
    publish: (type, properties) => publishMachineEvent(`${context.eventNamespace}.${type}`, properties),
    machine: machineCapabilities,
  }
}
