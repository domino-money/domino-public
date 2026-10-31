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
 * card asks our edge for the prices of the tokens the wallet holds, up to
 * 30 addresses per call (`tokenPrices`, split into batches of ten),
 * through the same guarded read (no credentials, no referrer, no redirect,
 * a bounded body and deadline). Those prices are an indicative figure in that
 * card only (lib/walletPrices.ts): never an amount, a quote, a position
 * figure or anything sent anywhere. The same reply's artwork is kept for the
 * addresses it names (`seed`), so the card's rows ask no token-pairs GET of
 * their own. Direct fallback reuses token-pairs reads, with two concurrent
 * requests per call and explicit gaps for partial failures. Only token
 * addresses leave the page, never the wallet's.
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
 *
 * Changed on purpose 2026-10-06 (the owner's point 3: Base and Arbitrum One in
 * New position "like Robinhood Chain", their tokens' icons and their pools' TVL,
 * 24h volume and APR): the same reads for a token on Base or Arbitrum One, by
 * the provider's own name for its chain (`base`, `arbitrum`), through our edge
 * first as on Robinhood Chain. Identity is chain plus address everywhere here:
 * every key below names the chain, since an address can repeat across chains.
 * The `tokens` read stays Robinhood Chain's (the Wallet card's).
 *
 * Changed on purpose 2026-10-14 (incident of 2026-10-13, package D1: about nine
 * 502 on /api/read/dex/ at every load of the owner's Positions, then 51 GETs to
 * the provider from his own address): the Wallet card's prices (`tokenPrices`)
 * are asked on our edge's new path, /api/read/dex2/ (`DEX_EDGE_V2`), whose
 * answer is a 200 that says each token's own state: its pairs with the time the
 * edge retrieved them, none, or missing with a reason. A token marked missing,
 * or one of a GET that gave nothing, has no price yet: it is not asked of the
 * provider. Only when our edge prices no token of the list at all is the
 * provider asked directly, as before. Each price is dated by its own retrieval
 * (`retrievedAt`, on the page's clock), however long the edge kept it. The
 * artwork, hints and figures reads keep the old path until the page has one
 * client for all of them (package D2).
 *
 * Changed on purpose 2026-10-15 (pack 7: two red 502s on the old path on a
 * Base or Arbitrum One position's page): the artwork, hints and figures reads
 * ask the new path too (`retrieveDated`), the same tokens and the same 30 s
 * reuse; a token it marks missing is not asked of the provider. Nothing of the
 * page asks /api/read/dex/ any more.
 */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
/** The provider's names for the chains a token here can be on (Robinhood Chain, Base, Arbitrum One). */
const DEX_CHAIN_SLUGS: Readonly<Record<number, string>> = { 4663: 'robinhood', 8453: 'base', 42161: 'arbitrum' }
/** The provider's name for a chain, or null for a chain these reads do not cover. */
export const dexChainSlug = (chainId: number): string | null => DEX_CHAIN_SLUGS[chainId] ?? null
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
/** Maximum addresses in one Wallet price read. */
export const PRICE_BATCH = 30

/** A token's artwork key: its chain and its address (Robinhood Chain, and since 2026-10-06 Base and Arbitrum One); never native ETH. */
export function tokenArtworkKey(chainId: number, address: string): string | null {
  return dexChainSlug(chainId) !== null && ADDRESS.test(address) && !/^0x0{40}$/i.test(address) ? `${chainId}:${address.toLowerCase()}` : null
}

export function safeTokenImage(value: unknown): string | null {
  const match = typeof value === 'string' && value.length <= 2048 && CDN_IMAGE.exec(value)
  return match ? `https://cdn.dexscreener.com/cms/images/${match[1]}?width=64&height=64&quality=85&format=auto` : null
}

/** The one image a token-pairs body gives `address` as a base token, on `chainId`'s pairs only; null for none, or for two. */
export function artworkFromPairs(body: unknown, address: string, chainId = 4663): string | null {
  const slug = dexChainSlug(chainId)
  if (!Array.isArray(body) || body.length > 100 || !ADDRESS.test(address) || slug === null) return null
  const urls = new Set<string>()
  for (const pair of body) {
    if (!pair || pair.chainId !== slug || typeof pair.baseToken?.address !== 'string'
      || pair.baseToken.address.toLowerCase() !== address.toLowerCase()) continue
    const image = safeTokenImage(pair.info?.imageUrl)
    if (image) urls.add(image)
  }
  return urls.size === 1 ? [...urls][0] : null
}

/**
 * Our own edge's first route for these GETs (functions/api/read/dex/[[path]].ts, audit I3). Since 2026-10-15 (pack 7)
 * the page asks none of it: it is the deployable builds' sign that our edge is there (`tokenArtwork` below), and its
 * route stays for the tabs opened before.
 */
export const DEX_EDGE = '/api/read/dex/'
/**
 * Our edge's path that answers per token, as a 200 whatever the provider does (functions/api/read/dex2/[[path]].ts,
 * 2026-10-14): where the Wallet card's prices are asked, wherever the deployment has our edge, and since 2026-10-15
 * (pack 7) every token's pairs (artwork, pool hints, figures).
 */
export const DEX_EDGE_V2 = '/api/read/dex2/'
/** After our edge gave no answer, the provider is asked directly for this long before the edge is tried again. */
const EDGE_RETRY_MS = 300000
/** Our edge's part of a read's time; the rest is the provider's, should the edge not answer. */
const EDGE_TIMEOUT = 3000
/**
 * The most tokens one `tokens` GET to our edge names (functions/_lib/dexEdge.ts MAX_TOKENS): the edge asks the provider
 * one token at a time and keeps each, about three subrequests a token, within a Function's own limit.
 */
const EDGE_BATCH = 10
/** A provider path our edge answers, by chain: Robinhood Chain's two reads, and Base's and Arbitrum One's token-pairs (2026-10-06). */
const EDGE_PATH = /^(token-pairs|tokens)\/v1\/(robinhood|base|arbitrum)\/([0-9a-fA-Fx,]+)$/
/** Our edge's path for a provider path it answers: Robinhood Chain's as they always were, another chain's named before the token. */
function edgePathOf(path: string): string | null {
  const match = EDGE_PATH.exec(path)
  if (!match) return null
  const [, kind, chain, list] = match
  if (chain === 'robinhood') return `${kind}/${list}`
  return kind === 'token-pairs' ? `${kind}/${chain}/${list}` : null
}

type Options = {
  fetch?: typeof fetch
  /** The monotonic clock the caches count on. */
  now?: () => number
  /** The wall clock, ms, a body's retrieval is dated on (`onPairs`). */
  wall?: () => number
  /** Our own edge's route, asked first; null or absent: the provider only (the test builds, the node tests). */
  edge?: string | null
}
type Entry = { value: string | null; expires: number; failed: boolean }
type Reading = { result: Promise<unknown>; deadline: number; users: number; controller: AbortController; settled: boolean }
/** One token of our edge's per-token answer: its pairs (none: an empty list) and when the edge retrieved them, wall ms on the page's clock. */
export type EdgeTokenPairs = { pairs: unknown[]; retrievedAt: number }
/**
 * A partial price read names its gaps explicitly: an unfetched token is not an unpriced token. Since 2026-10-14 an
 * answer from our edge is per token (`tokens`), each with its own retrieval time; the provider's own, read directly,
 * is one list as before.
 */
export type TokenPricesAnswer =
  | unknown[]
  | { pairs: unknown[]; unavailable: readonly string[] }
  | { tokens: Readonly<Record<string, EdgeTokenPairs>>; unavailable: readonly string[] }
  | null

/**
 * Our edge's per-token answer (functions/_lib/dexEdge.ts answerDex2) as the page takes it: for each asked address it
 * answered, the pairs and when it retrieved them, on the page's own clock (`wallNow` less the age the answer itself
 * gives, however long: the edge keeps an answer up to a day, and the reader applies its own age rule). An address
 * marked missing, absent, or written any other way is left out: it has no price yet. Null for a body that is no such
 * answer at all.
 */
function edgeTokenPairs(body: unknown, asked: readonly string[], wallNow: number): Map<string, EdgeTokenPairs> | null {
  // Anything but an object has none of these, and so is no such answer.
  const { v, now, tokens } = (body ?? {}) as { v?: unknown; now?: number; tokens?: Record<string, { at?: number; pairs?: unknown; none?: unknown } | null> | null }
  if (v !== 2 || !Number.isSafeInteger(now) || !tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return null
  const out = new Map<string, EdgeTokenPairs>()
  for (const address of asked) {
    const { at, pairs, none } = tokens[address] ?? {}
    const list = Array.isArray(pairs) ? pairs : pairs === undefined && none === true ? [] : null
    // The token's age as the edge gives it: a whole number of ms, from zero (retrieved as it answered) to the edge's own now.
    const age = (now as number) - (at as number)
    if (list && list.length <= 100 && Number.isSafeInteger(at) && age >= 0 && age <= (now as number)) out.set(address, { pairs: list, retrievedAt: wallNow - age })
  }
  return out
}
/**
 * A token-pairs body as it was read: who it is about, when it was retrieved (wall ms, the edge's own retrieval where it
 * answered), and on which chain (added 2026-10-06; Robinhood Chain's bodies say 4663).
 */
export type PairsListener = (address: string, body: unknown, retrievedAt: number, chainId: number) => void

export function createTokenArtworkResolver(options: Options = {}) {
  const fetch = options.fetch ?? globalThis.fetch
  const now = options.now ?? (() => performance.now())
  const wall = options.wall ?? (() => Date.now())
  const edge = options.edge ?? null
  /** Our edge's per-token path (2026-10-14), wherever the deployment has our edge: every GET to our edge since 2026-10-15 (pack 7). */
  const edge2 = edge === null ? null : DEX_EDGE_V2
  /**
   * Until when (on `now`) the provider is asked directly for a chain's reads, by the provider's name for the chain: our
   * edge gave no answer lately for that chain. Changed on purpose 2026-10-06 (review of the same day): one state for every
   * chain let a slow answer for a little-read Base or Arbitrum One token send Robinhood Chain's reads, the Wallet card's
   * `tokens` batch included, to the provider directly for five minutes (audit I3).
   */
  const edgeDownUntil = new Map<string, number>()
  const edgeUp = (slug: string) => now() >= (edgeDownUntil.get(slug) ?? -Infinity)
  /**
   * Until when (on `now`) our edge's per-token path is not asked: it gave no answer of its own at all lately. A state of
   * its own (2026-10-14): that path answers whatever the provider does, so the artwork reads' state above, which one 502
   * of the old path sets for five minutes, must not send the Wallet card's prices to the provider with them.
   */
  let edge2DownUntil = -Infinity
  const pairsListeners = new Set<PairsListener>()
  const observers = new Map<string, Set<() => void>>()
  const cache = new Map<string, Entry>()
  const pending = new Map<string, Promise<string | null>>()
  const required = new Set<string>()
  const queue: Array<() => void> = []
  let active = 0
  const bodies = new Map<string, { body: unknown; expires: number }>()
  /** Reads in flight, each with the time (on `now`) it gives up at. */
  const reading = new Map<string, Reading>()
  // A 429 is a request to wait, including when it came from our edge. Do not evade it with a direct fallback.
  const cooldown = new Map<string, number>()
  const cooling = (own: boolean) => now() < (cooldown.get(own ? 'edge' : 'provider') ?? 0)

  /**
   * One guarded GET of a provider body (`token-pairs/…` on Robinhood, Base or Arbitrum One), through our own edge first
   * where the deployment has it (audit I3): the parsed JSON and when it was retrieved (wall ms), or null for anything
   * else.
   *
   * Changed on purpose 2026-10-15 (pack 7: two red 502s on GET /api/read/dex/token-pairs/<chain>/<token> on a Base or
   * Arbitrum One position's page, the old path's answer for a token it has no read for): asked on our edge's new path
   * (`edge2`), whose 200 says the token's own state. Its pairs (none: an empty list) are the body, dated by the edge's own
   * retrieval; a token it marks missing has no body yet, is not asked of the provider, and does not give our edge up
   * (as the Wallet card's prices since package D1). Only when our edge gives no answer of its own (a refusal that is not
   * a 429, a failure, a body that is no such answer) is the provider asked directly, as before. The old path stays at
   * our edge for the tabs opened before this.
   */
  async function retrieveDated(path: string, remaining: number, signal?: AbortSignal): Promise<{ body: unknown; retrievedAt: number } | null> {
    const match = EDGE_PATH.exec(path)
    const slug = match?.[2] ?? null
    const token = match?.[1] === 'token-pairs' && !match[3].includes(',') ? match[3].toLowerCase() : null
    const viaEdge = edge2 !== null && slug !== null && token !== null && edgeUp(slug) ? edgePathOf(path) : null
    if (viaEdge !== null && edge2 !== null && slug !== null && token !== null) {
      const started = now()
      const answered = await get(`${edge2}${viaEdge}`, Math.min(remaining, EDGE_TIMEOUT), signal, true)
      if (signal?.aborted) return null
      const states = answered === null ? null : edgeTokenPairs(answered.body, [token], wall())
      if (states !== null) {
        const own = states.get(token)
        return own ? { body: own.pairs, retrievedAt: own.retrievedAt } : null
      }
      if (cooling(true)) return null
      edgeDownUntil.set(slug, now() + EDGE_RETRY_MS)
      remaining -= now() - started
      if (remaining <= 0) return null
    }
    return get(`https://api.dexscreener.com/${path}`, remaining, signal, false)
  }

  /** One bounded GET: our edge's (same origin, the beta cookie goes with it) or the provider's (no credentials, no referrer). */
  async function get(url: string, remaining: number, signal: AbortSignal | undefined, own: boolean): Promise<{ body: unknown; retrievedAt: number } | null> {
    if (signal?.aborted || cooling(own)) return null
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => controller.abort(), remaining)
    try {
      const response = await fetch(url, {
        signal: controller.signal, credentials: own ? 'same-origin' : 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
        headers: { Accept: 'application/json' },
      })
      if (response.status === 429) {
        const header = response.headers.get('Retry-After')
        const delay = header !== null && /^\d+$/.test(header) ? Number(header) * 1000 : header === null ? FAILED_TTL : Date.parse(header) - wall()
        // (2026-10-15, pack 8, Q3): the Retry-After plus 0 to 25% at random, never less than it named (./jitter.ts's rule,
        // written out here: this module imports nothing, and node loads it as it is in tests/token-artwork.test.mjs).
        const spread = Number.isFinite(delay) && delay > 0 ? delay + Math.floor(delay * 0.25 * Math.random()) : delay
        cooldown.set(own ? 'edge' : 'provider', now() + Math.max(FAILED_TTL, Math.min(3600000, Number.isFinite(spread) ? spread : FAILED_TTL)))
      }
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
   *
   * `chainId` names the chain (2026-10-06): one body per chain and address.
   */
  function lease(entry: Reading, signal?: AbortSignal): Promise<unknown> {
    entry.users++
    return new Promise((resolve) => {
      let done = false
      const finish = (body: unknown) => {
        if (done) return
        done = true
        signal?.removeEventListener('abort', cancel)
        entry.users--
        if (entry.users === 0 && !entry.settled) entry.controller.abort()
        resolve(body)
      }
      const cancel = () => finish(null)
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      void entry.result.then(finish)
    })
  }

  function pairsWithin(chainId: number, address: string, remaining: number, signal?: AbortSignal): Promise<unknown> {
    const slug = dexChainSlug(chainId)
    if (slug === null || signal?.aborted) return Promise.resolve(null)
    const key = `${chainId}:${address}`
    const kept = bodies.get(key)
    if (kept && kept.expires > now()) return Promise.resolve(kept.body)
    const deadline = now() + remaining
    const joined = reading.get(key)
    if (joined) {
      const answer = lease(joined, signal)
      if (joined.deadline >= deadline) return answer
      return answer.then((body) => {
        const left = deadline - now()
        return body !== null || left <= 0 || signal?.aborted ? body : pairsWithin(chainId, address, left, signal)
      })
    }
    const entry: Reading = { deadline, users: 0, controller: new AbortController(), settled: false, result: Promise.resolve(null) }
    entry.result = retrieveDated(`token-pairs/v1/${slug}/${address}`, remaining, entry.controller.signal).then((dated) => {
        entry.settled = true
        if (reading.get(key) === entry) reading.delete(key)
        const body = dated?.body ?? null
        if (dated !== null && body !== null) {
          bodies.delete(key)
          bodies.set(key, { body, expires: now() + BODY_TTL })
          while (bodies.size > 16) bodies.delete(bodies.keys().next().value!)
          // Pool hints and pricing can discover the artwork too. Mounted marks observe this cache, so a previous
          // transient miss never hides a logo until the user closes and opens the search again.
          seed(chainId, address, artworkFromPairs(body, address, chainId))
          for (const listener of pairsListeners) {
            try {
              listener(address, body, dated.retrievedAt, chainId)
            } catch {
              // A listener's failure is its own: the artwork and the hints read the body as before.
            }
          }
        }
        return body
      })
    reading.set(key, entry)
    return lease(entry, signal)
  }

  /** The token's artwork, null when the provider's answer names none, or undefined when no answer came. */
  async function artworkOf(chainId: number, address: string): Promise<string | null | undefined> {
    try {
      const body = await pairsWithin(chainId, address, TIMEOUT)
      return body === null ? undefined : artworkFromPairs(body, address, chainId)
    } catch { return undefined }
  }

  function remember(key: string, value: string | null, failed = false, force = false) {
    const kept = cache.get(key)
    // A slower, empty/failed read must not erase an image seeded by a newer successful response.
    if (!force && value === null && kept?.value && kept.expires > now()) return
    cache.delete(key)
    const expires = now() + (value ? FOUND_TTL : failed ? FAILED_TTL : NONE_TTL)
    cache.set(key, { value, expires: failed ? Math.max(expires, ...cooldown.values()) : expires, failed })
    while (cache.size > 128) cache.delete(cache.keys().next().value!)
    for (const listener of observers.get(key) ?? []) listener()
  }

  function resolve(chainId: number, address: string, visibleOnly = false): Promise<string | null> {
    const key = tokenArtworkKey(chainId, address)
    if (!key) return Promise.resolve(null)
    const cached = cache.get(key)
    if (cached && cached.expires > now()) return Promise.resolve(cached.value)
    if (!visibleOnly) required.add(key)
    const joined = pending.get(key)
    if (joined) return joined
    if (pending.size >= 32) { required.delete(key); remember(key, null, true); return Promise.resolve(null) }
    const result = new Promise<string | null>((done) => {
      // Its six seconds start when its read does, not while it waits for a slot (2026-09-28, speed wave, item 42:
      // a token late in the queue used to run out of time without ever being asked, then showed none for 5 minutes).
      const run = () => {
        if (visibleOnly && !required.has(key) && !observers.get(key)?.size) {
          pending.delete(key)
          done(null)
          queue.shift()?.()
          return
        }
        // Answered while it waited for a slot (a seed: the token search's batch, the Wallet card's prices, another
        // token's body): nothing to ask. Added 2026-10-30 (QA round 2, N6).
        const seeded = cache.get(key)
        if (seeded && seeded.expires > now()) {
          pending.delete(key)
          required.delete(key)
          done(seeded.value)
          queue.shift()?.()
          return
        }
        active++
        void artworkOf(chainId, address.toLowerCase()).then((found) => {
          remember(key, found ?? null, found === undefined)
          done(cache.get(key)?.value ?? null)
        }).finally(() => {
          pending.delete(key)
          required.delete(key)
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
   * queued behind the artwork lookups: its callers (New position's pool hints,
   * the markets' figures) wait for it with their own limits. Since 2026-10-06
   * also a token's on Base or Arbitrum One (New position's pools there).
   */
  function pairs(chainId: number, address: string): Promise<unknown> {
    return dexChainSlug(chainId) !== null && ADDRESS.test(address) ? pairsWithin(chainId, address.toLowerCase(), TIMEOUT) : Promise.resolve(null)
  }

  /**
   * Prices for up to PRICE_BATCH Robinhood tokens, through our edge in
   * bounded batches. The Wallet card's prices (lib/walletPrices.ts) are its
   * one caller.
   *
   * Changed on purpose 2026-10-14 (incident of 2026-10-13, package D1): asked
   * on our edge's per-token path. Whatever it answers for is the answer, each
   * token with its own retrieval time; a token it marks missing, or one of a
   * GET that gave nothing, is named `unavailable` (no price yet) and is not
   * asked of the provider. It was: every token of a batch with a gap went to
   * the provider directly, one GET per token from the visitor's own address.
   * Only when no token of the list was answered at all (our edge away, or not
   * in this build) is the provider asked, as before: shared token-pairs reads,
   * two at a time, the failed ones named separately. That path is given up on
   * its own account (`edge2DownUntil`), only when it gave no answer of its own.
   */
  async function tokenPrices(addresses: readonly string[], signal?: AbortSignal): Promise<TokenPricesAnswer> {
    const list = [...new Set(addresses.map((address) => address.toLowerCase()))].filter((address) => ADDRESS.test(address)).sort().slice(0, PRICE_BATCH)
    if (list.length === 0 || signal?.aborted) return null
    const parts: string[][] = []
    for (let i = 0; i < list.length; i += EDGE_BATCH) parts.push(list.slice(i, i + EDGE_BATCH))
    const found: unknown[] = []
    const missing: string[] = []
    const tokens: Record<string, EdgeTokenPairs> = {}
    const viaEdge = edge2 !== null && now() >= edge2DownUntil
    const answers = viaEdge
      ? await Promise.all(parts.map((part) => get(`${edge2}tokens/${part.join(',')}`, EDGE_TIMEOUT, signal, true)))
      : parts.map(() => null)
    if (signal?.aborted) return null
    let heard = false
    for (const [index, answer] of answers.entries()) {
      const answered = answer === null ? null : edgeTokenPairs(answer.body, parts[index], wall())
      if (answered) heard = true
      for (const address of parts[index]) {
        const own = answered?.get(address)
        if (own) tokens[address] = own
        else missing.push(address)
      }
    }
    if (missing.length < list.length) return { tokens, unavailable: missing }
    // No token priced by our edge. Asked and not heard from at all, its per-token path rests five minutes; either way the
    // provider is asked directly, as before, the artwork reads with it.
    if (viaEdge && !heard && !cooling(true)) edge2DownUntil = now() + EDGE_RETRY_MS
    if (missing.length && edge !== null && !cooling(true)) edgeDownUntil.set('robinhood', now() + EDGE_RETRY_MS)
    const unavailable: string[] = []
    // Same token-pairs coverage as our edge: the old tokens/v1 fallback omitted liquid v4 pools (including UFG).
    // Keep successful batches and read only their gaps. Two lanes, shared bodies/inflight, never an unbounded fanout.
    let next = 0
    await Promise.all(Array.from({ length: Math.min(2, missing.length) }, async () => {
      while (next < missing.length) {
        const address = missing[next++]
        if (signal?.aborted || cooling(true) || cooling(false)) { unavailable.push(address); continue }
        const body = await pairsWithin(4663, address, TIMEOUT, signal)
        if (Array.isArray(body) && body.length <= 100) {
          // Match the edge's bounded price subset: most liquid four pairs plus the most liquid base pair.
          const belongs = (token: unknown) => !!token && typeof token === 'object' && 'address' in token && typeof token.address === 'string' && token.address.toLowerCase() === address
          const ranked = body.filter(pair => pair?.chainId === 'robinhood' && (belongs(pair.baseToken) || belongs(pair.quoteToken)))
            .sort((a, b) => (typeof b.liquidity?.usd === 'number' && Number.isFinite(b.liquidity.usd) ? b.liquidity.usd : 0) - (typeof a.liquidity?.usd === 'number' && Number.isFinite(a.liquidity.usd) ? a.liquidity.usd : 0))
          const kept = ranked.slice(0, 4)
          const base = ranked.find(pair => belongs(pair.baseToken))
          if (base && !kept.includes(base)) kept.push(base)
          found.push(...kept)
        }
        else { unavailable.push(address); remember(`4663:${address}`, null, true) }
      }
    }))
    if (signal?.aborted) return null
    return unavailable.length === list.length ? null : unavailable.length ? { pairs: found, unavailable } : found
  }

  /**
   * Our edge's per-token `tokens` answer for up to PRICE_BATCH Robinhood Chain tokens, in GETs of EDGE_BATCH, and nothing
   * else: no provider fallback, no seed, no listener, no state given up. Null when this build has no edge, when our edge
   * is resting for these reads (its per-token path or Robinhood Chain's artwork reads gave no answer lately, or a 429
   * asked to wait), or when no GET answered. Added 2026-10-30 (QA round 2, N6): the token search asks it once for its
   * hits (lib/read/dexFigures.ts settleSearchHits), so a look-alike with no pair costs no token-pairs GET of its own.
   */
  async function edgeTokens(addresses: readonly string[], signal?: AbortSignal): Promise<Map<string, EdgeTokenPairs> | null> {
    const list = [...new Set(addresses.map((address) => address.toLowerCase()))].filter((address) => ADDRESS.test(address) && !/^0x0{40}$/.test(address)).sort().slice(0, PRICE_BATCH)
    if (list.length === 0 || signal?.aborted || edge2 === null || now() < edge2DownUntil || !edgeUp('robinhood') || cooling(true)) return null
    const parts: string[][] = []
    for (let i = 0; i < list.length; i += EDGE_BATCH) parts.push(list.slice(i, i + EDGE_BATCH))
    const answers = await Promise.all(parts.map((part) => get(`${edge2}tokens/${part.join(',')}`, EDGE_TIMEOUT, signal, true)))
    if (signal?.aborted) return null
    const out = new Map<string, EdgeTokenPairs>()
    let heard = false
    for (const [index, answer] of answers.entries()) {
      const answered = answer === null ? null : edgeTokenPairs(answer.body, parts[index], wall())
      if (!answered) continue
      heard = true
      for (const [address, own] of answered) out.set(address, own)
    }
    return heard ? out : null
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

  /** A visible mark observes later seeds and retries transient misses at most twice; absence needs no polling. */
  function observe(chainId: number, address: string, listener: (image: string | null) => void): () => void {
    const key = tokenArtworkKey(chainId, address)
    if (!key) return () => undefined
    let alive = true
    let tries = 0
    let reading = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => {
      clearTimeout(timer)
      const kept = cache.get(key)
      if (alive && !reading && kept?.failed && tries < 3) timer = setTimeout(ask, Math.max(1, kept.expires - now()))
    }
    const changed = () => {
      if (alive) listener(peek(chainId, address) ?? null)
      later()
    }
    const listeners = observers.get(key) ?? new Set<() => void>()
    observers.set(key, listeners)
    listeners.add(changed)
    const ask = () => {
      if (!alive) return
      tries++
      reading = true
      void resolve(chainId, address, true).then(() => {
        reading = false
        if (!alive) return
        changed()
      })
    }
    changed()
    ask()
    return () => {
      alive = false
      clearTimeout(timer)
      listeners.delete(changed)
      if (listeners.size === 0) observers.delete(key)
    }
  }

  return { resolve, pairs, tokenPrices, edgeTokens, seed, peek, onPairs, observe, rejectImage: (chainId: number, address: string) => {
    const key = tokenArtworkKey(chainId, address)
    if (key) remember(key, null, true, true)
  } }
}

// Our edge is asked first in the deployable builds only (audit I3): the test builds' servers have no such route.
export const tokenArtwork = createTokenArtworkResolver({ edge: typeof __DOMINO_POOL_SET__ !== 'undefined' && __DOMINO_POOL_SET__ === 'selected' ? DEX_EDGE : null })
