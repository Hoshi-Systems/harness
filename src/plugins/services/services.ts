import type { UnmanagedProcess } from '../../wire/index.js'
import path from 'node:path'

import {
  apiError,
  listCheckoutMeta,
  createCachedStore,
  publishMachineEvent,
  workspaceRoot,
} from '../../kernel/index.js'
import { listListeningPorts } from './listening-ports.js'
import { type TrackedProcess, listProcesses, startProcess, stopProcess } from './processes.js'

/**
 * ── Services ─────────────────────────────────────────────────────────────────
 *
 * A service is a NAMED, long-running thing that belongs to a checkout: the dev
 * server, a queue worker, a mailcatcher. The whole point of the abstraction is
 * that its backing runtime is an implementation detail — today every service is
 * a tracked process (utils/processes.ts), and the plan
 * is for shared infrastructure to become a sibling container later without the
 * panel, the API shape, or the user's mental model changing.
 *
 * ONE STORE, THREE WRITERS — the shape utils/memory.ts already proved here.
 * ~/.hoshi/services.json is the single registry: written by the user (the
 * panel), by the project's own manifest (`dev.yml` `run:`, stage 2), and by
 * detection (stage 2). Unlike processes.json this file has exactly ONE writer
 * process — the sidecar — so the cached-store pattern (goals.ts, triggers.ts)
 * is safe here where processes.ts deliberately re-reads from disk every call.
 *
 * The RECORD is the declaration; the RUNTIME is looked up, never stored. A
 * record holds what the user typed (name, command, cwd, port, env) plus a
 * pointer at its current process; status, pid and "is the port actually
 * listening" are derived on every read from the process registry and the live
 * socket scan. That means a process dying — a crash, a machine reboot, someone
 * killing it from a shell — needs no write here at all to show up correctly.
 *
 * `projectId` is likewise DERIVED, not stored: `cwd` is the durable fact and
 * the checkout manifest is the Platform's mirror, so resolving on read keeps
 * one source of truth even when a checkout is re-mirrored or renamed.
 *
 **/

export type ServiceScope =
  /** Belongs to one checkout — the default, and what a dev server is. */
  | 'project'
  /** Shared across every checkout on this machine (one Postgres, one
   *  mailcatcher). Opt-in, because memory is capped per machine by the org's
   *  tier — a copy per checkout is exactly what that cap can't afford. */
  | 'machine'

export type ServiceSource = 'user' | 'manifest' | 'detected'

export type ServiceStatus = 'stopped' | 'running' | 'failed' | 'exited'

export interface ServiceRecord {
  id: string
  /** Short label — what the panel row and the preview chip say ("web"), as
   *  opposed to the raw port number the chips show today. */
  name: string
  command: string
  cwd: string
  /** The port this service is expected to serve on; null when it doesn't serve
   *  one (a worker). Declared, not discovered — discovery stays the job of
   *  utils/ports.ts, and `listening` below is where the two are reconciled. */
  port: number | null
  scope: ServiceScope
  source: ServiceSource
  /** Extra environment on top of the sidecar's own, applied at start. */
  env: Record<string, string> | null
  /** The tracked process backing the current (or most recent) run. */
  processId: string | null
  createdAt: string
  updatedAt: string
}

/** A record plus everything derived at read time — the only shape that ever
 *  leaves this module, so the GET response and the `services.changed` payload
 *  can never drift apart. */
export interface ServiceView extends ServiceRecord {
  projectId: string | null
  status: ServiceStatus
  pid: number | null
  startedAt: string | null
  /** Whether `port` is actually accepting connections right now. A service can
   *  be `running` without listening yet — a dev server takes a moment to bind,
   *  and that gap is exactly when a user clicks Preview too early. */
  listening: boolean
}

/** A process running on this machine that no service claims — almost always
 *  one the agent started with `process_start`. Surfaced rather than hidden:
 *  the panel is meant to be an honest answer to "what is running here", and
 *  these are promotable into real services. */
export type { UnmanagedProcess }

