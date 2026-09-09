# Contributing to Harness

Harness is a standalone machine runtime. Contributions should make the runtime
more useful without requiring a particular product, organization, UI client, or
vendor service.

## Set up

Use Node.js 22 or newer and the pnpm version pinned in `package.json`.

```sh
corepack enable
pnpm install
pnpm typecheck
pnpm test
```

## Before opening a pull request

Run the complete local check:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm check:boundary
pnpm check:dist
```

`check:boundary` is intentional: product protocols and product-owned plugins
must remain outside this package. If a capability needs a branded client,
organization policy, or vendor contract to make sense, implement it as a plugin
and use the stable root or `/wire` exports.

## Scope a change

- Keep public APIs documented in the README or the plugin-authoring guide.
- Add a focused test for changed runtime behaviour.
- Do not import internal source paths from a plugin; use `@hoshi/harness` or
  `@hoshi/harness/wire`.
- Keep generated `dist` out of commits. The build recreates it from source.

For design context, see the [architecture guide](./docs/architecture.md) and
[plugin authoring guide](./docs/plugin-authoring.md).
