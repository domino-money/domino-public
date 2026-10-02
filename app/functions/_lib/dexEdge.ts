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
 * symbols, prices, liquidity, 24h volume, creation time and image), of pairs on Robinhood Chain, as the provider wrote
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
 */
import type { EdgeCache } from './publicEdge'

export const DEX_PREFIX = '/api/read/dex/'
export const DEX_UPSTREAM = 'https://api.dexscreener.com'
/** How long a token's answer is served as it is: the provider's own `Cache-Control: max-age=30`. */
export const DEX_FRESH_SECONDS = 30
/** How long it is served at all, read again behind once DEX_FRESH_SECONDS old. */
export const DEX_STALE_SECONDS = 300
/**
 * The most tokens one `tokens` ask may name: ten, about three subrequests each (a cache read, an upstream read, a cache
 * write), within a Function's own limit. The page splits a longer list (lib/tokenArtwork.ts EDGE_BATCH).
 */
export const MAX_TOKENS = 10
/** The most bytes one upstream body may have. */
const MAX_BODY = 262144
/** An upstream read gives up after this. */
const UPSTREAM_MS = 6_000
/** Upstream reads one ask runs side by side. */
const WIDTH = 6
/** Pairs a `tokens` answer keeps per token, besides its most liquid pair as a base. */
const PER_TOKEN = 4
const REFRESH_GUARD_MS = 10_000
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const STORED_AT = 'X-Edge-Stored-At'

export interface DexRuntime {
  cache: EdgeCache | null
  now: () => number
  waitUntil?: (work: Promise<unknown>) => void
  /** The upstream fetch: the Workers runtime's unless a test gives one. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  /** Keys refreshed behind lately: this isolate's own unless a test gives one. */
  refreshing?: Map<string, number>
  /** Upstream reads on their way, by key: this isolate's own unless a test gives one. */
  inflight?: Map<string, Promise<string | null>>
}

type Kind = 'token-pairs' | 'tokens'

const REFRESHING = new Map<string, number>()
const INFLIGHT = new Map<string, Promise<string | null>>()

function refuse(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

/** The ask, when it is one this route answers: its kind and its tokens, lowercase, each once, in order. */
export function dexAsk(request: Request): { kind: Kind; tokens: string[]; origin: string } | null {
  const url = new URL(request.url)
  const headers = request.headers
  const one = (name: string, accepted: readonly (string | null)[]) => accepted.includes(headers.get(name))
  if (request.method !== 'GET' || url.search !== '' || url.hash !== '' || headers.has('CF-Worker')) return null
  if (headers.has('Origin') && headers.get('Origin') !== url.origin) return null
  if (!one('Sec-Fetch-Site', [null, 'same-origin']) || !one('Sec-Fetch-Mode', [null, 'cors', 'same-origin']) || !one('Sec-Fetch-Dest', [null, 'empty']) || headers.has('Sec-Fetch-User')) return null
  if (!url.pathname.startsWith(DEX_PREFIX)) return null
  const [kind, list, ...rest] = url.pathname.slice(DEX_PREFIX.length).split('/')
  if (rest.length > 0 || (kind !== 'token-pairs' && kind !== 'tokens') || !list) return null
  const named = list.split(',')
  if (named.length > (kind === 'tokens' ? MAX_TOKENS : 1) || !named.every((token) => ADDRESS.test(token))) return null
  return { kind, tokens: [...new Set(named.map((token) => token.toLowerCase()))], origin: url.origin }
}

const text = (value: unknown, max: number) => (typeof value === 'string' && value.length <= max ? value : undefined)
const finite = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** One provider pair as passed on: the fields the page reads, of a pair on Robinhood Chain; null for anything else. */
export function trimPair(pair: unknown): Record<string, unknown> | null {
  if (!pair || typeof pair !== 'object') return null
  const p = pair as Record<string, unknown>
  if (p.chainId !== 'robinhood' || typeof p.pairAddress !== 'string') return null
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
    chainId: 'robinhood',
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

/** One upstream body for one token, as the passed-on JSON text of its trimmed pairs; null when there is no usable answer. */
async function upstream(rt: DexRuntime, kind: Kind, token: string): Promise<string | null> {
  const fetchImpl = rt.fetch ?? ((input: string, init: RequestInit) => fetch(input, init))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_MS)
  try {
    const response = await fetchImpl(`${DEX_UPSTREAM}/${kind}/v1/robinhood/${token}`, {
      method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', signal: controller.signal,
    })
    if (response.status !== 200 || !(response.headers.get('Content-Type') ?? '').startsWith('application/json') || !response.body) return null
    const declared = response.headers.get('Content-Length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) return null
    const reader = response.body.getReader()
    const parts: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY) { await reader.cancel(); return null }
      parts.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!Array.isArray(body) || body.length > 100) return null
    const pairs = body.map(trimPair).filter((pair): pair is Record<string, unknown> => pair !== null)
    return JSON.stringify(kind === 'tokens' ? pairsForPrice(pairs, token) : pairs)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const cacheKey = (origin: string, kind: Kind, token: string) => `${origin}/api/read/dex/cache/v1/${kind}/${token}`

/** A kept answer for one token and its age, while younger than DEX_STALE_SECONDS; null otherwise. */
async function keptPart(rt: DexRuntime, key: string): Promise<{ text: string; age: number } | null> {
  if (!rt.cache) return null
  try {
    const entry = await rt.cache.match(new Request(key))
    if (!entry) return null
    const at = Number(entry.headers.get(STORED_AT))
    const age = rt.now() - at
    if (!Number.isSafeInteger(at) || age < 0 || age >= DEX_STALE_SECONDS * 1000) return null
    const kept = await entry.text()
    return Array.isArray(JSON.parse(kept)) ? { text: kept, age } : null
  } catch {
    return null
  }
}

function keepPart(rt: DexRuntime, key: string, body: string): Promise<void> {
  if (!rt.cache) return Promise.resolve()
  const entry = new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `max-age=${DEX_STALE_SECONDS}`, [STORED_AT]: String(rt.now()) } })
  return rt.cache.put(new Request(key), entry).catch(() => undefined)
}

