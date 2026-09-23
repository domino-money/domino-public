import { useEffect, useRef, useState } from 'react'
import { zeroAddress, type Address, type Hex } from 'viem'
import { setupWallet } from '../../finance/wallet'
import { suggestGasBudget } from '../../finance/gas'
import { readRelease } from '../../finance/release'
import { createSetupClient, deploymentFrom, walletBalance, type GasBudget, type PoolKey, type PreparedSetup, type SetupDeployment, type SetupOperation, type WalletRpc } from '../../finance/setup'
import { errorCode, financeErrorText } from '../../finance/words'
import { switchToRobinhood } from '../../wallet/port'
import { setupDraft, type JourneyState, type SetupDraft } from '../../lib/create/journey'
import { mintPlanFor } from '../../lib/create/mintPlan'
import { pairedAmount } from '../../lib/create/pairAmount'
import { formatUnits } from '../../lib/read/decimal'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import { useWalletIdentity, walletKey } from '../../lib/walletIdentity'
import { rememberCreated } from '../../lib/positionMemory'
import { Button } from '../ui'
import { SymbolText } from '../read/screens/SymbolText'

/**
 * Review's last control: Create position. One press opens the position the
 * four steps describe, on Domino V1's own setup contract, through the wallet
 * alone — no private session, no service between the page and the chain.
 *
 * The wallet is asked, in order and only for what is needed: an exact
 * allowance for each token whose allowance is short, the deposit of both
 * tokens (native ETH travels with it), and the mint, which sends the position
 * NFT to the wallet and returns whatever the range did not use. Every step is
 * prepared against the chain first — the deployment verified through the
 * wallet, the transaction simulated, its gas estimated — offered to the
 * wallet once, and read back by hash before the next one is prepared. The
 * press on Create position is the review of these steps; the wallet shows each
 * transaction before it signs.
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
/** 'check', 'fund', 'mint', 'refund', or `approve:<token address>`: one approval per token. */
type StepKey = string
type StepState = 'waiting' | 'reading' | 'wallet' | 'chain' | 'done' | 'failed'
interface StepView {
  key: StepKey
  label: string
  token?: PoolOption['currencies'][number]
  state: StepState
}
type Phase = 'idle' | 'running' | 'failed' | 'held' | 'done'

const RECOVERY_KEY = 'domino.setup.public-recovery.v1'
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
/** Gas units kept in ETH for the steps after the deposit (the mint, or a refund), at the steps' own fee ceiling. */
const GAS_KEPT_UNITS = 4_000_000n
/** How long the page waits after the mint before opening Positions, so the read service has seen its block. */
const SETTLE_MS = 3_000
const CAPTION: Record<StepState, string> = {
  waiting: 'Next',
  reading: 'Checking…',
  wallet: 'Confirm in your wallet',
  chain: 'Waiting for the network',
  done: 'Done',
  failed: 'Stopped',
}
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

/** The two amounts the position takes at the pool's price as read: the one typed, and the one the range and the price make of it. */
function amountsOf(draft: SetupDraft): { amount0: bigint; amount1: bigint } | null {
  const other = pairedAmount({ sqrtPriceX96: draft.pool.sqrtPriceX96, tickLower: draft.tickLower, tickUpper: draft.tickUpper, independent: draft.independent, amountRaw: draft.amountRaw })
  if (other.kind !== 'amount') return null
  const mine = BigInt(draft.amountRaw), theirs = BigInt(other.raw)
  return draft.independent === 0 ? { amount0: mine, amount1: theirs } : { amount0: theirs, amount1: mine }
}
/** An amount with the slippage limit as room, rounded up: the most the deposit may take of that token. */
const withRoom = (amount: bigint, slippageBps: number) => (amount === 0n ? 0n : (amount * (10000n + BigInt(slippageBps)) + 9999n) / 10000n)

class Stop extends Error {
  constructor(readonly text: string) {
    super('create_position_stopped')
  }
}

