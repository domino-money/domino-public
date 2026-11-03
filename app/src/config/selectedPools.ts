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
 * Replaced again on 2026-11-02 (the owner, from the featured runs of 24 Oct to
 * 2 Nov): USDG/ORBIO (depth under the floor) and USDG/UBIK (no volume) were
 * withdrawn within hours of each fill, and ETH/USDG 0.05%, the deepest
 * ETH/USDG pool, is the one major pair in place of 0.01%. ETH/TORCH holds no
 * USDG, so its catalogue row names both its currencies.
 */
export const SELECTED_POOLS: readonly string[] = [
  '0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982', // ETH/USDG 0.05%
  '0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a', // PONS/USDG
  '0x1649550af1e3363b4c25236434530af7e6886b183e1f574a98fdd1d04d287a2d', // ETH/TORCH
  '0xa92a3df27a00a276183ff7265fd8affa11df1fe8bb23ddfaf13f6c879a3f818b', // CASHCAT/USDG
  '0x9be7ab27227e115085b0949a819a73f6963ddc6da0c6204d37757c24297706e8', // USDG/PRIORS
  '0xa95732060867f07aa9b8ae9a4b7b8d737bc3374f1dfbb952759c5ed676e8737c', // USDG/VIRTUAL
]
