/**
 * DEX Screener through our own edge (audit I3, 2026-10-01): GET /api/read/dex/token-pairs/<token> and
 * GET /api/read/dex/tokens/<token>[,<token>…], answered by this Pages Function from DEX Screener's public API, one
 * token per upstream request, each kept at the edge.
 *
 * Why: the page used to ask api.dexscreener.com itself, for every token's artwork, New position's pool hints, the
 * markets' second source of figures, and the Wallet card's prices, up to 30 of the wallet's token addresses in one GET.
 * The provider then saw the visitor's address (IP) beside a set of tokens that is close to unique to one wallet. Asked
 * here, it sees Cloudflare's address and one token at a time, the same token for every visitor, and most asks never
 * reach it at all: each token's answer is kept FRESH_SECONDS (the provider's own max-age) and served up to
 * STALE_SECONDS while it is read again behind.
 *
 * What is passed on: only the fields the page reads (chain, dex, labels, pair address, the two tokens' addresses and
 * symbols, prices, liquidity, 24h volume, creation time and image), of pairs on the chain asked, as the provider wrote
 * them: never a figure of ours. The page checks every field again, as it always did. A `tokens` answer keeps, per
 * token, its most liquid pairs and the most liquid pair it is the base of (its artwork): what the Wallet card reads.
 *
 * What is refused: anything but a plain same-origin GET of those two paths with lowercase-or-mixed hex addresses (at
 * most MAX_TOKENS), a Worker's subrequest, a query string. An upstream that refuses, fails, or answers anything but a
 * bounded JSON array is never kept; with nothing kept for a token the answer is 502 `upstream_unavailable`, and the
 * page then asks the provider itself, as before (lib/tokenArtwork.ts): DEX Screener may refuse Cloudflare's shared
 * egress, as the chain's public RPC does, and that could not be checked before a deploy.
 *
 * Every answer says how old the oldest part of it is (X-Domino-Edge-Age, ms), so the page dates the figures by when
 * this edge retrieved them, and how it was made (Server-Timing). The gate runs first, as for every /api path, and the
 * answer leaves no-store.
 *
 * Changed on purpose 2026-10-06 (the owner's point 3: Base and Arbitrum One's pools in New position with TVL, 24h volume
 * and APR "like Robinhood Chain", from the same provider): GET /api/read/dex/token-pairs/<chain>/<token> for `base` and
 * `arbitrum`, the provider's own names for Base and Arbitrum One, asked and kept the same way, each answer about one
 * chain and kept under that chain's name (a token's address can repeat across chains). Robinhood Chain keeps its paths
 * and its keys as they were. `tokens` stays Robinhood Chain's alone: the Wallet card is its one reader.
 *
 * Changed on purpose 2026-10-14 (incident of 2026-10-13, package D1: about nine 502 on this route at every load of the
 * owner's Positions; the incident's design, §1.4 and §2.4). What was wrong, each proven in this file:
 * a read was shared by the asks of one isolate but lived in its first asker's request, so a visitor who left mid-read
 * (leaving the list cancels six price GETs) left a promise that never settled, and every later ask for that token in
 * that isolate joined it and answered 502 at the deadline, for good (sharedWork.ts describes the hazard; this file was
 * left out on 2026-10-02); one token with no answer, or one slow one, failed all ten; a failure was never remembered,
 * so every ask reached the provider again; the two views kept two entries for one upstream URL; nothing said why; and
 * no visitor was limited. What it does now, where it differs from the paragraphs above:
 *
 *   - Reads cannot die (sharedWork.ts's three rules, `startRead`): every upstream read is handed to waitUntil when it
 *     is created, clears its own slot when it settles, and is dated; an ask never joins one older than
 *     DEX_READ_STALE_MS, waits on one it joined on a timer of its own, and a read it joins takes none of its lanes.
 *   - One kept entry per chain and token, the token's whole trimmed pair list with the time it was retrieved, read by
 *     both views (`tokens` cuts it with pairsForPrice as it answers), kept DEX_KEPT_SECONDS. Up to DEX_STALE_SECONDS
 *     old it is served at once and read again behind, as before; past that the provider is asked in the ask's own time,
 *     as before, and only when that read gives nothing is the older entry served, with its own time, and only on the
 *     new path. An empty list is an answer too, served as it is for DEX_NONE_FRESH_SECONDS.
 *   - Misses are remembered, per isolate: a token whose read gave nothing is not read again for DEX_MISS_SECONDS, then
 *     twice that, up to DEX_MISS_MAX_SECONDS, until an answer; an upstream 429 stops every read from this isolate for
 *     its Retry-After. What is kept is still served meanwhile.
 *   - A new path, GET /api/read/dex2/<the same asks> (`answerDex2`): a 200 for a valid ask whatever the provider does,
 *     saying each token's own state: {v: 2, now, tokens: {<address>: {at, pairs} | {at, none: true} | {missing: <reason>, retryAfterS}}},
 *     `at` and `now` on this edge's clock, so the page dates each token by its own retrieval. One slow or refused token
 *     no longer costs the other nine. The old path keeps its shape, its 502 and its ages for the tabs opened before the
 *     deploy (they read any other body as a failure, and an age past ten minutes as none), and gains the rest.
 *   - Every answer says why a token has no fresh read, per token, in Server-Timing (`miss;desc="<reason> <token>"`):
 *     the upstream's status class, `timeout`, `network`, `not_json`, `too_large`, `late` (this ask's own read is still
 *     on its way), `joined` (another ask's read, with its age as `dur`), or `capped`. Pages keeps no Function logs
 *     (wrangler.toml), so the evidence travels with the answer.
 *   - A visitor (a network, as the chain routes count one) has an allowance of asks (DEX_VISITOR; past it a 429 with
 *     Retry-After) and one of addresses this edge has never seen (DEX_VISITOR_NEW; past it such a token is `capped` and
 *     read by no one), since an unseen address is always one upstream read. An ask with nothing but `capped` tokens is
 *     a 429 too, and so is any old-path ask with one (its shape has no state per token): the page keeps to a 429 and
 *     does not go around it. Each 429 names what refused it (`limit;desc="asks"` or `"unseen"`).
 *
 * Still one token per upstream request, still nothing of the visitor upstream, and this path never calls Domino's node
 * or rugged97's services. Asking the provider in batches is another package (D3), as is the page's one client (D2).
 */
