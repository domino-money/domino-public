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
 * The embedded list's pools read on chain on 2026-09-23 (each pool's Initialize
 * event on the PoolManager) as having no hooks and a fixed fee, the only
 * pools Domino opens a position in. A catalogue row added later is not named
 * until its pool is read the same way. A featured list's pools need no such
 * set: every entry it shows passed the contract's runtime and the app's own
 * checks as hookless with a fixed fee, and carries its key (2026-09-26,
 * featured pools v1 §11.5).
 */
const HOOKLESS_FIXED_FEE: ReadonlySet<string> = new Set([
  '0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6', // WETH/USDG, fee 200
  '0xdb922f0619e11b0c1e6c3a142798f0243060b8a4331ea4f4e7de80e898cc02e7', // USDG/MARLIN, fee 50000
  '0x94c62eebf6454231b2fcd0259ede448ae3c6ad8617718cd88dab20b30cfae48a', // USDG/cbBTC, fee 1500
  '0xf399bd1544377680d48c62fd85c2105b869e55906c4189cc5ab3b4e83446928c', // USDG/U, fee 75
  '0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e', // ETH/USDG, fee 100
  '0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a', // PONS/USDG, fee 3000
])

/**
 * The currencies of a featured pool whose catalogue row names none. The
 * ETH/USDG row carries no addresses because Uniswap's ETH label does not say
 * native or wrapped; the same Initialize event does: currency0 is the zero
 * address, native ETH.
 */
const READ_CURRENCIES: Readonly<Record<string, readonly [string, string]>> = {
  '0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e': [NATIVE_CURRENCY, SELECTED_POOLS_COMMON_TOKEN],
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
