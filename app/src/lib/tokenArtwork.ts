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
 */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const CDN_IMAGE = /^https:\/\/cdn\.dexscreener\.com\/cms\/images\/([A-Za-z0-9_-]{8,128})(?:\?[^#\s]*)?$/
const MAX_BODY = 262144
const TIMEOUT = 6000
/** How long one token-pairs body is reused: the provider's own `Cache-Control: max-age=30`. */
const BODY_TTL = 30000
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

type Options = { fetch?: typeof fetch; now?: () => number }
type Entry = { value: string | null; expires: number }

export function createTokenArtworkResolver(options: Options = {}) {
  const fetch = options.fetch ?? globalThis.fetch
  const now = options.now ?? (() => performance.now())
  const cache = new Map<string, Entry>()
  const pending = new Map<string, Promise<string | null>>()
  const queue: Array<() => void> = []
  let active = 0
  const bodies = new Map<string, { body: unknown; expires: number }>()
  /** Reads in flight, each with the time (on `now`) it gives up at. */
  const reading = new Map<string, { result: Promise<unknown>; deadline: number }>()

  /** One guarded GET of a provider body (`token-pairs/…` or `tokens/…` on Robinhood): parsed JSON, or null for anything else. */
  async function retrieve(path: string, remaining: number): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), remaining)
    try {
      const response = await fetch(`https://api.dexscreener.com/${path}`, {
        signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
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
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch { return null }
    finally { clearTimeout(timer); controller.abort() }
  }

  /**
   * The token-pairs body for `address` (lowercase), shared by artwork and pool
   * hints: a body read in the last 30 s is reused, and a read in flight is
   * joined, so the two never ask twice for one token while it answers.
   *
   * Only a body is kept. A failure (a timeout, a 429, a network error, a reply
   * that is not JSON) is not an answer to reuse: the next ask reads again, and
   * the artwork keeps its own negative cache (`remember`). A read in flight
   * may have less time than the caller that joins it: an artwork lookup that
   * waited in the queue starts with what is left of its six seconds. When
   * such a read gives up, its null is not the joiner's answer, so the joiner
   * reads again with the time it has left.
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
      result: retrieve(`token-pairs/v1/robinhood/${address}`, remaining).then((body) => {
        if (reading.get(address) === entry) reading.delete(address)
        if (body !== null) {
          bodies.delete(address)
          bodies.set(address, { body, expires: now() + BODY_TTL })
          while (bodies.size > 16) bodies.delete(bodies.keys().next().value!)
        }
        return body
      }),
    }
    reading.set(address, entry)
    return entry.result
  }

  async function artworkWithin(address: string, remaining: number): Promise<string | null> {
    try { return artworkFromPairs(await pairsWithin(address, remaining), address) } catch { return null }
  }

  function remember(key: string, value: string | null) {
    cache.delete(key)
    cache.set(key, { value, expires: now() + (value ? 3600000 : 300000) })
    while (cache.size > 128) cache.delete(cache.keys().next().value!)
  }

  function resolve(chainId: number, address: string): Promise<string | null> {
    const key = tokenArtworkKey(chainId, address)
    if (!key) return Promise.resolve(null)
    const cached = cache.get(key)
    if (cached && cached.expires > now()) return Promise.resolve(cached.value)
    const joined = pending.get(key)
    if (joined) return joined
    if (pending.size >= 32) { remember(key, null); return Promise.resolve(null) }
    const queuedAt = now()
    const result = new Promise<string | null>((done) => {
      const run = () => {
        active++
        const remaining = TIMEOUT - (now() - queuedAt)
        void (remaining <= 0 ? Promise.resolve(null) : artworkWithin(address.toLowerCase(), remaining)).then((value) => {
          remember(key, value)
          done(value)
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
  function tokenPrices(addresses: readonly string[]): Promise<unknown> {
    const list = [...new Set(addresses.map((address) => address.toLowerCase()))].filter((address) => ADDRESS.test(address)).sort().slice(0, PRICE_BATCH)
    return list.length === 0 ? Promise.resolve(null) : retrieve(`tokens/v1/robinhood/${list.join(',')}`, TIMEOUT)
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

  return { resolve, pairs, tokenPrices, seed, peek, rejectImage: (chainId: number, address: string) => {
    const key = tokenArtworkKey(chainId, address)
    if (key) remember(key, null)
  } }
}

export const tokenArtwork = createTokenArtworkResolver()