/** Keeps the verified profile where Setup's owner recovery looks for it, so a held deposit can be refunded there too. */
function saveRecoveryProfile(deployment: SetupDeployment) {
  try {
    localStorage.setItem(RECOVERY_KEY, JSON.stringify({ contractVersion: '1.0.0-rc.1', chainId: 4663, available: true, deployment }))
  } catch {
    /* Recovery can also use the published deployment profile. */
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

export default function CreatePosition({ state, onBusy }: { state: JourneyState; onBusy?: (busy: boolean) => void }) {
  const identity = useWalletIdentity()
  const draft = setupDraft(state)
  const [phase, setPhase] = useState<Phase>('idle')
  const [steps, setSteps] = useState<StepView[]>([])
  const [notice, setNotice] = useState<{ text: string; code: string | null } | null>(null)
  const [held, setHeld] = useState<Open | null>(null)
  const generation = useRef(0)
  const running = useRef(false)
  // Another wallet or network: whatever was prepared or held for the previous one no longer applies.
  const wallet = walletKey(identity)
  const [seenWallet, setSeenWallet] = useState(wallet)
  if (seenWallet !== wallet) {
    setSeenWallet(wallet)
    setPhase('idle')
    setSteps([])
    setNotice(null)
    setHeld(null)
  }
  // The previous wallet's flow, if one was running, writes nothing more.
  useEffect(() => {
    generation.current++
    running.current = false
  }, [wallet])
  useEffect(() => () => void generation.current++, [])
  // Back stays put while the wallet is being asked: leaving Review would drop the flow mid-way.
  useEffect(() => {
    onBusy?.(phase === 'running')
  }, [phase, onBusy])
  useEffect(() => () => onBusy?.(false), [onBusy])

  const ready = draft !== null && draft.pool.integration === 'hookless_fixed_fee'
  const amounts = draft ? amountsOf(draft) : null
  const connected = wallet !== null
  const onOtherNetwork = identity.kind === 'connected' && wallet === null

  function mark(key: StepKey, next: StepState, gen: number) {
    if (generation.current !== gen) return
    setSteps((old) => old.map((step) => (step.key === key && step.state !== 'done' ? { ...step, state: next } : step)))
  }

  /** What a revert of this step means for the deposit. */
  const revertText = (key: StepKey) =>
    key === 'mint'
      ? 'The mint reverted on chain: your deposit is still held. Press Create position to try again, or refund it.'
      : key === 'refund'
        ? 'The refund reverted on chain: your deposit is still held. Try the refund again.'
        : key === 'fund'
          ? 'The deposit reverted on chain: nothing was deposited, only network gas was spent. Press Create position to try again.'
          : 'The approval reverted on chain: nothing was deposited. Press Create position to try again.'

  /** Offers one prepared step to the wallet, then waits for its receipt. Throws on a revert or a reorg. */
  async function sendAndWait(client: Client, step: PreparedSetup, key: StepKey, gen: number) {
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

  async function mintFrom(client: Client, key: PoolKey, gas: GasBudget, open: Open, gen: number): Promise<bigint> {
    if (!draft) throw new Stop('')
    const sqrtPriceX96 = await client.price(key)
    const operation = await client.inspect(open.id)
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
    saveRecoveryProfile(live.deployment)
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
    if (!draft || !amounts || running.current) return
    const pool = draft.pool
    const gen = ++generation.current
    running.current = true
    setPhase('running')
    setNotice(null)
    const funding = { amount0: withRoom(amounts.amount0, draft.slippageBps), amount1: withRoom(amounts.amount1, draft.slippageBps) }
    const erc20 = pool.currencies.filter((currency, index) => currency.address !== zeroAddress && (index === 0 ? funding.amount0 : funding.amount1) > 0n)
    setSteps([
      { key: 'check', label: 'Check the deployment and your balances', state: 'reading' },
      ...erc20.map((token) => ({ key: `approve:${token.address}`, label: 'Approve', token, state: 'waiting' as const })),
      { key: 'fund', label: 'Deposit the tokens', state: 'waiting' },
      { key: 'mint', label: 'Create the position', state: 'waiting' },
    ])
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
          setSteps([])
          setPhase('held')
          setNotice({
            text: `You have an earlier deposit in this pool: ${units(earlier.operation.balance0, pool.currencies[0])} ${symbolOf(pool.currencies[0])} and ${units(earlier.operation.balance1, pool.currencies[1])} ${symbolOf(pool.currencies[1])}. Press Create position to create this range from it, or refund it to your wallet.`,
            code: null,
          })
          return
        }
      }
      const gasKept = GAS_KEPT_UNITS * gas.maxFeePerGas
      if (!open) {
        // Enough of each token, with the slippage room, and ETH for the gas of the steps that follow, before the wallet is asked anything.
        for (const [index, currency] of pool.currencies.entries()) {
          const needed = index === 0 ? funding.amount0 : funding.amount1
          if (currency.address === zeroAddress) {
            const have = await walletBalance(rpc, zeroAddress)
            if (have < needed + gasKept) throw new Stop(`Your wallet holds ${ethText(have)} ETH; this position needs up to ${ethText(needed)} ETH plus about ${ethText(gasKept)} ETH for network gas. Lower the amount or add ETH.`)
          } else if (needed > 0n) {
            const have = await walletBalance(rpc, currency.address as Address)
            if (have < needed) throw new Stop(`Your wallet holds ${units(have, currency)} ${symbolOf(currency)}; this position may take up to ${units(needed, currency)} with your slippage limit. Lower the amount or add ${symbolOf(currency)} to your wallet.`)
          }
        }
        if (pool.currencies.every((currency) => currency.address !== zeroAddress)) {
          const eth = await walletBalance(rpc, zeroAddress)
          if (eth < gasKept) throw new Stop(`Keep some ETH for network gas: your wallet holds ${ethText(eth)} ETH, and these steps need about ${ethText(gasKept)} ETH.`)
        }
      }
      mark('check', 'done', gen)
      if (!open) {
        // The deposit keeps ETH back for the mint, or a refund, that follows it.
        const reserved: GasBudget = { ...gas, reserveWei: gasKept }
        let asked = 0
        while (!open) {
          const step = await client.fund(key, funding.amount0, funding.amount1, reserved)
          if (step.kind === 'approve') {
            asked++
            if (asked > MAX_APPROVALS) throw new Stop('The token allowance could not be set. Check your wallet activity, then press Create position again.')
            // A reset to zero and the exact amount are two signatures under the same token's step.
            const approving = `approve:${step.transaction.to.toLowerCase()}`
            setSteps((old) => old.map((entry) => (entry.key === approving ? { ...entry, state: 'waiting' } : entry)))
            await sendAndWait(client, step, approving, gen)
            continue
          }
          // Every allowance is in place: the approvals not asked for were already enough.
          setSteps((old) => old.map((entry) => (entry.key.startsWith('approve:') ? { ...entry, state: 'done' } : entry)))
          await sendAndWait(client, step, 'fund', gen)
          if (!step.operationId) throw new Stop('The deposit could not be read back. Check your wallet activity.')
          const funded = await settledOperation(client, step.operationId, (value) => value.balance0 > 0n || value.balance1 > 0n)
          open = { id: step.operationId, operation: funded }
          if (generation.current === gen) setHeld(open)
        }
      } else {
        setSteps((old) => old.map((entry) => (entry.key.startsWith('approve:') || entry.key === 'fund' ? { ...entry, state: 'done' } : entry)))
      }
      const tokenId = await mintFrom(client, key, gas, open, gen)
      await finish(rpc, tokenId, gen)
    } catch (error) {
      if (generation.current !== gen) return
      setSteps((old) => old.map((entry) => (entry.state === 'reading' || entry.state === 'wallet' || entry.state === 'chain' ? { ...entry, state: 'failed' } : entry)))
      const said = failureText(error, open !== null, 'The wallet could not complete this step. Check your wallet activity, then press Create position again: a deposit already made is never made twice.')
      if (said.text) setNotice(said)
      setPhase(open ? 'held' : 'failed')
      if (open) setHeld(open)
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
    setSteps([{ key: 'refund', label: 'Refund the deposit to your wallet', state: 'waiting' }])
    try {
      const { client, gas } = await connectClient()
      const step = await client.cancel(held.id, gas)
      await sendAndWait(client, step, 'refund', gen)
      if (generation.current !== gen) return
      setHeld(null)
      setPhase('idle')
      setNotice({ text: 'The deposit was refunded to your wallet.', code: null })
    } catch (error) {
      if (generation.current !== gen) return
      setSteps((old) => old.map((entry) => (entry.state === 'reading' || entry.state === 'wallet' || entry.state === 'chain' ? { ...entry, state: 'failed' } : entry)))
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
  let reason: string
  if (!ready) reason = draft ? 'This pool needs a separate integration: positions here take pools with no hooks and a fixed fee.' : 'Complete the steps above to create the position.'
  else if (!amounts) reason = 'The pool’s price or the range could not be used. Go back to the range and choose it again.'
  else if (onOtherNetwork) reason = 'Switch your wallet to Robinhood Chain to create the position.'
  else if (!connected) reason = 'Connect your wallet to create the position. Each transaction appears in your wallet to sign.'
  else if (phase === 'held') reason = 'A deposit is held for this pool. Press Create position to create the position from it, or refund it.'
  else reason = 'Your wallet asks you to sign each step: an exact approval if needed, the deposit, then the position.'

  return (
    <>
      {ready && amounts && !connected ? (
        <Button type="button" variant="primary" size="lg" className="w-full" data-create-position="connect" aria-describedby="create-reason" onClick={connectOrSwitch}>
          {onOtherNetwork ? 'Switch to Robinhood Chain' : 'Connect wallet'}
        </Button>
      ) : (
        <Button
          type="button"
          variant="primary"
          size="lg"
          className="w-full"
          data-create-position={phase}
          aria-describedby="create-reason"
          aria-busy={busy || undefined}
          disabled={!ready || !amounts || busy || phase === 'done'}
          onClick={() => void create()}
        >
          {busy ? 'Creating position…' : phase === 'done' ? 'Position created' : 'Create position'}
        </Button>
      )}
      <p id="create-reason" className="dm-flow-reason" data-align="start">
        {reason}
      </p>
      {steps.length > 0 && (
        <ol className="dm-flow-wsteps dm-flow-create-steps" data-create-steps="" aria-live="polite">
          {steps.map((step, index) => (
            <li key={`${step.key}-${index}`} data-create-step={step.key} data-create-step-state={step.state}>
              <span aria-hidden="true" className="dm-step-marker">
                {step.state === 'done' ? '✓' : index + 1}
              </span>
              <span className="grid min-w-0 gap-0.5">
                <span className="text-body font-medium text-fg">
                  {step.label}
                  {step.token && (
                    <>
                      {' '}
                      <SymbolText token={step.token} />
                    </>
                  )}
                </span>
                <span className="text-caption text-fg-muted">{CAPTION[step.state]}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {notice && (
        <p role="status" className="dm-flow-reason dm-flow-create-notice" data-align="start" data-create-notice={notice.code ?? 'said'}>
          {notice.text}
        </p>
      )}
      {phase === 'held' && held && (
        <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={() => void refund()} data-create-refund="">
          Refund the deposit instead
        </Button>
      )}
    </>
  )
}
