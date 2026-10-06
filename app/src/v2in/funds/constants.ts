/**
 * Deposit from another network, inline in New position's amount step (spec F7 §3, §9 #15/#16/#17): each point of the
 * spec's decisions that touches it, as one named constant, and the few fixed numbers. Copied on purpose from the
 * rejected #/v2 section's constants (src/v2ui/s2/constants.ts, reference only), values unchanged. Changing one is a
 * reviewed change of this file.
 */

/**
 * DECIDED #16 [owner, 02/10] (§3.5, §8.2 S2; texts #29): SHOW that the person may bridge with any other service, as a
 * discrete small line beside the fee and the provider in the quote: "Domino fee 0.35% · via {provider} · you can also
 * bridge with any other service" (copy.ts bridgeElsewhereLine).
 */
export const FUNDS_SHOW_BRIDGE_ELSEWHERE = true

/**
 * DECIDED #15 [owner, 02/10] (§3.1, §3.6, §8.2 S2): an ERC-20 deposit is always two separate transactions, the exact
 * approval then the deposit, with no EIP-5792 batch; the approval's receipt is waited for before the deposit.
 */
export const FUNDS_BATCH_APPROVAL_AND_DEPOSIT = false

/**
 * #17 (owner + F5/F8, §3.1, §3.2), the app's side done (Changed on purpose (data) 2026-10-02 (S2 wired)): the forwarder
 * family `/api/crosschain/v1/` (functions/_lib/bridge.ts), its Worker (bridge/src/crosschain-worker.mjs) and the HTTP
 * transport over the signed-in session's CSRF (src/finance/v2/http.ts) exist, so the offer's services are built where
 * the gate is `live`, which the crosschain route's own capabilities decide (src/v2/gate.ts). What is left is the
 * dashboard's: the Worker deployed with its keys, and the CROSSCHAIN_BRIDGE binding; until then the route answers
 * not_found, the gate stays `preview` and the offer runs locked (services.ts). Never a fixture in its place.
 */
export const FUNDS_HTTP_TRANSPORT_WIRED = true

/** The default slippage for the bridge quote: V1's own (50 bps, 0.5%). */
export const FUNDS_DEFAULT_SLIPPAGE_BPS = 50
/** The service's bounds for `slippageBps` (§3.4): 10 to 500. */
export const FUNDS_MIN_SLIPPAGE_BPS = 10
export const FUNDS_MAX_SLIPPAGE_BPS = 500

/**
 * §3.9 recommendation (rev2, with decision #9): at most this much native balance on the destination is "lacking", and
 * "Get gas on {destination}" is then suggested. Zero: the one case the spec names; no threshold is invented. With no
 * balance read, the option is shown for the person to decide.
 */
export const FUNDS_SUGGEST_DESTINATION_GAS_AT_OR_BELOW_WEI = 0n
/** Shown, never pre-chosen (§3.9 rev2: "para o usuário decidir"): Relay's top-up comes out of the deposit. */
export const FUNDS_DESTINATION_GAS_DEFAULT_ON = false

/** After a quote passes its deadline the offer asks for a new one by itself, at most this many times in a row. */
export const FUNDS_AUTO_REQUOTES = 3

/**
 * Added 2026-10-06 (the owner's point 2b: a US$16 position asked for US$270): the amount brought is sized from the
 * service's own quote, so its guaranteed minimum covers what the position lacks. The first quote asks for the need in the
 * token sent (by decimals for the same kind; at the USD prices Domino's service read, for another kind) plus this much
 * (Domino's 0.35%, the bridge's own fee and the 0.5% slippage, with room); when its minimum falls short, or its rate says
 * much less would do, one more quote asks for the need at the first one's rate, plus 1% (model.ts sizeStep,
 * sizeFromQuote). At most two quotes per choice: the service's quote budget is shared by every visitor.
 */
export const FUNDS_FIRST_GUESS_ROOM_BPS = 200

/**
 * Added 2026-10-06 (the review of 2026-10-06: a US$100 position offered to bring 0.4995 ETH): a first quote that covers
 * the need while its own rate says this much less would too (a first ask of everything held, for another kind of token
 * with no price read; a price that was off) is asked once more, smaller (model.ts sizeStep).
 */
export const FUNDS_SIZE_SLACK_BPS = 300

/**
 * Added 2026-10-06 (the owner's point 4: no "Get a quote" button): a change under "Change amount" asks for a new quote by
 * itself, once the person stops typing for this long. Changed on purpose 2026-10-06 (the review of 2026-10-06): every
 * quote the page asks counts (a one click's two, a re-size, "Get gas", a change, a new one past the deadline), and none is
 * asked past FUNDS_TYPED_QUOTES_PER_MINUTE in a minute (the crosschain service runs one quote budget per provider for
 * every visitor: backend/crosschain_config.py).
 */
export const FUNDS_TYPED_QUOTE_DEBOUNCE_MS = 900
export const FUNDS_TYPED_QUOTES_PER_MINUTE = 6

/**
 * Added 2026-10-06 (the owner's point 1): a holding the read values below this many US dollars is too little to bring
 * (about a bridge's own minimum), so the discreet line before an amount does not name it.
 */
export const FUNDS_LINE_MIN_USD = 1
/** How often a sent step's receipt is read while waiting for it. */
export const FUNDS_RECEIPT_POLL_MS = 3_000
/** How long the deposit's receipt is watched for "Finalized" once included; past it the step stays "Included". */
export const FUNDS_FINALITY_WATCH_MS = 60 * 60_000
/** The first wait before an origins or quote request asks again by itself after a transient failure (doubling, to 5 min). */
export const FUNDS_REQUEST_RETRY_MS = 5_000
