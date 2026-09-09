import type { EventHandler } from 'h3'
import type { ToolSet } from 'ai'
import type { MachineEvent } from '../kernel/events.js'
import type { KernelPorts, UnattendedContext } from '../kernel/host-ports.js'

/** The durable identity a plugin contributes to the machine's Capability
 * Passport. A plugin can be useful without an HTTP route or a tool; this is
 * the one thing a product can use to name that useful unit consistently. */
export interface CapabilityDeclaration {
  /** Stable, plugin-scoped id: `${plugin.name}.something`. */
  id: string
  title: string
  description: string
}

/**
 * ── What a plugin is ─────────────────────────────────────────────────────────
 *
 * A module with one `definePlugin` export. Everything it contributes is
 * declared through the host it is handed; nothing is contributed by side
 * effect, by filename, or by import order (docs/decisions/0002-own-harness.md).
 *
 * The host is deliberately small. A plugin that wants a power it does not have
 * is telling us the kernel is missing something, and that conversation is
 * better than a plugin reaching around the API to get it.
 *
 **/

export interface PluginRoutes {
  get(path: string, handler: EventHandler): void
  post(path: string, handler: EventHandler): void
  patch(path: string, handler: EventHandler): void
  put(path: string, handler: EventHandler): void
  delete(path: string, handler: EventHandler): void
  /** Answers whatever verb arrives — a websocket upgrade, a proxy passthrough. */
  all(path: string, handler: EventHandler): void
}

export interface PluginToolContext {
  sessionId: string
  directory: string
  agent: string
  /** Event namespace assigned by the registry from the owning plugin. */
  eventNamespace: string
}

export interface PluginHost {
  /** Tools a turn can call. Merged into what the model is offered, so what a
   *  plugin adds is indistinguishable to a turn from a built-in. */
  tools: {
    add(build: (context: PluginToolContext) => ToolSet | Promise<ToolSet>, names: () => string[]): void
  }
  routes: PluginRoutes
  events: {
    /** Publish on the machine's bus. The plugin's name is PREFIXED, so no
     *  plugin can publish `session.deleted` and make every client drop a
     *  session. */
    publish(type: string, properties: Record<string, unknown>): void
    /** What this plugin sends a client that has just connected — its own
     *  opening snapshot, so a client-side mirror is complete even when nothing
     *  has changed since it last looked. */
    onConnect(replay: (push: (event: MachineEvent) => void) => void | Promise<void>): void
  }
  jobs: {
    /** Recurring work. The interval is a plain millisecond number; a throw is
     *  logged and the schedule continues. */
    every(intervalMs: number, run: () => void | Promise<void>): void
    /** One-shot work, started after every plugin is up. */
    once(run: () => void | Promise<void>): void
  }
  log: {
    info(message: string, ...rest: unknown[]): void
    error(message: string, ...rest: unknown[]): void
  }
  /** What this plugin needs when it acts with nobody watching — notifying the
   *  owner, asking whether an action is allowed, checking spend, dispatching
   *  work (kernel/ports.ts). Every member is optional and safely absent: a
   *  machine with no organization behind it supplies none of them, and a
   *  plugin must read that as "nobody to ask" rather than "yes". */
  unattended: UnattendedContext
  /** This machine's Platform, or null when it has none — see kernel/ports.ts.
   *  Read at CALL time: a machine can be linked after it booted. */
  platform(): { platformUrl: string; token: string; machineId: string | null; orgId: string | null } | null
  /**
   *
   * READ a port another plugin answers.
   *
   * The mirror of `provide`, and the reason a plugin never has to import
   * `kernel/host-ports`. Ports are how two plugins reach each other at all —
   * `web-control` needs the display `desktop` owns, a schedule needs the
   * workflow runner, an alert needs to know whether a goal will report the
   * completion itself — and a plugin may not import another
   * (`pnpm check:harness-barrel`).
   *
   * Read THROUGH, never captured: a machine can be linked to an organization
   * after it booted, a display can come up after the first session, and a
   * plugin that snapshotted this at setup would go on answering the question
   * the machine used to have. Absence stays absence — `undefined` means nobody
   * answers that port here, which a caller must read as "nobody to ask" rather
   * than as a failure.
   *
   * What a plugin reads from here belongs in its `uses` declaration, which is
   * what makes the dependency visible to `machine.state` and to the next
   * person wondering why a plugin is degraded.
   *
   **/
  ports: KernelPorts