import { visitorNetwork } from './chainRoutes'
import type { EdgeCache } from './publicEdge'

export const DEX_PREFIX = '/api/read/dex/'
/** The path whose answer says each token's own state, as a 200 whatever the provider does (2026-10-14); the asks are DEX_PREFIX's. */
export const DEX2_PREFIX = '/api/read/dex2/'
export const DEX_UPSTREAM = 'https://api.dexscreener.com'
/** The chains this route asks about, by the provider's own names: Robinhood Chain's paths name none (as before 2026-10-06). */
export const DEX_CHAINS = ['robinhood', 'base', 'arbitrum'] as const
export type DexChain = (typeof DEX_CHAINS)[number]
/** How long a token's answer is served as it is: the provider's own `Cache-Control: max-age=30`. */
export const DEX_FRESH_SECONDS = 30
/**
 * How long it is served at once while it is read again behind, once DEX_FRESH_SECONDS old. Past this the provider is
 * asked in the ask's own time, and the old path serves nothing older (a tab opened before 2026-10-14 reads an age past
 * ten minutes as none, so a long-kept figure would look new there).
 */
export const DEX_STALE_SECONDS = 300
/**
 * How long a token's answer is kept at all (2026-10-14; it was DEX_STALE_SECONDS): a day, with the time it was
 * retrieved. One older than DEX_STALE_SECONDS leaves only on the new path, with that time, and only when the read that
 * should replace it gave nothing; the page applies its own age rule to it (the Wallet card counts a price for an hour).
 */
export const DEX_KEPT_SECONDS = 86_400
/** An empty list is an answer too, and one that changes rarely: served as it is this long (2026-10-14; it was DEX_FRESH_SECONDS). */
export const DEX_NONE_FRESH_SECONDS = 600
/**
 * The most tokens one `tokens` ask may name: ten, about three subrequests each (a cache read, an upstream read, a cache
 * write), within a Function's own limit. The page splits a longer list (lib/tokenArtwork.ts EDGE_BATCH).
 */
export const MAX_TOKENS = 10
/** The most bytes one upstream body may have. */
const MAX_BODY = 262144
/** An upstream read gives up after this (it may go on behind an ask that already answered: DEX_ANSWER_MS). */
const UPSTREAM_MS = 6_000
/**
 * How long an ask waits for its tokens before it answers (Changed on purpose 2026-10-03): under the page's own 3 s for
 * this route (lib/tokenArtwork.ts EDGE_TIMEOUT), so the page always hears from the edge instead of giving up on it and
 * leaving a request behind. A token not read by then makes the ask a 502, as a gap does (the page then asks the
 * provider itself, as before), and its read goes on behind and is kept, so the next ask for it is a hit.
 * Since 2026-10-14 the new path answers at the same moment, with that token `late` or `joined` and the others as they are.
 */
export const DEX_ANSWER_MS = 2_500
/**
 * How long a read on its way is joined (2026-10-14, sharedWork.ts's third rule): past UPSTREAM_MS and the write that
 * keeps its answer. An older one is taken for dead (its request's tasks cancelled with its visitor) and a new read starts.
 */
export const DEX_READ_STALE_MS = 10_000
/** A token whose read gave nothing is not read again for this long (2026-10-14), doubling with each miss in a row… */
export const DEX_MISS_SECONDS = 30
/** …up to this; also the longest the provider's own Retry-After is honoured for. */
export const DEX_MISS_MAX_SECONDS = 300
/** The retry hint of a token whose own read is still on its way (`late`): it has UPSTREAM_MS in all. */
export const DEX_ON_ITS_WAY_SECONDS = 3
/**
 * A visitor's asks of this route, both paths together (2026-10-14; there was no limit): a burst, and how many a minute
 * refill it, per isolate, as the chain routes' classes (chainRoutes.ts VISITOR_CLASSES). An ask answered from what is
 * kept costs a few cache reads, so this is wide: a cold Positions load is about ten asks, a long token list a few dozen,
 * and one carrier's address stands for several people.
 */
