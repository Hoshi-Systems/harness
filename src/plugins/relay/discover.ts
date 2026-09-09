import { discoverProvider, type Provider } from '../../kernel/index.js'
import type { RelayEndpointAd } from './protocol.js'
import type { RelayEndpoint } from './link.js'

/**
 * ── Proving an advertised endpoint ───────────────────────────────────────────
 *
 * The connector declares ids; the machine believes models it has seen. Each
 * endpoint is probed THROUGH the loopback forwarder with the same
 * `discoverProvider` every added-by-address provider goes through, so a
 * registration is evidence the whole path works — engine → loopback → socket →
 * connector → runtime — not a claim about one hop of it.
 *
 **/

/** More than this is a typo or an abuse, not a person's hardware. */
const MAX_ENDPOINTS = 8

const ID_SHAPE = /^[a-z0-9][a-z0-9_-]{0,31}$/

export interface ValidatedAds {
  accepted: RelayEndpoint[]
  failed: Array<{ id: string; reason: string }>
}

/** Which advertisements are even well-formed. Shape failures are reported per
 *  endpoint rather than failing the hello: one bad flag on the connector's
 *  command line must not cost the endpoints beside it. */
export function validateAds(ads: RelayEndpointAd[]): ValidatedAds {
  const accepted: RelayEndpoint[] = []
  const failed: Array<{ id: string; reason: string }> = []
  const seen = new Set<string>()
  for (const ad of ads) {
    const id = ad.id.trim().toLowerCase()
    if (!ID_SHAPE.test(id)) {
      failed.push({ id: ad.id, reason: 'endpoint ids are lowercase letters, digits, dashes or underscores' })
      continue
    }
    if (seen.has(id)) {
      failed.push({ id, reason: 'advertised twice' })
      continue
    }
    if (accepted.length >= MAX_ENDPOINTS) {
      failed.push({ id, reason: `only the first ${MAX_ENDPOINTS} endpoints are taken` })
      continue
    }
    seen.add(id)
    accepted.push({
      id,
      providerId: `local-${id}`,
      name: ad.name.trim().slice(0, 64) || id,
    })
  }
  return { accepted, failed }
}

/** Ask one endpoint what it serves, through the tunnel, and shape the answer
 *  as the provider the kernel will list. The base that ANSWERED is what the
 *  provider records — usually `…/v1`, because that is where the
 *  OpenAI-compatible surface lives, and the engine appends `/chat/completions`
 *  to whatever this says (kernel/model.ts). Recording the root when only
 *  `/v1` answered is how a provider lists models it can never run. */
export async function proveEndpoint(
  loopbackPort: number,
  endpoint: RelayEndpoint,
): Promise<{ provider: Provider } | { reason: string }> {
  const root = `http://127.0.0.1:${loopbackPort}/ep/${endpoint.id}`
  const viaV1 = await discoverProvider(`${root}/v1`, null)
  const proven = viaV1
    ? { base: `${root}/v1`, models: viaV1.models }
    : await discoverProvider(root, null).then((atRoot) => (atRoot ? { base: root, models: atRoot.models } : null))
  if (!proven) {
    return { reason: 'answered with no model list — check that the runtime is running and the URL is right' }
  }
  return {
    provider: {
      id: endpoint.providerId,
      name: endpoint.name,
      baseUrl: proven.base,
      keyEnvVar: null,
      /**
       *
       * Keyless by construction, not by evidence here: the tunnel is
       * authorized at the socket, and the probe above ran with no credential —
       * succeeding that way is the same proof `discoverProvider` always takes.
       *
       **/
      keyless: true,
      source: 'relay',
      policyBlocked: false,
      models: proven.models,
    },
  }
}