/** One token's upstream read, shared by every ask for it on its way (F7), and kept when it answered. */
function readPart(rt: DexRuntime, key: string, kind: Kind, token: string): Promise<string | null> {
  const inflight = rt.inflight ?? INFLIGHT
  const leading = inflight.get(key)
  if (leading) return leading
  const work = upstream(rt, kind, token).then(async (body) => {
    if (body !== null) await keepPart(rt, key, body)
    return body
  }).finally(() => {
    if (inflight.get(key) === work) inflight.delete(key)
  })
  inflight.set(key, work)
  return work
}

type Part = { text: string; age: number; made: 'hit' | 'stale' | 'miss' } | null

/** One token's answer: kept and fresh, kept and stale (read again behind), or read now. */
async function part(rt: DexRuntime, origin: string, kind: Kind, token: string): Promise<Part> {
  const key = cacheKey(origin, kind, token)
  const kept = await keptPart(rt, key)
  if (kept && kept.age < DEX_FRESH_SECONDS * 1000) return { ...kept, made: 'hit' }
  if (kept) {
    const refreshing = rt.refreshing ?? REFRESHING
    const since = refreshing.get(key)
    if (since === undefined || rt.now() - since >= REFRESH_GUARD_MS || rt.now() < since) {
      refreshing.set(key, rt.now())
      const work = readPart(rt, key, kind, token).finally(() => refreshing.delete(key))
      if (rt.waitUntil) rt.waitUntil(work)
      else void work
    }
    return { ...kept, made: 'stale' }
  }
  const body = await readPart(rt, key, kind, token)
  return body === null ? null : { text: body, age: 0, made: 'miss' }
}

export async function answerDex(request: Request, rt: DexRuntime): Promise<Response> {
  const asked = dexAsk(request)
  if (!asked) return refuse('not_found', 404)
  const parts: Part[] = Array.from({ length: asked.tokens.length }, (): Part => null)
  let next = 0
  const lane = async () => {
    while (next < asked.tokens.length) {
      const at = next++
      parts[at] = await part(rt, asked.origin, asked.kind, asked.tokens[at])
    }
  }
  await Promise.all(Array.from({ length: Math.min(WIDTH, asked.tokens.length) }, lane))
  // Every token answered, or none of it is: the page asks the provider itself for a batch with a gap (tokenArtwork.ts).
  if (parts.some((p) => p === null)) return refuse('upstream_unavailable', 502)
  const answered = parts as Exclude<Part, null>[]
  const pairs = answered.flatMap((p) => JSON.parse(p.text) as unknown[])
  const made = answered.some((p) => p.made === 'miss') ? 'miss' : answered.some((p) => p.made === 'stale') ? 'stale' : 'hit'
  return new Response(JSON.stringify(pairs), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Domino-Edge-Age': String(Math.max(0, ...answered.map((p) => Math.round(p.age)))),
      'Server-Timing': `edge;desc="${made}"`,
    },
  })
}
