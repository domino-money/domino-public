/**
 * The pools the landing reads, chosen in this one reviewed place.
 *
 * rugged97 selected these two Robinhood Chain (chain 4663) pool ids on #45
 * (comment 5636853694) as candidates for fresh pool-market validation: every
 * read proves the pool's identity, manager, full pool key, block and
 * provider again. The list is not a token allowlist, not an execution
 * admission and not a ranking; rows keep this file's order and nothing more.
 *
 * It holds ids only. Pair names, symbols and every figure come from
 * validated reads, never from here, and nothing historical is copied in.
 * An empty list is valid: the table then says no pools are selected, and
 * nothing is read at all.
 */
export const SELECTED_POOLS: readonly string[] = [
  '0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6',
  '0xdb922f0619e11b0c1e6c3a142798f0243060b8a4331ea4f4e7de80e898cc02e7',
]
