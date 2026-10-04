/**
 * The pools the landing reads, chosen in this one reviewed place.
 *
 * Robinhood Chain (chain 4663) pool ids, in display order. Every read proves
 * the pool's identity, manager, full pool key, block and provider again. The
 * list is not a token allowlist, not an execution admission and not a
 * ranking; rows keep this file's order and nothing more. This file holds ids
 * only; see selectedPoolCatalogue.ts for the display labels and source links.
 * Every numerical market figure still comes from validated reads, never from
 * the catalogue.
 * An empty list is valid: the table then says no pools are selected, and
 * nothing is read at all.
 *
 * History: the first two ids were selected on #45 (comment 5636853694) and
 * four more from Uniswap on 2026-09-13 UTC. Replaced on 2026-10-04 (the owner,
 * with 0xdecimal's review of the stuck Top pools): MARLIN was empty, cbBTC a
 * protected symbol, U an unreviewed upgradeable token, WETH/USDG a second
 * major pair beside ETH/USDG. ETH/USDG and PONS/USDG stayed.
 */
export const SELECTED_POOLS: readonly string[] = [
  '0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e', // ETH/USDG 0.01%
  '0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a', // PONS/USDG
  '0xea9f200e13055b82f175f44f592c4c13dd8c9d9320a66487d3c5cd90d68550ef', // USDG/ORBIO
  '0xa92a3df27a00a276183ff7265fd8affa11df1fe8bb23ddfaf13f6c879a3f818b', // CASHCAT/USDG
  '0x6d56f66e52e63e8be558d708a987426314bb4de92bc9b43a44effee1f2abf317', // USDG/UBIK
  '0xa95732060867f07aa9b8ae9a4b7b8d737bc3374f1dfbb952759c5ed676e8737c', // USDG/VIRTUAL
]