export const DEX_VISITOR = Object.freeze({ burst: 240, perMinute: 600 } as const)
/**
 * The addresses this edge has never seen that a visitor's asks may have read (2026-10-14): each is one upstream read,
 * whoever asks, and the provider allows the address every Worker shares 300 a minute. A burst of 120 is one cold load of
 * the largest wallet the page prices at once (lib/walletPrices.ts PRICE_BATCH × PRICE_GETS); then one a second. A token
 * with an answer kept, one this isolate has read before (DexMemory.seen), or one being read, costs nothing here.
 */
export const DEX_VISITOR_NEW = Object.freeze({ burst: 120, perMinute: 60 } as const)
/** Upstream reads one ask runs side by side. */
const WIDTH = 6
/** Pairs a `tokens` answer keeps per token, besides its most liquid pair as a base. */
const PER_TOKEN = 4
const REFRESH_GUARD_MS = 10_000
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const STORED_AT = 'X-Edge-Stored-At'
/** The most misses, visitors and seen tokens one isolate remembers; the least recently written go first. */
const MAX_MISSES = 2_000
const MAX_VISITORS = 5_000
const MAX_SEEN = 5_000
/** Past this many reads on their way, the ones older than DEX_READ_STALE_MS are let go as a new one starts. */
const MAX_FLIGHTS = 256

type Kind = 'token-pairs' | 'tokens'
type Pairs = Record<string, unknown>[]

/**
 * Why a token has no fresh read (2026-10-14), as the answer says it: the upstream's status (`status_other`: any other
 * than 200, 403, 429 and 5xx, a redirect included), no answer in UPSTREAM_MS (`timeout`), no connection (`network`), a
 * body that is not a bounded JSON array (`not_json`, `too_large`), this ask's own read still on its way (`late`), a read
 * of another ask's on its way (`joined`), or the visitor's allowance of unseen addresses spent (`capped`).
 */
export type DexReason = 'status_429' | 'status_403' | 'status_5xx' | 'status_other' | 'timeout' | 'network' | 'not_json' | 'too_large' | 'late' | 'joined' | 'capped'

/** One upstream read as every ask that waited for it gets it: the token's pairs and when they were retrieved, or why there are none and how long until another read may start. */
type Read = { pairs: Pairs; at: number } | { reason: DexReason; retryAfterS: number }

/** A read on its way and when it began (sharedWork.ts). */
export interface DexFlight {
  work: Promise<Read>
  started: number
}

/** What one isolate keeps between asks (2026-10-14): its reads on their way, what it refreshed lately, its misses and its visitors. */
export interface DexMemory {
  inflight: Map<string, DexFlight>
  refreshing: Map<string, number>
  /** Tokens whose last read gave nothing: no new read before `until`; `step` counts the misses in a row. */
  misses: Map<string, { until: number; step: number; reason: DexReason }>
  /** No upstream read at all before this: the provider's own 429 and its Retry-After. */
  pausedUntil: number
  salt: string | null
  /** Per allowance and visitor: what is left of it, as of `at`. */
  visitors: Map<string, { tokens: number; at: number }>
  /**
   * Tokens this isolate has read an answer for: with what the cache keeps, what makes an address "seen" (DEX_VISITOR_NEW).
   * Where the cache keeps nothing (it may not on a pages.dev preview), a token read again is still not a new address.
   */
  seen: Set<string>
}

export const dexMemory = (): DexMemory => ({ inflight: new Map(), refreshing: new Map(), misses: new Map(), pausedUntil: 0, salt: null, visitors: new Map(), seen: new Set() })

let isolate = dexMemory()

/** Tests: forget the isolate's reads on their way, its misses, the provider's wait and its visitors. */
export function resetDexMemory(): void {
  isolate = dexMemory()
}

export interface DexRuntime {
  cache: EdgeCache | null
  now: () => number
  waitUntil?: (work: Promise<unknown>) => void
  /** The upstream fetch: the Workers runtime's unless a test gives one. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  /** Keys refreshed behind lately: this isolate's own unless a test gives one. */
  refreshing?: Map<string, number>
  /** How long an ask waits before answering: DEX_ANSWER_MS unless a test gives another. */
  answerMs?: number
  /** Upstream reads on their way, by key: this isolate's own unless a test gives one. */
  inflight?: Map<string, DexFlight>
  /** What the isolate remembers between asks: its own unless a test gives one (dexMemory()). */
  memory?: DexMemory
  /** How long one upstream read may take: UPSTREAM_MS unless a test gives another. */
  upstreamMs?: number
}

function refuse(code: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  })
}

interface Asked {
  kind: Kind
  chain: DexChain
  tokens: string[]
  origin: string
}

/** The ask under `prefix`, when it is one these routes answer; null otherwise. */
function askUnder(prefix: string, request: Request): Asked | null {
  const url = new URL(request.url)
  const headers = request.headers
  const one = (name: string, accepted: readonly (string | null)[]) => accepted.includes(headers.get(name))
  if (request.method !== 'GET' || url.search !== '' || url.hash !== '' || headers.has('CF-Worker')) return null
  if (headers.has('Origin') && headers.get('Origin') !== url.origin) return null
  if (!one('Sec-Fetch-Site', [null, 'same-origin']) || !one('Sec-Fetch-Mode', [null, 'cors', 'same-origin']) || !one('Sec-Fetch-Dest', [null, 'empty']) || headers.has('Sec-Fetch-User')) return null
  if (!url.pathname.startsWith(prefix)) return null
  const parts = url.pathname.slice(prefix.length).split('/')
  const [kind] = parts
  if (kind !== 'token-pairs' && kind !== 'tokens') return null
  // Another chain is named before the token, and only for token-pairs: never Robinhood Chain's own name.
  const chain: DexChain | null = parts.length === 2 ? 'robinhood' : parts.length === 3 && kind === 'token-pairs' && (parts[1] === 'base' || parts[1] === 'arbitrum') ? parts[1] : null
  const list = parts[parts.length - 1]
  if (chain === null || !list) return null
  const named = list.split(',')
  if (named.length > (kind === 'tokens' ? MAX_TOKENS : 1) || !named.every((token) => ADDRESS.test(token))) return null
  return { kind, chain, tokens: [...new Set(named.map((token) => token.toLowerCase()))], origin: url.origin }
}

