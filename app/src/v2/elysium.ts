/**
 * Elysium (Kinetiq), the fourth chain V2 serves on the day every day-9 piece is in the repository.
 *
 * Elysium is an Arbitrum Orbit (Nitro) chain that settles to HyperEVM and pays its network fees in HYPE. Its mainnet's
 * chain id is 99901 (rugged97's #459, 6 Nov 2026: the id Conduit deployed, in the deployment tool's enabled chains) and it
 * has Uniswap v4 alone; its enabled V2 profile, Domino deployment and service versions arrive with rugged97's day-9
 * pull request, and until then api-contracts/v2/chains/elysium.json is a disabled placeholder. These are the facts the
 * app needs for it that do not hang on any of those: its words, its currencies, its finality, its one Uniswap version
 * and where its mark is. Changed on purpose 2026-11-07 (Elysium as a fourth V2 chain, switched on by itself): they are
 * its row of ./chains.ts V2_CHAIN_FACTS where the build's switch says Elysium is live (lib/elysiumIdentity.ts
 * ELYSIUM_LIVE, which config/chainIdentity.ts V2_CHAIN_IDS follows); elsewhere nothing reads them as a chain V2 serves.
 * tests/v2/elysium-chain.test.mjs runs the chain both ways, tests/v2/hype-chain.test.mjs a synthetic HYPE-native chain,
 * and tests/v2/v4-only-chain.test.mjs the synthetic chain 99901 with v4 alone.
 *
 * Its name, its mark's path and whether funds can come from it are lib/elysiumIdentity.ts's, which Home takes before
 * V2 loads (a V1 file never imports a V2 module). No URL of a host: any module may take it.
 */
import { ELYSIUM_FUNDS_FROM, ELYSIUM_MARK, ELYSIUM_NAME } from '../lib/elysiumIdentity'

export const ELYSIUM = Object.freeze({
  slug: 'elysium' as const,
  name: ELYSIUM_NAME,
  nativeSymbol: 'HYPE' as const,
  wrappedSymbol: 'WHYPE' as const,
  /**
   * "Finalized" usually comes about this many minutes after "Included" (spec §1.3; never a deadline): the testnet
   * rehearsal of 5 Nov 2026 measured its `finalized` block 712 s behind its head (docs/v2/QUALIFY_CHAIN.md). Checked on
   * 2026-11-09 (Elysium's day 9, checklist step 4): on mainnet `finalized` trails the head by 6 to 25 minutes, moving in
   * batch steps (350 s at the profile's block 3233210, 10 to 25 minutes during the deployment, rugged97's measurements),
   * so 12 stays: the middle of that.
   */
  finalityMinutes: 12,
  /**
   * The Uniswap versions it has: v4 alone (rugged97's #459: mainnet 99901 has Uniswap v4 only, so its profile names
   * `uniswap.v3` null and its deployment registers nine contracts). Its facts row takes these, so its profile is held to
   * v4 alone and nothing of v3 is offered, planned, sent or read there (./chains.ts hasDex).
   */
  dexes: Object.freeze([4] as const),
  mark: ELYSIUM_MARK,
  fundsFrom: ELYSIUM_FUNDS_FROM,
})
