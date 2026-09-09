# Architecture

`@hoshi/harness` is deliberately the smallest durable runtime that can host a
machine. It owns no product UI or organization-specific feature.

```mermaid
flowchart LR
  client["Any machine client"] -->|HTTP, WebSocket| daemon["Harness daemon"]
  daemon --> kernel["Kernel\nsessions · turns · providers · permissions · events"]
  daemon --> builtin["Built-in generic plugins\nfiles · git · terminal · MCP · services"]
  daemon --> external["External plugin packages\n--plugins-from / HOSHI_PLUGINS"]
  external --> product["Product-specific UI, policy, integrations"]
  kernel --> wire["Public machine wire\n@hoshi/harness/wire"]
  client --> wire
```

The arrow into the daemon is ordinary HTTP/WebSocket traffic. The arrow into an
external plugin is an in-process module load: a plugin is not a sidecar and does
not get a second kernel. The daemon rejects a plugin made by another installed
copy of the harness, because that copy would register tools and routes that the
running machine cannot serve.

## Capability Passport

The machine has one safe, versioned description of its usable surface. It is a
projection of live runtime facts, rather than a configuration file a product has
to keep in sync.

```mermaid
flowchart TB
  declaration["Plugin declaration\nid · title · description"] --> registry
  setup["Plugin setup\nroutes · tools · dependencies"] --> registry["Live plugin registry\nstate · reason · surfaces"]
  routes["Kernel route table"] --> passport["Capability Passport\nGET /capabilities · CLI"]
  registry --> passport
  passport --> clients["Any client\nHoshi · CLI · future Reference Console"]
```

An owner can read the Passport to discover and diagnose a machine. It does not
grant any access: every route and tool retains its own authorization checks.
See [Capability Passport](./capability-passport.md) for the wire contract.

## Ownership test

| Belongs in the harness | Belongs in a plugin |
| --- | --- |
| Live machine primitives: a turn, file, terminal, provider, event stream | A product's UI protocol or design-system vocabulary |
| A generic capability useful to a standalone machine | Organization policy, billing, tenancy, or provisioning |
| The plugin contract and lifecycle | A vendor integration or branded workflow |

When a capability needs a product client to make sense, implement it as a
plugin. The harness should still be useful and comprehensible when that plugin
is absent.
