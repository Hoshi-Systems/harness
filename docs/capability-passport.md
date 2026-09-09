# Capability Passport proposal

## Purpose

Harness is a runtime for a persistent agent machine, not a product-specific
coding client. An operator or any client therefore needs one stable answer to:

> What can this machine do, which extension supplied it, and why is it not
> available right now?

The Capability Passport is that answer. It turns the runtime's existing plugin
lifecycle, dependency declarations, route table, and tool registry into a
versioned, read-only machine contract. A product may render it however it
chooses; no product contributes fields to it.

## Contract

`GET /capabilities` will be an authenticated endpoint. Its initial response is
a snapshot with a schema version:

```ts
interface CapabilityPassport {
  schemaVersion: 1
  capabilities: Capability[]
}

interface Capability {
  id: string
  title: string
  description: string
  owner: { kind: 'kernel' | 'plugin'; name: string }
  state: 'ready' | 'degraded'
  reason: string | null
  requires: {
    system: Array<{ id: string; reason: string }>
    ports: string[]
  }
  surfaces: {
    tools: string[]
    routes: Array<{ method: string; path: string }>
  }
}
```

`id` is stable vocabulary, not a display label. A plugin owns IDs beneath its
own name (`files.workspace`, for example); duplicate IDs fail boot and name
both owners. A `ready` capability never grants access: every route and tool
keeps its normal authorization checks.

## Sources of truth

The Passport is a projection, not a second registry:

- The kernel declares generic machine primitives in one static list.
- A plugin declares the capabilities it owns next to its description,
  dependencies, and port requirements.
- The existing plugin registry owns lifecycle state and records the routes and
  tools registered during setup.
- A degraded plugin remains visible. “Known but unavailable” is different from
  “this runtime does not support it.”

The connection-time `machine.state` snapshot remains the lightweight event
surface. If availability changes after boot, it is republished; a client then
refetches the detailed Passport once. No polling loop is introduced.

## Safety

The Passport is owner-authenticated, like the existing plugin status endpoint.
It must never include credentials, environment values, filesystem paths,
commands, raw log output, or arbitrary thrown errors. A dependency identifier
and human-readable reason are enough to explain a degraded capability.

The unauthenticated `/health` endpoint remains only an infrastructure probe.

## Implementation sequence

1. Add `CapabilityDeclaration` to the public plugin contract, validate
   owner-qualified IDs, and reject duplicates.
2. Declare kernel capabilities and migrate built-in plugins.
3. Record registered tools and routes in the existing plugin registry.
4. Export Passport types from `@hoshi/harness/wire`; add the authenticated
   endpoint and lifecycle tests.
5. Add a standalone external-plugin conformance fixture and built-daemon wire
   test.
6. Build a read-only Reference Console as a separate client of this contract.

## Non-goals

- No plugin marketplace, package installer, or generic model-authored UI.
- No vendor, organization, tenancy, billing, or branded-client vocabulary.
- No claim that the Passport is an authorization or policy system.

The first product built on Harness may consume this contract, but Harness must
remain complete and understandable when that product is absent.
