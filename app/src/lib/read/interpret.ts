/**
 * One reply, one outcome. The order below is the contract, and the tests fail
 * if any two steps swap.
 *
 *   1. The beta gate. Its 401 and its 503 page carry no contract header, so
 *      they are recognised before the header is required and before anything
 *      of the body is treated as a producer payload.
 *   2. A redirect: Cloudflare Access in front of a staging origin.
 *   3. The `X-Domino-Read-Contract` header, on success and error replies
 *      alike, exact match against the pinned candidate. A non-JSON reply with
 *      no header is an edge page or a missing bridge, not a contract.
 *   4. JSON media, the size bound, and parsing.
 *   5. 200: the package runtime (`assertResponse`), then the identity checks
 *      against the request. Only then `ok`.
 *   6. Anything else: `validateError` checks code and status together, then
 *      the error table decides the state.
 *
 * Nothing here retries; pipeline.ts decides that from the outcome.
 */
import { ERROR_CLASS } from './errors'
import { ACCEPTED_READ_CONTRACTS } from './pin'
import type {
  ErrorCode,
  FailedOutcome,
  Observation,
  Provenance,
  ProviderObservation,
  RawReply,
  ReadOutcome,
  ReadKey,
  ReadRequests,
  ReadResponses,
  ReadValidators,
  RequestOf,
} from './types'

/** The gate's JSON refusal, byte for byte as functions/_middleware.ts sends it. */
export const GATE_REFUSAL = '{"error":"beta_access_required"}'
/**
 * The access page's title. The gate answers every request with this page when
 * its configuration is broken; an edge error page never carries it.
 */
export const GATE_PAGE_MARKER = '<title>Domino · Closed beta</title>'
/** The bridge's own response bound (LIMITS.responseBytes in bridge/src/worker.mjs). */
export const MAX_RESPONSE_BYTES = 1024 * 1024
/** Non-JSON bodies are only ever inspected for the gate marker. */
export const MAX_PAGE_BYTES = 16 * 1024

const JSON_MEDIA = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i
const isJsonMedia = (type: string | null) => type !== null && JSON_MEDIA.test(type)
const isHtmlMedia = (type: string | null) => type !== null && /^text\/html\b/i.test(type)

const lower = (value: string) => value.toLowerCase()
const sameAddress = (a: string, b: string) => lower(a) === lower(b)
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, i) => sameAddress(value, b[i]))

/**
 * Does the payload answer the question that was asked? The runtime proves the
 * shape; this proves it is about the requested pool, token, NFT or block. A
 * mismatch is a wrong answer, and a wrong answer is never rendered. For NFTs
 * the answer is the whole requested set: one result per id, none left out,
 * none twice, none extra.
 *
 * Two echoes are deliberately not bound: `pools.pairedToken` (the fixtures
 * answer null for a requested pair, an open question for the producer) and the
 * wallet, which wallet-assets does not echo at all.
 */
export function answersRequest<R extends ReadKey>(route: R, request: RequestOf<R>, data: ReadResponses[R]): boolean {
  switch (route) {
    case 'capabilities':
      return true
    case 'token': {
      const q = request as unknown as ReadRequests['token']
      const d = data as ReadResponses['token']
      return sameAddress(d.asset.address, q.token)
    }
    case 'pools': {
      const q = request as unknown as ReadRequests['pools']
      const d = data as ReadResponses['pools']
      return sameAddress(d.selectedToken, q.token)
    }
    case 'pool-market': {
      const q = request as unknown as ReadRequests['pool-market']
      const d = data as ReadResponses['pool-market']
      if (!sameAddress(d.poolId, q.poolId) || !sameAddress(d.pool.poolId, q.poolId)) return false
      const market = d.market.data
      if (market && (!sameAddress(market.poolId, d.poolId) || !sameList(market.currencies, d.pool.currencies))) return false
      const history = d.priceHistory.data
      if (history && (!sameAddress(history.poolId, d.poolId) || !sameList(history.currencies, d.pool.currencies))) return false
      // Omitted means the schema default, false.
      const wanted = q.includePriceHistory ?? false
      if (wanted && d.priceHistory.status === 'not_requested') return false
      if (!wanted && d.priceHistory.status !== 'not_requested') return false
      return true
    }
    case 'wallet-assets':
      return true
    case 'nft-positions': {
      const q = request as unknown as ReadRequests['nft-positions']
      const d = data as ReadResponses['nft-positions']
      if (typeof q.blockNumber === 'number' && d.snapshot.number !== q.blockNumber) return false
      // As many results as ids, no id twice, none that was not asked for: exactly the requested set.
      const asked = new Set(q.tokenIds)
      const answered = new Set(d.items.map((item) => item.tokenId))
      return d.items.length === q.tokenIds.length && answered.size === d.items.length && d.items.every((item) => asked.has(item.tokenId))
    }
    case 'catalogue': {
      const q = request as unknown as ReadRequests['catalogue']
      const d = data as ReadResponses['catalogue']
      if (typeof q.revision === 'number' && d.revision !== q.revision) return false
      return d.items.every((item) => item.currencies.some((currency) => sameAddress(currency, q.token)))
    }
    case 'pool-activity':
    case 'pool-positions':
    case 'pool-metrics': {
      const q = request as unknown as ReadRequests['pool-metrics']
      const d = data as ReadResponses['pool-metrics']
      return sameAddress(d.poolId, q.poolId)
    }
    default:
      return route satisfies never
  }
}

