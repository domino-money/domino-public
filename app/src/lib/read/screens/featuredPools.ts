/**
 * The site's featured pools (config/selectedPoolCatalogue.ts) that New
 * position always names in its pools read, in front of the provider's hints.
 *
 * The provider's token-pairs list is capped at 30 pairs and not ranked by
 * liquidity: for USDG, the token every featured pool holds, it names none of
 * them (read 2026-09-23), so the largest usable USDG pools never reached the
 * list. Naming them is still only a question: the read service verifies each
 * id on chain and attaches its own figures, and a pool it does not confirm is
 * not an option (poolsList.ts `usablePoolsRequest`).
 */
import { SELECTED_POOL_CATALOGUE, SELECTED_POOLS_COMMON_TOKEN, type PoolCatalogueEntry } from '../../../config/selectedPoolCatalogue'
import { NATIVE_CURRENCY, poolIdKey, type AddressKey, type PoolIdKey } from './identity'

/**
 * The embedded list's pools read as having no hooks and a fixed fee, the only
 * pools Domino opens a position in: PONS/USDG on chain on 2026-09-23 (its
 * Initialize event on the PoolManager); CASHCAT/USDG and USDG/VIRTUAL from
 * their keys as Domino's reader verified them at a block (2026-09-25 and
 * 2026-10-04); ETH/USDG 0.05%, ETH/TORCH and USDG/PRIORS the same way on
 * 2026-11-02 (blocks 104,273,764 to 104,276,809: no hooks, fee mode fixed,
 * the fees below; each id is the hash of that key). A catalogue row added
 * later is not named until its pool is read the same way. A featured list's
 * pools need no such set: every entry it shows passed the contract's runtime
 * and the app's own checks as hookless with a fixed fee, and carries its key
 * (2026-09-26, featured pools v1 §11.5).
 */
const HOOKLESS_FIXED_FEE: ReadonlySet<string> = new Set([
  '0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982', // ETH/USDG, fee 500
  '0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a', // PONS/USDG, fee 3000
  '0x1649550af1e3363b4c25236434530af7e6886b183e1f574a98fdd1d04d287a2d', // ETH/TORCH, fee 3000
  '0xa92a3df27a00a276183ff7265fd8affa11df1fe8bb23ddfaf13f6c879a3f818b', // CASHCAT/USDG, fee 2690
  '0x9be7ab27227e115085b0949a819a73f6963ddc6da0c6204d37757c24297706e8', // USDG/PRIORS, fee 10000
  '0xa95732060867f07aa9b8ae9a4b7b8d737bc3374f1dfbb952759c5ed676e8737c', // USDG/VIRTUAL, fee 3000
])

/**
 * The currencies of a featured pool whose catalogue row names none. The
 * ETH/USDG row carries no addresses because Uniswap's ETH label does not say
 * native or wrapped; the read of its pool does: currency0 is the zero
 * address, native ETH (ETH/USDG 0.05% since 2026-11-02, its key as Domino's
 * reader verified it; the 0.01% pool before, by its Initialize event).
 */
export const READ_CURRENCIES: Readonly<Record<string, readonly [string, string]>> = {
  '0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982': [NATIVE_CURRENCY, SELECTED_POOLS_COMMON_TOKEN],
}

/**
 * An entry's currencies when New position may name it, lowercase: a featured
 * list's from its validated key, an embedded one's when the hand-written set
 * above has it; null otherwise.
 */
function namedCurrencies(entry: PoolCatalogueEntry): string[] | null {
  if (entry.poolKey) return [entry.poolKey.currency0, entry.poolKey.currency1]
  const poolId = entry.poolId.toLowerCase()
  if (!HOOKLESS_FIXED_FEE.has(poolId)) return null
  return (entry.addresses ?? READ_CURRENCIES[poolId])?.map((address) => address.toLowerCase()) ?? null
}

/** The list on screen, as lib/read/featuredSource.ts hands it over; the embedded list until it does. */
let listed: () => readonly PoolCatalogueEntry[] = () => SELECTED_POOL_CATALOGUE

/** Called once by lib/read/featuredSource.ts, so New position names the pools of the list on screen. */
export function followFeaturedList(entries: () => readonly PoolCatalogueEntry[]) {
  listed = entries
}

/**
 * The featured pools that hold `token` and, when given, `paired` on the other
 * side, in list order, lowercase, each once. `entries` is the list on screen
 * (lib/read/featuredSource.ts) unless a caller names one.
 */
export function featuredPoolIds(token: AddressKey, paired: AddressKey | null, entries: readonly PoolCatalogueEntry[] = listed()): PoolIdKey[] {
  const ids: PoolIdKey[] = []
  for (const entry of entries) {
    const poolId = entry.poolId.toLowerCase()
    const currencies = namedCurrencies(entry)
    if (!currencies) continue
    const at = currencies.indexOf(token)
    if (at === -1) continue
    if (paired !== null && currencies[1 - at] !== paired) continue
    const key = poolIdKey(poolId)
    if (!ids.includes(key)) ids.push(key)
  }
  return ids
}
