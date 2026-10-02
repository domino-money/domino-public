/**
 * Which pools New position asks the read service to verify.
 *
 * Asked only for a token, the pools route verifies the first twelve pools its
 * catalogue holds for it, by pool id: for a token with hundreds of pools that
 * is mostly empty or hooked pools, and none of the ones people trade in. So
 * New position first takes the token-pairs list the token artwork already
 * reads (one GET per token, shared: lib/tokenArtwork.ts), keeps the Uniswap
 * pools on Robinhood Chain that hold the token (and the second asset, when one
 * is chosen), and names the most liquid ten in the pools read
 * (poolsList.ts `usablePoolsRequest`), after the site's featured pools that
 * hold the token (featuredPools.ts): the provider's list is capped at 30
 * pairs, not ranked by liquidity, and can leave those out.
 *
 * The list is a question, never an answer: only the pool ids are used, and
 * only to ask. Whether each pool exists, what it holds, its fee and its hooks
 * come from the chain through the read service, and every figure on a row is
 * the read service's own. A pool the list names that the chain does not
 * confirm is not an option, and nothing here is ever shown.
 */
import { tokenArtwork } from '../../tokenArtwork'
import { CHAIN_ID, NATIVE_CURRENCY, poolIdKey, type AddressKey, type PoolIdKey } from './identity'
import { MAX_POOL_HINTS } from './poolsList'

const POOL_ID = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
/**
 * How long New position (and a token's Markets page) waits for the hints before it reads the pools without them.
 * Changed 2026-10-01 (audit A16): 800 ms, from 2.5 s. The hints are a single GET, through our own edge where it keeps
 * them, usually already in hand (asked when the token is pointed at in the search); a slow provider held the whole
 * list for up to 2.5 s.
 */
export const HINT_WAIT_MS = 800

/** One pair as the provider's token-pairs list gives it; every field is checked before use. */
type Pair = {
  chainId?: unknown
  dexId?: unknown
  labels?: unknown
  pairAddress?: unknown
  baseToken?: { address?: unknown } | null
  quoteToken?: { address?: unknown } | null
  liquidity?: { usd?: unknown } | null
}

/** The token-pairs body for one address, or null. */
export type PairsSource = (address: AddressKey) => Promise<unknown>

const lowerAddress = (value: unknown): string | null => (typeof value === 'string' && ADDRESS.test(value) ? value.toLowerCase() : null)

/**
 * Up to `limit` pool ids from a token-pairs body, most reported liquidity
 * first: Robinhood Chain, Uniswap, labelled v4 (a 32-byte pool id, not a pair
 * contract), holding `token` and, when given, `paired` on the other side, with
 * a finite liquidity figure. Lowercase, each once. A body that is not a list,
 * or is longer than the provider ever sends, gives none.
 */
export function v4PoolHints(body: unknown, token: AddressKey, paired: AddressKey | null, limit = MAX_POOL_HINTS): PoolIdKey[] {
  if (!Array.isArray(body) || body.length > 100) return []
  const found: Array<{ id: PoolIdKey; usd: number }> = []
  for (const entry of body as unknown[]) {
    if (!entry || typeof entry !== 'object') continue
    const pair = entry as Pair
    if (pair.chainId !== 'robinhood' || pair.dexId !== 'uniswap' || !Array.isArray(pair.labels) || !pair.labels.includes('v4')) continue
    if (typeof pair.pairAddress !== 'string' || !POOL_ID.test(pair.pairAddress)) continue
    const base = lowerAddress(pair.baseToken?.address)
    const quote = lowerAddress(pair.quoteToken?.address)
    if (base !== token && quote !== token) continue
    if (paired !== null && (base === token ? quote : base) !== paired) continue
    const usd = pair.liquidity?.usd
    if (typeof usd !== 'number' || !isFinite(usd) || usd < 0) continue
    found.push({ id: poolIdKey(pair.pairAddress), usd })
  }
  found.sort((a, b) => b.usd - a.usd || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const ids: PoolIdKey[] = []
  for (const { id } of found) if (!ids.includes(id)) ids.push(id)
  return ids.slice(0, Math.min(limit, MAX_POOL_HINTS))
}

const artworkPairs: PairsSource = (address) => tokenArtwork.pairs(CHAIN_ID, address)

/**
 * The hints for a token (and second asset). The provider lists native ETH's
 * pools under the zero address, 30 at most and nearly all of them ETH/USDG
 * (read 2026-09-23), so ETH alone is asked by that address and a pair with
 * ETH by its other side.
 */
export async function poolHints(token: AddressKey, paired: AddressKey | null, pairs: PairsSource = artworkPairs): Promise<PoolIdKey[]> {
  const ask = token === NATIVE_CURRENCY && paired !== null ? paired : token
  return v4PoolHints(await pairs(ask), token, paired)
}

/**
 * The hints, or none: whatever `poolHints` has by `wait` ms, and none after a
 * failure or once `signal` aborts. Never rejects, so the pools read that
 * follows always happens.
 */
export function hintsWithin(token: AddressKey, paired: AddressKey | null, signal: AbortSignal, options: { wait?: number; pairs?: PairsSource } = {}): Promise<PoolIdKey[]> {
  return new Promise((done) => {
    let settled = false
    const finish = (hints: PoolIdKey[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      done(hints)
    }
    const stop = () => finish([])
    const timer = setTimeout(stop, options.wait ?? HINT_WAIT_MS)
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    else poolHints(token, paired, options.pairs).then(finish, stop)
  })
}