  /** ANSWER a kernel port. The mirror of everything else the host offers: those
   *  are what a plugin takes, this is what it gives.
   *
   *  This is how an organization reaches the kernel at all — the allow-list on
   *  providers, the floor under unattended actions, the spend ceiling, the
   *  channels an owner watches. A machine that installs none of those plugins
   *  answers none of those ports, which is exactly what a machine with no
   *  organization behind it should do.
   *
   *  Composed, never clobbered: two plugins may answer different ports, and one
   *  that replaced the whole registry would silently disarm the other. */
  provide(ports: KernelPorts | ((current: KernelPorts) => KernelPorts)): void
}

/** Software a plugin needs present on the machine (docs/decisions/0002-own-harness.md).
 *
 *  `verify` is the contract and `install` is a convenience: the daemon trusts
 *  what verify says at every boot, and a machine is free to have arrived at
 *  that state some other way — a base image that already ships it, an admin who
 *  installed it, a different package manager entirely. */
export interface SystemDependency {
  id: string
  /** Why this plugin needs it, in words a person reads in a failure. */
  reason: string
  /** A command whose success means the dependency is present. */
  verify: string
  install?: {
    apt?: string[]
    brew?: string[]
    /** Last resort: fetch and unpack, with a checksum per architecture. */
    fallback?: { url: string; sha256: Record<string, string>; into: string }
  }
  /** Platforms this plugin can run on at all. Absent means any. */
  platforms?: NodeJS.Platform[]
}

export interface Plugin<Config = Record<string, never>> {
  name: string
  description: string
  /**
   * What this plugin contributes to the machine's public Capability Passport.
   *
   * Optional only while third-party plugins migrate to the pre-1.0 contract.
   * First-party plugins always declare one; a plugin without it remains fully
   * functional but is deliberately absent from `/capabilities` rather than
   * being guessed from a package name.
   */
  capability?: CapabilityDeclaration
  system?: SystemDependency[]
  /**
   *
   * Parse this plugin's configuration, or throw saying what is wrong.
   *
   * It is handed whatever the harness was started with under this plugin's
   * name, `undefined` included, and it returns the shape `setup` is given. A
   * plugin with no `config` gets `undefined` and may ignore the parameter.
   *
   * Throwing is the contract: the message is what a person reads when the
   * machine comes up degraded, so say which key and what was expected rather
   * than letting a bad value through. `Number(process.env.HOSHI_DESKTOP_PORT)`
   * used to answer `NaN` for a typo, and a machine that listens on NaN reports
   * nothing at all.
   *
   * Any validator: this repo has zod, an external plugin need not.
   *
   **/
  config?: (input: unknown) => Config
  /**
   *
   * Ports this plugin READS — the plugins it depends on, named.
   *
   * `system` says what the machine must have installed; this says what another
   * plugin must be answering. Every port is optional by construction (a machine
   * with no organization behind it answers none of them), so this does not
   * gate startup: what it does is make the dependency VISIBLE. Before it, the
   * only way to learn that `triggers` needs whoever owns workflows was to read
   * `triggers` looking for `ports()` calls.
   *
   * `pnpm check:harness-ports` holds it true in both directions: a port read
   * without being declared fails, and a declaration nothing reads fails too.
   *
   **/
  uses?: Array<keyof KernelPorts>
  /** Runs once at boot. May return a handle for orderly shutdown — and may do
   *  so synchronously: subscribing to the machine's event bus is not an async
   *  act, and forcing a plugin to be async to say "here is how to stop me"
   *  would be a shape the contract imposed for no reason. */
  setup(
    host: PluginHost,
    config: Config,
  ): void | { shutdown?: () => void | Promise<void> } | Promise<void | { shutdown?: () => void | Promise<void> }>
}

