import { useEffect, useRef, useState } from 'react'
import { zeroAddress, type Address, type Hex } from 'viem'
import { confirmDelegate, setupWallet } from '../../finance/wallet'
import { suggestGasBudget } from '../../finance/gas'
import { readRelease } from '../../finance/release'
import { saveSetupProfile } from '../../finance/recoveryProfile'
import { lookupRoute, routeCurrent, validateRoute, type RouteQuote } from '../../finance/routedQuote'
import { routeJournal, type RouteEvidence, type RouteRecord } from '../../finance/routedJournal'
import { deadlinePassed, poolDigest, routeEvidence, routedReplacement, swapDigest, walletOwnReads, type ReplacementFinding } from '../../finance/routedReplacement'
import { routedBatchPlan, routedTermsKey } from '../../finance/routedPlan'
import { personRefused } from '../../finance/nonce'
import { atomicStatus, createSetupClient, deploymentFrom, forgetOpenRequest, isRevert, nonceStanding, walletBalance, type AtomicStatus, type BatchPlan, type BatchState, type GasBudget, type PoolKey, type PreparedBatch, type PreparedSetup, type SetupOperation, type WalletRpc } from '../../finance/setup'
import { errorCode, financeErrorText } from '../../finance/words'
import { SWITCH_NOTICE, switchToRobinhood } from '../../wallet/port'
import { CREATE } from '../../lib/create/copy'
import { publishBatchAbility, publishCreateProgress, publishCreated, type LiveState, type LiveStep } from '../../lib/create/createProgress'
import { publishRoutedReview } from '../../lib/create/routedReview'
import { depositPlan, needsSides, quoteWithin, sizeSwap, swapFeePips, type DepositPlan, type PoolTerms, type Side, type SwapSize } from '../../lib/create/depositPlan'
import { setupDraft, type JourneyState, type SetupDraft } from '../../lib/create/journey'
import { mintPlanFor } from '../../lib/create/mintPlan'
import { pairedAmount } from '../../lib/create/pairAmount'
import { formatUnits } from '../../lib/read/decimal'
import { MAX_SQRT_PRICE, MIN_SQRT_PRICE } from '../../lib/read/screens/poolRange'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import { useWalletIdentity, walletKey } from '../../lib/walletIdentity'
import { Button } from '../ui'

/**
 * Review's last control: Create position. One press opens the position the
 * four steps describe, on Domino V1's own setup contract, through the wallet
 * alone. The existing pool path needs no private session. For a signed-in
 * wallet, an optional authenticated route comparison can select Uniswap;
 * every transaction is still verified and signed through that wallet.
 *
 * What the wallet holds decides how it is funded (lib/create/depositPlan.ts):
 * both tokens as the range pairs them, or one token alone, part of which is
 * swapped for the other inside the pool before the mint — the setup
 * contract's own assisted swap, sized from the contract's own quotes. One
 * token alone is deposited only into a pool that can swap part of it: before
 * any approval, Uniswap's own quotes of that swap are read through the wallet
 * (swapPreflight), and a pool that cannot fill it is said with nothing
 * deposited. The wallet is asked, in order and only for what is
 * needed: an exact allowance
 * for each token deposited whose allowance is short, the deposit, the swap
 * when one token was deposited, and the mint, which sends the position NFT to
 * the wallet and returns whatever the range did not use. Every step is
 * prepared against the chain first — the deployment verified through the
 * wallet, the transaction simulated, its gas estimated — offered to the
 * wallet once, and read back by hash before the next one is prepared. The
 * press on Create position is the review of these steps; the wallet shows each
 * transaction before it signs, and Review's list of wallet steps shows each as
 * it happens (lib/create/createProgress.ts).
 *
 * The deposit carries the slippage limit as room, as Uniswap's own caps do:
 * the mint is sized at the pool's price read on chain at that moment, for the
 * worst price inside the band, so it fits the deposit wherever in the band it
 * executes (lib/create/mintPlan.ts). What it does not use comes back with the
 * NFT. A range that takes one token alone takes exactly the amount Review
 * shows, with no room (lib/create/depositPlan.ts, 2026-09-28, one-sided).
 *
 * When the position exists, Review offers what comes next in this control's
 * place (2026-09-24, the three features joined up: components/create/
 * CreatedNext.tsx): open it on Positions as a plain position, or automate it.
 * No quote or financial response is kept in browser storage: only opaque
 * offer latches and transaction/operation hashes prevent duplicate swaps.
 * Positions lists the result from chain for the connected wallet. An earlier deposit of this wallet
 * in this pool whose mint did not happen is never funded again: it is shown
 * with its amounts, and the next press creates the position from it, or it
 * can be refunded.
 */

type Client = ReturnType<typeof createSetupClient>
type Open = { id: Hex; operation: SetupOperation }
type Phase = 'idle' | 'running' | 'failed' | 'held' | 'done'
/**
 * `nonce`: the nonce the swap went out with, so a replacement in the wallet is known on any later press (fix round 1).
 * `evidence`: what tells a replacement apart, read right before the swap was offered (fix round 3, finance/routedJournal.ts).
 */
type RouteContinuation = { owner: Address; plan: BatchPlan; claim: string; hash: Hex | null; nonce: bigint | null; evidence: RouteEvidence | null; swapped: boolean; wasOffered: () => boolean }
/**
 * What an earlier routed swap the journal still holds is known to have done: the reviewed swap (`swapped`), its input's
 * allowance used as the swap uses it (`spent`: a sign, fix round 3.2), not taken yet but not proven never to be
 * (`untouched`), a replacement after which the wallet used Uniswap otherwise (`changed`), one that may still go through
 * until its deadline (`waiting`, fix round 3.2), or one nothing could tell apart (`unknown`). Fix round 3.1: `spent`,
 * `untouched` and `changed` are new (finance/routedReplacement.ts).
 */
type RouteOutcome = 'swapped' | 'spent' | 'untouched' | 'changed' | 'waiting' | 'unknown'
/**
 * An earlier routed swap found again on a later press, for this pool's deposit (fix round 3.2: a record for another
 * pool's deposit is settled apart, settleElsewhere): what it did, until when (seconds, the chain's clock) it may still
 * go through where that is known, and how it stands apart from its record: mined under its own hash (`mined`), replaced
 * in the wallet (`replaced`), offered with no hash back and its nonce taken (`unanswered`), or signed with its hash back
 * and never on chain, its nonce still free (`unseen`).
 */
type Recovered = { outcome: RouteOutcome; until?: number; why: 'mined' | 'replaced' | 'unanswered' | 'unseen'; late?: boolean }
/** Fix round 3.2: why the Uniswap route is not offered for this deposit: another pool's record that may still go through, or a swap the person said they rejected. */
type RouteBlock = { kind: 'elsewhere' | 'held'; until: number | null }

const readSetupRelease = () => readRelease('/api/setup/v1/release', (value) => deploymentFrom(value))
/** A batch simulated on the chain's own RPC, for a wallet without eth_simulateV1: the page's chain code, loaded as its reads load it. */
const simulateOnChain = async (params: unknown[]) => (await import('../../lib/chain/chainCode')).simulateOnChain(params)
const currentSetupDeployment = async () => {
  const release = await readSetupRelease()
  return release.kind === 'available' ? release.deployment : null
}
/** How long a sent step is watched for its receipt. */
const RECEIPT_WAIT_MS = 300_000
const RECEIPT_EVERY_MS = 2_000
/** Exact allowances asked for before the deposit: a short allowance may take a reset to zero and the amount, per token. */
const MAX_APPROVALS = 4
/** Gas units kept in ETH through the deposit for the steps after it (the swap and the mint, or a refund), at the steps' own fee ceiling. */
const GAS_AFTER_DEPOSIT_UNITS = 6_000_000n
/** Gas units the approvals and the deposit itself may cost, at the same ceiling: never deposited. */
const GAS_UP_TO_DEPOSIT_UNITS = 3_000_000n
/** The furthest the assisted swap may move the pool's square-root price, in basis points: about 10% in price. */
const SWAP_PRICE_LIMIT_BPS = 500n
/** Before a one-token deposit, a size passes only if its swap ends this much short of the limit: room for the price to move before the swap is sent. */
const SWAP_CHECK_MARGIN_BPS = 50n
/** How far the device clock may be from the chain's: the swap and the mint carry a deadline drawn from it, and the contract refuses one too far off. */
const CLOCK_SKEW_S = 300
/**
 * What the check before a one-token deposit says when it stops (swapPreflight): each says nothing was deposited, and
 * what to do instead. `noLiquidity` and `tooThin` both follow quotes that found no size the pool fills: the first when
 * nothing is in range at the pool's price. `held`: the same pool met after a deposit is made, when the refund is the
 * way out.
 */
const PREFLIGHT = {
  noLiquidity: 'This pool has no liquidity at its current price, so part of your deposit cannot be swapped in it. Nothing was deposited. Deposit both tokens, or choose another pool.',
  tooThin: 'This pool is too thin to swap part of your deposit within a 10% price move. Nothing was deposited. Lower the amount, deposit both tokens, or choose another pool.',
  noPosition: 'After the swap, this deposit would make no position in this range. Nothing was deposited. Widen the range or change the amount.',
  unchecked: 'The pool could not be checked just now. Nothing was deposited. Try again in a moment.',
  quoter: 'The pool’s swap check could not be verified on chain. Nothing was deposited. Deposit both tokens to create this position.',
  clock: 'Your device’s clock is more than 5 minutes off the network’s time. Nothing was deposited. Set the clock right, then try again.',
  held: 'This pool has no liquidity at its current price, so your deposit cannot be swapped in it. Refund the deposit to your wallet.',
  heldClock: 'Your device’s clock is more than 5 minutes off the network’s time, so the swap cannot be signed. Your deposit is held: set the clock right and press Create position again, or refund it.',
} as const
/**
 * A deposit of one token for a range that took it alone, met with the price moved into the range since (2026-09-28,
 * one-sided): the range needs both tokens now, and Review showed no swap, so none is sent. The next press on the held
 * deposit may swap part of it, and this sentence says so first.
 */
const INTO_RANGE = 'The price moved into your range, which now needs both tokens. Your deposit is held: press Create position to swap part of it and finish, or refund it.'
/** What a batch's watch says when it ends without the position (createInOneBatch, watchBatch). */
const BATCH = {
  dropped: 'Your wallet did not include the batch. Nothing was deposited. Press Create position again.',
  reverted: 'The batch reverted on chain: nothing was deposited, only network gas was spent. Press Create position again.',
  unknown: 'The batch’s outcome could not be read. Check your wallet activity, then press Create position again: the chain is read first, and nothing is sent twice.',
  waiting: 'The batch is still waiting to be included. Check your wallet activity, then press Create position again: nothing is sent twice.',
} as const
/** A step the wallet replaced ("Speed up" or "Cancel", audit C14) that did not happen, read back from the chain. */
const REPLACED = {
  approve: 'Your wallet replaced the approval with another transaction, and nothing was approved. Press Create position again.',
  fund: 'Your wallet replaced the deposit with another transaction, and nothing was deposited. Press Create position again.',
  swap: 'Your wallet replaced the swap with another transaction, and nothing was swapped. Your deposit is held: press Create position to continue, or refund it.',
  mint: 'Your wallet replaced the mint with another transaction, and the position was not created. Your deposit is held: press Create position to continue, or refund it.',
  refund: 'Your wallet replaced the refund with another transaction, and your deposit is still held. Try the refund again.',
} as const
/** A routed Uniswap swap that completed, found again on a later press: the next press uses both balances, never a second swap. */
const ROUTE_RECOVERED = 'Your earlier Uniswap swap completed. Its tokens and the unspent input remain in your wallet, and the swap fee was collected. Press Create position to use both wallet balances without another swap, or go back to change the amount.'
/**
 * A routed swap the wallet replaced with a transaction that could not be told apart (fix round 2): treated as one that
 * may have swapped. Changed on purpose in fix round 3 (2026-10-01): it says we could not confirm what the wallet did,
 * and no longer that a new swap will never be sent: the person may say it did not go through (routeUnconfirmed).
 */
const ROUTE_REPLACED_UNKNOWN = 'Your wallet replaced the Uniswap swap with another transaction, and we could not confirm what your wallet did. Check your wallet activity, then press Create position to continue with the tokens now in your wallet. No new swap is sent on its own.'
/**
 * Fix round 3.1 (2026-10-01): a replaced swap whose input's Permit2 allowance reads exactly as the reviewed swap leaves
 * it (spent by the swap's amount, the same expiry and nonce): every guard of a completed swap holds. It used to read as
 * not confirmed, and a later one-token press offered "It did not go through", which could lead to a second swap and fee
 * for the same deposit.
 * Changed on purpose in fix round 3.2 (2026-10-02): a revoke of that allowance (Permit2's lockdown) leaves it the same
 * with nothing swapped, so the page says what the chain shows and never that the swap went through. The guards stay.
 * Nor that the wallet replaced it: a swap offered with no hash back, approved late, reads so too.
 */
const ROUTE_SPENT = 'The chain shows Uniswap can no longer take the amount your earlier Uniswap swap was to spend, as after a swap that went through, so no new swap is offered for this deposit. Check your wallet activity: if it went through, what you received is in your wallet. Press Create position to use both wallet balances, or go back to change the amount.'
/** Fix round 3.2: the same, on a later one-token press that the wallet's balances cannot cover. */
const ROUTE_SPENT_BALANCES = 'Your earlier Uniswap swap may have gone through: the chain shows Uniswap can no longer take what it was to spend. Use both tokens now in your wallet: go back and lower the amount or add the missing token. No second swap will be sent.'
/**
 * Fix round 3.1: a replaced swap that has not taken its input, where nothing yet proves it never can (the wallet may have
 * signed it under a nonce of its own). Its allowance, and the router call, expire at `time`; a press after that finds it
 * did not happen and asks for a fresh quote. No new swap is offered before then.
 */
const routeUntouched = (time: string) =>
  `Your wallet replaced the Uniswap swap with another transaction. The swap has not taken your tokens, and after ${time} it never can. After ${time}, press Create position to get a new quote. Until then, no new swap is offered.`
