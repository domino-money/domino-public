import { useEffect, useRef, useState } from 'react'
import { zeroAddress, type Address, type Hex } from 'viem'
import { setupWallet } from '../../finance/wallet'
import { suggestGasBudget } from '../../finance/gas'
import { readRelease } from '../../finance/release'
import { saveSetupProfile } from '../../finance/recoveryProfile'
import { createSetupClient, deploymentFrom, isRevert, walletBalance, type GasBudget, type PoolKey, type PreparedSetup, type SetupOperation, type WalletRpc } from '../../finance/setup'
import { errorCode, financeErrorText } from '../../finance/words'
import { switchToRobinhood } from '../../wallet/port'
import { CREATE } from '../../lib/create/copy'
import { publishCreateProgress, type LiveState, type LiveStep } from '../../lib/create/createProgress'
import { depositPlan, needsSides, quoteWithin, sizeSwap, swapFeePips, type DepositPlan, type PoolTerms, type Side } from '../../lib/create/depositPlan'
import { setupDraft, type JourneyState, type SetupDraft } from '../../lib/create/journey'
import { mintPlanFor } from '../../lib/create/mintPlan'
import { pairedAmount } from '../../lib/create/pairAmount'
import { formatUnits } from '../../lib/read/decimal'
import { MAX_SQRT_PRICE, MIN_SQRT_PRICE } from '../../lib/read/screens/poolRange'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import { useWalletIdentity, walletKey } from '../../lib/walletIdentity'
import { rememberCreated } from '../../lib/positionMemory'
import { Button } from '../ui'

/**
 * Review's last control: Create position. One press opens the position the
 * four steps describe, on Domino V1's own setup contract, through the wallet
 * alone — no private session, no service between the page and the chain.
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
 * NFT.
 *
 * When the position exists the page opens it on Positions and remembers it
 * for this wallet (lib/positionMemory.ts). An earlier deposit of this wallet
 * in this pool whose mint did not happen is never funded again: it is shown
 * with its amounts, and the next press creates the position from it, or it
 * can be refunded.
 */

type Client = ReturnType<typeof createSetupClient>
type Open = { id: Hex; operation: SetupOperation }
type Phase = 'idle' | 'running' | 'failed' | 'held' | 'done'