/**
 *
 * A plugin's own handle on the host it was started with.
 *
 * Most of a plugin is not its `setup` function. Its routes are default-export
 * modules the router imports by name, its bus subscriptions run long after
 * setup returned, and its helpers are reached from both — none of which is
 * handed a host. Threading one into every signature would be a large change to
 * a lot of files for no reader's benefit, so a plugin binds it once instead:
 *
 *     // workflows/host.ts
 *     export const { bind, ports } = hostBinding()
 *
 *     // workflows/index.ts
 *     setup(host) { bind(host) }
 *
 *     // workflows.id.delete.ts
 *     await ports().detachTriggersForWorkflow?.(id)
 *
 * The shape is deliberately the one the kernel registry had, because that is
 * what these call sites were written against — what changes is WHOSE it is. The
 * kernel's is private and mutable and pinned its own storage; this one is the
 * plugin's, reads through the host it was actually given, and is declared in
 * `uses` where `pnpm check:harness-ports` can hold it to the code.
 *
 * Unbound reads answer `{}` — every port is optional anyway, and a test that
 * imports a plugin's module without starting the plugin should see "nobody
 * answers that" rather than throw.
 *
 * `bind` takes the port surface alone rather than a whole `PluginHost`, so a
 * test can supply one without assembling a host it does not use. It must be a
 * GETTER if the test installs ports afterwards — the binding reads through, the
 * way the real host does.
 *
 **/
export function hostBinding(): {
  bind(host: Pick<PluginHost, 'ports'>): void
  ports(): KernelPorts
} {
  let bound: Pick<PluginHost, 'ports'> | null = null
  return {
    bind: (host) => {
      bound = host
    },
    ports: () => bound?.ports ?? {},
  }
}

/**
 *
 * A plugin with its configuration type BOUND — what a registry can hold.
 *
 * `Plugin<A>` and `Plugin<B>` are not assignable to one another, so a list of
 * plugins that each configure themselves differently has no honest element
 * type. The repo's answer was `Plugin<never>` and a cast at the call site
 * (`setup(host, config as never)`), which typechecks because `never` is the
 * bottom type and means nothing at all: the configuration was `unknown` going
 * in and `never` coming out, and no plugin has ever received one.
 *
 * So the type is erased where it stops being useful. `definePlugin` closes over
 * the plugin's own `Config` — inside, `configure` and `setup` still agree;
 * outside, a registry sees `unknown` and does not need to care.
 *
 **/
export interface RegisteredPlugin {
  name: string
  description: string
  capability?: CapabilityDeclaration
  system?: SystemDependency[]
  uses?: Array<keyof KernelPorts>
  /** Parse the input for this plugin. Throws with a readable message. */
  configure(input: unknown): unknown
  setup(
    host: PluginHost,
    config: unknown,
  ): void | { shutdown?: () => void | Promise<void> } | Promise<void | { shutdown?: () => void | Promise<void> }>
}

/**
 *
 * WHICH harness defined a plugin.
 *
 * A plugin registers with the kernel it imports: its routes go into that
 * kernel's table, its events onto that kernel's bus, its ports into that
 * kernel's registry. Load one built against a SECOND copy of this package —
 * a stale `dist` beside a source checkout, a plugin package that resolved
 * `@hoshi/harness` into its own `node_modules` — and every one of those lands
 * in a kernel nothing is serving. Nothing throws; the plugin simply is not
 * there, and `machine.state` reports it ready.
 *
 * So the brand is a Symbol this MODULE INSTANCE owns, not `Symbol.for`: a
 * second copy of the module mints a second symbol, and `isOwnPlugin` answers
 * false for anything it defined. The loader turns that into the one message
 * that explains the failure (daemon/load.ts).
 *
 **/
const DEFINED_HERE: unique symbol = Symbol('hoshi.harness.plugin')

/** Whether THIS harness's `definePlugin` produced the value. */
export function isOwnPlugin(value: unknown): value is RegisteredPlugin {
  return typeof value === 'object' && value !== null && (value as { [DEFINED_HERE]?: true })[DEFINED_HERE] === true
}

export function definePlugin<Config = Record<string, never>>(plugin: Plugin<Config>): RegisteredPlugin {
  const registered: RegisteredPlugin = {
    name: plugin.name,
    description: plugin.description,
    capability: plugin.capability,
    system: plugin.system,
    uses: plugin.uses,
    configure: (input) => (plugin.config ? plugin.config(input) : undefined),
    setup: (host, config) => plugin.setup(host, config as Config),
  }
  Object.defineProperty(registered, DEFINED_HERE, { value: true })
  return registered
}
