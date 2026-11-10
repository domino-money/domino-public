/**
 * Deposit from another network, inline in New position's amount step (spec F7 §3, §9 #15/#16/#17): each point of the
 * spec's decisions that touches it, as one named constant, and the few fixed numbers. Copied on purpose from the
 * rejected #/v2 section's constants (src/v2ui/s2/constants.ts, reference only), values unchanged. Changing one is a
 * reviewed change of this file.
 */

/**
 * DECIDED #16 [owner, 02/10] (§3.5, §8.2 S2; texts #29): SHOW that the person may bridge with any other service, as a
 * discrete small line beside the fee and the provider in the quote: "Domino fee 0.35% · via {provider} · you can also
 * bridge with any other service" (copy.ts bridgeElsewhereLine). Changed on purpose 2026-10-06 (rugged's answer of 6 Oct,
 * F7 delta of 6 Oct §1: the Domino fee in view with its amount and token, its chain and where it is charged): the line
 * is the §3.5 fee sentence, then the same clause: "Domino fee (0.35%): 0.35 USDC, charged by Relay on Arbitrum One · you
 * can also bridge with any other service".
 */
export const FUNDS_SHOW_BRIDGE_ELSEWHERE = true

/**
 * DECIDED #15 [owner, 02/10] (§3.1, §3.6, §8.2 S2): an ERC-20 deposit is always two separate transactions, the exact
 * approval then the deposit, with no EIP-5792 batch; the approval's receipt is waited for before the deposit.
 * Changed on purpose 2026-10-06 (rugged's answer of 6 Oct: the owner revoked decision #15; F7 delta of 6 Oct §2): when
 * the wallet batches atomically on the ORIGIN chain (finance/batch.ts atomicStatus: `supported` or `ready`), the exact
 * approval and the deposit go as ONE EIP-5792 batch, one confirmation (./flow.ts); otherwise the two transactions above.
 * An allowance that already covers the amount sends the deposit alone, one transaction; native ETH is one transaction.
 */
export const FUNDS_BATCH_APPROVAL_AND_DEPOSIT = true

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
 * Added 2026-10-06 (the owner's point 2b: a US$16 position asked for US$270). Changed on purpose 2026-10-06 (rugged's
 * delta of 6 Oct §3, crosschain-v1 1.1.0-rc.1): the amount brought is the service's own, asked by output in ONE quote;
 * this room (Domino's 0.35%, the bridge's own fee and the 0.5% slippage, with room) is used only to choose which coin
 * covers what the position lacks (model.ts bringChoice, withFeeRoom).
 */
export const FUNDS_FIRST_GUESS_ROOM_BPS = 200

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

/**
 * Added 2026-10-06 (the review of rugged97's #379: Ethereum's and OP Mainnet's ETH as origins): the ETH kept on Ethereum
 * when its own ETH is brought from there, for that deposit's fee in Ethereum's own gas, as every origin keeps its own
 * (model.ts sendable). The origin sender asks the wallet there for the deposit's gas estimate plus 20%, at twice the
 * network's gas price, beside the amount sent (finance/v2/crosschain.ts). Domino's three networks and OP Mainnet, rollups
 * whose gas costs a sliver of that, keep the gas Review keeps (0.0005 ETH, lib/create/reviewPlan.ts), as before; on
 * Ethereum that falls short from about 2 gwei, so 0.003 ETH: a deposit of up to 120,000 gas at up to 12.5 gwei. What is
 * kept stays in the wallet there.
 */
export const FUNDS_ETHEREUM_GAS_RESERVE_WEI = 3_000_000_000_000_000n

/** How often a sent step's receipt is read while waiting for it. */
export const FUNDS_RECEIPT_POLL_MS = 3_000
/**
 * Added 2026-11-09 (core flows, the owner: nothing may load forever): how long a batch the wallet took (approval and deposit
 * together) is followed before the page says the wallet has not sent it yet, and the longest wait between two asks of the
 * wallet about it. It was asked every FUNDS_RECEIPT_POLL_MS for good, "Preparing your transfer…" or "Sent, waiting to be
 * included…" with nothing else to do.
 */
export const FUNDS_BATCH_FOLLOW_MS = 180_000
export const FUNDS_BATCH_POLL_MAX_MS = 30_000
/**
 * The wait before the next ask about a batch the wallet took `followedMs` ago: `base` (FUNDS_RECEIPT_POLL_MS) through the
 * first minute, then doubled each minute, never more than FUNDS_BATCH_POLL_MAX_MS. Pure.
 */
export function batchPollMs(followedMs: number, base: number = FUNDS_RECEIPT_POLL_MS): number {
  const minutes = Math.max(0, Math.floor(followedMs / 60_000))
  return Math.min(Math.max(base, FUNDS_BATCH_POLL_MAX_MS), base * 2 ** Math.min(minutes, 16))
}
/** How long the deposit's receipt is watched for "Finalized" once included; past it the step stays "Included". */
export const FUNDS_FINALITY_WATCH_MS = 60 * 60_000
/** The first wait before an origins or quote request asks again by itself after a transient failure (doubling, to 5 min). */
export const FUNDS_REQUEST_RETRY_MS = 5_000

/**
 * Added 2026-10-30 (launch capacity, CAP-5): every preparation of a transfer spends the wallet's one request budget, which
 * its plan at Review shares (finance/v2/requestCoordinator.ts). A preparation that found no route because every provider
 * was busy (`funding_routes_busy`) waits this long at least before it is asked again by itself; and an amount is
 * prepared again by itself at most FUNDS_AUTO_RETRIES times after its first try (then Check again, or another amount,
 * asks again: the offer stays one click, the owner's decision of 2026-10-05).
 */
export const FUNDS_ROUTES_BUSY_RETRY_MS = 60_000
export const FUNDS_AUTO_RETRIES = 3