/** Freshness and provider provenance, per family. */
export function observe<R extends ReadKey>(route: R, data: ReadResponses[R]): Observation {
  switch (route) {
    case 'capabilities':
      return { block: null, providers: [] }
    case 'token': {
      const d = data as ReadResponses['token']
      return { block: d.snapshot, providers: [] }
    }
    case 'pools': {
      const d = data as ReadResponses['pools']
      const providers: ProviderObservation[] = []
      d.pools.forEach((pool, i) => {
        if (pool.providerMetrics) {
          providers.push({ scope: `pools[${i}].providerMetrics`, provider: 'dexscreener', retrievedAt: pool.providerMetrics.retrievedAt })
        }
      })
      providers.push({ scope: 'discovery', provider: 'dexscreener', retrievedAt: null })
      const catalogue = d.catalogue.status === 'available' ? d.catalogue.revision : undefined
      return { block: d.snapshot, revision: catalogue, providers }
    }
    case 'pool-market': {
      const d = data as ReadResponses['pool-market']
      const providers: ProviderObservation[] = [
        { scope: 'market', provider: 'geckoterminal', retrievedAt: d.market.data?.retrievedAt ?? null, cache: d.market.cache },
      ]
      if (d.priceHistory.cache) {
        providers.push({
          scope: 'priceHistory',
          provider: 'geckoterminal',
          retrievedAt: d.priceHistory.data?.retrievedAt ?? null,
          cache: d.priceHistory.cache,
        })
      }
      return { block: d.snapshot, providers }
    }
    case 'wallet-assets': {
      const d = data as ReadResponses['wallet-assets']
      const inventory = d.inventory
      const providers: ProviderObservation[] =
        inventory.source === 'alchemy'
          ? [{ scope: 'inventory', provider: 'alchemy', retrievedAt: inventory.status === 'page_received' ? inventory.retrievedAt : null }]
          : []
      return { block: d.snapshot, providers }
    }
    case 'nft-positions': {
      const d = data as ReadResponses['nft-positions']
      return { block: d.snapshot, freshness: { ...d.freshness }, providers: [] }
    }
    case 'catalogue': {
      const d = data as ReadResponses['catalogue']
      return {
        block: null,
        revision: d.revision,
        interval: { startBlock: d.startBlock, indexedThrough: d.indexedThrough, coverage: d.coverage },
        providers: [],
      }
    }
    case 'pool-activity':
    case 'pool-positions': {
      const d = data as ReadResponses['pool-activity']
      const { number, hash, timestamp } = d.snapshot
      return {
        block: { number, hash, timestamp },
        revision: 'revision' in d ? d.revision : undefined,
        freshness: { ...d.freshness },
        providers: [],
      }
    }
    case 'pool-metrics': {
      const d = data as ReadResponses['pool-metrics']
      const { number, hash, timestamp } = d.snapshot
      const providers: ProviderObservation[] = []
      for (const price of d.prices) {
        for (const provider of price.observedSources ?? []) {
          providers.push({ scope: `prices.${lower(price.currency)}`, provider, retrievedAt: price.lastTimestamp })
        }
      }
      return { block: { number, hash, timestamp }, revision: d.revision, freshness: { ...d.freshness }, providers }
    }
    default:
      return route satisfies never
  }
}

