/**
 * New position's V2 choices (the integrated journey, 2026-10-02), one named constant each. Most are the OWNER'S DECISIONS
 * of spec F7 rev2/rev3 (§0, §9: the number in brackets), copied from the rejected #/v2 screens' table
 * (src/v2ui/s1/constants.ts) so this area never imports v2ui; the rest are this journey's own choices, said as such and
 * listed in the report.
 */

/**
 * The journey's own choice: on a chain whose S1 gate is only `preview` (the preview alias and the dev server, before the
 * deploy), and where today's create works (Robinhood Chain), New position keeps today's steps and Create position (Setup)
 * exactly, so V1 stays fully testable there. The zap replaces Setup on Robinhood Chain once its gate says `live`. False:
 * the literal reading (the zap path, locked after the review, wherever the gate is `preview`).
 */
export const SETUP_STAYS_WHILE_PREVIEW = true

/**
 * The owner, 2026-10-05: New position on Robinhood Chain is HIS journey (components/create/Journey.tsx, the screens he
 * built), exactly, whatever S1's gate says, the zap path's own screens only behind "Create a new pool (advanced)". V2
 * connects behind his screens, never in place of them (2026-10-04's switch to the zap path's screens is undone). False:
 * the zap path's screens on Robinhood Chain once its gate is `live` (./model/routing.ts).
 */
export const JOURNEY_STAYS_ON_ROBINHOOD = true

/** [#2] The S1 slippage: 0.5% by default, editable from 0.1% to 5%, a warning above 2%. */
export const JOURNEY_DEFAULT_SLIPPAGE_BPS = 50
export const JOURNEY_MIN_SLIPPAGE_BPS = 10
export const JOURNEY_MAX_SLIPPAGE_BPS = 500
export const JOURNEY_SLIPPAGE_WARNING_ABOVE_BPS = 200
/** [#29] The proposed text, valid as written. */
export const JOURNEY_HIGH_SLIPPAGE_COPY = 'High slippage: you may receive noticeably less than quoted.'

/** [#3] A quote is good for 3 minutes; the intent's and the permit's deadline is 5 minutes after it (the plan API's own). */
export const JOURNEY_QUOTE_LIFETIME_S = 180
export const JOURNEY_DEADLINE_S = 300

/** [#4] No Domino relayer at launch: the relayed consent is never offered (a create is direct, batched or Permit2). */
export const JOURNEY_RELAYED_OFFERED = false

/** [#6] v4 pools with a hook stay refused: never offered in the pool choice. */
export const JOURNEY_HOOKED_POOLS_SHOWN = false

/** [#7] Creating a pool is in M1, as an advanced and labeled path, only for a pool with no price yet (§2.6.5). */
export const JOURNEY_POOL_CREATION_OFFERED = true
export const NEW_POOL_TITLE = 'Create a new pool (advanced)'
export const NEW_POOL_CONFIRM_COPY = 'If this price differs from the market, arbitrageurs will take the difference from your deposit.'
export const NEW_POOL_RACE_COPY = 'The pool was created by someone else at a different price. Review and try again.'

/** [#26] A new v4 pool offers the four v3 pairs: 0.01%, 0.05%, 0.3% and 1%, with tick spacings 1, 10, 60 and 200. */
export const V4_NEW_POOL_TIERS: readonly { fee: number; tickSpacing: number }[] = Object.freeze([
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
])

/** [#9] No public RPC: a pool on Base or Arbitrum One is the one the person indicates, read through the wallet's provider. */
export const JOURNEY_PUBLIC_RPC = false

/** [#22] No USD, APR or TVL for a V2 pool: no qualified source is wired. */
export const JOURNEY_USD_SHOWN = false

/** The journey's choice: a recipient other than the connected wallet is never offered (the plan API plans for the session's wallet). */
export const JOURNEY_CHOSEN_RECIPIENT_OFFERED = false

/** How often a sent step's receipt, and a batch's status, is asked again; a delay is never a failure. */
export const JOURNEY_RECEIPT_POLL_MS = 1_500

/** How many times in a row a plan that failed on price, or expired, is quoted again on its own before the person is asked. */
export const JOURNEY_QUIET_REQUOTES = 2

/** The rule the page judges a pool's price by on this page (the V1 range step's own, lib/read/screens/poolRange.ts). */
export const JOURNEY_PRICE_STALE_MS = 300_000
