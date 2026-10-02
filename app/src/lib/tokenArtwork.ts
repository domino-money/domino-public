/** Optional decoration from https://docs.dexscreener.com/api/reference.
 * Chain/address association is not token approval. Never use this API's prices,
 * names or links as application data. A pair image belongs to its BASE token.
 *
 * One exception, since 2026-09-24: New position also reads the same token-pairs
 * body to choose which pool ids the read service is asked to verify on chain
 * (lib/read/screens/poolHints.ts). Only the ids are used, as a question for the
 * read service; every figure shown still comes from the read service's own
 * reply. Both uses share one GET per token (`pairs`, cached for 30 s). The
 * hints may also ask for native ETH by the zero address, the provider's own
 * name for it (since 2026-09-23); artwork never does.
 *
 * A second exception, since 2026-09-25 (owner's request: the Positions Wallet
 * card lists only the main tokens, largest first, by their USD value): the
 * card asks the provider's `tokens` endpoint once for the prices of the
 * tokens the wallet holds, up to 30 addresses in one GET (`tokenPrices`),
 * through the same guarded read (no credentials, no referrer, no redirect,
 * a bounded body and deadline). Those prices are an indicative figure in that
 * card only (lib/walletPrices.ts): never an amount, a quote, a position
 * figure or anything sent anywhere. The same reply's artwork is kept for the
 * addresses it names (`seed`), so the card's rows ask no token-pairs GET of
 * their own. Only token addresses leave the page, never the wallet's.
 *
 * Changed 2026-10-01 (audit I3, privacy): where the deployment has it, every one
 * of these GETs goes to our own edge first (functions/api/read/dex/[[path]].ts,
 * `edge`), which asks the provider one token at a time and keeps its answers,
 * so neither the visitor's address nor a wallet's set of tokens reaches the
 * provider. Only when our edge gives no answer (it may be refused by the
 * provider, or not deployed yet) is the provider asked directly, as before, and
 * then for EDGE_RETRY_MS before the edge is tried again.
 *
 * A third exception, since 2026-10-01 (audit V1, V2, V3): the markets read the
 * liquidity and 24h volume in the same token-pairs body, as a second source
 * beside the read service's, always attributed to DEX Screener and dated by when
 * it was retrieved (lib/read/dexFigures.ts, `onPairs`). Nothing else of it is used.
 */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const CDN_IMAGE = /^https:\/\/cdn\.dexscreener\.com\/cms\/images\/([A-Za-z0-9_-]{8,128})(?:\?[^#\s]*)?$/
const MAX_BODY = 262144
const TIMEOUT = 6000
/** How long one token-pairs body is reused: the provider's own `Cache-Control: max-age=30`. */
const BODY_TTL = 30000
/**
 * How long a lookup's outcome is kept: found artwork an hour, the provider's answer that names none five minutes, and
 * a lookup that got no answer at all (a timeout, a refusal, a network error, a reply that is not JSON, or one never
 * sent because too many were waiting) 30 s, since it says nothing about the token (2026-09-28, speed wave, item 42:
 * such a failure used to be kept as "no image" for five minutes).
 */
const FOUND_TTL = 3600000
const NONE_TTL = 300000
const FAILED_TTL = 30000
/** Addresses one `tokens` GET may name: the provider's own limit. */
export const PRICE_BATCH = 30

export function tokenArtworkKey(chainId: number, address: string): string | null {
  return chainId === 4663 && ADDRESS.test(address) && !/^0x0{40}$/i.test(address) ? `4663:${address.toLowerCase()}` : null
}

export function safeTokenImage(value: unknown): string | null {
  const match = typeof value === 'string' && value.length <= 2048 && CDN_IMAGE.exec(value)
  return match ? `https://cdn.dexscreener.com/cms/images/${match[1]}?width=64&height=64&quality=85&format=auto` : null
}

export function artworkFromPairs(body: unknown, address: string): string | null {
  if (!Array.isArray(body) || body.length > 100 || !ADDRESS.test(address)) return null
  const urls = new Set<string>()
  for (const pair of body) {
    if (!pair || pair.chainId !== 'robinhood' || typeof pair.baseToken?.address !== 'string'
      || pair.baseToken.address.toLowerCase() !== address.toLowerCase()) continue
    const image = safeTokenImage(pair.info?.imageUrl)
    if (image) urls.add(image)
  }
  return urls.size === 1 ? [...urls][0] : null
}

/** Our own edge's route for these GETs (functions/api/read/dex/[[path]].ts, audit I3). */
export const DEX_EDGE = '/api/read/dex/'
/** After our edge gave no answer, the provider is asked directly for this long before the edge is tried again. */
const EDGE_RETRY_MS = 300000
/** Our edge's part of a read's time; the rest is the provider's, should the edge not answer. */
const EDGE_TIMEOUT = 3000
/**
 * The most tokens one `tokens` GET to our edge names (functions/_lib/dexEdge.ts MAX_TOKENS): the edge asks the provider
 * one token at a time and keeps each, about three subrequests a token, within a Function's own limit.
 */
const EDGE_BATCH = 10
const EDGE_PATH = /^(token-pairs|tokens)\/v1\/robinhood\/([0-9a-fA-Fx,]+)$/

type Options = {
  fetch?: typeof fetch
  /** The monotonic clock the caches count on. */
  now?: () => number
  /** The wall clock, ms, a body's retrieval is dated on (`onPairs`). */
  wall?: () => number
  /** Our own edge's route, asked first; null or absent: the provider only (the test builds, the node tests). */
  edge?: string | null
}
type Entry = { value: string | null; expires: number }
/** A token-pairs body as it was read: who it is about, and when it was retrieved (wall ms, the edge's own retrieval where it answered). */
export type PairsListener = (address: string, body: unknown, retrievedAt: number) => void

export function createTokenArtworkResolver(options: Options = {}) {
  const fetch = options.fetch ?? globalThis.fetch
  const now = options.now ?? (() => performance.now())
  const wall = options.wall ?? (() => Date.now())
  const edge = options.edge ?? null
  /** Until when (on `now`) the provider is asked directly: our edge gave no answer lately. */
  let edgeDownUntil = -Infinity
  const pairsListeners = new Set<PairsListener>()
  const cache = new Map<string, Entry>()
  const pending = new Map<string, Promise<string | null>>()
  const queue: Array<() => void> = []
  let active = 0
  const bodies = new Map<string, { body: unknown; expires: number }>()
  /** Reads in flight, each with the time (on `now`) it gives up at. */
  const reading = new Map<string, { result: Promise<unknown>; deadline: number }>()

  /**
   * One guarded GET of a provider body (`token-pairs/…` or `tokens/…` on Robinhood), through our own edge first where
   * the deployment has it (audit I3): the parsed JSON and when it was retrieved (wall ms), or null for anything else.
   */
  async function retrieveDated(path: string, remaining: number, signal?: AbortSignal): Promise<{ body: unknown; retrievedAt: number } | null> {
    const viaEdge = edge !== null && now() >= edgeDownUntil ? EDGE_PATH.exec(path) : null
    if (viaEdge && edge !== null) {
      const started = now()
      const answered = await get(`${edge}${viaEdge[1]}/${viaEdge[2]}`, Math.min(remaining, EDGE_TIMEOUT), signal, true)
      if (answered !== null || signal?.aborted) return answered
      edgeDownUntil = now() + EDGE_RETRY_MS
      remaining -= now() - started
      if (remaining <= 0) return null
    }
    return get(`https://api.dexscreener.com/${path}`, remaining, signal, false)
  }

  async function retrieve(path: string, remaining: number, signal?: AbortSignal): Promise<unknown> {
    return (await retrieveDated(path, remaining, signal))?.body ?? null
  }

  /** One bounded GET: our edge's (same origin, the beta cookie goes with it) or the provider's (no credentials, no referrer). */
  async function get(url: string, remaining: number, signal: AbortSignal | undefined, own: boolean): Promise<{ body: unknown; retrievedAt: number } | null> {
    if (signal?.aborted) return null
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => controller.abort(), remaining)
    try {
      const response = await fetch(url, {
        signal: controller.signal, credentials: own ? 'same-origin' : 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
        headers: { Accept: 'application/json' },
      })
      if (!response.ok || response.redirected || !response.headers.get('content-type')?.startsWith('application/json') || !response.body) return null
      const declared = response.headers.get('content-length')
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) return null
      const reader = response.body.getReader()
      const parts: Uint8Array[] = []
      let size = 0
      while (true) {
        const result = await reader.read()
        if (result.done) break
        size += result.value.byteLength
        if (size > MAX_BODY) { await reader.cancel(); return null }
        parts.push(result.value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
      if (controller.signal.aborted) return null
      const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      // Our edge says how old its kept answer is (functions/_lib/dexEdge.ts): the body is dated by its own retrieval.
      const age = own ? Number(response.headers.get('X-Domino-Edge-Age') ?? '0') : 0
      return { body, retrievedAt: wall() - (Number.isSafeInteger(age) && age >= 0 && age <= 600000 ? age : 0) }
    } catch { return null }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort() }
  }

  /**
   * The token-pairs body for `address` (lowercase), shared by artwork and pool
   * hints: a body read in the last 30 s is reused, and a read in flight is
   * joined, so the two never ask twice for one token while it answers.
   *
   * Only a body is kept. A failure (a timeout, a 429, a network error, a reply
   * that is not JSON) is not an answer to reuse: the next ask reads again, and
   * the artwork keeps its own short negative cache (`remember`). A read in
   * flight may have less time left than the caller that joins it (it started
   * earlier). When such a read gives up, its null is not the joiner's answer,
   * so the joiner reads again with the time it has left.
   */
  function pairsWithin(address: string, remaining: number): Promise<unknown> {
    const kept = bodies.get(address)
    if (kept && kept.expires > now()) return Promise.resolve(kept.body)
    const deadline = now() + remaining
    const joined = reading.get(address)
    if (joined) {
      if (joined.deadline >= deadline) return joined.result
      return joined.result.then((body) => {
        const left = deadline - now()
        return body !== null || left <= 0 ? body : pairsWithin(address, left)
      })
    }
    const entry: { result: Promise<unknown>; deadline: number } = {
      deadline,
      result: retrieveDated(`token-pairs/v1/robinhood/${address}`, remaining).then((dated) => {
        if (reading.get(address) === entry) reading.delete(address)
        const body = dated?.body ?? null
        if (dated !== null && body !== null) {
          bodies.delete(address)
          bodies.set(address, { body, expires: now() + BODY_TTL })
          while (bodies.size > 16) bodies.delete(bodies.keys().next().value!)
          for (const listener of pairsListeners) {
            try {
              listener(address, body, dated.retrievedAt)
            } catch {
              // A listener's failure is its own: the artwork and the hints read the body as before.
            }
          }
        }
        return body
      }),
    }
    reading.set(address, entry)
    return entry.result
  }

  /** The token's artwork, null when the provider's answer names none, or undefined when no answer came. */
  async function artworkOf(address: string): Promise<string | null | undefined> {
    try {
      const body = await pairsWithin(address, TIMEOUT)
      return body === null ? undefined : artworkFromPairs(body, address)
    } catch { return undefined }
  }

  function remember(key: string, value: string | null, failed = false) {
    cache.delete(key)
    cache.set(key, { value, expires: now() + (value ? FOUND_TTL : failed ? FAILED_TTL : NONE_TTL) })
    while (cache.size > 128) cache.delete(cache.keys().next().value!)
  }

  function resolve(chainId: number, address: string): Promise<string | null> {
    const key = tokenArtworkKey(chainId, address)
    if (!key) return Promise.resolve(null)
    const cached = cache.get(key)
    if (cached && cached.expires > now()) return Promise.resolve(cached.value)
    const joined = pending.get(key)
    if (joined) return joined
    if (pending.size >= 32) { remember(key, null, true); return Promise.resolve(null) }
    const result = new Promise<string | null>((done) => {
      // Its six seconds start when its read does, not while it waits for a slot (2026-09-28, speed wave, item 42:
      // a token late in the queue used to run out of time without ever being asked, then showed none for 5 minutes).
      const run = () => {
        active++
        void artworkOf(address.toLowerCase()).then((found) => {
          remember(key, found ?? null, found === undefined)
          done(found ?? null)
        }).finally(() => {
          pending.delete(key)
          active--
          queue.shift()?.()
        })
      }
      if (active < 2) run()
      else queue.push(run)
    })
    pending.set(key, result)
    return result
  }

  /**
   * The token-pairs body for a Robinhood token, or for native ETH by the zero
   * address, or null: the same guarded GET and 30 s reuse as the artwork. Not
   * queued behind the artwork lookups: the one caller (New position's pool
   * hints) waits for it with its own limit.
   */
  function pairs(chainId: number, address: string): Promise<unknown> {
    return chainId === 4663 && ADDRESS.test(address) ? pairsWithin(address.toLowerCase(), TIMEOUT) : Promise.resolve(null)
  }

  /**
   * The provider's `tokens` body for up to PRICE_BATCH Robinhood token
   * addresses (lowercased, deduplicated, sorted, so one set is one URL), or
   * null: one guarded GET with the artwork's deadline, never retried here.
   * The Wallet card's prices (lib/walletPrices.ts) are its one caller.
   */
  function tokenPrices(addresses: readonly string[], signal?: AbortSignal): Promise<unknown> {
    const list = [...new Set(addresses.map((address) => address.toLowerCase()))].filter((address) => ADDRESS.test(address)).sort().slice(0, PRICE_BATCH)
    if (list.length === 0) return Promise.resolve(null)
    if (edge === null || now() < edgeDownUntil || list.length <= EDGE_BATCH) return retrieve(`tokens/v1/robinhood/${list.join(',')}`, TIMEOUT, signal)
    // Through our edge, EDGE_BATCH tokens a GET, side by side, as one answer; any GET without one sends the whole list
    // to the provider directly, as before (audit I3).
    return (async () => {
      const parts: string[][] = []
      for (let i = 0; i < list.length; i += EDGE_BATCH) parts.push(list.slice(i, i + EDGE_BATCH))
      const started = now()
      const answers = await Promise.all(parts.map((part) => get(`${edge}tokens/${part.join(',')}`, Math.min(TIMEOUT, EDGE_TIMEOUT), signal, true)))
      if (answers.every((answer) => answer !== null && Array.isArray(answer.body))) return answers.flatMap((answer) => answer?.body as unknown[])
      if (signal?.aborted) return null
      edgeDownUntil = now() + EDGE_RETRY_MS
      const left = TIMEOUT - (now() - started)
      return left > 0 ? get(`https://api.dexscreener.com/tokens/v1/robinhood/${list.join(',')}`, left, signal, false).then((answer) => answer?.body ?? null) : null
    })()
  }

  /**
   * Artwork a `tokens` reply already answered for a token: its one safe image,
   * or none (null) when the token is the base of a pair there and has no image.
   * Found artwork is never replaced by a none.
   */
  function seed(chainId: number, address: string, image: string | null) {
    const key = tokenArtworkKey(chainId, address)
    if (!key) return
    const kept = cache.get(key)
    if (image === null && kept?.value && kept.expires > now()) return
    remember(key, image === null ? null : safeTokenImage(image))
  }

  /** The artwork already held for a token, without asking: a URL, null (none), or undefined (not known yet). */
  function peek(chainId: number, address: string): string | null | undefined {
    const key = tokenArtworkKey(chainId, address)
    const kept = key ? cache.get(key) : undefined
    return kept && kept.expires > now() ? kept.value : undefined
  }

  /** Told of every token-pairs body read from now on (lib/read/dexFigures.ts). Returns the unsubscribe. */
  function onPairs(listener: PairsListener): () => void {
    pairsListeners.add(listener)
    return () => pairsListeners.delete(listener)
  }

  return { resolve, pairs, tokenPrices, seed, peek, onPairs, rejectImage: (chainId: number, address: string) => {
    const key = tokenArtworkKey(chainId, address)
    if (key) remember(key, null)
  } }
}

// Our edge is asked first in the deployable builds only (audit I3): the test builds' servers have no such route.
export const tokenArtwork = createTokenArtworkResolver({ edge: typeof __DOMINO_POOL_SET__ !== 'undefined' && __DOMINO_POOL_SET__ === 'selected' ? DEX_EDGE : null })