type Failure<R extends ReadKey> = FailedOutcome<R>

function classifyError<R extends ReadKey>(route: R, provenance: Provenance, status: number, code: ErrorCode, retryAfter: string | null): Failure<R> {
  const base = { route, provenance }
  const rule = ERROR_CLASS[code]
  switch (rule.kind) {
    case 'restart':
      return { ...base, state: 'restart_required', code: code as 'invalid_or_expired_cursor' | 'catalogue_revision_changed' }
    case 'route_disabled':
      return { ...base, state: 'disabled', reason: 'route_not_enabled' }
    case 'request_rejected':
      return { ...base, state: 'request_rejected', code, status }
    case 'busy':
      return { ...base, state: 'busy', retryAfterSeconds: retryAfterSeconds(retryAfter) }
    case 'incompatible':
      return { ...base, state: 'incompatible', reason: 'upstream_contract_mismatch' }
    case 'unavailable':
      return { ...base, state: 'unavailable', cause: { kind: 'producer', code, status }, retryable: rule.retryable }
    default:
      return rule satisfies never
  }
}

/** The bridge's own bound: an integer from 1 to 60, otherwise 1. */
export function retryAfterSeconds(header: string | null): number {
  if (header === null || !/^\d{1,3}$/.test(header)) return 1
  const seconds = Number(header)
  return seconds >= 1 && seconds <= 60 ? seconds : 1
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

export function interpretReply<R extends ReadKey>(
  route: R,
  request: RequestOf<R>,
  raw: RawReply,
  validators: ReadValidators,
  provenance: Provenance,
): ReadOutcome<R> {
  const base = { route, provenance: { ...provenance, contract: raw.contractHeader } }
  const text = raw.body.kind === 'text' ? raw.body.text : null

  // 1. The gate, before the header and before any producer validation.
  if (raw.status === 401) {
    if (text === GATE_REFUSAL && isJsonMedia(raw.contentType)) return { ...base, state: 'gate_required' }
    return { ...base, state: 'invalid', reason: 'unrecognised_401' }
  }
  if (raw.status === 503 && isHtmlMedia(raw.contentType) && text !== null && text.includes(GATE_PAGE_MARKER)) {
    return { ...base, state: 'gate_unavailable' }
  }

  // 2. Access answers with a redirect, which a manual-redirect fetch cannot read.
  if (raw.opaqueRedirect) return { ...base, state: 'access_required' }

  // 3. The contract header, on every reply the bridge authors.
  if (raw.contractHeader === null) {
    if (!isJsonMedia(raw.contentType)) {
      return { ...base, state: 'unavailable', cause: { kind: 'edge', status: raw.status }, retryable: false }
    }
    return { ...base, state: 'incompatible', reason: 'contract_header_missing' }
  }
  if (!ACCEPTED_READ_CONTRACTS.has(raw.contractHeader)) {
    return { ...base, state: 'incompatible', reason: 'contract_version_not_accepted' }
  }

  // 4. Media, size, syntax.
  if (!isJsonMedia(raw.contentType)) return { ...base, state: 'invalid', reason: 'not_json' }
  if (raw.body.kind === 'too_large') return { ...base, state: 'invalid', reason: 'too_large' }
  if (raw.body.kind === 'undecodable' || text === null) return { ...base, state: 'invalid', reason: 'invalid_json' }
  const parsed = parseJson(text)
  if (!parsed.ok) return { ...base, state: 'invalid', reason: 'invalid_json' }

  // 5. Success: the shared runtime, then the question that was asked.
  if (raw.status === 200) {
    let data: ReadResponses[R]
    try {
      data = validators.assertResponse(route, parsed.value)
    } catch {
      return { ...base, state: 'invalid', reason: 'response_contract' }
    }
    if (!answersRequest(route, request, data)) return { ...base, state: 'invalid', reason: 'identity_mismatch' }
    return { ...base, state: 'ok', data, observation: observe(route, data) }
  }

  // 6. A producer error: finite code and matching status, or nothing.
  if (!validators.validateError(raw.status, parsed.value)) return { ...base, state: 'invalid', reason: 'error_contract' }
  return classifyError(route, base.provenance, raw.status, parsed.value.error, raw.retryAfterHeader)
}