const readSetupRelease = () => readRelease('/api/setup/v1/release', (value) => deploymentFrom(value))
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
/** How long the page waits after the mint before opening Positions, so the read service has seen its block. */
const SETTLE_MS = 3_000
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
/** This page's sentences for the setup client's codes whose shared sentence names a control it does not have. */
const OWN_TEXT: Readonly<Record<string, string>> = {
  native_gas_reserve_insufficient: 'Keep some ETH for network gas: your ETH does not cover this step. Lower the ETH amount or add ETH.',
  gas_budget_exceeded: 'This step needs more gas than expected. Try again in a moment.',
  invalid_gas_budget: 'The network’s gas price could not be used. Try again in a moment.',
  pending_wallet_transaction: 'Your wallet has a transaction waiting. Let it finish, or cancel it in your wallet, then press Create position again.',
  wallet_review_expired: 'The step took too long to reach your wallet. Press Create position again.',
  wallet_review_required: 'The step took too long to reach your wallet. Press Create position again.',
  setup_release_expired: 'The deployment profile expired. Reload the page and try again.',
  invalid_mint_limits: 'The position could not be sized at the pool’s price now. Press Create position again.',
  invalid_swap_budget: 'The swap could not be sized from your deposit. Press Create position again.',
  swap_output_insufficient: 'The swap would return too little at your slippage limit. Press Create position again, or raise the slippage limit.',
  pool_not_initialized: 'This pool has no price on chain yet, so a position cannot be created in it here.',
}
const decimalsOf = (token: PoolOption['currencies'][number]) => (token.origin === 'read' ? token.decimals : null)
const symbolOf = (token: PoolOption['currencies'][number]) => token.symbol ?? 'token'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const units = (raw: bigint, token: PoolOption['currencies'][number]) => formatUnits(String(raw), decimalsOf(token))?.text ?? String(raw)
const ethText = (wei: bigint) => formatUnits(String(wei), 18)?.text ?? String(wei)
const isRejection = (error: unknown) => Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 4001)

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
  const generation = useRef(0)
  const running = useRef(false)
  const steps = useRef<readonly LiveStep[]>([])
  // Another wallet or network: whatever was prepared or held for the previous one no longer applies.
  const wallet = walletKey(identity)
  const [seenWallet, setSeenWallet] = useState(wallet)
  if (seenWallet !== wallet) {
    setSeenWallet(wallet)
    setPhase('idle')
    setNotice(null)
    setHeld(null)
    setRefundFirst(false)
  }
  // The previous wallet's flow, if one was running, writes nothing more, and Review shows its plan again.
  useEffect(() => {
    generation.current++
    running.current = false
    steps.current = []
    publishCreateProgress(null)
  }, [wallet])
  useEffect(
    () => () => {
      generation.current++
      publishCreateProgress(null)
    },
    [],
  )
  // Back stays put while the wallet is being asked: leaving Review would drop the flow mid-way.
  useEffect(() => {
    onBusy?.(phase === 'running')
  }, [phase, onBusy])
  useEffect(() => () => onBusy?.(false), [onBusy])

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

  /** Offers one prepared step to the wallet, then waits for its receipt. Throws on a revert or a reorg. */
  async function sendAndWait(client: Client, step: PreparedSetup, key: string, gen: number) {
    // The step may have been prepared after a long check: no prompt opens on a page that was left meanwhile.
    stillHere(gen)
    mark(key, 'wallet', gen)
    const hash = await client.send(step, true)
    mark(key, 'chain', gen)
    const until = Date.now() + RECEIPT_WAIT_MS
    let settled = false
    while (!settled) {
      await sleep(RECEIPT_EVERY_MS)
      if (generation.current !== gen) throw new Stop('')
      const receipt = await client.receipt(hash, step.operationId ?? undefined)
      if (receipt.state === 'included' || receipt.state === 'finalized') settled = true
      else if (receipt.state === 'reverted') throw new Stop(revertText(key))
      else if (receipt.state === 'reorged') throw new Stop('The block that held the transaction left the chain. Check your wallet activity, then press Create position again.')
      else if (Date.now() > until) throw new Stop('The transaction is still waiting to be included. Check your wallet activity, then press Create position again: nothing is sent twice.')
    }
    mark(key, 'done', gen)
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
   */
  async function swapIfNeeded(client: Client, key: PoolKey, gas: GasBudget, open: Open, gen: number): Promise<boolean> {
    if (!draft) throw new Stop('')
    const operation = await client.inspect(open.id)
    if (operation.swapped) {
      drop('swap', gen)
      return false
    }
    const terms = await termsNow(client, key, draft.pool, draft)
    const [needs0, needs1] = needsSides(terms)
    const from: Side | null = needs1 && operation.balance1 === 0n && operation.balance0 > 0n ? 0 : needs0 && operation.balance0 === 0n && operation.balance1 > 0n ? 1 : null
    if (from === null) {
      drop('swap', gen)
      return false
    }
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
    await sendAndWait(client, step, 'swap', gen)
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
  async function swapPreflight(client: Client, key: PoolKey, settled: SetupDraft, from: Side, deposit: bigint, gen: number) {
    mark('swap', 'reading', gen)
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
        return
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
    } catch (error) {
      if (error instanceof Stop) throw error
      const code = errorCode(error)
      // A pool with no price has its own sentence (OWN_TEXT); anything else unread is a check that did not happen.
      if (code === 'pool_not_initialized') throw error
      throw new Stop(code === 'quoter_identity_changed' ? PREFLIGHT.quoter : PREFLIGHT.unchecked, code ?? 'pool_check_unavailable')
    }
    mark('swap', 'waiting', gen)
  }

  async function mintFrom(client: Client, key: PoolKey, gas: GasBudget, open: Open, gen: number): Promise<bigint> {
    if (!draft) throw new Stop('')
    const swapped = await swapIfNeeded(client, key, gas, open, gen)
    // The node may answer a moment behind the receipt: the mint is sized on the balances the swap left, never on the ones before it.
    const operation = await settledOperation(client, open.id, (value) => (!swapped || value.swapped) && (value.balance0 > 0n || value.balance1 > 0n))
    if (swapped && !operation.swapped) throw new Stop('The swap was included, and your deposit is still being read back. Press Create position again in a moment: nothing is swapped twice.')
    const sqrtPriceX96 = await client.price(key)
    const plan = mintPlanFor({ sqrtPriceX96: String(sqrtPriceX96), tickLower: draft.tickLower, tickUpper: draft.tickUpper, balance0: operation.balance0, balance1: operation.balance1, slippageBps: draft.slippageBps })
    if (!plan) throw new Stop('At the pool’s price now, the deposit makes no position in this range. Refund it, or go back and widen the range.')
    const step = await client.mint(open.id, { tickLower: draft.tickLower, tickUpper: draft.tickUpper, ...plan }, gas)
    await sendAndWait(client, step, 'mint', gen)
    const done = await settledOperation(client, open.id, (value) => value.closed && value.tokenId > 0n)
    if (!done.closed || done.tokenId === 0n) throw new Stop('The mint was included, and the position is still being read back. Press Create position again in a moment: nothing is deposited twice.')
    return done.tokenId
  }

  async function connectClient(): Promise<{ client: Client; rpc: WalletRpc; gas: GasBudget }> {
    const live = await readSetupRelease()
    if (live.kind !== 'available') throw new Stop('The deployment could not be confirmed just now. Nothing was sent. Try again in a moment.')
    const rpc = await setupWallet()
    const client = createSetupClient(rpc, live.deployment, () => Date.now() / 1000, currentSetupDeployment)
    const gas = await suggestGasBudget(rpc)
    saveSetupProfile(live.deployment)
    return { client, rpc, gas }
  }

  async function finish(rpc: WalletRpc, tokenId: bigint, gen: number) {
    // Listed on Positions from now on, for this wallet, without typing its id.
    rememberCreated(rpc.owner, tokenId.toString())
    if (generation.current !== gen) return
    setHeld(null)
    setPhase('done')
    setNotice({ text: `Position NFT ${tokenId.toString()} is in your wallet. Opening it on Positions…`, code: null })
    await sleep(SETTLE_MS)
    if (generation.current === gen) window.location.hash = `#/positions/${tokenId.toString()}`
  }

  async function create() {
    if (!draft || !needs || running.current) return
    const pool = draft.pool
    const gen = ++generation.current
    running.current = true
    setPhase('running')
    setNotice(null)
    setRefundFirst(false)
    // Review keeps its own plan in view until this run knows its steps.
    show([], gen)
    let open: Open | null = held
    try {
      const { client, rpc, gas } = await connectClient()
      const key = poolKeyOf(pool)
      if (open) {
        // The deposit this page holds, as the chain has it now: minted meanwhile, refunded, or still waiting for its mint.
        const current = await client.inspect(open.id)
        if (current.closed && current.tokenId > 0n) {
          await finish(rpc, current.tokenId, gen)
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
        show([
          { key: 'fund', title: CREATE.review.fundStep, state: 'done' },
          { key: 'mint', title: CREATE.review.mintStep, state: 'waiting' },
        ], gen)
      } else {
        // What the wallet holds decides the funding: both tokens, or one of them with the swap. ETH keeps the gas of every step:
        // the approvals and the deposit, and, held back through the deposit itself, the swap and the mint or a refund.
        const kept = GAS_AFTER_DEPOSIT_UNITS * gas.maxFeePerGas
        const gasTotal = kept + GAS_UP_TO_DEPOSIT_UNITS * gas.maxFeePerGas
        const held0 = await walletBalance(rpc, pool.currencies[0].address as Address)
        const held1 = await walletBalance(rpc, pool.currencies[1].address as Address)
        const eth = pool.currencies[0].address === zeroAddress ? held0 : await walletBalance(rpc, zeroAddress)
        if (eth < gasTotal) throw new Stop(`Keep some ETH for network gas: your wallet holds ${ethText(eth)} ETH, and these steps may need up to ${ethText(gasTotal)} ETH.`)
        const spendable = (raw: bigint, index: 0 | 1) => (pool.currencies[index].address === zeroAddress ? raw - gasTotal : raw)
        const terms = await termsNow(client, key, pool, draft)
        const plan = depositPlan({ terms, independent: draft.independent, typedRaw: BigInt(draft.amountRaw), need0: needs[0], need1: needs[1], slippageBps: draft.slippageBps, balances: [spendable(held0, 0), spendable(held1, 1)] })
        if (plan.kind === 'short') {
          const token = pool.currencies[plan.token]
          const have = plan.have < 0n ? 0n : plan.have
          throw new Stop(`Your wallet holds ${units(have, token)} ${symbolOf(token)}${token.address === zeroAddress ? ' after network gas' : ''}; this position needs ${units(plan.need, token)}. Lower the amount, or add ${symbolOf(token)} to your wallet.`)
        }
        const funding: readonly [bigint, bigint] = plan.kind === 'both' ? [plan.amount0, plan.amount1] : plan.from === 0 ? [plan.deposit, 0n] : [0n, plan.deposit]
        show([
          ...pool.currencies.flatMap((token, index) =>
            token.address !== zeroAddress && funding[index] > 0n ? [{ key: `approve:${token.address}`, title: CREATE.review.approveStep, token, state: 'waiting' as const }] : [],
          ),
          plan.kind === 'swap'
            ? { key: 'fund', title: CREATE.review.fundOneStep, token: pool.currencies[plan.from], state: 'waiting' as const }
            : { key: 'fund', title: CREATE.review.fundStep, state: 'waiting' as const },
          ...(plan.kind === 'swap' ? [{ key: 'swap', title: CREATE.review.swapStep, state: 'waiting' as const }] : []),
          { key: 'mint', title: CREATE.review.mintStep, state: 'waiting' },
        ], gen)
        // One token alone is deposited only into a pool that can swap part of it: checked before any approval.
        if (plan.kind === 'swap') await swapPreflight(client, key, draft, plan.from, plan.deposit, gen)
        // The deposit keeps ETH back for the swap and the mint, or a refund, that follow it.
        const reserved: GasBudget = { ...gas, reserveWei: kept }
        let asked = 0
        while (!open) {
          // The check above can take many seconds: a page left meanwhile prepares nothing.
          stillHere(gen)
          const step = await client.fund(key, funding[0], funding[1], reserved)
          if (step.kind === 'approve') {
            asked++
            if (asked > MAX_APPROVALS) throw new Stop('The token allowance could not be set. Check your wallet activity, then press Create position again.')
            // A reset to zero and the exact amount are two signatures under the same token's step: the second one opens it again.
            const approveKey = `approve:${step.transaction.to.toLowerCase()}`
            mark(approveKey, 'waiting', gen, true)
            await sendAndWait(client, step, approveKey, gen)
            continue
          }
          // Every allowance is in place: the approvals not asked for were already enough.
          show(steps.current.map((entry) => (entry.key.startsWith('approve:') ? { ...entry, state: 'done' } : entry)), gen)
          await sendAndWait(client, step, 'fund', gen)
          if (!step.operationId) throw new Stop('The deposit could not be read back. Check your wallet activity.')
          const funded = await settledOperation(client, step.operationId, (value) => value.balance0 > 0n || value.balance1 > 0n)
          open = { id: step.operationId, operation: funded }
          if (generation.current === gen) setHeld(open)
        }
      }
      const tokenId = await mintFrom(client, key, gas, open, gen)
      await finish(rpc, tokenId, gen)
    } catch (error) {
      if (generation.current !== gen) return
      stopAt(gen)
      const said = failureText(error, open !== null, 'The wallet could not complete this step. Check your wallet activity, then press Create position again: a deposit already made is never made twice.')
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
      await sendAndWait(client, step, 'refund', gen)
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

  const openWallet = () => document.querySelector<HTMLButtonElement>('header [aria-haspopup="dialog"]')?.click()
  const connectOrSwitch = () => {
    if (onOtherNetwork) void switchToRobinhood()
    else openWallet()
  }
  const busy = phase === 'running'
  // Review's reading says the wallet cannot fund this position either way. The press stays open: it looks for an earlier
  // deposit in this pool first, which may be where the tokens are, and reads the wallet itself before anything is sent.
  const short = reviewed?.kind === 'short' && phase !== 'held' && phase !== 'running' && phase !== 'done'
  let reason: string
  if (!ready) {
    // Why there is nothing to create: a missing choice, or a pool positions are not created in (hooks, a dynamic fee).
    reason = CREATE.review.notReady
  } else if (!needs) reason = 'The pool’s price or the range could not be used. Go back to the range and choose it again.'
  else if (onOtherNetwork) reason = 'Switch your wallet to Robinhood Chain to create the position.'
  else if (!connected) reason = 'Connect your wallet to create the position. Each transaction appears in your wallet to sign.'
  else if (phase === 'done') reason = 'The position is created. Positions opens it in a moment.'
  else if (phase === 'held' && refundFirst) reason = 'A deposit is held for this pool. Refund it to your wallet.'
  else if (phase === 'held') reason = 'A deposit is held for this pool. Press Create position to create the position from it, or refund it.'
  else if (busy) reason = 'Confirm each step in your wallet. The list above marks each one as it is done.'
  else if (short) reason = 'Your wallet does not seem to hold enough for this position. Lower the amount, or add the token named above to your wallet.'
  else if (phase === 'failed') reason = 'Press Create position to try again. An allowance already set is not asked for again.'
  else reason = 'Your wallet asks you to sign each step in the list above, in order.'

  return (
    <>
      {ready && needs && !connected ? (
        <Button type="button" variant="primary" size="lg" className="w-full" data-create-position="connect" aria-describedby="create-reason" onClick={connectOrSwitch}>
          {onOtherNetwork ? 'Switch to Robinhood Chain' : 'Connect wallet'}
        </Button>
      ) : (
        <Button
          type="button"
          variant={refundFirst && phase === 'held' ? 'outline' : 'primary'}
          size="lg"
          className="w-full"
          data-create-position={phase}
          aria-describedby="create-reason"
          aria-busy={busy || undefined}
          disabled={!ready || !needs || busy || phase === 'done'}
          onClick={() => void create()}
        >
          {busy ? 'Creating position…' : phase === 'done' ? 'Position created' : 'Create position'}
        </Button>
      )}
      <p id="create-reason" className="dm-flow-reason" data-align="start">
        {reason}
      </p>
      {notice && (
        <p role="status" className="dm-flow-reason dm-flow-create-notice" data-align="start" data-create-notice={notice.code ?? 'said'}>
          {notice.text}
        </p>
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