/**
 * The ask, when it is one this route answers: its kind, its chain and its tokens, lowercase, each once, in order.
 * `token-pairs/<token>` and `tokens/<tokens>` are Robinhood Chain's; `token-pairs/<chain>/<token>` is Base's or Arbitrum
 * One's (2026-10-06). Robinhood Chain has one path only, the one it always had.
 */
export function dexAsk(request: Request): Asked | null {
  return askUnder(DEX_PREFIX, request)
}

/** The same asks under the new path's prefix (2026-10-14): neither path's reader takes the other's. */
export function dex2Ask(request: Request): Asked | null {
  return askUnder(DEX2_PREFIX, request)
}

const text = (value: unknown, max: number) => (typeof value === 'string' && value.length <= max ? value : undefined)
const finite = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** One provider pair as passed on: the fields the page reads, of a pair on Robinhood Chain; null for anything else. */
export function trimPair(pair: unknown): Record<string, unknown> | null {
  return trimPairOn('robinhood')(pair)
}

/** The same for a pair on `chain` (2026-10-06: Base's and Arbitrum One's, under their own names). */
export const trimPairOn = (chain: DexChain) => (pair: unknown): Record<string, unknown> | null => {
  if (!pair || typeof pair !== 'object') return null
  const p = pair as Record<string, unknown>
  if (p.chainId !== chain || typeof p.pairAddress !== 'string') return null
  const token = (value: unknown) => {
    const t = value as Record<string, unknown> | null
    return t && typeof t === 'object' && typeof t.address === 'string' && ADDRESS.test(t.address)
      ? { address: t.address, ...(text(t.symbol, 64) !== undefined ? { symbol: t.symbol } : {}), ...(text(t.name, 128) !== undefined ? { name: t.name } : {}) }
      : null
  }
  const base = token(p.baseToken)
  const quote = token(p.quoteToken)
  if (!base || !quote) return null
  const liquidity = p.liquidity as Record<string, unknown> | null
  const volume = p.volume as Record<string, unknown> | null
  const info = p.info as Record<string, unknown> | null
  const labels = Array.isArray(p.labels) ? p.labels.filter((label): label is string => typeof label === 'string' && label.length <= 16).slice(0, 8) : undefined
  return {
    chainId: chain,
    ...(text(p.dexId, 64) !== undefined ? { dexId: p.dexId } : {}),
    ...(labels ? { labels } : {}),
    pairAddress: text(p.pairAddress, 66),
    baseToken: base,
    quoteToken: quote,
    ...(text(p.priceNative, 48) !== undefined ? { priceNative: p.priceNative } : {}),
    ...(text(p.priceUsd, 48) !== undefined ? { priceUsd: p.priceUsd } : {}),
    ...(liquidity && typeof liquidity === 'object' && finite(liquidity.usd) !== undefined ? { liquidity: { usd: liquidity.usd } } : {}),
    ...(volume && typeof volume === 'object' && finite(volume.h24) !== undefined ? { volume: { h24: volume.h24 } } : {}),
    ...(finite(p.pairCreatedAt) !== undefined ? { pairCreatedAt: p.pairCreatedAt } : {}),
    ...(info && typeof info === 'object' && text(info.imageUrl, 2048) !== undefined ? { info: { imageUrl: info.imageUrl } } : {}),
  }
}

const liquidityOf = (pair: Record<string, unknown>) => ((pair.liquidity as { usd?: number } | undefined)?.usd ?? -1)
const addressOf = (side: unknown) => ((side as { address?: string } | undefined)?.address ?? '').toLowerCase()

/** A `tokens` answer's pairs for one token: its most liquid ones, and the most liquid one it is the base of (its artwork). */
export function pairsForPrice(pairs: readonly Record<string, unknown>[], token: string): Record<string, unknown>[] {
  const mine = pairs.filter((pair) => addressOf(pair.baseToken) === token || addressOf(pair.quoteToken) === token)
  const ranked = [...mine].sort((a, b) => liquidityOf(b) - liquidityOf(a))
  const kept = ranked.slice(0, PER_TOKEN)
  const base = ranked.find((pair) => addressOf(pair.baseToken) === token)
  if (base && !kept.includes(base)) kept.push(base)
  return kept
}

/** A whole number of seconds for a wait of `ms`, never under one. */
const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000))

