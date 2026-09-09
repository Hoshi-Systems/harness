# Harness

`@hoshi/harness` is a self-hosted machine runtime. It provides the
HTTP/WebSocket server, session and provider runtime, permission handling, event
bus, and plugin host. Product UI protocols, organization policy, and vendor
integrations belong in separately installed plugins.

See the [architecture diagram](./docs/architecture.md) for the runtime boundary
and [plugin authoring guide](./docs/plugin-authoring.md) for the extension API.

## Run it

Node.js 22 or later is required.

```sh
pnpm add @hoshi/harness
npx hoshi-harness --host 127.0.0.1 --port 4200
```

The daemon stores state in `~/.hoshi` and uses `/workspace` when that mounted
directory exists (otherwise `~/.hoshi-workspace`). Set
`HOSHI_STATE_DIR` and `WORKSPACE_ROOT`, or pass `--state` and `--workspace`, to
choose different locations.

```sh
hoshi-harness --workspace ./workspace --state ./.hoshi --port 4200
```

Run `hoshi-harness routes` to inspect the installed API surface,
`hoshi-harness capabilities` to print the safe capability inventory a client
would receive from `GET /capabilities`, or `hoshi-harness doctor` to report
missing optional system dependencies.

## Plugins

Plugins are explicit modules. A plugin package exports an array of results from
`definePlugin`; load it with `--plugins-from` or `HOSHI_PLUGINS`.

```ts
import { definePlugin } from '@hoshi/harness'

export default [
  definePlugin({
    name: 'example',
    description: 'An example extension',
    capability: {
      id: 'example.inspect',
      title: 'Example inspection',
      description: 'Inspects an example.',
    },
    setup(host) {
      host.routes.get('/example', () => ({ ok: true }))
    },
  }),
]
```

```sh
hoshi-harness --plugins-from @acme/hoshi-plugin
```

A plugin must resolve `@hoshi/harness` to the same installed package instance
as the daemon. The loader rejects a second copy because it would register with
a kernel that the running daemon cannot serve.

## Library and wire contracts

Use `createHarness()` to embed the daemon, and import machine-wire contracts
from the dedicated export:

```ts
import { createHarness } from '@hoshi/harness'
import type { CapabilityPassport, MachineEvent, MachineProfile } from '@hoshi/harness/wire'

const harness = createHarness({ port: 4200 })
await harness.listen()
```

`createHarness()` applies `workspace` and `state` to the running kernel. One
Harness may be live in a Node.js process at a time; run separate processes for
separate machines. This reflects the process-wide route table, plugin registry,
and host ports, and prevents their state from being silently shared.

The `@hoshi/harness/wire` entry point is intended for machine clients and plugin
authors. Internal kernel files are not a supported API.

Plugins can also contribute complete prompt sections through
`agentInstructions` and declare conversation-only tools through
`systemToolNames`. Those extension points keep a product protocol out of the
core while letting the daemon assemble one coherent runtime.

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check:dist
pnpm check:boundary
```

The package is released under the [MIT License](./LICENSE).
