/**
 * The position page's Domino V2 choices (spec F7 rev3 §0, §9: the owner's decisions, the number in brackets), one named
 * constant each, copied from the S1 reference (the former src/v2ui/s1/constants.ts) for the actions this page carries. The rest are
 * app choices, each said as such. Listed in the integration report.
 */

/** [#2] The S1 slippage: 0.5% by default, editable from 0.1% to 5%, a warning above 2%. */
export const POSITION_SLIPPAGE_DEFAULT_BPS = 50
export const POSITION_SLIPPAGE_MIN_BPS = 10
export const POSITION_SLIPPAGE_MAX_BPS = 500
export const POSITION_SLIPPAGE_WARN_ABOVE_BPS = 200
/** [#29] The proposed text, valid as written. */
export const HIGH_SLIPPAGE_COPY = 'High slippage: you may receive noticeably less than quoted.'

/** [#3] A quote is good for 3 minutes; the intent's deadline is 5 minutes after it (the plan API sets both, the clients check them). */
export const QUOTE_LIFETIME_S = 180
export const PLAN_DEADLINE_S = 300

/** [#4] No Domino relayer at launch: the relayed consent is never offered (a change of range and an exit are direct). */
export const RELAYED_OFFERED = false

/**
 * [#5] A position under automation (§2.13), until the vault has manual actions: on an armed root "Change range" is
 * BLOCKED; add, withdraw and collect are allowed after the warning; at the end the page offers to turn automation back on.
 * A successor is held by its vault: no action here.
 */
export const ROOT_BLOCKS_CHANGE_RANGE = true
export const ROOT_PAUSE_COPY = 'This pauses automation for this position. You can turn it back on afterwards.'
export const ROOT_CHANGE_RANGE_COPY = 'Change range isn’t available while your automation manages this position.'
/** A successor has no action here (§8.2): the vault holds it, and the way out is on the main position's page (its vault's reserves). */
export const SUCCESSOR_BLOCKED_COPY = "Your automation holds this position. Withdraw it from your automation on your main position's page first."
export const REARM_COPY = 'Turn automation back on'
/**
 * Added 2026-11-09 (the core-flows fix; the owner: closing a position with automation must be totally easy): what Close
 * position says, in one plain line, of the automation on it. Closing an automation's main position turns that automation
 * off by itself (its vault never refuses the owner's exit), so no tick box: this line. A position Domino-compound holds
 * comes back to the wallet first, then closes (./CloseSteps.tsx). Named as the screens name it; "your automation" when
 * its name is not read.
 */
export const closeTurnsOffCopy = (name: string | null): string => `Closing also turns off ${name ?? 'your automation'} for this position.`
export const closeHeldCopy = (name: string | null): string => `${name ?? 'Your automation'} holds this position. It comes back to your wallet first, then closes.`
/** The close's steps (./CloseSteps.tsx), in the words the automation's own buttons use (../automate/VaultCard.tsx). */
export const CLOSE_STEP = { withdrawChild: 'Withdraw from your automation', close: 'Close position', withdrawReserves: 'Withdraw to wallet' } as const
/**
 * Added 2026-10-06 (the integration review, rugged-literal #1): the root of Auto-exit's own automation, its Auto-exit on
 * or paused, in Auto-exit's words. Its exit needs the position's approval alone, so only a step that moves that approval
 * (the zap's, on Add liquidity on v4 or Withdraw in one token) pauses it, and approving the position again ends the pause.
 */
export const EXIT_PAUSE_COPY = 'This pauses Auto-exit until you approve this position again.'
export const EXIT_REARM_COPY = 'Approve again'

/** [#6] v4 pools with a hook stay refused: an existing hooked position says this on its actions (the "···" menu's heading). */
export const HOOKED_COPY = "Pools with hooks aren't supported yet."

/** [#9] No public RPC: lists and history from read-v6; the wallet's own provider only right before a signature or a send. */
export const PUBLIC_RPC = false

/**
 * [#22] No USD, APR or TVL on a V2 position: no qualified source is wired for these reads.
 * Changed on purpose 2026-10-06 (rugged97's delta of 5 Oct, item 4: read-v6 1.1.0-rc.1's qualified USD, by the owner's
 * rules of decision #22): what a position holds and its fees are valued at the prices read-v6 gives its tokens, when every
 * token held above zero has one and the position's read is fresh; otherwise no figure, never a zero. Still no APR or TVL.
 */
export const USD_SHOWN = true

/**
 * App choice: an exit through the zap that takes everything out keeps the NFT (burn = false), as V1's Close position
 * does: nothing irreversible beyond the withdrawal, and the empty NFT stays in the wallet.
 */
export const EXIT_BURNS = false

/** §2.6.3 recommendation: a change of range that moves all of the liquidity burns the old NFT. */
export const CHANGE_RANGE_BURNS_WHEN_ALL = true

/** §2.6.4 recommendation: above this share of the source token coming back unconverted, offer a lower slippage or both tokens. */
export const UNCONVERTED_OFFER_ABOVE_PERCENT = 10

/** How often a sent step's receipt, and a batch's status, is asked again; a delay is never a failure. */
export const RECEIPT_POLL_MS = 1_500

/**
 * App choice (2026-10-06, the review of point 5): how often the page reads the wallet's list again while it waits for a
 * position New position just made (read-v6's index runs a few seconds behind the chain), for at most two minutes.
 */
export const NEW_POSITION_REREAD_MS = 3_000

/** The range choices around the price now, either way, in percent (the S1 reference's). */
export const RANGE_PRESETS: readonly { key: string; label: string; percent: number }[] = Object.freeze([
  { key: 'narrow', label: 'Narrow ±1%', percent: 1 },
  { key: 'medium', label: 'Medium ±5%', percent: 5 },
  { key: 'wide', label: 'Wide ±20%', percent: 20 },
])

/** The shares of a position a change of range or a withdrawal can move. */
export const SHARES = ['100', '50', '25'] as const
export type Share = (typeof SHARES)[number]