/** The provider's Retry-After as seconds, at most DEX_MISS_MAX_SECONDS; DEX_MISS_SECONDS when it names none it can read. */
function retryAfterOf(header: string | null, now: number): number {
  const value = header?.trim() ?? ''
  const asked = value === '' ? NaN : /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - now) / 1000
  return Number.isFinite(asked) ? Math.min(DEX_MISS_MAX_SECONDS, Math.max(1, Math.ceil(asked))) : DEX_MISS_SECONDS
}

/**
 * One upstream body for one token: its trimmed pairs, the whole list (2026-10-14: each view cuts it as it answers), or
 * why there is none, and for a 429 how long the provider asked to wait.
 */
async function upstream(rt: DexRuntime, chain: DexChain, token: string): Promise<{ pairs: Pairs } | { reason: DexReason; retryAfterS?: number }> {
  const fetchImpl = rt.fetch ?? ((input: string, init: RequestInit) => fetch(input, init))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), rt.upstreamMs ?? UPSTREAM_MS)
  try {
    // The provider's tokens endpoint can omit liquid v4 pairs (observed for UFG on 2026-10-11).
    // Both views read one token at a time: its pair list, of which the price view takes its bounded subset as it answers.
    const response = await fetchImpl(`${DEX_UPSTREAM}/token-pairs/v1/${chain}/${token}`, {
      method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', signal: controller.signal,
    })
    if (response.status !== 200) {
      // Its body is never read: let it go.
      void response.body?.cancel().catch(() => undefined)
      if (response.status === 429) return { reason: 'status_429', retryAfterS: retryAfterOf(response.headers.get('Retry-After'), rt.now()) }
      return { reason: response.status === 403 ? 'status_403' : response.status >= 500 && response.status <= 599 ? 'status_5xx' : 'status_other' }
    }
    if (!(response.headers.get('Content-Type') ?? '').startsWith('application/json') || !response.body) return { reason: 'not_json' }
    const declared = response.headers.get('Content-Length')
    if (declared !== null && !/^\d+$/.test(declared)) return { reason: 'not_json' }
    if (declared !== null && Number(declared) > MAX_BODY) return { reason: 'too_large' }
    const reader = response.body.getReader()
    const parts: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY) { await reader.cancel(); return { reason: 'too_large' } }
      parts.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
    let body: unknown
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      return { reason: 'not_json' }
    }
    if (!Array.isArray(body) || body.length > 100) return { reason: 'not_json' }
    return { pairs: body.map(trimPairOn(chain)).filter((pair): pair is Record<string, unknown> => pair !== null) }
  } catch {
    return { reason: controller.signal.aborted ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Where one token's answer is kept: one entry per chain and token, read by both views (2026-10-14; the key named the
 * view, so a token asked both ways was read and kept twice, and Robinhood Chain's named no chain).
 */
const cacheKey = (origin: string, chain: DexChain, token: string) => `${origin}/api/read/dex/cache/v2/${chain}/${token}`

/** A kept answer for one token, when it was retrieved and its age, while younger than DEX_KEPT_SECONDS; null otherwise. */
async function keptPart(rt: DexRuntime, key: string): Promise<{ pairs: Pairs; at: number; age: number } | null> {
  if (!rt.cache) return null
  try {
    const entry = await rt.cache.match(new Request(key))
    if (!entry) return null
    const at = Number(entry.headers.get(STORED_AT))
    const age = rt.now() - at
    if (!Number.isSafeInteger(at) || age < 0 || age >= DEX_KEPT_SECONDS * 1000) return null
    const pairs: unknown = JSON.parse(await entry.text())
    return Array.isArray(pairs) ? { pairs: pairs as Pairs, at, age } : null
  } catch {
    return null
  }
}

function keepPart(rt: DexRuntime, key: string, pairs: Pairs, at: number): Promise<void> {
  if (!rt.cache) return Promise.resolve()
  const entry = new Response(JSON.stringify(pairs), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `max-age=${DEX_KEPT_SECONDS}`, [STORED_AT]: String(at) } })
  return rt.cache.put(new Request(key), entry).catch(() => undefined)
}

/** Why no read of `key` may start at `now`, and for how long: the provider's own wait, or the token's last miss; null when one may. */
function blocked(memory: DexMemory, key: string, now: number): Gap | null {
  // A time further ahead than any wait this file sets is a clock that moved, never a wait.
  const left = (until: number) => (until > now && until - now <= DEX_MISS_MAX_SECONDS * 1000 ? until - now : 0)
  const paused = left(memory.pausedUntil)
  if (paused > 0) return { reason: 'status_429', retryAfterS: seconds(paused) }
  const miss = memory.misses.get(key)
  const held = miss ? left(miss.until) : 0
  return miss && held > 0 ? { reason: miss.reason, retryAfterS: seconds(held) } : null
}

/** The read of `key` on its way, while it is young enough to join (sharedWork.ts's third rule); undefined otherwise. */
function liveFlight(inflight: Map<string, DexFlight>, key: string, now: number): DexFlight | undefined {
  const flight = inflight.get(key)
  return flight && now >= flight.started && now - flight.started <= DEX_READ_STALE_MS ? flight : undefined
}

/**
 * Starts one token's upstream read, shared by every ask for it on its way (F7). 2026-10-14 (sharedWork.ts's three
 * rules): it is handed to waitUntil here, as it is created, so it outlives a visitor who leaves; it clears its own slot
 * when it settles; and it is dated, so no ask joins it past DEX_READ_STALE_MS. What it brings is kept with the time it
 * was retrieved; what it does not bring is remembered: the provider's 429 stops every read from this isolate for its
 * Retry-After, anything else stops this token's for DEX_MISS_SECONDS, doubling up to DEX_MISS_MAX_SECONDS.
 */