/** A type alias, not an interface, on purpose: `publishMachineEvent` takes a
 *  `Record<string, unknown>`, and an interface has no implicit index signature
 *  to satisfy it. Making the snapshot publishable directly is what keeps the
 *  GET response and the event payload literally the same value. */
export type ServicesSnapshot = {
  services: ServiceView[]
  unmanaged: UnmanagedProcess[]
}

interface ServiceStore {
  services: ServiceRecord[]
}

const serviceStore = createCachedStore<ServiceStore>('services.json', (stored) => {
  const parsed = stored as ServiceStore | null
  return parsed && Array.isArray(parsed.services) ? parsed : { services: [] }
})

/**
 * ── Pure helpers (unit-tested in services.test.ts) ───────────────────────────
 *
 **/

/** Is `target` the same as `parent`, or inside it? Compares path SEGMENTS, not
 *  the raw string: `/workspace/acme/shop-admin` starts with
 *  `/workspace/acme/shop` as a string but is a different checkout entirely, and
 *  a naive prefix test would file its dev server under the wrong project. */
export function isWithin(parent: string, target: string): boolean {
  const from = path.resolve(parent)
  const to = path.resolve(target)
  if (from === to) return true
  const rel = path.relative(from, to)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Which checkout a working directory belongs to. LONGEST match wins, so a
 *  checkout nested inside another one claims its own processes rather than
 *  losing them to the outer directory. Null means the personal space (the
 *  workspace root itself) or anywhere else with no checkout above it. */
export function attributeProject(cwd: string, checkouts: { id: string; directory: string }[]): string | null {
  let best: { id: string; length: number } | null = null
  for (const checkout of checkouts) {
    if (!isWithin(checkout.directory, cwd)) continue
    const length = path.resolve(checkout.directory).length
    if (!best || length > best.length) best = { id: checkout.id, length }
  }
  return best?.id ?? null
}

/** A service's status, read off its backing process. No process at all — never
 *  started, or the registry trimmed a long-settled run — is `stopped`, which is
 *  also what the user should see after a machine reboot: the declaration
 *  survives, the run doesn't. */
export function deriveStatus(proc: TrackedProcess | undefined): ServiceStatus {
  if (!proc) return 'stopped'
  if (proc.status === 'running') return 'running'
  if (proc.status === 'failed') return 'failed'
  /**
   *
   * A deliberate stop reads as `stopped`; an unattended death reads as
   * `exited`, so "I stopped this" and "this fell over" stay distinguishable.
   *
   **/
  return proc.status === 'stopped' ? 'stopped' : 'exited'
}

/**
 * ── Reads ────────────────────────────────────────────────────────────────────
 *
 **/

/** Everything the panel needs, in one shape: declared services with their live
 *  runtime resolved, plus the running processes nothing declares. Shared by
 *  `GET /services` and by every `services.changed` publish. */
export async function servicesSnapshot(): Promise<ServicesSnapshot> {
  const [store, processes, checkouts, ports] = await Promise.all([
    serviceStore.load(),
    listProcesses(),
    listCheckoutMeta(),
    listListeningPorts(),
  ])

  const byId = new Map(processes.map((proc) => [proc.id, proc]))
  const listening = new Set(ports)
  const claimed = new Set<string>()

  const services = store.services.map((record) => {
    const proc = record.processId ? byId.get(record.processId) : undefined
    if (proc) claimed.add(proc.id)
    const status = deriveStatus(proc)
    return {
      ...record,
      projectId: record.scope === 'machine' ? null : attributeProject(record.cwd, checkouts),
      status,
      pid: proc?.pid ?? null,
      startedAt: proc?.startedAt ?? null,
      listening: status === 'running' && record.port != null && listening.has(record.port),
    } satisfies ServiceView
  })

  const unmanaged = processes
    .filter((proc) => proc.status === 'running' && !claimed.has(proc.id))
    .map((proc) => ({
      processId: proc.id,
      name: proc.name,
      command: proc.command,
      cwd: proc.cwd,
      pid: proc.pid,
      projectId: attributeProject(proc.cwd, checkouts),
      startedAt: proc.startedAt,
    }))

  return { services, unmanaged }
}

/** One service's derived view, or undefined when the id is unknown. */
export async function getServiceView(id: string): Promise<ServiceView | undefined> {
  return (await servicesSnapshot()).services.find((service) => service.id === id)
}

async function requireRecord(id: string): Promise<ServiceRecord> {
  const record = (await serviceStore.load()).services.find((service) => service.id === id)
  if (!record) apiError(404, 'service.notFound', 'Service not found.')
  return record
}

/**
 * ── Publishing ───────────────────────────────────────────────────────────────
 *
 **/

/** Push the whole snapshot to every live `/events` listener. Machine realtime
 *  is events, never client polling (CLAUDE.md) — and a panel of long-running
 *  things is precisely the surface that tempts a `setInterval`. Called at every
 *  mutation here; plugins/state-events.ts additionally re-publishes when the
 *  snapshot changes on its own (a process dying under us), which is the case no
 *  mutation path can ever catch. */
async function publishServicesChanged(): Promise<void> {
  publishMachineEvent('services.changed', await servicesSnapshot())
}

/**
 * ── Validation ───────────────────────────────────────────────────────────────
 *
 **/

const MAX_NAME = 60
const MAX_COMMAND = 4_000
const MAX_ENV_ENTRIES = 100

export function validateName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > MAX_NAME) {
    apiError(400, 'service.nameLength', `Enter a name (1–${MAX_NAME} characters).`, { max: MAX_NAME })
  }
  return name
}