/**
 * Fix round 3.1: an earlier swap known to have gone through, made for a deposit in another pool: said once, and it does
 * not hold up this one. Changed on purpose in fix round 3.2: its record is moved aside, never let go, so it still guards
 * that pool's deposit against a second swap, and the sentence says so.
 */
const ROUTE_ELSEWHERE = 'Your earlier Uniswap swap, for a deposit in another pool, went through: what you received is in your wallet, and that pool’s deposit uses it without another swap. Press Create position to continue with this deposit.'
/** Fix round 3.2: the same for an allowance read as the swap leaves it (a sign, never said as proof: ROUTE_SPENT). */
const ROUTE_ELSEWHERE_SPENT = 'Your earlier Uniswap swap, for a deposit in another pool, may have gone through: the chain shows Uniswap can no longer take what it was to spend. That pool’s deposit uses your wallet’s balances without another swap. Press Create position to continue with this deposit.'
/**
 * Fix round 3.2 (2026-10-02): a swap offered with no hash back whose nonce another transaction took. Nothing proves the
 * wallet replaced it: it may still be showing the swap, and a wallet that sets its own nonces would sign it under the
 * next one. It can go through only until its router deadline (`time`); no new swap is offered for this deposit before
 * then, and "It did not go through" only after it.
 */
const routeWaiting = (time: string) =>
  `Another transaction from your wallet went out in place of the Uniswap swap this page offered, and your wallet may still be showing that swap: reject it there if it is. It can go through only until ${time}, so no new swap is offered for this deposit before then. After ${time}, press Create position again.`
/**
 * Fix round 3.2: a swap the wallet signed, its hash back, that the chain does not show, its nonce still free: it may still
 * reach the network until its deadline. Only this pool's one-token deposit waits (a both-token deposit takes the nonce).
 */
const routeUnseen = (time: string) =>
  `Your wallet signed the Uniswap swap, and the network does not show it yet. It can still go through until ${time}, so no new swap is offered for this deposit before then. Check your wallet activity. You can still deposit both tokens; after ${time}, press Create position again.`
/** Fix round 3.2: a swap offered with no hash back, its nonce taken, not told apart, kept before deadlines were (no time to say). */
const ROUTE_UNANSWERED_UNKNOWN = 'Another transaction from your wallet went out in place of the Uniswap swap this page offered, and we could not confirm whether the swap went through. Check your wallet activity, then press Create position to continue with the tokens now in your wallet. No new swap is sent on its own.'
/** Fix round 3.2: either of those, once its deadline has passed with nothing proven: the person checks their wallet. */
const ROUTE_UNCONFIRMED_LATE = 'We could not confirm whether the Uniswap swap this page offered went through, and it can no longer go through now. Check your wallet activity, then press Create position to continue with the tokens now in your wallet. No new swap is sent on its own.'
/** Fix round 3.2: why the Uniswap route is not offered here, said after the pool's own reason when only that route could serve the deposit. */
const routeBlocked = (block: RouteBlock) => block.kind === 'held'
  ? `The Uniswap swap you said you rejected could still go through until ${block.until === null ? 'its deadline' : timeOfDay(block.until)} if your wallet still shows it, so no new Uniswap swap is offered before then.`
  : block.until === null
    ? 'An earlier Uniswap swap, for a deposit in another pool, is not settled yet, so no new Uniswap swap is offered here. Return to that pool and press Create position there.'
    : `An earlier Uniswap swap, for a deposit in another pool, could still go through until ${timeOfDay(block.until)}, so no new Uniswap swap is offered here before then.`
/**
 * Fix round 3 (2026-10-01): a later press on a one-token deposit while the journal holds a replaced swap nothing could
 * tell apart. It used to say the earlier swap completed (route_use_balances), which may be false, and held every
 * one-token deposit of this wallet in this browser for good. The person checks their wallet activity, and only their own
 * word lets the journal go (the button below the notice), after which a fresh quote is reviewed before anything is signed.
 * Changed on purpose in fix round 3.1: it says what this deposit needs ("more `missing` than your wallet holds now"),
 * never that the wallet holds none of it, which suggested the swap failed when it may have paid some of it.
 */
const routeUnconfirmed = (missing: string) =>
  `We could not confirm whether your earlier Uniswap swap went through. Check your wallet activity. If it went through, what you received is in your wallet, and this deposit needs more ${missing} than your wallet holds now: go back and lower the amount, or add ${missing}. If it did not go through, say so below to get a new quote; you review it before anything is signed.`
/**
 * Fix round 3.1: the same press, after a replacement following which the chain shows the wallet used Uniswap otherwise
 * (its Permit2 allowance set again, spent by another amount, or signed again). That may be the swap: no way to a new
 * quote is offered, and the deposit is made from the wallet's balances.
 */
const routeChanged = (missing: string, time?: string) => time === undefined
  ? `We could not confirm whether your earlier Uniswap swap went through, and the chain shows your wallet used Uniswap since, so no new swap is offered for this deposit. Check your wallet activity. This deposit needs more ${missing} than your wallet holds now: go back and lower the amount, or add ${missing}.`
  // Fix round 3.2: no longer for good. Once the router call's deadline has passed it can never go through, and the person
  // may then say it did not (routeUnconfirmed).
  : `We could not confirm whether your earlier Uniswap swap went through, and the chain shows your wallet used Uniswap since. It can go through only until ${time}, so no new swap is offered for this deposit before then. Check your wallet activity. This deposit needs more ${missing} than your wallet holds now: go back and lower the amount, or add ${missing}.`
/**
 * Fix round 3.1: a routed swap offered to the wallet whose hash never came back, its nonce still free on chain with
 * nothing pending. The wallet may still be showing it; "I rejected it in my wallet" lets its journal go (forgetRequest).
 * Changed on purpose in fix round 3.2: it may be another tab's offer, and closing a dialog on this screen does not reject
 * a request a phone wallet still shows, so it says neither "this page" nor "closed".
 */
const ROUTE_REQUEST_OPEN = 'Your wallet may still be showing a Uniswap swap that Domino offered, in this tab or another. Approve or reject it there. If you rejected it there, say so below.'
/** A time on the chain's clock (seconds), in the person's own time of day. */
const timeOfDay = (seconds: number) => new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(seconds * 1000 + 60_000))
/** This page's sentences for the setup client's codes whose shared sentence names a control it does not have. */
const OWN_TEXT: Readonly<Record<string, string>> = {
  native_gas_reserve_insufficient: 'Keep some ETH for network gas: your ETH does not cover this step. Lower the ETH amount or add ETH.',
  native_eth_refused: "Your wallet can't receive ETH right now: its smart-account delegation (EIP-7702) refuses plain ETH, so unused ETH could not come back from this deposit. Change or turn off that delegation in your wallet, then try again. Nothing was sent.",
  gas_budget_exceeded: 'This step needs more gas than expected. Try again in a moment.',
  invalid_gas_budget: 'The network’s gas price could not be used. Try again in a moment.',
  // Changed on purpose 2026-10-01 (audit C2): said only when the chain shows a transaction of this wallet still pending;
  // it used to be said, too, for a request this page offered and never heard back from, which no wallet can cancel.
  pending_wallet_transaction: 'Your wallet has a transaction waiting to go through. Let it finish, then press Create position again.',
  wallet_request_open: 'Your wallet may still be showing an earlier request from this page. Approve or reject it there. If you already rejected or closed it, say so below.',
  wallet_rpc_unreachable: 'Your wallet can’t reach Robinhood Chain right now. Check the network’s RPC in your wallet, then press Create position again. Nothing was sent.',
  wallet_review_expired: 'The step took too long to reach your wallet. Press Create position again.',
  wallet_review_required: 'The step took too long to reach your wallet. Press Create position again.',
  setup_release_expired: 'The deployment profile expired. Reload the page and try again.',
  invalid_mint_limits: 'The position could not be sized at the pool’s price now. Press Create position again.',
  invalid_swap_budget: 'The swap could not be sized from your deposit. Press Create position again.',
  swap_output_insufficient: 'The swap would return too little at your slippage limit. Press Create position again, or raise the slippage limit.',
  pool_not_initialized: 'This pool has no price on chain yet, so a position cannot be created in it here.',
  // The press checked the account's delegate a moment before; the deposit's own check read another one.
  delegate_unrecognized: 'Your account’s smart-account contract (EIP-7702) changed while the deposit was prepared. Nothing was sent. Press Create position again.',
  batch_upgrade_declined: 'You declined turning on your wallet’s smart account. Nothing was deposited. Press Create position to go step by step, or sign all steps at once again.',
  batch_state_changed: 'Another deposit was opened from this wallet meanwhile. Nothing was sent. Press Create position again.',
  batch_simulation_reverted: 'The batch would fail at the pool’s price now. Nothing was sent. Press Create position again.',
  batch_coordination_unavailable: 'This browser cannot keep track of a batch here. Nothing was sent. Press Create position to go step by step.',
  invalid_simulation_reply: 'The batch could not be checked just now. Nothing was sent. Try again in a moment.',
}
/**
 * Said before anything is read or asked when the account's EIP-7702 delegate is not one this app recognizes
 * (finance/delegates.ts): its code runs on everything the account holds. The person continues only by confirming it.
 */
const unrecognizedText = (delegate: Address) =>
  `Your account runs a smart-account contract (EIP-7702) that Domino does not recognize: ${delegate}. That code can move everything the account holds, including the position this would create. Nothing was sent. Continue only if you set up this smart account in your wallet yourself.`
const decimalsOf = (token: PoolOption['currencies'][number]) => (token.origin === 'read' ? token.decimals : null)
const symbolOf = (token: PoolOption['currencies'][number]) => token.symbol ?? 'token'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const units = (raw: bigint, token: PoolOption['currencies'][number]) => formatUnits(String(raw), decimalsOf(token))?.text ?? String(raw)
const ethText = (wei: bigint) => formatUnits(String(wei), 18)?.text ?? String(wei)
/** The person's own refusal: 4001, WalletConnect's 5000, or a hardware wallet's words (finance/nonce.ts, audit C2). */
const isRejection = (error: unknown) => personRefused(error)

const poolKeyOf = (pool: PoolOption): PoolKey => ({
  currency0: pool.currencies[0].address as Address,
  currency1: pool.currencies[1].address as Address,
  fee: pool.feePips,
  tickSpacing: pool.tickSpacing,
  hooks: zeroAddress,
})
const sameKey = (key: PoolKey, pool: PoolOption) =>
  key.currency0.toLowerCase() === pool.currencies[0].address && key.currency1.toLowerCase() === pool.currencies[1].address && key.fee === pool.feePips && key.tickSpacing === pool.tickSpacing

/** What the position takes of each token at the pool's price as read: the typed amount and the one the range pairs with it. */
function needsOf(draft: SetupDraft): readonly [bigint, bigint] | null {
  const other = pairedAmount({ sqrtPriceX96: draft.pool.sqrtPriceX96, tickLower: draft.tickLower, tickUpper: draft.tickUpper, independent: draft.independent, amountRaw: draft.amountRaw })
  if (other.kind !== 'amount') return null
  const mine = BigInt(draft.amountRaw), theirs = BigInt(other.raw)
  return draft.independent === 0 ? [mine, theirs] : [theirs, mine]
}
/** The price the assisted swap may not cross: a partial fill reverts whole, so a thinner pool than this is said, never half-used. */
function swapLimit(sqrtPriceX96: bigint, zeroForOne: boolean, bps = SWAP_PRICE_LIMIT_BPS): bigint {
  if (zeroForOne) {
    const limit = (sqrtPriceX96 * (10000n - bps)) / 10000n
    return limit > MIN_SQRT_PRICE ? limit : MIN_SQRT_PRICE + 1n
  }
  const limit = (sqrtPriceX96 * (10000n + bps)) / 10000n
  return limit < MAX_SQRT_PRICE ? limit : MAX_SQRT_PRICE - 1n
}

/** A stop with its sentence; `code` is what the notice carries (data-create-notice). */
class Stop extends Error {
  constructor(
    readonly text: string,
    code = 'create_position_stopped',
  ) {
    super(code)
  }
}

/** A thrown error in the words of this page. `held` says whether a deposit is waiting for its mint. */
function failureText(error: unknown, held: boolean, fallback: string): { text: string; code: string | null } {
  const code = errorCode(error)
  if (error instanceof Stop) return { text: error.text, code }
  if (isRejection(error))
    return { text: held ? 'You declined in your wallet. Your deposit is held: press Create position to continue, or refund it.' : 'You declined in your wallet. Nothing was deposited. Press Create position to continue.', code }
  if (code && Object.hasOwn(OWN_TEXT, code)) return { text: OWN_TEXT[code], code }
  return { text: financeErrorText(code, fallback, 'Create position'), code }
}

/**
 * `reviewed` is Review's reading of how the wallet funds these choices, from
 * the balances the read service reported (lib/create/reviewPlan.ts): while it
 * says the wallet cannot fund them either way, the line under the button says
 * so. Create position itself reads the wallet again and decides from what it
 * finds.
 */
