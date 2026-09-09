# Hoshi Harness

`@hoshi/harness` is the self-hosted machine runtime behind Hoshi. It provides
the HTTP/WebSocket server, session and provider runtime, permission handling,
event bus, and plugin host. Platform-specific policy belongs in separately
installed plugins.

## Run it

Node.js 22 or later is required.

```sh
pnpm add @hoshi/harness
npx hoshi-harness --host 127.0.0.1 --port 4200
```

The daemon stores state in `~/.hoshi` and uses `~/workspace` by default. Set
`HOSHI_STATE_DIR` and `WORKSPACE_ROOT`, or pass `--state` and `--workspace`, to
choose different locations.

```sh
hoshi-harness --workspace ./workspace --state ./.hoshi --port 4200
```

Run `hoshi-harness routes` to inspect the installed API surface, or
`hoshi-harness doctor` to report missing optional system dependencies.

## Plugins

Plugins are explicit modules. A plugin package exports an array of results from
`definePlugin`; load it with `--plugins-from` or `HOSHI_PLUGINS`.

```ts
import { definePlugin } from '@hoshi/harness'

export default [
  definePlugin({
    name: 'example',
    description: 'An example extension',
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
import type { MachineEvent, MachineProfile } from '@hoshi/harness/wire'

const harness = createHarness({ port: 4200 })
await harness.listen()
```

The `@hoshi/harness/wire` and `@hoshi/harness/hgl` entry points are intended
for clients and plugin authors. Internal kernel files are not a supported API.

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check:dist
```

The package is released under the [MIT License](./LICENSE).