export function validateCommand(value: unknown): string {
  const command = typeof value === 'string' ? value.trim() : ''
  if (!command || command.length > MAX_COMMAND) {
    apiError(400, 'service.commandLength', `Enter a command (1–${MAX_COMMAND} characters).`, { max: MAX_COMMAND })
  }
  return command
}

/** A service's working directory must sit inside the workspace. Not a privilege
 *  boundary — the machine's owner already has a shell on it — but the panel's
 *  contract is "things that belong to your projects", and a cwd outside the
 *  workspace can't be attributed to one. */
export function validateCwd(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) apiError(400, 'service.cwdRequired', 'A working directory is required.')
  const resolved = path.resolve(raw)
  if (!isWithin(workspaceRoot(), resolved)) {
    apiError(400, 'service.cwdOutsideWorkspace', 'The working directory must be inside the workspace.')
  }
  return resolved
}

export function validatePort(value: unknown): number | null {
  if (value == null || value === '') return null
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    apiError(400, 'service.portInvalid', 'Not a valid TCP port.')
  }
  return port
}

export function validateScope(value: unknown): ServiceScope {
  if (value == null) return 'project'
  if (value !== 'project' && value !== 'machine') {
    apiError(400, 'service.scopeInvalid', 'scope must be "project" or "machine".')
  }
  return value
}

export function validateEnv(value: unknown): Record<string, string> | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    apiError(400, 'service.envInvalid', 'env must be an object of string values.')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_ENV_ENTRIES) {
    apiError(400, 'service.envTooLarge', `At most ${MAX_ENV_ENTRIES} environment variables.`, {
      max: MAX_ENV_ENTRIES,
    })
  }
  const env: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (!key.trim() || typeof raw !== 'string') {
      apiError(400, 'service.envInvalid', 'env must be an object of string values.')
    }
    env[key.trim()] = raw
  }
  return env
}

/**
 * ── Mutations ────────────────────────────────────────────────────────────────
 *
 **/

export async function createService(fields: {
  name: string
  command: string
  cwd: string
  port: number | null
  scope: ServiceScope
  env: Record<string, string> | null
  source?: ServiceSource
}): Promise<ServiceView> {
  const store = await serviceStore.load()
  const now = new Date().toISOString()
  const record: ServiceRecord = {
    id: crypto.randomUUID(),
    name: fields.name,
    command: fields.command,
    cwd: fields.cwd,
    port: fields.port,
    scope: fields.scope,
    source: fields.source ?? 'user',
    env: fields.env,
    processId: null,
    createdAt: now,
    updatedAt: now,
  }
  store.services.push(record)
  serviceStore.persist()
  await publishServicesChanged()
  return (await getServiceView(record.id))!
}