function startRead(rt: DexRuntime, memory: DexMemory, inflight: Map<string, DexFlight>, key: string, chain: DexChain, token: string): DexFlight {
  const read = async (): Promise<Read> => {
    const got = await upstream(rt, chain, token)
    const now = rt.now()
    if ('pairs' in got) {
      memory.misses.delete(key)
      memory.seen.delete(key)
      memory.seen.add(key)
      while (memory.seen.size > MAX_SEEN) memory.seen.delete(memory.seen.values().next().value as string)
      await keepPart(rt, key, got.pairs, now)
      return { pairs: got.pairs, at: now }
    }
    if (got.reason === 'status_429') {
      const wait = got.retryAfterS ?? DEX_MISS_SECONDS
      const until = now + wait * 1000
      // A later wait already set stands, unless it is no wait at all (blocked()).
      if (!(memory.pausedUntil > until && memory.pausedUntil - now <= DEX_MISS_MAX_SECONDS * 1000)) memory.pausedUntil = until
      return { reason: got.reason, retryAfterS: wait }
    }
    const step = (memory.misses.get(key)?.step ?? -1) + 1
    const wait = Math.min(DEX_MISS_MAX_SECONDS, DEX_MISS_SECONDS * 2 ** Math.min(step, 8))
    memory.misses.delete(key)
    memory.misses.set(key, { until: now + wait * 1000, step, reason: got.reason })
    while (memory.misses.size > MAX_MISSES) memory.misses.delete(memory.misses.keys().next().value as string)
    return { reason: got.reason, retryAfterS: wait }
  }
  const flight: DexFlight = { started: rt.now(), work: read().catch((): Read => ({ reason: 'network', retryAfterS: DEX_MISS_SECONDS })) }
  // A dead read's slot is taken over by the next read of its token; one never asked for again is swept here, so the map
  // holds no more than the reads that can still answer, and a few.
  if (inflight.size >= MAX_FLIGHTS) for (const [other, old] of inflight) if (flight.started - old.started > DEX_READ_STALE_MS) inflight.delete(other)
  inflight.set(key, flight)
  const clear = () => {
    if (inflight.get(key) === flight) inflight.delete(key)
  }
  void flight.work.then(clear, clear)
  if (rt.waitUntil) rt.waitUntil(flight.work)
  return flight
}