export default function CreatePosition({ state, reviewed = null, onBusy }: { state: JourneyState; reviewed?: DepositPlan | null; onBusy?: (busy: boolean) => void }) {
  const identity = useWalletIdentity()
  const draft = setupDraft(state)
  const [phase, setPhase] = useState<Phase>('idle')
  const [notice, setNotice] = useState<{ text: string; code: string | null } | null>(null)
  const [held, setHeld] = useState<Open | null>(null)
  // The held deposit cannot be used in this pool as it is now: the refund is the one main action.
  const [refundFirst, setRefundFirst] = useState(false)
  // The account's unrecognized delegate the last press stopped at, until the person confirms it or presses again.
  const [unrecognized, setUnrecognized] = useState<{ owner: Address; delegate: Address } | null>(null)
  // The replaced routed swap the last press could not tell apart (fix round 3), until the person says it did not go through or presses again.
  const [unconfirmed, setUnconfirmed] = useState<{ owner: string; claim: string } | null>(null)
  // The routed swap offered to the wallet with no hash back, its nonce still free (fix round 3.1), until the person says
  // they rejected it or presses again.
  // Fix round 3.2: with the router call's deadline, until which a new Uniswap route waits once the person says so.
  const [openRoute, setOpenRoute] = useState<{ owner: string; claim: string; nonce: bigint; deadline: bigint | null } | null>(null)
  // What the connected wallet can do with a batch (EIP-5792): null until read, for this wallet only.
  const [atomic, setAtomic] = useState<AtomicStatus | null>(null)
  // The wallet is being asked to switch to (or add) Robinhood Chain from this button (2026-10-01, audit C1).
  const [switching, setSwitching] = useState(false)
  const generation = useRef(0)
  const running = useRef(false)
  // Whether the last press asked for one signature (a batch): its line says so, and a confirmation that runs the press again keeps it.
  // 2026-09-28 (review): false again as soon as that press goes on step by step (a held deposit's mint, a batch the wallet
  // refused or no simulation could check), so the line never says "one signature" while the wallet asks for each step.
  const [batching, setBatching] = useState(false)
  const steps = useRef<readonly LiveStep[]>([])
  const quote = useRef<RouteQuote | null>(null)
  const reviewedRoute = useRef<string | null>(null)
  const routeAbort = useRef<AbortController | null>(null)
  const continuation = useRef<RouteContinuation | null>(null)
  const pendingAtomic = useRef<{ claim: string; offered: () => boolean } | null>(null)
  const recoverySeen = useRef<string | null>(null)
  const routeFallback = useRef<string | null>(null)
  // Another wallet or network: whatever was prepared or held for the previous one no longer applies.
  const wallet = walletKey(identity)
  const [seenWallet, setSeenWallet] = useState(wallet)
  if (seenWallet !== wallet) {
    setSeenWallet(wallet)
    setPhase('idle')
    setNotice(null)
    setHeld(null)
    setRefundFirst(false)
    setUnrecognized(null)
    setUnconfirmed(null)
    setOpenRoute(null)
    setAtomic(null)
  }
  // The previous wallet's flow, if one was running, writes nothing more, and Review shows its plan again.
  useEffect(() => {
    generation.current++
    running.current = false
    steps.current = []
    publishCreateProgress(null)
    publishCreated(null)
    routeAbort.current?.abort()
    quote.current = null
    reviewedRoute.current = null
    continuation.current = null
    pendingAtomic.current = null
    recoverySeen.current = null
    routeFallback.current = null
    publishRoutedReview(null)
  }, [wallet])
  useEffect(
    () => () => {
      generation.current++
      publishCreateProgress(null)
      publishCreated(null)
      routeAbort.current?.abort()
      publishRoutedReview(null)
    },
    [],
  )
  // Back stays put while the wallet is being asked: leaving Review would drop the flow mid-way.
  useEffect(() => {
    onBusy?.(phase === 'running')
  }, [phase, onBusy])
  useEffect(() => () => onBusy?.(false), [onBusy])
  // Whether this wallet executes a batch atomically now (`supported`), could once it turns on its smart account
  // (`ready`), or neither: asked of the wallet itself, once per wallet, and nothing is signed or sent for it.
  useEffect(() => {
    if (wallet === null) return
    let live = true
    setupWallet().then((rpc) => atomicStatus(rpc)).then(
      (status) => { if (live) setAtomic(status) },
      () => { if (live) setAtomic('unsupported') },
    )
    return () => { live = false }
  }, [wallet])
  // Review's list of wallet steps shows the one signature as soon as it is known (2026-09-28), for this wallet only:
  // null again for another wallet, until it is read, and once this control leaves the page.
  useEffect(() => {
    publishBatchAbility(wallet === null ? null : atomic)
  }, [wallet, atomic])
  useEffect(() => () => publishBatchAbility(null), [])

  const ready = draft !== null
  const needs = draft ? needsOf(draft) : null
  const connected = wallet !== null
  const onOtherNetwork = identity.kind === 'connected' && wallet === null

  /** Review's list of wallet steps, as this run has them. Until the run knows them, Review keeps showing its own plan. */
  function show(next: readonly LiveStep[], gen: number) {
    if (generation.current !== gen) return
    steps.current = next
    publishCreateProgress(next.length > 0 ? next : null)
  }
  /** Moves one step on; a step already done stays done unless `again` (a second signature under the same step). */
  function mark(key: string, next: LiveState, gen: number, again = false) {
    show(steps.current.map((step) => (step.key === key && (again || step.state !== 'done') ? { ...step, state: next } : step)), gen)
  }
  function stopAt(gen: number) {
    show(steps.current.map((step) => (step.state === 'reading' || step.state === 'wallet' || step.state === 'chain' ? { ...step, state: 'failed' } : step)), gen)
  }

  /** What a revert of this step means for the deposit. */
  const revertText = (key: string) =>
    key === 'mint'
      ? 'The mint reverted on chain: your deposit is still held. Press Create position to try again, or refund it.'
      : key === 'swap'
        ? 'The swap reverted on chain: your deposit is still held, unswapped. Press Create position to try again, or refund it.'
        : key === 'refund'
          ? 'The refund reverted on chain: your deposit is still held. Try the refund again.'
          : key === 'fund'
            ? 'The deposit reverted on chain: nothing was deposited, only network gas was spent. Press Create position to try again.'
            : 'The approval reverted on chain: nothing was deposited. Press Create position to try again.'

  /** Stops this run, saying nothing, once the page was left or the wallet changed since it started: the wallet is asked nothing more. */
  function stillHere(gen: number) {
    if (generation.current !== gen) throw new Stop('')
  }

  /**
   * Offers one prepared step to the wallet once, then waits for its receipt. Throws on a revert or a reorg. `replaced`:
   * the wallet replaced the transaction ("Speed up" or "Cancel": the chain does not know its hash and the account's
   * nonce has passed it; 2026-10-01, audit C14), so the caller reads the state again to know whether the step happened.
   * It used to be watched as pending for five minutes.
   */
  async function sendAndWait(client: Client, step: PreparedSetup, key: string, gen: number): Promise<'included' | 'replaced'> {
    // The step may have been prepared after a long check: no prompt opens on a page that was left meanwhile.
    stillHere(gen)
    mark(key, 'wallet', gen)
    const hash = await client.send(step, true)
    mark(key, 'chain', gen)
    const until = Date.now() + RECEIPT_WAIT_MS
    for (;;) {
      await sleep(RECEIPT_EVERY_MS)
      if (generation.current !== gen) throw new Stop('')
      const receipt = await client.receipt(hash, step.operationId ?? undefined)
      if (receipt.state === 'included' || receipt.state === 'finalized') break
      if (receipt.state === 'replaced') {
        mark(key, 'waiting', gen, true)
        return 'replaced'
      }
      if (receipt.state === 'reverted') throw new Stop(revertText(key))
      if (receipt.state === 'reorged') throw new Stop('The block that held the transaction left the chain. Check your wallet activity, then press Create position again.')
      if (Date.now() > until) throw new Stop('The transaction is still waiting to be included. Check your wallet activity, then press Create position again: nothing is sent twice.')
    }
    mark(key, 'done', gen)
    return 'included'
  }

  /** The operation as the chain has it now, read again a few times while the node catches up with a receipt. */
  async function settledOperation(client: Client, id: Hex, done: (operation: SetupOperation) => boolean): Promise<SetupOperation> {
    let operation = await client.inspect(id)
    for (let tries = 0; tries < 5 && !done(operation); tries++) {
      await sleep(RECEIPT_EVERY_MS)
      operation = await client.inspect(id)
    }
    return operation
  }

  /**
   * A deposit the wallet replaced ("Speed up" or "Cancel", audit C14), read back from the chain: a sped-up deposit opened
   * its operation, a cancelled one never did. The setup contract reads an operation never opened with the zero owner,
   * which inspect refuses as not this wallet's: null. Read again a few times, as settledOperation does, so a node still
   * behind the replacement's block is not taken for a cancel.
   */
  async function replacedDeposit(client: Client, id: Hex): Promise<SetupOperation | null> {
    const read = () => client.inspect(id).then((value): SetupOperation | null => value, (error: unknown) => {
      if (errorCode(error) === 'operation_not_owned') return null
      throw error
    })
    let operation = await read()
    for (let tries = 0; tries < 5 && !(operation && (operation.balance0 > 0n || operation.balance1 > 0n)); tries++) {
      await sleep(RECEIPT_EVERY_MS)
      operation = await read()
    }
    return operation && (operation.balance0 > 0n || operation.balance1 > 0n) ? operation : null
  }

  /** The pool, the range, the fees and the slippage band the swap and the mint are sized with, at the price the chain reports now. */
  async function termsNow(client: Client, key: PoolKey, pool: PoolOption, settled: SetupDraft): Promise<PoolTerms> {
    return {
      sqrtPriceX96: await client.price(key),
      tickLower: settled.tickLower,
      tickUpper: settled.tickUpper,
      feePips: pool.feePips,
      assistedFeeBps: client.deployment.feeBps,
      slippageBps: settled.slippageBps,
    }
  }

  /** Takes a step off Review's list: the run found it is not needed. */
  function drop(key: string, gen: number) {
    if (steps.current.some((step) => step.key === key)) show(steps.current.filter((step) => step.key !== key), gen)
  }

  /**
   * The assisted swap, when the deposit holds only one token and the range needs the other too: part of it for
   * the other, sized from the contract's own quotes so the position it leaves is the largest (lib/create/depositPlan.ts
   * sizeSwap). Once per deposit. True when a swap was sent and included.
   *
   * Fixed 2026-09-28 (one-sided): a deposit that already makes the position as it is (one token for a range that takes
   * it alone, its edge touching the price included) is never swapped: the mint's band stays on that side of the range
   * (lib/create/mintPlan.ts). The study found a range whose edge touched the price swapping about 1% of the deposit, a
   * swap Review had not shown. `allowed`: whether this press planned a swap; one that did not sends none.
   */
  async function swapIfNeeded(client: Client, key: PoolKey, gas: GasBudget, open: Open, gen: number, allowed: boolean): Promise<boolean> {
    if (!draft) throw new Stop('')
    const operation = await client.inspect(open.id)
    if (operation.swapped) {
      drop('swap', gen)
      return false
    }
    const terms = await termsNow(client, key, draft.pool, draft)
    const asHeld = mintPlanFor({
      sqrtPriceX96: String(terms.sqrtPriceX96),
      tickLower: draft.tickLower,
      tickUpper: draft.tickUpper,
      balance0: operation.balance0,
      balance1: operation.balance1,
      slippageBps: draft.slippageBps,
    })
    if (asHeld) {
      drop('swap', gen)
      return false
    }
    const [needs0, needs1] = needsSides(terms)
    const from: Side | null = needs1 && operation.balance1 === 0n && operation.balance0 > 0n ? 0 : needs0 && operation.balance0 === 0n && operation.balance1 > 0n ? 1 : null
    if (from === null) {
      drop('swap', gen)
      return false
    }
    if (!allowed) throw new Stop(INTO_RANGE, 'range_needs_both')
    if (!steps.current.some((step) => step.key === 'swap')) {
      const at = steps.current.findIndex((step) => step.key === 'mint')
      const swapStep: LiveStep = { key: 'swap', title: CREATE.review.swapStep, state: 'waiting' }
      show(at < 0 ? [...steps.current, swapStep] : [...steps.current.slice(0, at), swapStep, ...steps.current.slice(at)], gen)
    }
    mark('swap', 'reading', gen)
    // A clock far off the chain's makes every quote and swap revert: said as itself, before anything is quoted, and the
    // wallet is asked nothing. A pool with nothing in range at its price may still fill the swap in a range the price
    // reaches, so the contract's quotes decide; the in-range liquidity only picks the sentence when no size fills.
    const onChain = await client.poolState(key)
    if (Math.abs(Date.now() / 1000 - onChain.chainTime) > CLOCK_SKEW_S) throw new Stop(PREFLIGHT.heldClock, 'device_clock_off')
    const balance = from === 0 ? operation.balance0 : operation.balance1
    const zeroForOne = from === 0
    const limit = swapLimit(terms.sqrtPriceX96, zeroForOne)
    // Each size asked is the swap simulated by the contract through the wallet; a size it refuses is too large for this pool.
    const sized = await sizeSwap(terms, from, balance, async (gross) => {
      stillHere(gen)
      try {
        return await client.quoteSwap(open.id, zeroForOne, gross, limit)
      } catch (error) {
        if (isRevert(error)) return null
        throw error
      }
    })
    if (!sized)
      throw onChain.liquidity === 0n
        ? new Stop(PREFLIGHT.held, 'held_pool_no_liquidity')
        : new Stop('This pool is too thin to swap part of your deposit within a 10% price move. Your deposit is held: refund it, then try a smaller amount.')
    // What the mint would make after this swap, at the price it leaves: nothing is swapped for a position that cannot follow.
    const kept = balance - sized.gross
    const after = mintPlanFor({
      sqrtPriceX96: String(sized.sqrtPriceX96),
      tickLower: draft.tickLower,
      tickUpper: draft.tickUpper,
      balance0: from === 0 ? kept : sized.output,
      balance1: from === 0 ? sized.output : kept,
      slippageBps: draft.slippageBps,
    })
    if (!after) throw new Stop('After the swap, your deposit would make no position in this range. Nothing was swapped: refund the deposit, or go back and widen the range.')
    const step = await client.swap(open.id, zeroForOne, sized.gross, draft.slippageBps, limit, gas)
    if ((await sendAndWait(client, step, 'swap', gen)) === 'replaced') {
      // Replaced in the wallet: a sped-up swap did swap; a cancelled one did not, and nothing is offered again for it.
      const now = await settledOperation(client, open.id, (value) => value.swapped)
      if (!now.swapped) throw new Stop(REPLACED.swap, 'transaction_replaced')
      mark('swap', 'done', gen)
    }
    return true
  }

  /**
   * Before anything is approved or deposited for one token alone: whether this pool can swap part of it, read through
   * the wallet. The device clock against the chain's (the swap carries a deadline drawn from it), then the swap sized
   * as it will be after the deposit, each size quoted by Uniswap's V4Quoter and refused when the pool cannot fill it or
   * it would end past the swap's price limit less a margin, and the position that swap leaves. The quotes decide: a
   * pool with nothing in range at its price may fill the swap in a range the price reaches, and its in-range
   * liquidity only picks the sentence when no size fills. Any doubt stops here, with nothing deposited; after the
   * deposit, the setup contract's own quotes still size the swap that is sent (swapIfNeeded).
   */
  async function swapPreflight(client: Client, key: PoolKey, settled: SetupDraft, from: Side, deposit: bigint, gen: number): Promise<{ sized: SwapSize; price: bigint } | null> {
    mark('swap', 'reading', gen)
    let checked: { sized: SwapSize; price: bigint } | null = null
    try {
      const onChain = await client.poolState(key)
      const terms: PoolTerms = {
        sqrtPriceX96: onChain.sqrtPriceX96,
        tickLower: settled.tickLower,
        tickUpper: settled.tickUpper,
        feePips: settled.pool.feePips,
        assistedFeeBps: client.deployment.feeBps,
        slippageBps: settled.slippageBps,
      }
      // The range takes only the token deposited: nothing will be swapped, so there is nothing to check.
      if (!needsSides(terms)[from === 0 ? 1 : 0]) {
        mark('swap', 'waiting', gen)
        return null
      }
      if (Math.abs(Date.now() / 1000 - onChain.chainTime) > CLOCK_SKEW_S) throw new Stop(PREFLIGHT.clock, 'device_clock_off')
      const zeroForOne = from === 0
      const check = swapLimit(onChain.sqrtPriceX96, zeroForOne, SWAP_PRICE_LIMIT_BPS - SWAP_CHECK_MARGIN_BPS)
      const fee = swapFeePips(onChain.lpFee, onChain.protocolFee, zeroForOne)
      const sized = await sizeSwap(terms, from, deposit, quoteWithin(terms.assistedFeeBps, zeroForOne, fee, check, (net, step) => {
        stillHere(gen)
        return client.quotePool(key, zeroForOne, net, step)
      }))
      if (!sized) throw onChain.liquidity === 0n ? new Stop(PREFLIGHT.noLiquidity, 'pool_no_liquidity') : new Stop(PREFLIGHT.tooThin, 'pool_too_thin')
      const kept = deposit - sized.gross
      const after = mintPlanFor({
        sqrtPriceX96: String(sized.sqrtPriceX96),
        tickLower: settled.tickLower,
        tickUpper: settled.tickUpper,
        balance0: from === 0 ? kept : sized.output,
        balance1: from === 0 ? sized.output : kept,
        slippageBps: settled.slippageBps,
      })
      if (!after) throw new Stop(PREFLIGHT.noPosition, 'swap_makes_no_position')
      checked = { sized, price: onChain.sqrtPriceX96 }
    } catch (error) {
      if (error instanceof Stop) throw error
      const code = errorCode(error)
      // A pool with no price has its own sentence (OWN_TEXT), and so does a wallet that cannot reach the chain; anything
      // else unread is a check that did not happen.
      if (code === 'pool_not_initialized' || code === 'wallet_rpc_unreachable' || code === 'site_reads_unavailable') throw error
      throw new Stop(code === 'quoter_identity_changed' ? PREFLIGHT.quoter : PREFLIGHT.unchecked, code ?? 'pool_check_unavailable')
    }
    mark('swap', 'waiting', gen)
    return checked
  }

  /**
   * Create position in one signature (EIP-5792; docs/plans/2026-09-25-eip5792-batches-design.md): the approvals, the
   * deposit, a one-token deposit's swap and the mint as one batch the wallet executes whole or not at all. The swap is
   * the size the preflight's quotes found, asking at least the owner's slippage limit of its output; the mint is sized
   * for that least, at the price the quotes say the swap leaves, and returns the rest. Null: this wallet cannot make
   * or simulate the batch after all, and the same press goes on step by step.
   */
  async function createInOneBatch(client: Client, gas: GasBudget, key: PoolKey, settled: SetupDraft, plan: DepositPlan, funding: readonly [bigint, bigint],
    checked: { sized: SwapSize; price: bigint } | null, gen: number): Promise<{ tokenId: bigint } | { held: Open } | null> {
    // A batch this page or another tab offered for this very operation, its outcome not known yet: watched, never offered twice.
    const waiting = await client.offeredBatch()
    if (waiting) {
      mark('batch', 'chain', gen)
      return watchBatch(client, waiting.id, waiting.operationId, gen)
    }
    let swap: BatchPlan['swap'] = null
    let balances: readonly [bigint, bigint] = funding
    let price = await client.price(key)
    if (plan.kind === 'swap' && checked) {
      const zeroForOne = plan.from === 0
      const minOutput = (checked.sized.output * BigInt(10_000 - settled.slippageBps)) / 10_000n
      if (minOutput <= 0n) throw new Stop(PREFLIGHT.tooThin, 'swap_output_insufficient')
      swap = { zeroForOne, gross: checked.sized.gross, minOutput, sqrtLimit: swapLimit(checked.price, zeroForOne) }
      const kept = plan.deposit - checked.sized.gross
      balances = zeroForOne ? [kept, minOutput] : [minOutput, kept]
      price = checked.sized.sqrtPriceX96
    }
    const minted = mintPlanFor({ sqrtPriceX96: String(price), tickLower: settled.tickLower, tickUpper: settled.tickUpper, balance0: balances[0], balance1: balances[1], slippageBps: settled.slippageBps })
    if (!minted) throw new Stop(PREFLIGHT.noPosition, 'swap_makes_no_position')
    stillHere(gen)
    let prepared: PreparedBatch | null = null
    try {
      prepared = await client.prepareBatch({ key, amount0: funding[0], amount1: funding[1], swap, mint: { tickLower: settled.tickLower, tickUpper: settled.tickUpper, ...minted } }, gas)
    } catch (error) {
      if (errorCode(error) === 'batch_simulation_unavailable') return null
      throw error
    }
    stillHere(gen)
    mark('batch', 'wallet', gen)
    let id = ''
    try {
      id = await client.sendBatch(prepared, true)
    } catch (error) {
      if (errorCode(error) !== 'batch_unsupported') throw error
      if (generation.current === gen) setAtomic('unsupported')
      return null
    }
    mark('batch', 'chain', gen)
    return watchBatch(client, id, prepared.operationId, gen)
  }

  /** A sent batch, read every two seconds for five minutes at most, until the operation it opened holds the position or cannot. */
  async function watchBatch(client: Client, id: string, operationId: Hex, gen: number): Promise<{ tokenId: bigint } | { held: Open }> {
    const until = Date.now() + RECEIPT_WAIT_MS
    for (let beat = 0; ; beat++) {
      if (generation.current !== gen) throw new Stop('')
      let read: BatchState | null = null
      try {
        read = await client.batchStatus(id, operationId)
      } catch (error) {
        // A read that fails (a busy wallet, a node behind) is read again at the next beat, to the end of the watch.
        if (Date.now() > until) throw error
      }
      if (read?.state === 'created') {
        mark('batch', 'done', gen)
        return { tokenId: read.tokenId }
      }
      if (read?.state === 'held') return { held: { id: operationId, operation: await client.inspect(operationId) } }
      if (read?.state === 'dropped') throw new Stop(BATCH.dropped, 'batch_dropped')
      if (read?.state === 'reverted') throw new Stop(BATCH.reverted, 'batch_reverted')
      if (read?.state === 'unknown') throw new Stop(BATCH.unknown, 'batch_unknown')
      if (Date.now() > until) throw new Stop(BATCH.waiting, 'batch_waiting')
      await sleep(RECEIPT_EVERY_MS)
    }
  }

  /** `swapAllowed`: whether a swap may be sent for this deposit: one this press planned, or a deposit an earlier press left held. */
  async function mintFrom(client: Client, key: PoolKey, gas: GasBudget, open: Open, gen: number, swapAllowed: boolean): Promise<bigint> {
    if (!draft) throw new Stop('')
    const swapped = await swapIfNeeded(client, key, gas, open, gen, swapAllowed)
    // The node may answer a moment behind the receipt: the mint is sized on the balances the swap left, never on the ones before it.
    const operation = await settledOperation(client, open.id, (value) => (!swapped || value.swapped) && (value.balance0 > 0n || value.balance1 > 0n))
    if (swapped && !operation.swapped) throw new Stop('The swap was included, and your deposit is still being read back. Press Create position again in a moment: nothing is swapped twice.')
    const sqrtPriceX96 = await client.price(key)
    const plan = mintPlanFor({ sqrtPriceX96: String(sqrtPriceX96), tickLower: draft.tickLower, tickUpper: draft.tickUpper, balance0: operation.balance0, balance1: operation.balance1, slippageBps: draft.slippageBps })
    if (!plan) throw new Stop('At the pool’s price now, the deposit makes no position in this range. Refund it, or go back and widen the range.')
    const step = await client.mint(open.id, { tickLower: draft.tickLower, tickUpper: draft.tickUpper, ...plan }, gas)
    const minted = await sendAndWait(client, step, 'mint', gen)
    const done = await settledOperation(client, open.id, (value) => value.closed && value.tokenId > 0n)
    if (!done.closed || done.tokenId === 0n) throw minted === 'replaced' ? new Stop(REPLACED.mint, 'transaction_replaced') : new Stop('The mint was included, and the position is still being read back. Press Create position again in a moment: nothing is deposited twice.')
    if (minted === 'replaced') mark('mint', 'done', gen)
    return done.tokenId
  }

  async function connectClient(): Promise<{ client: Client; rpc: WalletRpc; gas: GasBudget }> {
    const live = await readSetupRelease()
    if (live.kind !== 'available') throw new Stop('The deployment could not be confirmed just now. Nothing was sent. Try again in a moment.')
    const rpc = await setupWallet()
    const client = createSetupClient(rpc, live.deployment, () => Date.now() / 1000, currentSetupDeployment, {
      simulate: simulateOnChain, validateRoute,
      routeAuthorized: () => quote.current !== null && routeCurrent(quote.current),
    })
    const gas = await suggestGasBudget(rpc)
    saveSetupProfile(live.deployment)
    return { client, rpc, gas }
  }

  /** Called at Create, not while typing. A new route is shown in the existing Review
   * before the same button may offer it to the wallet. Session/epoch and the short
   * monotonic quote lifetime are checked again immediately before each offer. */
  async function chooseRoute(rpc: WalletRpc, key: PoolKey, settled: SetupDraft, from: Side, gross: bigint, deposit: bigint, batch: boolean, gen: number, refresh = false): Promise<RouteQuote | null> {
    const request = { chainId: 4663, poolId: settled.pool.key, poolKey: { currency0: key.currency0, currency1: key.currency1, fee_pips: key.fee, tick_spacing: key.tickSpacing, hooks: zeroAddress }, tokenIn: from === 0 ? key.currency0 : key.currency1, amountRaw: String(gross), slippageBps: settled.slippageBps }
    let selected = quote.current
    const sameRequest = selected && selected.preview.request.owner.toLowerCase() === rpc.owner.toLowerCase()
      && selected.preview.request.poolId === request.poolId && selected.preview.request.tokenIn === request.tokenIn
      && selected.preview.request.amountRaw === request.amountRaw && selected.preview.request.slippageBps === request.slippageBps
    if (refresh || !selected || !sameRequest || !routeCurrent(selected)) {
      routeAbort.current?.abort()
      const abort = new AbortController()
      routeAbort.current = abort
      const result = await lookupRoute(request, rpc.owner, abort.signal)
      stillHere(gen)
      if (!result.ok) {
        quote.current = null
        publishRoutedReview(null)
        if (result.reason === 'aborted') throw new Stop('The wallet session changed. Press Create position again.', 'route_session_changed')
        return null
      }
      selected = result
      quote.current = result
    }
    if (selected.preview.decision !== 'uniswap' || !selected.preview.uniswap) {
      publishRoutedReview(null)
      if (selected.preview.pool.amountOutRaw === '0') throw new Stop(PREFLIGHT.noLiquidity, 'pool_no_liquidity')
      return null
    }
    const p = selected.preview, u = p.uniswap!
    const terms = routedTermsKey(p, deposit) + (batch ? '|atomic' : '|sequential')
    publishRoutedReview({ from, gross: p.request.amountRaw, totalInput: String(deposit), output: u.amountOutRaw, minimum: u.minimumAmountOutRaw,
      fee: u.feeRaw, advantageBps: p.advantageBps, priceImpact: u.priceImpactPercent, poolUnfilled: p.pool.amountOutRaw === '0', sequential: !batch })
    if (reviewedRoute.current !== terms) {
      reviewedRoute.current = terms
      show([], gen)
      throw new Stop(batch ? 'A better Uniswap route is ready. Review the updated amounts and fee, then press Create position to confirm.'
        : 'A better Uniswap route is ready. Review the amounts and steps, then press Create position. If you stop after the swap, its tokens remain in your wallet; the swap and fee are not undone.', 'route_review_required')
    }
    return selected
  }

  /** Confirm a prior router transaction without relying on stored financial data.
   * A reload cannot restart its swap; it can only use a new both-token deposit.
   * `pool`: the pool this press is for; its tokens are the ones a replaced swap's input may be (fix round 3: the journal
   * keeps no address). Says what the record is known to have done (RouteOutcome). `here` (fix round 3.1): whether the
   * record is known to be this pool's (its pool digest; a record without one counts as this pool's, as before).
   *
   * Fix round 3.1: a swap offered to the wallet whose hash never came back (a signer slower than the signing window, a
   * reload while the wallet showed it, an answer that is not a hash) keeps its nonce with its claim: once that nonce has
   * passed on chain, what took it is told apart as for a replaced swap (it may be the swap itself); while it is still free
   * with nothing pending, the person may say they rejected it (forgetRequest). It used to hold every later press of the
   * wallet in this browser, both-token deposits too, for good. A record kept before nonces were stays as it was.
   *
   * Fix round 3.2: a swap signed with its hash back that the chain does not show, its nonce still free, may still reach
   * the network until its router deadline: it waits for that (`unseen`), holding up only this pool's one-token deposit
   * and the Uniswap route, where it used to stop every press in every pool. The first press that finds a record for this
   * pool's deposit says what it did (`told`); a record for another pool's deposit is settled apart (settleElsewhere). */
  async function assessRoute(rpc: WalletRpc, record: RouteRecord, pool: PoolOption, here: boolean, gen: number): Promise<Recovered> {
    const owner = rpc.owner.toLowerCase()
    const deadline = record.evidence?.deadline ?? null
    if (!record.hash) {
      if (record.nonce === undefined || record.nonce === null) throw new Stop('A Uniswap swap was already offered to your wallet and its outcome is unknown. Check wallet activity before continuing; Domino will not offer it again.', 'route_outcome_unknown')
      await unansweredRoute(rpc, record.claim, record.nonce, deadline, gen)
      return replacedOutcome(rpc, record, record.nonce, pool, here, 'unanswered', gen)
    }
    const [tx, receipt] = await Promise.all([
      rpc.request('eth_getTransactionByHash', [record.hash]), rpc.request('eth_getTransactionReceipt', [record.hash]),
    ]) as [{ from?: string; to?: string; hash?: string; blockHash?: string; input?: string } | null, { transactionHash?: string; blockHash?: string; blockNumber?: string; status?: string } | null]
    stillHere(gen)
    // A swap the wallet replaced has no transaction under its hash, ever: its nonce, kept beside it, passed on chain says
    // so (fix round 1). A record kept before nonces were (the release before) stays as it was: pending or unverified.
    if (!tx && !receipt && record.nonce !== undefined && record.nonce !== null) {
      if (await nonceReplaced(rpc, record.hash, record.nonce)) {
        stillHere(gen)
        return replacedOutcome(rpc, record, record.nonce, pool, here, 'replaced', gen)
      }
      // Fix round 3.2: nothing under the hash and the nonce still the next one, with nothing pending: the signed swap may
      // still reach the network until its deadline, and nothing proves it never will before then.
      if (deadline !== null && await nonceStanding(rpc, record.nonce) === 'open') {
        stillHere(gen)
        return lifetime(rpc, { outcome: 'unknown', why: 'unseen' }, deadline, gen)
      }
    }
    stillHere(gen)
    if (!receipt || !tx || tx.hash?.toLowerCase() !== record.hash || receipt.transactionHash?.toLowerCase() !== record.hash
      || tx.from?.toLowerCase() !== owner || tx.to?.toLowerCase() !== '0x204faca1764b154221e35c0d20abb3c525710498'
      || !receipt.blockNumber || !receipt.blockHash || tx.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase()
      // Fix round 3: where the journal kept the reviewed calldata's digest, the transaction under the hash must be it.
      || (record.evidence?.swap && (typeof tx.input !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.input) || swapDigest(tx.input as Hex) !== record.evidence.swap))) {
      throw new Stop('The earlier Uniswap swap is still pending or could not be verified. Check wallet activity; nothing is swapped again.', 'route_outcome_unknown')
    }
    const block = await rpc.request('eth_getBlockByNumber', [receipt.blockNumber, false]) as { hash?: string } | null
    stillHere(gen)
    if (block?.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Stop('The earlier swap’s block changed. Wait for its outcome to be confirmed; nothing is swapped again.', 'route_outcome_unknown')
    if (receipt.status === '0x0') {
      await routeJournal().release(owner, record.claim)
      throw new Stop('The earlier Uniswap swap reverted. No swap fee was collected; network gas was spent. Press Create position to try again.', 'route_reverted')
    }
    if (receipt.status !== '0x1') throw new Stop('The earlier swap’s outcome could not be verified. Nothing is swapped again.', 'route_outcome_unknown')
    return { outcome: 'swapped', why: 'mined' }
  }

  /**
   * A routed swap offered to the wallet with no hash back (fix round 3.1): where its nonce stands on chain. Passed: a
   * transaction took it (the swap itself, approved late, or anything else), and the caller tells it apart. Still free with
   * nothing pending: the wallet may still be showing it, and only the person's word lets its journal go (the "I rejected
   * it in my wallet" button, forgetRequest). Anything pending, or a node behind: said, and nothing is let go. `deadline`
   * (fix round 3.2): the router call's, until which a new Uniswap route waits once the person says so.
   */
  async function unansweredRoute(rpc: WalletRpc, claim: string, nonce: bigint, deadline: bigint | null, gen: number): Promise<void> {
    const standing = await nonceStanding(rpc, nonce)
    stillHere(gen)
    if (standing === 'passed') return
    if (standing === 'open') {
      if (generation.current === gen) setOpenRoute({ owner: rpc.owner.toLowerCase(), claim, nonce, deadline })
      throw new Stop(ROUTE_REQUEST_OPEN, 'wallet_request_open')
    }
    throw new Stop('A Uniswap swap was offered to your wallet, and its outcome is not on chain yet. Check your wallet activity, then press Create position again: nothing is swapped twice.', 'route_outcome_unknown')
  }

  /**
   * What took the nonce of a routed swap found again on a later press (fix rounds 2, 3 and 3.1), from what the journal
   * kept at the send, read through the wallet's own provider (none for a wallet that hands its reads to the site, which
   * serves none: `unknown`). One that did not swap lets the journal go; anything else is said once (`told`). `why` (fix round 3.2):
   * replaced in the wallet under its own hash, or offered with no hash back (a cancel at its nonce then proves nothing).
   */
  async function replacedOutcome(rpc: WalletRpc, record: RouteRecord, nonce: bigint, pool: PoolOption, here: boolean, why: 'replaced' | 'unanswered', gen: number): Promise<Recovered> {
    const reads = walletOwnReads(rpc)
    const found: ReplacementFinding = reads ? await routedReplacement(reads, rpc.owner, nonce, record.evidence ?? null,
      { tokens: pool.currencies.map((token) => token.address), thisPool: here && Boolean(record.evidence?.pool), unanswered: why === 'unanswered' }) : { kind: 'unknown' }
    stillHere(gen)
    if (found.kind === 'not_swapped' || found.kind === 'reverted') await routeReplaced(rpc.owner.toLowerCase(), record.claim, found.kind)
    return lifetime(rpc, recoveredOf(found, why), record.evidence?.deadline ?? null, gen)
  }

  /** A finding that did not let the journal go, as the page holds it. */
  function recoveredOf(found: ReplacementFinding, why: 'replaced' | 'unanswered'): Recovered {
    const outcome: RouteOutcome = found.kind === 'swapped' || found.kind === 'spent' || found.kind === 'untouched' || found.kind === 'changed' ? found.kind : 'unknown'
    return { outcome, why, until: found.until }
  }

  /**
   * Fix round 3.2: how long an outcome nothing told apart holds, from the router call's deadline (RouteEvidence.deadline)
   * on the chain's clock. Before it the swap may still go through: one offered with no hash back, or signed and never
   * seen, waits (`waiting`: no way to a new quote); a replacement after which the wallet used Uniswap otherwise stays
   * `changed` until then (it used to stay so for good). After it the call can never go through, and either is one nothing
   * told apart (`unknown`, `late`): the person checks their wallet and may say it did not go through. A record with no
   * deadline (the rounds before) keeps what it had. A replaced swap nothing told apart is `unknown` at once, as before:
   * its own hash can never be mined.
   */
  async function lifetime(rpc: WalletRpc, r: Recovered, deadline: bigint | null, gen: number): Promise<Recovered> {
    const timed = r.outcome === 'changed' || ((r.why === 'unanswered' || r.why === 'unseen') && (r.outcome === 'unknown' || r.outcome === 'untouched'))
    if (!timed || deadline === null) return r
    const past = await deadlinePassed(walletOwnReads(rpc), deadline)
    stillHere(gen)
    if (past) return { outcome: 'unknown', why: r.why, late: true }
    if (r.outcome === 'changed' && r.why === 'replaced') return { ...r, until: Number(deadline) }
    return { outcome: 'waiting', why: r.why, until: r.outcome === 'untouched' && r.until !== undefined ? r.until : Number(deadline) }
  }

  /** What an earlier routed swap is said to be, the first time a press finds it (fix rounds 3.1 and 3.2: one sentence per outcome). */
  function noticeOf(r: Recovered): Stop {
    if (r.outcome === 'swapped') return new Stop(ROUTE_RECOVERED, 'route_recovered')
    if (r.outcome === 'spent') return new Stop(ROUTE_SPENT, 'route_spent')
    if (r.outcome === 'untouched' && r.until !== undefined) return new Stop(routeUntouched(timeOfDay(r.until)), 'route_untouched')
    if (r.outcome === 'waiting' && r.until !== undefined) return new Stop(r.why === 'unseen' ? routeUnseen(timeOfDay(r.until)) : routeWaiting(timeOfDay(r.until)), 'route_waiting')
    // Fix round 3.2: a swap offered with no hash back was never seen replaced: never said so.
    return new Stop(r.late ? ROUTE_UNCONFIRMED_LATE : r.why === 'unanswered' ? ROUTE_UNANSWERED_UNKNOWN : ROUTE_REPLACED_UNKNOWN, 'route_replaced_unknown')
  }

  /** The first press that finds an earlier routed swap for this pool's deposit stops and says what it did; a later one goes on with it. */
  function told(claim: string, r: Recovered): Recovered {
    if (recoverySeen.current !== claim) {
      recoverySeen.current = claim
      throw noticeOf(r)
    }
    return r
  }

  /**
   * Fix round 3.2: the record in the slot, kept for a deposit in another pool (its pool digest). It is never let go from
   * here: it guards that deposit against a second swap. Fix round 3.1 let go of one known to have gone through, after which
   * that pool's one-token deposit could be offered a second swap and fee. A swap known to have gone through, or whose
   * allowance reads as it leaves it, is moved aside for its pool (the journal's `park`) and said once; one that may still
   * go through holds up only the Uniswap route here, until its deadline has passed on the chain's clock, when it is moved
   * aside too. Null: it holds up nothing here any more.
   */
  async function settleElsewhere(rpc: WalletRpc, record: RouteRecord, pool: PoolOption, gen: number): Promise<RouteBlock | null> {
    const owner = rpc.owner.toLowerCase(), journal = routeJournal()
    const r = await assessRoute(rpc, record, pool, false, gen)
    if (r.outcome === 'swapped' || r.outcome === 'spent') {
      const moved = await journal.park(owner, record.claim)
      stillHere(gen)
      // Said once: once moved aside, it is no longer in the slot; kept there (no room to move it), said on the first press.
      const seen = `${record.claim}|elsewhere`
      if (moved || recoverySeen.current !== seen) {
        recoverySeen.current = seen
        throw new Stop(r.outcome === 'spent' ? ROUTE_ELSEWHERE_SPENT : ROUTE_ELSEWHERE, 'route_recovered_elsewhere')
      }
      return { kind: 'elsewhere', until: null }
    }
    const deadline = record.evidence?.deadline ?? null
    const past = deadline !== null && await deadlinePassed(walletOwnReads(rpc), deadline)
    stillHere(gen)
    if (past && await journal.park(owner, record.claim)) return null
    stillHere(gen)
    return { kind: 'elsewhere', until: deadline !== null && !past ? Number(deadline) : null }
  }

  /** Fix round 3.2: a swap the person said they rejected, its hash never back, holds up a new Uniswap route until its deadline (forgetRequest). */
  async function heldRoute(rpc: WalletRpc, gen: number): Promise<RouteBlock | null> {
    const journal = routeJournal(), owner = rpc.owner.toLowerCase()
    const until = journal.heldUntil(owner)
    if (until === null) return null
    const past = await deadlinePassed(walletOwnReads(rpc), until)
    stillHere(gen)
    if (!past) return { kind: 'held', until: Number(until) }
    await journal.releaseHold(owner, until)
    return null
  }

  /** Whether `hash`, which the chain does not know, was replaced: the owner's mined nonce is past `nonce`, and the hash is
   * still unknown when asked again after that (a node that had not seen it yet is not a replacement). */
  async function nonceReplaced(rpc: WalletRpc, hash: Hex, nonce: bigint): Promise<boolean> {
    const latest = await rpc.request('eth_getTransactionCount', [rpc.owner, 'latest'])
    if (typeof latest !== 'string' || !/^0x[0-9a-fA-F]+$/.test(latest) || BigInt(latest) <= nonce) return false
    return (await rpc.request('eth_getTransactionByHash', [hash])) === null
  }

  /**
   * The routed swap was replaced in the wallet and the transaction at its nonce did not swap (fix round 2; audit C14,
   * fix round 1): a cancel, a reviewed router call that reverted, or (fix rounds 3 and 3.1) a replacement after which the
   * swap's input is still untouched where nothing can take it any more. Its own hash can never be mined, so its journal is
   * let go, settled by the chain, and the next press reads the balances again and asks for a fresh quote and review before
   * anything is signed: nothing is sent again on its own. A replacement that swapped, or one that could not be told
   * apart, never comes here: its journal stays, and no second swap is offered for the deposit on its own.
   */
  async function routeReplaced(owner: string, claim: string, by: 'not_swapped' | 'reverted'): Promise<never> {
    await routeJournal().release(owner, claim)
    continuation.current = null
    quote.current = null
    reviewedRoute.current = null
    throw by === 'reverted'
      ? new Stop('Your wallet replaced the Uniswap swap, and the replacement reverted. Nothing was swapped and no swap fee was collected; network gas was spent. Press Create position to read your balances again and review before signing.', 'route_reverted')
      // Changed on purpose in fix round 3 (2026-10-01): "this swap", since another transaction of the wallet's may have swapped something else.
      : new Stop('Your wallet replaced the Uniswap swap with another transaction, so this swap did not happen and no swap fee was collected for it. Press Create position to read your balances again and review before signing.', 'route_replaced')
  }

  /**
   * What took a replaced routed swap's nonce, as the swap that page sent knows it (fix round 2). "Speed up" sent the
   * reviewed router call under another hash: it is the swap, done, and the press goes on as after any swap. A cancel,
   * or a reviewed router call that reverted, lets the journal go. Anything else keeps the journal and is said (fix round
   * 3.1: its input taken as the swap takes it, not taken yet, or not told apart): the next press uses the tokens in the
   * wallet, and no second swap is offered on its own.
   */
  async function routeReplacedBy(rpc: WalletRpc, pending: RouteContinuation, gen: number): Promise<'swapped'> {
    const reads = walletOwnReads(rpc)
    // Fix round 3.2: a swap offered with no hash back may still be in the wallet: a cancel at its nonce proves nothing.
    const why = pending.hash === null ? 'unanswered' : 'replaced'
    const found: ReplacementFinding = pending.nonce === null || reads === null ? { kind: 'unknown' }
      : await routedReplacement(reads, rpc.owner, pending.nonce, pending.evidence,
        { tokens: [pending.plan.key.currency0, pending.plan.key.currency1], input: pending.plan.routed?.preview.request.tokenIn, thisPool: true, unanswered: why === 'unanswered' })
    stillHere(gen)
    if (found.kind === 'swapped') return 'swapped'
    if (found.kind === 'not_swapped' || found.kind === 'reverted') await routeReplaced(pending.owner, pending.claim, found.kind)
    const said = await lifetime(rpc, recoveredOf(found, why), pending.evidence?.deadline ?? null, gen)
    continuation.current = null
    recoverySeen.current = pending.claim
    throw noticeOf(said)
  }

  /** The sequential router transfer is quarantined before opening the wallet.
   * After a confirmed swap every retry funds/mints only; no fee can be repeated. */
  async function runRoutedSwap(client: Client, rpc: WalletRpc, gas: GasBudget, prepared: PreparedBatch, plan: BatchPlan, selected: RouteQuote, gen: number) {
    const owner = prepared.owner.toLowerCase() as Address
    for (let i = 0; i < 4; i++) {
      stillHere(gen)
      if (!routeCurrent(selected)) throw new Stop('The route quote expired. Press Create position to refresh it before signing.', 'route_expired')
      const step = await client.prepareRoutedStep(prepared, gas)
      stillHere(gen)
      if (!routeCurrent(selected)) throw new Stop('The route quote expired. Press Create position to refresh it before signing.', 'route_expired')
      if (step.kind !== 'route-swap') {
        const stepKey = step.kind === 'route-permit' ? 'route-permit' : 'route-approve'
        mark(stepKey, 'waiting', gen, true)
        await sendAndWait(client, step, stepKey, gen)
        continue
      }
      // What tells a replacement apart later (fix round 3), read before the swap is offered: the head, the reviewed
      // calldata's digest and the input's Permit2 allowance, through the wallet. A read that fails only leaves its part out.
      // Fix round 3.1: the allowance the swap leaves and the pool it is for; and no read at all for a wallet that hands its
      // reads to the site, which serves none (WalletConnect; lib/walletReads.ts, RPC-SPEC D6).
      const request = plan.routed?.preview.request
      const evidence = await routeEvidence(walletOwnReads(rpc), prepared.owner, request?.tokenIn ?? '', BigInt(request?.amountRaw ?? '0'), step.transaction.data, plan.key)
      stillHere(gen)
      // Fix round 3.1: the nonce the swap goes out with (checked free on chain by its preparation, and again by the send)
      // is kept with the claim, before the wallet is asked, so a hash that never comes back holds nothing for good.
      const nonce = /^0x[0-9a-fA-F]+$/.test(step.transaction.nonce) ? BigInt(step.transaction.nonce) : null
      const journal = routeJournal()
      const claim = await journal.claim(owner, nonce ?? undefined, evidence)
      const pending: RouteContinuation = { owner, plan, claim, hash: null, nonce, evidence, swapped: false, wasOffered: () => client.wasOffered(step) }
      continuation.current = pending
      mark('route-swap', 'wallet', gen)
      let hash: Hex
      try {
        stillHere(gen)
        if (!routeCurrent(selected)) throw new Stop('The route expired before signing. Press Create position again.', 'route_expired')
        hash = await client.send(step, true)
      } catch (error) {
        // Only explicit rejection (or our pre-send check) proves no signed transaction exists.
        if (!client.wasOffered(step) || isRejection(error)) {
          await journal.release(owner, claim)
          continuation.current = null
        }
        throw error
      }
      pending.hash = hash
      await journal.record(owner, claim, hash, nonce ?? undefined, evidence)
      mark('route-swap', 'chain', gen)
      await waitRouted(client, rpc, pending, gen)
      return
    }
    throw new Stop('The route approvals could not be confirmed. Check wallet activity before trying again.', 'route_approval_unavailable')
  }

  async function waitRouted(client: Client, rpc: WalletRpc, pending: RouteContinuation, gen: number) {
    if (!pending.hash && !pending.wasOffered()) {
      await routeJournal().release(pending.owner, pending.claim)
      continuation.current = null
      throw new Stop('The wallet declined the earlier swap. Nothing was swapped. Press Create position to prepare it again.', 'route_rejected')
    }
    if (!pending.hash) {
      if (pending.nonce === null) throw new Stop('The swap was offered but its outcome is unknown. Check wallet activity; nothing will be swapped again.', 'route_outcome_unknown')
      // Fix round 3.1: offered with no hash back. Its nonce passed, what took it decides, as for a replaced swap (the swap
      // itself, approved late, is `swapped`); still free with nothing pending, the person may say they rejected it.
      await unansweredRoute(rpc, pending.claim, pending.nonce, pending.evidence?.deadline ?? null, gen)
      await routeReplacedBy(rpc, pending, gen)
      pending.swapped = true
      mark('route-swap', 'done', gen)
      return
    }
    const until = Date.now() + RECEIPT_WAIT_MS
    for (;;) {
      stillHere(gen)
      const receipt = await client.receipt(pending.hash, undefined, pending.plan, pending.nonce ?? undefined)
      if (receipt.state === 'included' || receipt.state === 'finalized') {
        pending.swapped = true
        mark('route-swap', 'done', gen)
        return
      }
      if (receipt.state === 'reverted') {
        await routeJournal().release(pending.owner, pending.claim)
        continuation.current = null
        throw new Stop('The Uniswap swap reverted. Nothing was deposited and no swap fee was collected; network gas was spent.', 'route_reverted')
      }
      if (receipt.state === 'reorged' || Date.now() > until) throw new Stop('The Uniswap swap’s outcome is not confirmed. Check wallet activity, then press Create position to check again; nothing is swapped twice.', 'route_outcome_unknown')
      // Replaced in the wallet (audit C14): its own hash will never be mined. What took its nonce decides (fix round 2):
      // a sped-up swap is the swap, done; a cancel lets the journal go (fix round 1); anything else keeps it.
      if (receipt.state === 'replaced' && await routeReplacedBy(rpc, pending, gen) === 'swapped') {
        pending.swapped = true
        mark('route-swap', 'done', gen)
        return
      }
      await sleep(RECEIPT_EVERY_MS)
    }
  }

  /** The position is in the wallet: Review offers what comes next in this control's place. */
  function finish(tokenId: bigint, gen: number) {
    if (generation.current !== gen) return
    setHeld(null)
    setPhase('done')
    setNotice(null)
    // With the wallet that made it (RPC fix round 2): only that wallet's list is asked again for it.
    publishCreated(tokenId.toString(), wallet === null ? null : wallet.slice(wallet.indexOf('|') + 1))
  }

  /** `batch`: one signature for every step (EIP-5792), for a wallet that can; by default when it can without an upgrade. */
  async function create(batch = atomic === 'supported') {
    if (!draft || !needs || running.current) return
    const pool = draft.pool
    const gen = ++generation.current
    setBatching(batch)
    running.current = true
    setPhase('running')
    setNotice(null)
    setRefundFirst(false)
    setUnrecognized(null)
    setUnconfirmed(null)
    setOpenRoute(null)
    // Review keeps its own plan in view until this run knows its steps.
    show([], gen)
    let open: Open | null = held
    // A deposit an earlier press left held may need its swap; a new one is swapped only when this press plans it.
    let swapAllowed = true
    // The journal's record that guards this press's deposit (fix round 3.2: the one in the slot for this pool, a batch, or
    // one moved aside for this pool): it holds up a one-token deposit, and goes with this press's completed mint. A record
    // in the slot for another pool's deposit is never this one (settleElsewhere, `elsewhere`).
    let routedRecord: RouteRecord | null = null
    // What the journal's earlier routed swap is known to have done (fix rounds 3, 3.1 and 3.2): null when this press did
    // not find it again (none, this page's own continuation, or a batch).
    let recovered: Recovered | null = null
    // Fix round 3.2: another pool's record that may still go through, kept in the slot: it holds up the Uniswap route here.
    let elsewhere: RouteBlock | null = null
    try {
      const { client, rpc, gas } = await connectClient()
      const key = poolKeyOf(pool)
      const owner = rpc.owner.toLowerCase(), here = poolDigest(owner, key)
      routedRecord = routeJournal().read(owner)
      if (routedRecord?.batchOperation) {
        if (pendingAtomic.current?.claim === routedRecord.claim && !pendingAtomic.current.offered()) {
          await routeJournal().release(rpc.owner.toLowerCase(), routedRecord.claim)
          pendingAtomic.current = null
          throw new Stop('The earlier batch was not sent. Press Create position to prepare it again.', 'route_rejected')
        }
        show([{ key: 'batch', title: CREATE.review.batchStepTitle(true, true), state: 'chain' }], gen)
        try {
          const prior = await watchBatch(client, rpc.batchOffered?.(routedRecord.batchOperation) ?? '', routedRecord.batchOperation, gen)
          if ('tokenId' in prior) {
            await routeJournal().release(rpc.owner.toLowerCase(), routedRecord.claim)
            pendingAtomic.current = null
            finish(prior.tokenId, gen)
            return
          }
          if (!sameKey(prior.held.operation.key, pool)) throw new Stop('The earlier batch belongs to another pool. Return to that pool to finish or refund its deposit.', 'route_context_changed')
          open = prior.held
          swapAllowed = false
        } catch (error) {
          if (['batch_dropped', 'batch_reverted'].includes(errorCode(error) ?? '')) {
            await routeJournal().release(rpc.owner.toLowerCase(), routedRecord.claim)
            pendingAtomic.current = null
          }
          throw error
        }
      }
      // Any previously offered atomic route is watched first, before quoting
      // another route or preparing the sequential fallback.
      const priorBatch = routedRecord?.batchOperation ? null : await client.offeredBatch()
      if (priorBatch) {
        show([{ key: 'batch', title: CREATE.review.batchStepTitle(true, true), state: 'chain' }], gen)
        const prior = await watchBatch(client, priorBatch.id, priorBatch.operationId, gen)
        if ('tokenId' in prior) { finish(prior.tokenId, gen); return }
        open = prior.held
        swapAllowed = false
      }
      const continuing = continuation.current
      if (continuing && continuing.owner === rpc.owner.toLowerCase()) {
        if (!sameKey(continuing.plan.key, pool)) throw new Stop('The earlier swap belongs to another pool. Return to that pool to finish using its tokens; no new swap will be sent.', 'route_context_changed')
        if (!continuing.swapped) await waitRouted(client, rpc, continuing, gen)
        swapAllowed = false
      } else if (routedRecord && !routedRecord.batchOperation) {
        if (routedRecord.evidence?.pool && routedRecord.evidence.pool !== here) {
          // Fix round 3.2: kept for another pool's deposit. Never let go from here (fix round 3.1 let go of one that went
          // through, and that pool's one-token deposit could then be offered a second swap and fee): moved aside for its
          // pool, or, while it may still go through, kept, holding up only the Uniswap route here.
          elsewhere = await settleElsewhere(rpc, routedRecord, pool, gen)
          routedRecord = null
        } else {
          recovered = told(routedRecord.claim, await assessRoute(rpc, routedRecord, pool, true, gen))
          swapAllowed = false
        }
      }
      if (!routedRecord && !(continuing && continuing.owner === owner)) {
        // Fix round 3.2: a record moved aside for this pool's deposit guards it as the one in the slot did.
        const parked = routeJournal().parked(owner, here)
        if (parked) {
          routedRecord = parked
          recovered = told(parked.claim, await assessRoute(rpc, parked, pool, true, gen))
          swapAllowed = false
        }
      }
      /** The deposit this pool's records guarded is done: each is let go (the one in the slot, the continuation's, one moved aside). */
      const settled = async () => {
        const journal = routeJournal()
        for (const claim of new Set([routedRecord?.claim, continuation.current?.claim, journal.parked(owner, here)?.claim])) {
          if (claim) await journal.release(owner, claim)
        }
      }
      if (open) {
        // The deposit this page holds, as the chain has it now: minted meanwhile, refunded, or still waiting for its mint.
        const current = await client.inspect(open.id)
        if (current.closed && current.tokenId > 0n) {
          await settled()
          continuation.current = null
          finish(current.tokenId, gen)
          return
        }
        open = current.closed || current.recoveryStarted ? null : { id: open.id, operation: current }
        if (!open && generation.current === gen) setHeld(null)
      } else {
        const rows = await client.recent()
        const earlier = rows.find((row) => !row.operation.closed && !row.operation.recoveryStarted && sameKey(row.operation.key, pool)) ?? null
        if (earlier) {
          // Found, not chosen: the wallet is asked nothing until the owner says what to do with it.
          if (generation.current !== gen) return
          setHeld(earlier)
          setPhase('held')
          setNotice({
            text: `You have an earlier deposit in this pool: ${units(earlier.operation.balance0, pool.currencies[0])} ${symbolOf(pool.currencies[0])} and ${units(earlier.operation.balance1, pool.currencies[1])} ${symbolOf(pool.currencies[1])}. Press Create position to create this range from it, or refund it to your wallet.`,
            code: null,
          })
          return
        }
      }
      if (open) {
        // A held deposit's swap and mint are steps of their own: never in a batch.
        if (generation.current === gen) setBatching(false)
        show([
          { key: 'fund', title: CREATE.review.fundStep, state: 'done' },
          { key: 'mint', title: CREATE.review.mintStep, state: 'waiting' },
        ], gen)
      } else {
        // New funds, and the position they become, are held by the account, and its delegate's code runs on all of it:
        // one this app does not recognize is said before anything else is read or asked (setup.ts fund checks it too).
        const account = await client.account()
        if (account.kind === 'delegated' && account.known === null && rpc.delegateConfirmed?.(account.delegate) !== true) {
          if (generation.current === gen) setUnrecognized({ owner: rpc.owner, delegate: account.delegate })
          throw new Stop(unrecognizedText(account.delegate), 'delegate_unrecognized')
        }
        // What the wallet holds decides the funding: both tokens, or one of them with the swap. ETH keeps the gas of every step:
        // the approvals and the deposit, and, held back through the deposit itself, the swap and the mint or a refund.
        const kept = GAS_AFTER_DEPOSIT_UNITS * gas.maxFeePerGas
        const gasTotal = kept + GAS_UP_TO_DEPOSIT_UNITS * gas.maxFeePerGas
        // The three balances asked at once (audit C10).
        const [held0, held1, ethHeld] = await Promise.all([
          walletBalance(rpc, pool.currencies[0].address as Address),
          walletBalance(rpc, pool.currencies[1].address as Address),
          pool.currencies[0].address === zeroAddress ? null : walletBalance(rpc, zeroAddress),
        ])
        const eth = ethHeld ?? held0
        if (eth < gasTotal) throw new Stop(`Keep some ETH for network gas: your wallet holds ${ethText(eth)} ETH, and these steps may need up to ${ethText(gasTotal)} ETH.`)
        const spendable = (raw: bigint, index: 0 | 1) => (pool.currencies[index].address === zeroAddress ? raw - gasTotal : raw)
        const terms = await termsNow(client, key, pool, draft)
        const resumed = continuing?.swapped ? continuing.plan : null
        const plan: DepositPlan = resumed
          ? { kind: 'both', amount0: resumed.amount0, amount1: resumed.amount1 }
          : depositPlan({ terms, independent: draft.independent, typedRaw: BigInt(draft.amountRaw), need0: needs[0], need1: needs[1], slippageBps: draft.slippageBps, balances: [spendable(held0, 0), spendable(held1, 1)] })
        if (plan.kind === 'short') {
          const token = pool.currencies[plan.token]
          const have = plan.have < 0n ? 0n : plan.have
          throw new Stop(`Your wallet holds ${units(have, token)} ${symbolOf(token)}${token.address === zeroAddress ? ' after network gas' : ''}; this position needs ${units(plan.need, token)}. Lower the amount, or add ${symbolOf(token)} to your wallet.`)
        }
        let funding: readonly [bigint, bigint] = plan.kind === 'both' ? [plan.amount0, plan.amount1] : plan.from === 0 ? [plan.deposit, 0n] : [0n, plan.deposit]
        if (routedRecord && plan.kind === 'swap') {
          // Fix round 3: said as completed only when it is known to be; a replacement nothing could tell apart is said as
          // such, and the person's own word after checking the wallet is the one way to a new quote (releaseUnconfirmed).
          // Fix round 3.1: only for this pool's deposit; and only when nothing was read that says more: a swap whose input
          // the chain shows taken went through, one not taken yet waits for its expiry, and one after which the wallet
          // used Uniswap otherwise is never let go on the person's word. Fix round 3.2: the person's word only once nothing
          // the page offered can still go through (its deadline passed): one that may (`waiting`, or `changed` before its
          // deadline) waits for that; and an allowance read as the swap leaves it is never said as proof.
          const missing = symbolOf(pool.currencies[plan.from === 0 ? 1 : 0])
          const r: Recovered = recovered ?? { outcome: 'swapped', why: 'mined' }
          if (r.outcome === 'unknown') {
            if (generation.current === gen) setUnconfirmed({ owner, claim: routedRecord.claim })
            throw new Stop(routeUnconfirmed(missing), 'route_unconfirmed')
          }
          if (r.outcome === 'changed') throw new Stop(routeChanged(missing, r.until !== undefined ? timeOfDay(r.until) : undefined), 'route_changed')
          if (r.outcome === 'untouched') throw new Stop(r.until !== undefined ? routeUntouched(timeOfDay(r.until)) : ROUTE_REPLACED_UNKNOWN, 'route_untouched')
          if (r.outcome === 'waiting' && r.until !== undefined) throw new Stop(r.why === 'unseen' ? routeUnseen(timeOfDay(r.until)) : routeWaiting(timeOfDay(r.until)), 'route_waiting')
          throw new Stop(r.outcome === 'spent' ? ROUTE_SPENT_BALANCES
            : 'Your earlier Uniswap swap completed. Use both tokens now in your wallet: go back and lower the amount or add the missing token. No second swap will be sent.', 'route_use_balances')
        }
        // Fix round 3.1: a record kept for another pool's deposit holds up neither this pool's own assisted swap nor this
        // deposit; only the Uniswap route waits for it (the journal holds one routed swap at a time). Fix round 3.2: such a
        // record is never `routedRecord` (settleElsewhere), and once it can no longer go through it is moved aside.
        swapAllowed = !routedRecord && plan.kind === 'swap'
        // The one token deposited: a one-token plan's, or the one a range that takes one token alone is funded with.
        const one: Side | null = plan.kind === 'swap' ? plan.from : funding[0] === 0n ? 1 : funding[1] === 0n ? 0 : null
        const inOrder: readonly LiveStep[] = [
          ...pool.currencies.flatMap((token, index) =>
            token.address !== zeroAddress && funding[index] > 0n ? [{ key: `approve:${token.address}`, title: CREATE.review.approveStep, token, state: 'waiting' as const }] : [],
          ),
          one !== null
            ? { key: 'fund', title: CREATE.review.fundOneStep, token: pool.currencies[one], state: 'waiting' as const }
            : { key: 'fund', title: CREATE.review.fundStep, state: 'waiting' as const },
          ...(plan.kind === 'swap' ? [{ key: 'swap', title: plan.swap >= plan.deposit ? CREATE.review.swapAllStep : CREATE.review.swapStep, state: 'waiting' as const }] : []),
          { key: 'mint', title: CREATE.review.mintStep, state: 'waiting' },
        ]
        // One step for the batch, named after what it holds, as Review named it before the press (journey.ts batchedSteps).
        const batchTitle = CREATE.review.batchStepTitle(inOrder.some((step) => step.key.startsWith('approve:')), plan.kind === 'swap')
        if (resumed) {
          setBatching(false)
          show([{ key: 'route-swap', title: 'Swap through Uniswap · 0.65% output fee', state: 'done' }, ...inOrder], gen)
        } else show(batch ? [{ key: 'batch', title: batchTitle, state: 'waiting' }] : inOrder, gen)
        // One token alone is deposited only into a pool that can swap part of it: checked before any approval.
        let checked: { sized: SwapSize; price: bigint } | null = null
        let poolFailure: unknown = null
        if (plan.kind === 'swap') {
          try { checked = await swapPreflight(client, key, draft, plan.from, plan.deposit, gen) } catch (error) {
            if (!['pool_no_liquidity', 'pool_too_thin'].includes(errorCode(error) ?? '')) throw error
            poolFailure = error
          }
        }
        let routePrepared: PreparedBatch | null = null
        let routePlan: BatchPlan | null = null
        let selected: RouteQuote | null = null
        const intent = JSON.stringify([wallet, pool.key, draft.tickLower, draft.tickUpper, draft.amountRaw, draft.slippageBps])
        // Fix round 3.2: what holds up the Uniswap route for this deposit, said when only that route could serve it.
        let blocked: RouteBlock | null = null
        if (plan.kind === 'swap' && (checked || poolFailure) && routeFallback.current !== intent && !routedRecord) blocked = elsewhere ?? await heldRoute(rpc, gen)
        if (plan.kind === 'swap' && (checked || poolFailure) && routeFallback.current !== intent && !routedRecord && !blocked) {
          const gross = checked?.sized.gross ?? plan.swap
          selected = await chooseRoute(rpc, key, draft, plan.from, gross, plan.deposit, batch, gen)
          if (selected) {
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                routePlan = routedBatchPlan(selected.preview, plan.deposit, key, draft, await client.price(key))
                routePrepared = await client.prepareBatch(routePlan, gas)
                break
              } catch {
                stillHere(gen)
                if (attempt === 0) {
                  selected = await chooseRoute(rpc, key, draft, plan.from, gross, plan.deposit, batch, gen, true)
                  if (selected) continue
                }
                selected = null
                routePlan = null
                routePrepared = null
                routeFallback.current = intent
                quote.current = null
                publishRoutedReview(null)
                if (poolFailure) throw poolFailure
                throw new Stop('The Uniswap route could not be independently verified. Review the selected-pool swap instead, then press Create position. Nothing was sent.', 'route_pool_fallback')
              }
            }
          }
        }
        if (poolFailure && !routePrepared) {
          // Fix round 3.2: the pool alone cannot serve this deposit, and the Uniswap route is held up: said, with until when.
          // It used to say the pool's reason alone, hiding that an earlier swap held up the one route that could.
          if (blocked && poolFailure instanceof Stop) throw new Stop(`${poolFailure.text} ${routeBlocked(blocked)}`, errorCode(poolFailure) ?? 'pool_too_thin')
          throw poolFailure
        }
        if (selected && routePlan && routePrepared) {
          stillHere(gen)
          if (!routeCurrent(selected)) throw new Stop('The route expired during its safety check. Press Create position to refresh it.', 'route_expired')
          if (batch) {
            // The same cross-tab latch protects BOTH atomic and sequential
            // routed swaps. The Setup operation latch alone cannot protect a
            // standalone router transfer racing an atomic batch in another tab.
            const journal = routeJournal()
            const claim = await journal.claim(owner)
            const prepared = routePrepared
            pendingAtomic.current = { claim, offered: () => client.wasBatchOffered(prepared) }
            try {
              await journal.recordBatch(owner, claim, prepared.operationId)
              routedRecord = journal.read(owner)
              stillHere(gen)
              if (!routeCurrent(selected)) throw new Stop('The route expired before signing. Press Create position again.', 'route_expired')
              mark('batch', 'wallet', gen)
              // Never silently turn an atomic swap into independent transactions.
              const id = await client.sendBatch(prepared, true)
              mark('batch', 'chain', gen)
              const made = await watchBatch(client, id, prepared.operationId, gen)
              if ('tokenId' in made) {
                await journal.release(owner, claim)
                pendingAtomic.current = null
                finish(made.tokenId, gen)
                return
              }
              open = made.held
              if (generation.current === gen) setHeld(open)
            } catch (error) {
              if (errorCode(error) === 'batch_unsupported' && generation.current === gen) {
                setAtomic('unsupported')
                setBatching(false)
              }
              if (!client.wasBatchOffered(prepared) || isRejection(error) || ['batch_dropped', 'batch_reverted', 'batch_upgrade_declined', 'batch_unsupported'].includes(errorCode(error) ?? '')) {
                await journal.release(owner, claim)
                pendingAtomic.current = null
              }
              throw error
            }
          } else {
            const routeSteps: LiveStep[] = [
              ...(selected.preview.request.tokenIn !== zeroAddress ? [
                { key: 'route-approve', title: 'Approve the exact swap amount', token: pool.currencies[plan.kind === 'swap' ? plan.from : 0], state: 'waiting' as const },
                { key: 'route-permit', title: 'Authorize the Uniswap router', state: 'waiting' as const },
              ] : []),
              { key: 'route-swap', title: 'Swap through Uniswap · 0.65% output fee', state: 'waiting' },
              ...pool.currencies.flatMap((token, index) => token.address !== zeroAddress && (index === 0 ? routePlan!.amount0 : routePlan!.amount1) > 0n
                ? [{ key: `approve:${token.address}`, title: CREATE.review.approveStep, token, state: 'waiting' as const }] : []),
              { key: 'fund', title: CREATE.review.fundStep, state: 'waiting' },
              { key: 'mint', title: CREATE.review.mintStep, state: 'waiting' },
            ]
            show(routeSteps, gen)
            await runRoutedSwap(client, rpc, gas, routePrepared, routePlan, selected, gen)
            routedRecord = routeJournal().read(owner)
          }
          funding = [routePlan.amount0, routePlan.amount1]
          swapAllowed = false
        } else if (batch && !resumed) {
          const made = await createInOneBatch(client, gas, key, draft, plan, funding, checked, gen)
          if (made && 'tokenId' in made) {
            // Fix round 3.2: a mint in one batch completes this pool's deposit as a mint step by step does.
            await settled()
            finish(made.tokenId, gen)
            return
          }
          if (made) {
            // A batch cannot leave its operation funded and open; if one did, it is a held deposit like any other.
            open = made.held
            if (generation.current === gen) setHeld(open)
          } else show(inOrder, gen)
          // Whatever is left is asked step by step, and the line under the button says so from here on.
          if (generation.current === gen) setBatching(false)
        }
        // The deposit keeps ETH back for the swap and the mint, or a refund, that follow it.
        const reserved: GasBudget = { ...gas, reserveWei: kept }
        let asked = 0
        // The approval the wallet last replaced ("Speed up" or "Cancel", audit C14), as its token and calldata.
        let replacedApproval: string | null = null
        while (!open) {
          // The check above can take many seconds: a page left meanwhile prepares nothing.
          stillHere(gen)
          const step = await client.fund(key, funding[0], funding[1], reserved)
          if (step.kind === 'approve') {
            asked++
            if (asked > MAX_APPROVALS) throw new Stop('The token allowance could not be set. Check your wallet activity, then press Create position again.')
            // An approval replaced in the wallet that the chain says did not happen (a cancel) is asked for again: never
            // in the same press, which stops here instead; the person presses again if they want it.
            const same = `${step.transaction.to.toLowerCase()}|${step.transaction.data.toLowerCase()}`
            if (replacedApproval === same) throw new Stop(REPLACED.approve, 'transaction_replaced')
            // A reset to zero and the exact amount are two signatures under the same token's step: the second one opens it again.
            const approveKey = `approve:${step.transaction.to.toLowerCase()}`
            mark(approveKey, 'waiting', gen, true)
            // Replaced or included, the allowance is read again by the next preparation, which asks only for what is
            // still missing (audit C14): a sped-up approval leaves nothing to ask.
            replacedApproval = (await sendAndWait(client, step, approveKey, gen)) === 'replaced' ? same : null
            continue
          }
          // Every allowance is in place: the approvals not asked for were already enough.
          show(steps.current.map((entry) => (entry.key.startsWith('approve:') ? { ...entry, state: 'done' } : entry)), gen)
          const deposited = await sendAndWait(client, step, 'fund', gen)
          if (!step.operationId) throw new Stop('The deposit could not be read back. Check your wallet activity.')
          let funded: SetupOperation
          if (deposited === 'replaced') {
            // Replaced in the wallet and nothing deposited: a cancel. Nothing is offered again until the next press.
            const replaced = await replacedDeposit(client, step.operationId)
            if (!replaced) throw new Stop(REPLACED.fund, 'transaction_replaced')
            mark('fund', 'done', gen)
            funded = replaced
          } else funded = await settledOperation(client, step.operationId, (value) => value.balance0 > 0n || value.balance1 > 0n)
          open = { id: step.operationId, operation: funded }
          if (generation.current === gen) setHeld(open)
        }
      }
      const tokenId = await mintFrom(client, key, gas, open, gen, swapAllowed)
      // Fix round 3.1: the mint completes the deposit the record guarded, never another pool's. Fix round 3.2: and any
      // record moved aside for this pool's deposit (a record kept for another pool's is never here: settleElsewhere).
      await settled()
      continuation.current = null
      finish(tokenId, gen)
    } catch (error) {
      if (generation.current !== gen) return
      stopAt(gen)
      // Fix round 3.1: a swap offered with no hash back whose nonce is still free says so in its own words, with the way out.
      const said = continuation.current && !(error instanceof Stop && errorCode(error) === 'wallet_request_open')
        ? { text: continuation.current.swapped
          ? `The Uniswap swap completed and its fee was collected. ${open ? 'Your deposit is held: continue or refund it.' : 'The received tokens remain in your wallet. Press Create position to continue without another swap.'}`
          : 'A Uniswap swap was offered. Its outcome must be confirmed before continuing; nothing will be swapped twice. Check wallet activity, then press Create position again.', code: errorCode(error) }
        : failureText(error, open !== null, 'The wallet could not complete this step. Check your wallet activity, then press Create position again: a deposit already made is never made twice.')
      if (said.text) setNotice(said)
      setPhase(open ? 'held' : 'failed')
      if (open) setHeld(open)
      // Only once the contract's own quotes found no size this pool fills, with nothing in range at its price.
      setRefundFirst(open !== null && said.code === 'held_pool_no_liquidity')
    } finally {
      if (generation.current === gen) running.current = false
    }
  }

  async function refund() {
    if (!held || running.current) return
    const gen = ++generation.current
    running.current = true
    setPhase('running')
    setNotice(null)
    show([{ key: 'refund', title: 'Refund the deposit to your wallet', state: 'waiting' }], gen)
    try {
      const { client, gas } = await connectClient()
      const step = await client.cancel(held.id, gas)
      if ((await sendAndWait(client, step, 'refund', gen)) === 'replaced') {
        // Replaced in the wallet (audit C14): refunded only if the operation reads closed now.
        const now = await settledOperation(client, held.id, (value) => value.closed)
        if (!now.closed) throw new Stop(REPLACED.refund, 'transaction_replaced')
      }
      if (generation.current !== gen) return
      setHeld(null)
      setRefundFirst(false)
      setPhase('idle')
      setNotice({ text: 'The deposit was refunded to your wallet.', code: null })
    } catch (error) {
      if (generation.current !== gen) return
      stopAt(gen)
      const said = failureText(error, true, 'The refund could not be completed. Your deposit is still held.')
      setNotice(isRejection(error) ? { text: 'You declined in your wallet. Your deposit is still held.', code: said.code } : said)
      setPhase('held')
    } finally {
      if (generation.current === gen) running.current = false
    }
  }

  /**
   * "I rejected it in my wallet" (2026-10-01, audit C2, the owner's OK): the person says the request this page offered
   * and never heard back from is gone from their wallet. The latch on it is let go, only while the chain shows nothing
   * pending; nothing is sent, and the next press prepares and reviews everything again. Fix round 3.2: for a routed swap,
   * a new Uniswap route waits until its router deadline (the wallet may show it still, in another tab or on a phone).
   */
  async function forgetRequest() {
    if (running.current) return
    const route = openRoute
    setOpenRoute(null)
    try {
      const rpc = await setupWallet()
      let freed = await forgetOpenRequest(rpc)
      // Fix round 3.1: a routed swap offered with no hash back is let go on the same word, and only while its nonce is
      // still the next one on chain with nothing pending (a swap the wallet sent keeps its journal until it is mined, and
      // what took its nonce is then told apart). Nothing is sent, and the next press reviews a fresh quote.
      // Fix round 3.2: the wallet may still show it after all (a phone wallet keeps a request a closed dialog here did not
      // reject), and the request can go through until its router deadline: a new Uniswap route waits until then (`hold`,
      // kept before the journal is let go). The pool's own assisted swap and a both-token deposit do not wait.
      let waitsUntil: bigint | null = null
      if (route && route.owner === rpc.owner.toLowerCase() && await nonceStanding(rpc, route.nonce) === 'open') {
        const journal = routeJournal()
        if (route.deadline !== null && !(await deadlinePassed(walletOwnReads(rpc), route.deadline))) {
          await journal.hold(route.owner, route.deadline)
          waitsUntil = route.deadline
        }
        await journal.release(route.owner, route.claim)
        continuation.current = null
        quote.current = null
        reviewedRoute.current = null
        recoverySeen.current = null
        freed = true
      }
      setNotice({
        text: !freed ? 'Press Create position to check again.'
          : waitsUntil !== null ? `Nothing was sent. Press Create position to continue. A new Uniswap swap can be offered after ${timeOfDay(Number(waitsUntil))}, when the one you rejected can no longer go through.`
            : 'Nothing was sent. Press Create position to continue.',
        code: freed ? 'request_forgotten' : 'request_unchanged',
      })
    } catch (error) {
      setNotice(failureText(error, held !== null, 'Your wallet could not be read just now. Press Create position to check again.'))
    }
  }

  /**
   * "It did not go through" (fix round 3, 2026-10-01): the person checked their wallet activity and says the replaced
   * routed swap the chain could not tell apart did not go through. Offered only after a press found that swap replaced
   * (its nonce passed with nothing under its own hash, so it can never be mined now), nothing that tells the replacement
   * apart (old state gone and nothing read: an ETH input whose swap no log shows, or an allowance that could not be read;
   * fix round 3.1: never one read spent, changed or untouched), for this pool's deposit, and too little of the other token
   * in the wallet for this deposit. Its journal is let go, nothing is sent, and the next press asks for a fresh quote that is reviewed
   * before anything is signed. A swap that did go through left its tokens in the wallet: the notice says so first.
   * Fix round 3.2: a swap offered with no hash back, or signed and never seen on chain, may still be in the wallet, so
   * "its nonce passed" proves nothing for it: offered only once its router deadline has passed on the chain's clock, when
   * nothing the page offered can go through any more (lifetime). So too a replacement after which the wallet used Uniswap
   * otherwise (`changed`), which used to hold for good. Never for one whose allowance reads as the swap leaves it (`spent`).
   */
  async function releaseUnconfirmed() {
    if (!unconfirmed || running.current) return
    const { owner, claim } = unconfirmed
    setUnconfirmed(null)
    try {
      const rpc = await setupWallet()
      if (rpc.owner.toLowerCase() !== owner) {
        setNotice({ text: 'Press Create position to check again.', code: 'route_unchanged' })
        return
      }
      await routeJournal().release(owner, claim)
      continuation.current = null
      quote.current = null
      reviewedRoute.current = null
      recoverySeen.current = null
      setNotice({ text: 'Nothing was sent. Press Create position to get a new quote, and review it before anything is signed.', code: 'route_released' })
    } catch (error) {
      setNotice(failureText(error, held !== null, 'This browser could not let go of the earlier swap just now. Press Create position to check again.'))
    }
  }

  /** The person set up this smart account themselves: remembered for this account on this page, and the press runs again. */
  function confirmUnrecognized() {
    if (!unrecognized || running.current) return
    confirmDelegate(unrecognized.owner, unrecognized.delegate)
    setUnrecognized(null)
    void create(batching)
  }

  const openWallet = () => document.querySelector<HTMLButtonElement>('header [aria-haspopup="dialog"]')?.click()
  // Changed on purpose 2026-10-01 (audit C1): the switch's outcome is said here, in the wallet dialog's own words; it
  // used to be dropped, and the button did nothing anyone could see. A switch that worked changes the wallet, which
  // clears the line and the notice above.
  const connectOrSwitch = async () => {
    if (!onOtherNetwork) {
      openWallet()
      return
    }
    if (switching) return
    setSwitching(true)
    setNotice(null)
    try {
      const result = await switchToRobinhood()
      if (result !== 'switched') setNotice({ text: SWITCH_NOTICE[result], code: `switch_${result}` })
    } finally {
      setSwitching(false)
    }
  }
  const busy = phase === 'running'
  // Changed on purpose (round 6, 2026-09-27, the owner: plain words): each reason below is one short sentence, and a
  // held deposit is "refunded", the word of the button beside it (Refund the deposit instead).
  // Review's reading says the wallet cannot fund this position either way. The press stays open: it looks for an earlier
  // deposit in this pool first, which may be where the tokens are, and reads the wallet itself before anything is sent.
  const short = reviewed?.kind === 'short' && phase !== 'held' && phase !== 'running' && phase !== 'done'
  let reason: string
  if (!ready) {
    // Why there is nothing to create: a missing choice, or a pool positions are not created in (hooks, a dynamic fee).
    reason = CREATE.review.notReady
  } else if (!needs) reason = 'The price or the range can’t be used. Go back to Range and choose it again.'
  else if (onOtherNetwork) reason = 'Switch your wallet to Robinhood Chain to continue.'
  // 2026-10-01 (audit C5): while the wallet control is still finding a returning visitor's wallet.
  else if (identity.kind === 'unknown') reason = 'Looking for your wallet…'
  else if (!connected) reason = 'Connect a wallet to create this position.'
  else if (phase === 'held' && refundFirst) reason = 'You have a deposit waiting in this pool. Refund it to your wallet.'
  else if (phase === 'held') reason = 'You have a deposit waiting in this pool. Press Create position to finish from it, or refund it.'
  else if (busy) reason = batching ? 'Confirm in your wallet: one signature for every step.' : 'Confirm each step in your wallet.'
  else if (short) reason = CREATE.amount.short
  else if (phase === 'failed' && unrecognized) reason = 'Your wallet is asked nothing until you confirm the smart account below, or connect another account.'
  else if (phase === 'failed' && unconfirmed) reason = 'Check your wallet activity before you continue.'
  else if (phase === 'failed') reason = 'Press Create position to try again.'
  else if (atomic === 'supported') reason = CREATE.review.batchReason
  else reason = 'Your wallet will ask you to confirm each step.'
  // A wallet that could batch once it turns on its smart account: offered beside the steps, never chosen for the person.
  const offerBatch = atomic === 'ready' && ready && needs !== null && connected && (phase === 'idle' || phase === 'failed') && !unrecognized

  return (
    <>
      {ready && needs && !connected ? (
        <Button type="button" variant="primary" size="xl" className="w-full" data-create-position="connect" aria-describedby="create-reason" aria-busy={switching || undefined} disabled={switching} onClick={() => void connectOrSwitch()}>
          {onOtherNetwork ? (switching ? 'Switching…' : 'Switch to Robinhood Chain') : 'Connect wallet'}
        </Button>
      ) : (
        <Button
          type="button"
          variant={refundFirst && phase === 'held' ? 'outline' : 'primary'}
          size="xl"
          className="w-full"
          data-create-position={phase}
          aria-describedby={phase === 'done' ? 'created-title' : 'create-reason'}
          aria-busy={busy || undefined}
          disabled={!ready || !needs || busy || phase === 'done'}
          onClick={() => void create()}
        >
          {busy ? 'Creating position…' : phase === 'done' ? 'Position created' : 'Create position'}
        </Button>
      )}
      {/* Once the position exists, what comes next is said under the button instead (CreatedNext.tsx). */}
      {phase !== 'done' && (
        <p id="create-reason" className="dm-flow-reason" data-align="start">
          {reason}
        </p>
      )}
      {notice && (
        <p role="status" className="dm-flow-reason dm-flow-create-notice" data-align="start" data-create-notice={notice.code ?? 'said'}>
          {notice.text}
        </p>
      )}
      {notice?.code === 'wallet_request_open' && phase !== 'running' && (
        <Button type="button" variant="outline" size="md" className="w-full" onClick={() => void forgetRequest()} data-create-forget-request="">
          I rejected it in my wallet
        </Button>
      )}
      {phase === 'failed' && unconfirmed && notice?.code === 'route_unconfirmed' && (
        <Button type="button" variant="outline" size="md" className="w-full" onClick={() => void releaseUnconfirmed()} data-create-route-release="">
          It did not go through: get a new quote
        </Button>
      )}
      {phase === 'failed' && unrecognized && (
        <Button type="button" variant="outline" size="md" className="w-full" onClick={confirmUnrecognized} data-create-confirm-delegate={unrecognized.delegate}>
          I set up this smart account: continue
        </Button>
      )}
      {offerBatch && (
        <>
          <Button type="button" variant="outline" size="md" className="w-full" onClick={() => void create(true)} data-create-batch="offer" aria-describedby="create-batch-note">
            {CREATE.review.batchOffer}
          </Button>
          <p id="create-batch-note" className="dm-flow-reason" data-align="start">
            {CREATE.review.batchOfferNote}
          </p>
        </>
      )}
      {phase === 'held' && held && (
        <Button
          type="button"
          variant={refundFirst ? 'primary' : 'outline'}
          size={refundFirst ? 'lg' : 'md'}
          className="w-full"
          disabled={busy}
          onClick={() => void refund()}
          data-create-refund={refundFirst ? 'first' : ''}
        >
          Refund the deposit instead
        </Button>
      )}
    </>
  )
}