export async function patchService(
  id: string,
  patch: Partial<Pick<ServiceRecord, 'name' | 'command' | 'cwd' | 'port' | 'scope' | 'env'>>,
): Promise<ServiceView> {
  const record = await requireRecord(id)
  Object.assign(record, patch, { updatedAt: new Date().toISOString() })
  serviceStore.persist()
  await publishServicesChanged()
  return (await getServiceView(id))!
}

export async function deleteService(id: string): Promise<void> {
  const record = await requireRecord(id)
  /**
   *
   * Deleting a declaration must not orphan its process — otherwise the row
   * vanishes while the dev server keeps holding its port, and the only way back
   * is a shell. Stop first, then forget.
   *
   **/
  if (record.processId) await stopProcess(record.processId)
  const store = await serviceStore.load()
  store.services = store.services.filter((service) => service.id !== id)
  serviceStore.persist()
  await publishServicesChanged()
}

export async function startService(id: string): Promise<ServiceView> {
  const record = await requireRecord(id)
  const current = await getServiceView(id)
  if (current?.status === 'running') {
    apiError(409, 'service.alreadyRunning', 'This service is already running.')
  }

  /**
   *
   * A declared port already held by something else is the commonest way a start
   * fails, and `EADDRINUSE` buried in a log tail is a poor way to learn it.
   * Name the holder when another service is the one holding it (US-6); fall
   * back to a plain "in use" when it's something we don't own, since the socket
   * scan gives us the port but not a name we could stand behind.
   *
   **/
  if (record.port != null) {
    const port = record.port
    const { services } = await servicesSnapshot()
    const holder = services.find((other) => other.id !== id && other.status === 'running' && other.port === port)
    if (holder) {
      apiError(409, 'service.portTaken', `Port ${port} is already used by "${holder.name}".`, {
        port,
        holder: holder.name,
      })
    }
    if ((await listListeningPorts()).includes(port)) {
      apiError(409, 'service.portBusy', `Port ${port} is already in use on this machine.`, { port })
    }
  }

  let started
  try {
    started = await startProcess({
      name: record.name,
      command: record.command,
      cwd: record.cwd,
      env: record.env,
    })
  } catch (error) {
    apiError(400, 'service.startFailed', `Could not start "${record.name}": ${(error as Error).message}`, {
      name: record.name,
    })
  }

  record.processId = started.id
  record.updatedAt = new Date().toISOString()
  serviceStore.persist()
  await publishServicesChanged()
  return (await getServiceView(id))!
}

/** Stop a service's process. Deliberately idempotent: stopping something
 *  already stopped is a no-op success, not a 4xx — the button should never
 *  punish a double click or a stale view. */
export async function stopService(id: string): Promise<ServiceView> {
  const record = await requireRecord(id)
  if (record.processId) await stopProcess(record.processId)
  await publishServicesChanged()
  return (await getServiceView(id))!
}

export async function restartService(id: string): Promise<ServiceView> {
  await stopService(id)
  return startService(id)
}

/** Promote a process nothing declares into a real service, keeping its current
 *  run attached — so adopting the dev server the agent started doesn't kill it
 *  and start a second one. */
export async function adoptProcess(fields: {
  processId: string
  name?: string
  port: number | null
  scope: ServiceScope
}): Promise<ServiceView> {
  const { unmanaged } = await servicesSnapshot()
  const proc = unmanaged.find((candidate) => candidate.processId === fields.processId)
  if (!proc)
    apiError(404, 'service.processNotAdoptable', 'That process is not running, or already belongs to a service.')

  const store = await serviceStore.load()
  const now = new Date().toISOString()
  const record: ServiceRecord = {
    id: crypto.randomUUID(),
    name: fields.name?.trim() || proc.name,
    command: proc.command,
    cwd: proc.cwd,
    port: fields.port,
    scope: fields.scope,
    source: 'user',
    env: null,
    processId: proc.processId,
    createdAt: now,
    updatedAt: now,
  }
  store.services.push(record)
  serviceStore.persist()
  await publishServicesChanged()
  return (await getServiceView(record.id))!
}