/** The visitor's key in this isolate: a salted digest of its network (chainRoutes.ts visitorNetwork), never the address; null without one. */
async function visitorOf(memory: DexMemory, request: Request): Promise<string | null> {
  const address = request.headers.get('CF-Connecting-IP')
  if (address === null) return null
  if (memory.salt === null) memory.salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${memory.salt}${visitorNetwork(address)}`)))
  return Array.from(bytes.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * One of the visitor's `limit` taken: 0 when there was one, else the milliseconds until one is back. A request without
 * CF-Connecting-IP (a local server, a test) is not limited, as on the chain routes.
 */
function taken(memory: DexMemory, visitor: string | null, name: 'ask' | 'new', limit: { burst: number; perMinute: number }, now: number): number {
  if (visitor === null) return 0
  const key = `${name}|${visitor}`
  const rate = limit.perMinute / 60_000
  const kept = memory.visitors.get(key)
  const tokens = kept ? Math.min(limit.burst, kept.tokens + Math.max(0, now - kept.at) * rate) : limit.burst
  memory.visitors.delete(key)
  const admit = tokens >= 1
  memory.visitors.set(key, { tokens: admit ? tokens - 1 : tokens, at: now })
  while (memory.visitors.size > MAX_VISITORS) memory.visitors.delete(memory.visitors.keys().next().value as string)
  return admit ? 0 : Math.ceil((1 - tokens) / rate)
}

/** Why a token has no fresh read in this answer, how long until one may be tried, and for `joined` the age of the read it waited on. */
interface Gap {
  reason: DexReason
  retryAfterS: number
  ageMs?: number
}

/** One token's part of an answer: its pairs with the time they were retrieved and how they were made (and why not fresher), or only why there are none. */
type Part = { pairs: Pairs; at: number; made: 'hit' | 'stale' | 'miss'; gap?: Gap } | { gap: Gap }

/** What an ask knows of one token while it waits: its part once it has one, the read of another ask's it waits on, and the older entry the new path may still serve. */
interface Progress {
  part: Part | null
  joined: DexFlight | null
  fallback: { pairs: Pairs; at: number } | null
}

/** What a token's turn for a read of its own came to: a read (its own, or another ask's that began meanwhile), the visitor's wait for an unseen address, or null when no read may start now. */
type Turn = { flight: DexFlight; own: boolean } | { capped: number } | null

/** The older entry with the reason it is not fresher, where the path serves one; else the reason alone. */
const gapOf = (progress: Progress, gap: Gap): Part => (progress.fallback ? { ...progress.fallback, made: 'stale', gap } : { gap })
const partOf = (progress: Progress, read: Read): Part => ('pairs' in read ? { pairs: read.pairs, at: read.at, made: 'miss' } : gapOf(progress, read))

/**
 * Every token's part of one ask, by its deadline at the latest: kept and fresh, kept and stale (read again behind), read
 * now, or the reason there is none. `shape` 1 is the old path (nothing older than DEX_STALE_SECONDS), 2 the new one.
 */
async function partsOf(asked: Asked, rt: DexRuntime, memory: DexMemory, visitor: string | null, shape: 1 | 2): Promise<Part[]> {
  const inflight = rt.inflight ?? memory.inflight
  const refreshing = rt.refreshing ?? memory.refreshing
  // The ask's own timers: its deadline, and the bound of each read it joined. All cleared as it answers.
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const sleep = (ms: number) => new Promise<null>((resolve) => {
    const timer = setTimeout(() => { timers.delete(timer); resolve(null) }, Math.max(0, ms))
    timers.add(timer)
  })
  // WIDTH reads of this ask's own side by side; a read it joined is another ask's and takes no lane.
  let active = 0
  let queued = 0
  const waiting: (() => void)[] = []
  const turns: Promise<Turn>[] = []
  const lane = (): Promise<() => void> => new Promise((resolve) => {
    const take = () => {
      active += 1
      let held = true
      resolve(() => {
        if (!held) return
        held = false
        active -= 1
        waiting.shift()?.()
      })
    }
    if (active < WIDTH) take()
    else waiting.push(take)
  })
  /**
   * This token's own read, started at its turn, unless by then another ask reads it (joined instead), no read may start
   * (null: the next look says why), or the visitor has no unseen address left (the wait). It starts whether or not the
   * ask still waits for it, and frees its lane when it settles.
   */
  const turn = (key: string, token: string, unseen: boolean): Promise<Turn> => {
    queued += 1
    const mine = lane().then((free): Turn => {
      queued -= 1
      const live = liveFlight(inflight, key, rt.now())
      if (live || blocked(memory, key, rt.now())) {
        free()
        return live ? { flight: live, own: false } : null
      }
      const short = unseen ? taken(memory, visitor, 'new', DEX_VISITOR_NEW, rt.now()) : 0
      if (short > 0) {
        free()
        return { capped: short }
      }
      const flight = startRead(rt, memory, inflight, key, asked.chain, token)
      void flight.work.then(free, free)
      return { flight, own: true }
    })
    turns.push(mine)
    return mine
  }

  const one = async (token: string, progress: Progress): Promise<Part> => {
    const key = cacheKey(asked.origin, asked.chain, token)
    const kept = await keptPart(rt, key)
    if (kept) {
      if (kept.age < (kept.pairs.length === 0 ? DEX_NONE_FRESH_SECONDS : DEX_FRESH_SECONDS) * 1000) return { pairs: kept.pairs, at: kept.at, made: 'hit' }
      if (kept.age < DEX_STALE_SECONDS * 1000) {
        // Served at once and read again behind, unless a read is on its way, was started lately, or may not start now.
        const stop = blocked(memory, key, rt.now())
        const since = refreshing.get(key)
        if (!stop && !liveFlight(inflight, key, rt.now()) && (since === undefined || rt.now() - since >= REFRESH_GUARD_MS || rt.now() < since)) {
          refreshing.set(key, rt.now())
          const forget = () => {
            refreshing.delete(key)
          }
          void startRead(rt, memory, inflight, key, asked.chain, token).work.then(forget, forget)
        }
        return { pairs: kept.pairs, at: kept.at, made: 'stale', ...(stop ? { gap: stop } : {}) }
      }
      // Past five minutes the provider is asked in this ask's own time. Should that give nothing, the new path still has
      // this entry, with its own time; the old path has none (DEX_STALE_SECONDS).
      if (shape === 2) progress.fallback = { pairs: kept.pairs, at: kept.at }
    }
    for (;;) {
      const stop = blocked(memory, key, rt.now())
      if (stop) return gapOf(progress, stop)
      const running = liveFlight(inflight, key, rt.now())
      if (running) {
        // Another ask's read: waited for no longer than its bound, on this ask's own timer; then the slot is looked at again.
        progress.joined = running
        const got = await Promise.race([running.work, sleep(running.started + DEX_READ_STALE_MS - rt.now())])
        progress.joined = null
        if (got !== null) return partOf(progress, got)
        if (inflight.get(key) === running) inflight.delete(key)
        continue
      }
      const mine = await turn(key, token, kept === null && !memory.seen.has(key))
      if (mine === null) continue
      if ('capped' in mine) return gapOf(progress, { reason: 'capped', retryAfterS: seconds(mine.capped) })
      if (mine.own) return partOf(progress, await mine.flight.work)
    }
  }

  const progress: Progress[] = asked.tokens.map(() => ({ part: null, joined: null, fallback: null }))
  const all = Promise.all(asked.tokens.map((token, at) => one(token, progress[at]).then((part) => {
    progress[at].part = part
  }))).then(() => true)
  // A failure after the deadline has no one waiting for it; one before it is the ask's own (the route answers 502).
  all.catch(() => undefined)
  const done = await Promise.race([all, sleep(rt.answerMs ?? DEX_ANSWER_MS)])
  for (const timer of timers) clearTimeout(timer)
  // Answered before the page gives up. A read already started goes on behind (startRead); a token still waiting for its
  // turn is read behind too, and that wait and its read are handed on here, while this request can still hand work on,
  // so what they bring is kept for the next ask.
  if (done === null && queued > 0 && rt.waitUntil) {
    rt.waitUntil(Promise.all(turns.map((waited) => waited.then((mine) => (mine !== null && 'flight' in mine && mine.own ? mine.flight.work : undefined)))).catch(() => undefined))
  }
  const now = rt.now()
  return progress.map((state) => {
    if (state.part) return state.part
    const joined = state.joined
    return gapOf(state, joined
      ? { reason: 'joined', retryAfterS: seconds(joined.started + DEX_READ_STALE_MS - now), ageMs: Math.max(0, Math.round(now - joined.started)) }
      : { reason: 'late', retryAfterS: DEX_ON_ITS_WAY_SECONDS })
  })
}

/**
 * How an answer was made, and why each token without a fresh read has none (2026-10-14): `miss` when a token was read
 * now or has no answer, `stale` when one left while it is read again (or could not be), `hit` otherwise; then one
 * `miss;desc="<reason> <token>"` per such token, with the age of the read it joined as `dur`.
 */
function timingOf(asked: Asked, parts: readonly Part[]): string {
  const made = parts.some((part) => !('pairs' in part) || part.made === 'miss') ? 'miss' : parts.some((part) => 'pairs' in part && part.made === 'stale') ? 'stale' : 'hit'
  const notes = parts.flatMap((part, at) => (part.gap ? [`miss;${part.gap.ageMs !== undefined ? `dur=${part.gap.ageMs};` : ''}desc="${part.gap.reason} ${asked.tokens[at]}"`] : []))
  return [`edge;desc="${made}"`, ...notes].join(', ')
}

/** The route's answer for a valid ask, in the old path's shape (1) or the new one's (2), after the visitor's turn. */
async function answer(asked: Asked, request: Request, rt: DexRuntime, shape: 1 | 2): Promise<Response> {
  const memory = rt.memory ?? isolate
  const visitor = await visitorOf(memory, request)
  const wait = taken(memory, visitor, 'ask', DEX_VISITOR, rt.now())
  if (wait > 0) return refuse('rate_limited', 429, { 'Retry-After': String(seconds(wait)), 'Server-Timing': 'limit;desc="asks"' })
  const parts = await partsOf(asked, rt, memory, visitor, shape)
  const timing = timingOf(asked, parts)
  const now = rt.now()
  const view = (pairs: Pairs, token: string) => (asked.kind === 'tokens' ? pairsForPrice(pairs, token) : pairs)
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  // Tokens left unread for the visitor's own allowance of unseen addresses, and how long until it has one again.
  const capped = parts.flatMap((part) => (!('pairs' in part) && part.gap.reason === 'capped' ? [part.gap.retryAfterS] : []))
  const unseen = () => refuse('rate_limited', 429, { 'Retry-After': String(Math.max(...capped)), 'Server-Timing': `${timing}, limit;desc="unseen"` })
  if (shape === 2) {
    // Nothing of the ask but the visitor's own wait: said as a wait, which the page keeps to (lib/tokenArtwork.ts cooldown),
    // so it does not take "no token priced" for our edge being away and ask the provider itself. With any other token in
    // the ask, `capped` is one more state of the 200.
    if (capped.length === parts.length) return unseen()
    const tokens: Record<string, unknown> = {}
    parts.forEach((part, at) => {
      const token = asked.tokens[at]
      if (!('pairs' in part)) {
        tokens[token] = { missing: part.gap.reason, retryAfterS: part.gap.retryAfterS }
        return
      }
      const pairs = view(part.pairs, token)
      tokens[token] = pairs.length > 0 ? { at: part.at, pairs } : { at: part.at, none: true }
    })
    return new Response(JSON.stringify({ v: 2, now, tokens }), { status: 200, headers: { ...headers, 'Server-Timing': timing } })
  }
  // Every token answered, or none of it is: a tab opened before 2026-10-14 asks the provider itself for a batch with a gap.
  const answered = parts.filter((part): part is Extract<Part, { pairs: Pairs }> => 'pairs' in part)
  if (answered.length !== parts.length) {
    // This shape has no state per token, so one left unread for the visitor's own allowance makes the whole ask that wait,
    // never a gap: a 502 here would send every read of the chain to the provider directly for five minutes.
    return capped.length > 0 ? unseen() : refuse('upstream_unavailable', 502, { 'Server-Timing': timing })
  }
  const pairs = answered.flatMap((part, at) => view(part.pairs, asked.tokens[at]))
  return new Response(JSON.stringify(pairs), {
    status: 200,
    headers: { ...headers, 'X-Domino-Edge-Age': String(Math.max(0, ...answered.map((part) => Math.round(now - part.at)))), 'Server-Timing': timing },
  })
}

export async function answerDex(request: Request, rt: DexRuntime): Promise<Response> {
  const asked = dexAsk(request)
  return asked ? answer(asked, request, rt, 1) : refuse('not_found', 404)
}

/** The new path (2026-10-14): the same asks, a 200 that says each token's own state whatever the provider does. */
export async function answerDex2(request: Request, rt: DexRuntime): Promise<Response> {
  const asked = dex2Ask(request)
  return asked ? answer(asked, request, rt, 2) : refuse('not_found', 404)
}
