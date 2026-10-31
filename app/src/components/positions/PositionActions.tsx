import { useEffect, useRef, useState, type ReactNode } from 'react'
import { suggestGasBudget } from '../../finance/gas'
import { closeMinimums, createPositionClient, positionTokenId, type PositionClient, type PositionState, type PreparedPosition } from '../../finance/position'
import type { GasBudget } from '../../finance/setup'
import { positionWallet } from '../../finance/wallet'
import { errorCode, financeErrorText } from '../../finance/words'
import { CREATE } from '../../lib/create/copy'
import { SLIPPAGE_DEFAULT_BPS, slippageBpsFrom, slippageWritten } from '../../lib/create/slippage'
import { formatUsd, usdgValue } from '../../lib/format/usd'
import type { TokenDisplay } from '../../lib/read/types'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { PositionNetworkError } from '../../lib/positions/positionNetwork'
import { v2SwitchNotice, type ChainSwitchOutcome } from '../../wallet/port'
import { SlippageChoice } from '../create/SlippageChoice'
import { TokenMark } from '../TokenIcon'
import { Button, Skeleton } from '../ui'
import { IconClose } from '../icons'
import { IconCollect } from './actionIcons'
import { ActionSheet, SheetAlert, SheetCard, SheetFact, SheetFacts, SheetMore, SheetNote, SheetStatus, TokenRow, TokenRows } from './ActionSheet'
import { SequenceSwitch } from './SequenceSwitch'
import { QuietMark } from './visual/QuietMarks'
import { amountText, currencyName, outcomeUnknown, readAfterReplaced, watchReceipt } from './walletSteps'
// The person's own refusal, by the nonce latch's rule: 4001, WalletConnect's 5000, a hardware wallet's words (fix round 1).
import { personRefused as isRejection } from '../../finance/nonce'

/**
 * The owner's own actions on a position NFT, from the connected wallet
 * straight to Uniswap's PositionManager (finance/position.ts): Collect fees
 * and Close position. Each opens its own dialog, which reads the position on
 * chain through the wallet, shows what the wallet would receive and what the
 * network fee may be, and sends one transaction when pressed. Closing takes
 * out all of the liquidity and the fees; the empty NFT stays in the wallet.
 *
 * Shown only when the connected wallet, on any network, is the NFT's
 * owner as the read service reported it; the chain is asked again before
 * anything is sent. Opened lazily by the Positions screens in wallet builds.
 *
 * 2026-09-25 (the owner: "vamos ligar tudo"): for the root of one of Domino's
 * sequences, Turn on or Pause stands first (SequenceSwitch.tsx), in the place
 * of the page's own way on (`automate`: Automate, or the docs on switching a
 * sequence on), which is shown whenever the switch offers nothing.
 */

export interface PositionCurrency { address: string; symbol: string | null; decimals: number | null }
export interface PositionActionsProps {
  /** Canonical decimal NFT id. */
  tokenId: string
  /** Lowercase NFT owner as the read service reported it. */
  owner: string
  /** Display only; the actions read the chain again. */
  liquidityRaw: string
  unsettledFeesRaw: readonly [string, string] | null
  currencies: readonly [PositionCurrency, PositionCurrency]
  /** Pool hooks address, lowercase. */
  hooks: string
  /** Called after a collect or close is included on chain, so the page reads again: with its block when the receipt named it. */
  onChanged: (block?: bigint) => void
  /** The fees relay's pool price, for a pair with USDG: the dialog adds what it receives in USD beside the pinned amounts. */
  usd?: { usdgIndex: 0 | 1; sqrtPriceX96: bigint; block: number } | null
  /** The page's own token marks (already resolved there), drawn beside the dialog's amounts. */
  tokens?: readonly [TokenDisplay, TokenDisplay] | null
  /** The page's own way on for this position (Automate, or the docs on switching its sequence on), shown first unless Turn on or Pause takes its place. */
  automate?: ReactNode
  /** The V2 automation control, placed after Withdraw and before the optional Close action. */
  automationSlot?: ReactNode
  /** Collect fees is the primary button: a plain position's (2026-09-27); a sequence's is outlined. */
  primary?: boolean
  /**
   * (QA round 2, N49) The position is the root of Auto-exit's own vault (read-v6, through the page's V2 actions): its
   * subscriber is that vault, and Collect fees leaves Auto-exit on (the docs, and the V2 dialogs), so the note that
   * collecting or closing stops Domino automation is not said.
   */
  autoExitRoot?: boolean
}

type Action = 'collect' | 'close'
type Stage = 'switching' | 'reading' | 'ready' | 'wallet' | 'chain' | 'done' | 'failed'
interface Run { action: Action; stage: Stage; prepared: PreparedPosition | null; notice: { text: string; code: string | null } | null }

const NO_HOOKS = '0x0000000000000000000000000000000000000000'
const TITLE: Readonly<Record<Action, string>> = { collect: 'Collect fees', close: 'Close position' }
const PRIMARY: Readonly<Record<Action, string>> = { collect: 'Collect in wallet', close: 'Close in wallet' }
const PROGRESS: Partial<Record<Stage, string>> = { switching: 'Switch to Robinhood Chain in your wallet…', reading: 'Checking your position…', wallet: 'Confirm in your wallet…', chain: 'Waiting for the network', done: 'Done' }
const AUTOMATION = 'Collecting fees or closing stops Domino automation for this position.'
const HOOKED = 'Positions in pools with hooks can’t be collected or closed here.'
const UNKNOWN_CONTRACT = 'Uniswap’s position contract on this network is not the one this site knows. Nothing was sent.'
const SLOW = 'The step took too long to reach your wallet. Try again.'
/** This component's sentences for the client's codes. Anything else falls back to the shared ones, then to a plain line. */
const OWN_TEXT: Readonly<Record<string, string>> = {
  position_price_moved: 'The price moved past your slippage limit. Nothing was sent. Raise the limit, or try again.',
  position_deadline_passed: 'The step expired before it reached the network. Nothing changed. Try again.',
  position_not_owned: 'This position NFT is not in your connected wallet.',
  position_already_empty: 'This position is already closed: it holds no liquidity.',
  position_not_found: 'This position NFT no longer exists.',
  position_pool_has_hooks: HOOKED,
  position_simulation_reverted: 'The network refused this step when it was checked. Nothing was sent.',
  invalid_position_identity: 'This position could not be verified on chain. Nothing was sent.',
  invalid_position_id: 'This position NFT id could not be read.',
  pool_not_initialized: 'This pool has no price on chain. Nothing was sent.',
  deployment_code_changed: UNKNOWN_CONTRACT,
  deployment_identity_unpinned: UNKNOWN_CONTRACT,
  wallet_identity_changed: 'Your wallet account or network changed. Nothing was sent.',
  connect_robinhood_wallet: 'Connect your wallet on Robinhood Chain first.',
  pending_wallet_transaction: 'Your wallet has a transaction waiting. Let it finish, then try again.',
  native_gas_reserve_insufficient: 'Your ETH does not cover the network fee for this step.',
  native_eth_refused: "Your wallet can't receive ETH right now: its smart-account delegation (EIP-7702) refuses plain ETH, so this payout would fail. Change or turn off that delegation in your wallet, then try again.",
  gas_budget_exceeded: 'This step needs more gas than expected. Try again in a moment.',
  invalid_gas_budget: 'The network fee could not be worked out. Try again in a moment.',
  wallet_review_required: SLOW,
  wallet_review_expired: SLOW,
  invalid_slippage: 'Choose a slippage limit from 0.1% to 5%.',
}
function failureText(error: unknown): { text: string; code: string | null } {
  if (error instanceof PositionNetworkError) return { text: v2SwitchNotice(error.outcome as Exclude<ChainSwitchOutcome, 'switched'>, 'Robinhood Chain'), code: error.message }
  const code = errorCode(error)
  if (isRejection(error)) return { text: 'You declined in your wallet. Nothing was sent.', code: 'declined' }
  if (code && Object.hasOwn(OWN_TEXT, code)) return { text: OWN_TEXT[code], code }
  return { text: financeErrorText(code, 'Your wallet could not complete this step. Check your wallet activity before trying again: nothing is sent twice.', 'Create position'), code }
}
const WATCHED_TEXT = {
  reverted: 'The transaction reverted on chain. Nothing changed; only network gas was spent.',
  reorged: 'The block that held the transaction left the chain. Check your wallet activity before trying again.',
  waiting: 'The transaction is still waiting to be included. Check your wallet activity: nothing is sent twice.',
  unknown: outcomeUnknown('transaction'),
} as const
/**
 * 2026-10-01 (audit C14): "Cancel" in the wallet, read back from the chain: the step did not happen. Changed on purpose
 * 2026-10-01 (integration pass 3, the copy review): "this step" for "the collect"/"the close", what is still true in plain
 * words, and "Press … again", as Create position says it (components/create/CreatePosition.tsx REPLACED).
 */
const REPLACED: Readonly<Record<Action, string>> = {
  collect: 'Your wallet replaced this step with another transaction, and no fees were collected. Press Collect in wallet again.',
  close: 'Your wallet replaced this step with another transaction, and the position is still open. Press Close in wallet again.',
}
/**
 * Whether a step the wallet replaced happened after all (audit C14), from the position read again: a close leaves no
 * liquidity, and a collect moves the position's last fee growth (only a settlement of the position does).
 */
const happened = (action: Action, before: PositionState, now: PositionState) =>
  action === 'close' ? now.liquidity === 0n : now.lastFeeGrowth[0] !== before.lastFeeGrowth[0] || now.lastFeeGrowth[1] !== before.lastFeeGrowth[1]
/** The press read the position again and it pays less than what the dialog showed: the new figures, for a second press. */
const CHANGED = 'The amounts changed since you opened this. Check them, then press again.'

const lessIn = (a: readonly [bigint, bigint], b: readonly [bigint, bigint]) => a[0] < b[0] || a[1] < b[1]
/**
 * Whether the step prepared at the press pays less, in either token, than the one on screen: what it receives, and
 * for a close what it receives at least at the limit chosen now, as the dialog draws it. Fees only grow while nobody
 * touches the position, so a collect that pays less was settled elsewhere; a close that pays less had its price move.
 */
function paysLess(fresh: PreparedPosition, shown: PreparedPosition, bps: number): boolean {
  if (lessIn(fresh.receive, shown.receive)) return true
  if (fresh.kind !== 'close') return false
  const { sqrtPriceX96, tickLower, tickUpper, liquidity, fees } = shown.state
  const minimums = closeMinimums(sqrtPriceX96, tickLower, tickUpper, liquidity, bps)
  return lessIn(fresh.atLeast, [minimums[0] + fees[0], minimums[1] + fees[1]])
}

/**
 * The pair's amounts as token rows (ActionSheet.tsx): each token's mark (the page's own, or the quiet mark its address
 * gives), its figure and its symbol; a dash with the reason in its title when a token's decimals are unknown, and
 * skeletons while the position is read. `lg` for what the wallet receives, `sm` for At least.
 */
function Pair({ amounts, currencies, tokens, size = 'lg', unread = null }: { amounts: readonly [bigint, bigint] | null; currencies: readonly [PositionCurrency, PositionCurrency]; tokens?: readonly [TokenDisplay, TokenDisplay] | null; size?: 'lg' | 'sm'; unread?: string | null }) {
  const markSize = size === 'lg' ? 28 : 16
  return (
    <TokenRows size={size}>
      {currencies.map((currency, index) => {
        const name = currencyName(currency)
        const token = tokens?.[index]
        const mark = token ? <TokenMark token={token} size={markSize} /> : <QuietMark address={currency.address} size={markSize} />
        const raw = amounts?.[index] ?? null
        const shown = raw === null ? null : amountText(raw, currency.decimals)
        if (raw === null) return <TokenRow key={currency.address} mark={mark} amount={unread ? <span className="dm-pa-token-amount" title={unread}>— <bdi className="dm-pa-token-symbol">{name}</bdi></span> : <Skeleton className="dm-receipt-skel" />} />
        if (!shown) return <TokenRow key={currency.address} mark={mark} amount={<span className="dm-pa-token-amount" title={`${name}’s decimals are unknown.`}>— <bdi className="dm-pa-token-symbol">{name}</bdi></span>} />
        return <TokenRow key={currency.address} mark={mark} figure={shown.text} symbol={name} title={`${shown.exact} ${name}`} />
      })}
    </TokenRows>
  )
}
const Dash = ({ reason }: { reason: string }) => <span title={reason}>—</span>

/** The dialogs' one plain line under the title. Changed on purpose 2026-10-01 (audit E5): plain words, no "liquidity" and no "NFT". */
const LEDE: Readonly<Record<Action, string>> = {
  collect: 'The fees this position has earned go to your wallet. The position stays open.',
  close: 'Your tokens and fees return to your wallet. The position, now empty, stays in your wallet.',
}

export default function PositionActions({ tokenId, owner, liquidityRaw, unsettledFeesRaw, currencies, hooks, onChanged, usd = null, tokens = null, automate = null, automationSlot = null, primary, autoExitRoot = false }: PositionActionsProps) {
  const identity = useWalletIdentity()
  const wallet = identity.kind === 'connected' ? `${identity.connectorName}|${identity.address.toLowerCase()}` : null
  const mine = wallet !== null && identity.kind === 'connected' && identity.address.toLowerCase() === owner.toLowerCase()
  const [open, setOpen] = useState<Action | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [slippage, setSlippage] = useState(String(SLIPPAGE_DEFAULT_BPS))
  const generation = useRef(0)
  const client = useRef<{ key: string; positions: PositionClient } | null>(null)
  const preparing = useRef<number | null>(null)
  const changed = useRef(onChanged)
  useEffect(() => {
    changed.current = onChanged
  }, [onChanged])
  // Another owner/provider invalidates the review. The network change requested by this dialog must not close it.
  const [seenWallet, setSeenWallet] = useState(wallet)
  if (seenWallet !== wallet) {
    setSeenWallet(wallet)
    setOpen(null)
    setRun(null)
  }
  useEffect(() => {
    generation.current++
    client.current = null
  }, [wallet])
  useEffect(() => () => void generation.current++, [])

  if (!mine) return null

  async function connect(gen: number, action: Action): Promise<{ positions: PositionClient; gas: GasBudget }> {
    const { wallet: rpc, key } = await positionWallet(owner, () => generation.current === gen, () => {
      setRun({ action, stage: 'switching', prepared: null, notice: null })
    })
    if (generation.current !== gen) throw new Error('wallet_identity_changed')
    setRun((before) => before?.stage === 'switching' ? { ...before, stage: 'reading' } : before)
    if (client.current?.key !== key) client.current = { key, positions: createPositionClient(rpc) }
    return { positions: client.current.positions, gas: await suggestGasBudget(rpc) }
  }
  async function prepareFor(action: Action, positions: PositionClient, gas: GasBudget, bps: number) {
    const id = positionTokenId(tokenId)
    return action === 'collect' ? positions.prepareCollect(id, gas) : positions.prepareClose(id, bps, gas)
  }
  const bps = slippageBpsFrom(slippage)

  /** Opens an action's dialog. A step already on its way is shown, never prepared again; otherwise the position is read fresh. */
  async function show(action: Action) {
    setOpen(action)
    if (preparing.current === generation.current) return
    if (run?.action === action && (run.stage === 'wallet' || run.stage === 'chain')) return
    const gen = ++generation.current
    preparing.current = gen
    setRun({ action, stage: 'reading', prepared: null, notice: null })
    try {
      const { positions, gas } = await connect(gen, action)
      const prepared = await prepareFor(action, positions, gas, bps ?? SLIPPAGE_DEFAULT_BPS)
      if (generation.current === gen) setRun({ action, stage: 'ready', prepared, notice: null })
    } catch (error) {
      if (generation.current === gen) setRun({ action, stage: 'failed', prepared: null, notice: failureText(error) })
    } finally {
      if (preparing.current === gen) preparing.current = null
    }
  }

  /**
   * The press: the position read and simulated once more, offered to the wallet once, then watched until it is in a
   * block. What is offered is never less than what the dialog showed: a collect with nothing left to collect stops
   * with that said, and a step that now pays less stops at its new figures for a second press.
   */
  async function confirm(action: Action) {
    if (bps === null && action === 'close') return
    if (preparing.current === generation.current) return
    const gen = ++generation.current
    preparing.current = gen
    const alive = () => generation.current === gen
    const reviewed = run?.action === action ? run.prepared : null
    let prepared = reviewed
    let sent = false
    setRun({ action, stage: 'wallet', prepared, notice: null })
    try {
      const { positions, gas } = await connect(gen, action)
      const step = await prepareFor(action, positions, gas, bps ?? SLIPPAGE_DEFAULT_BPS)
      prepared = step
      if (!alive()) return
      if (action === 'collect' && step.receive[0] === 0n && step.receive[1] === 0n) {
        // The dialog draws "There are no fees to collect right now." for this step and keeps its button off.
        setRun({ action, stage: 'ready', prepared, notice: null })
        return
      }
      if (reviewed === null || paysLess(step, reviewed, bps ?? SLIPPAGE_DEFAULT_BPS)) {
        setRun({ action, stage: 'ready', prepared, notice: { text: CHANGED, code: 'changed' } })
        return
      }
      setRun({ action, stage: 'wallet', prepared, notice: null })
      const hash = await positions.send(step, true)
      sent = true
      if (!alive()) return
      setRun({ action, stage: 'chain', prepared, notice: null })
      // RPC fix round 2: the block it was included in, so the wallet's list waits for a read at or past it (walletChanged).
      let included: bigint | undefined
      let outcome = await watchReceipt(async () => {
        const receipt = await positions.receipt(hash)
        if ('blockNumber' in receipt) included = receipt.blockNumber
        return receipt
      }, alive)
      if (outcome === 'stopped' || !alive()) return
      if (outcome === 'replaced') {
        // 2026-10-01 (audit C14): replaced in the wallet ("Speed up" or "Cancel"). The position read again says whether the
        // step happened: a sped-up one did, under another hash; a cancelled one did not. Nothing is sent again.
        const done = await readAfterReplaced(() => positions.inspect(step.tokenId), (now) => happened(action, step.state, now), alive)
        if (done === null || !alive()) return
        if (!done) {
          setRun({ action, stage: 'failed', prepared, notice: { text: REPLACED[action], code: 'replaced' } })
          return
        }
        outcome = 'included'
      }
      if (outcome === 'included') {
        setRun({ action, stage: 'done', prepared, notice: null })
        changed.current(included)
      } else setRun({ action, stage: 'failed', prepared, notice: { text: WATCHED_TEXT[outcome], code: outcome } })
    } catch (error) {
      if (!alive()) return
      // Once sent, a failure is a watch that could not conclude, never a step known to have failed.
      if (sent) setRun({ action, stage: 'failed', prepared, notice: { text: WATCHED_TEXT.unknown, code: errorCode(error) ?? 'unknown' } })
      else setRun({ action, stage: isRejection(error) ? 'ready' : 'failed', prepared, notice: failureText(error) })
    } finally {
      if (preparing.current === gen) preparing.current = null
    }
  }

  const hooked = hooks.toLowerCase() !== NO_HOOKS
  const empty = liquidityRaw === '0'
  // As the shared contract has it: nothing to collect when both reported fees are zero, or when the read service
  // reported none (unknown counts as zero). The dialog itself always reads the fees again on chain.
  const noFees = unsettledFeesRaw === null || (unsettledFeesRaw[0] === '0' && unsettledFeesRaw[1] === '0')
  const collectReason = hooked ? HOOKED : empty ? 'This position is closed: it holds no liquidity.' : unsettledFeesRaw === null ? 'The fees could not be read just now.' : noFees ? 'No fees to collect yet.' : undefined
  const pending = run !== null && (run.stage === 'switching' || run.stage === 'reading' || run.stage === 'wallet' || run.stage === 'chain')
  const shown = open && run?.action === open ? run : null
  const prepared = shown?.prepared ?? null
  const busy = shown !== null && (shown.stage === 'switching' || shown.stage === 'reading' || shown.stage === 'wallet' || shown.stage === 'chain')
  // What the close pays at least at the limit chosen now: the principal minimums at that limit and the fees.
  const minimums = open === 'close' && prepared && bps !== null
    ? closeMinimums(prepared.state.sqrtPriceX96, prepared.state.tickLower, prepared.state.tickUpper, prepared.state.liquidity, bps)
    : null
  const atLeast = minimums && prepared ? ([minimums[0] + prepared.state.fees[0], minimums[1] + prepared.state.fees[1]] as const) : null
  const nothingToCollect = open === 'collect' && prepared !== null && prepared.receive[0] === 0n && prepared.receive[1] === 0n
  const fee = prepared ? amountText(prepared.networkFeeWei, 18) : null
  // Nothing was read: the figures are dashes, with the reason one hover away.
  const unread = !prepared && shown?.stage === 'failed' ? (shown.notice?.text ?? 'The position could not be read.') : null
  const canSend = shown !== null && prepared !== null && (shown.stage === 'ready' || shown.stage === 'failed') && !nothingToCollect && !(open === 'close' && bps === null)
  // What the dialog receives in USD at the fees relay's pool price (1 USDG = $1): a line of its own, beside the pinned amounts.
  const [d0, d1] = [currencies[0].decimals, currencies[1].decimals]
  const receiveUsd = usd && prepared && d0 !== null && d1 !== null ? formatUsd(usdgValue({ amounts: prepared.receive, decimals: [d0, d1], usdgIndex: usd.usdgIndex, sqrtPriceX96: usd.sqrtPriceX96 })) : null
  const closeDialog = () => {
    if (run?.stage === 'switching' || run?.stage === 'reading') {
      generation.current++
      setRun(null)
    }
    setOpen(null)
  }

  return (
    <>
      {!__DOMINO_V2__ && <SequenceSwitch tokenId={tokenId} holder={owner} liquid={!empty} fallback={automate} />}
      <div className="dm-position-base-actions" data-position-actions={hooked ? 'hooks' : ''}>
        {/* One primary (2026-09-27, Domino's buttons): Collect fees for a plain position; for one of Domino's sequences,
            which collects and re-adds its fees itself, outlined, and the sequence's own Turn on is the primary. */}
        <Button
          type="button"
          variant={primary ? 'primary' : 'outline'}
          disabled={hooked || empty || noFees || (pending && run?.action !== 'collect')}
          title={collectReason}
          aria-busy={(pending && run?.action === 'collect') || undefined}
          aria-haspopup="dialog"
          aria-expanded={open === 'collect'}
          data-position-action="collect"
          onClick={() => void show('collect')}
        >
          <IconCollect size={18} /><span>Collect fees</span>
        </Button>
        <span className="dm-position-tools-slot" data-position-action-tools="" />
        {automationSlot}
        {!empty && (
          <Button
            type="button"
            variant="danger"
            disabled={hooked || (pending && run?.action !== 'close')}
            title={hooked ? HOOKED : undefined}
            aria-busy={(pending && run?.action === 'close') || undefined}
            aria-haspopup="dialog"
            aria-expanded={open === 'close'}
            data-position-action="close"
            onClick={() => void show('close')}
          >
            <IconClose size={18} /><span>Close position</span>
          </Button>
        )}
        {/* Changed on purpose 2026-10-03 (the owner, point 9: "literally ugly"): the dialog is the position actions' family
            (ActionSheet.tsx): the plain line under the title; what the wallet receives as token rows in a card (its USD
            value, at the pool's price, on the card's right); At least and the network fee as quiet facts under it; the
            note, the step in progress and a failure as their own lines; the slippage tolerance under a quiet Advanced at
            the foot of the body; one button. The same figures, words and hooks as before. */}
        {open && (
          <ActionSheet
            id={`position-${open}`}
            title={TITLE[open]}
            lede={LEDE[open]}
            onClose={closeDialog}
            data-position-dialog={open}
            footer={
              shown?.stage === 'done' ? (
                <Button type="button" variant="secondary" size="lg" onClick={() => setOpen(null)}>
                  Back to position
                </Button>
              ) : shown?.stage === 'failed' && !prepared ? (
                <Button type="button" variant="primary" size="lg" onClick={() => void show(open)} data-position-retry="">Try again</Button>
              ) : (
                <Button type="button" variant="primary" size="lg" disabled={!canSend} aria-busy={busy || undefined} data-position-send={open} onClick={() => void confirm(open)}>
                  {PRIMARY[open]}
                </Button>
              )
            }
          >
            <div className="dm-pa-field" data-position-receive={open}>
              <SheetCard caption="You receive" aside={receiveUsd && usd ? <span title={`Pool price at block ${usd.block}`}>{receiveUsd}</span> : undefined}>
                <Pair amounts={prepared ? prepared.receive : null} currencies={currencies} tokens={tokens} unread={unread} />
              </SheetCard>
              <SheetFacts>
                {open === 'close' && (
                  <SheetFact label="At least" data-position-at-least="">
                    {atLeast ? <Pair amounts={atLeast} currencies={currencies} tokens={tokens} size="sm" /> : prepared ? <Dash reason="Choose a slippage limit from 0.1% to 5%." /> : unread ? <Dash reason={unread} /> : <Pair amounts={null} currencies={currencies} tokens={tokens} size="sm" />}
                  </SheetFact>
                )}
                <SheetFact label="Network fee" data-position-network-fee="">
                  {fee ? <span className="tnum" title={`${fee.exact} ETH at most`}>Up to {fee.text} ETH</span> : unread ? <Dash reason={unread} /> : <Skeleton className="ml-auto h-4 w-20" />}
                </SheetFact>
              </SheetFacts>
            </div>
            {prepared?.state.hasSubscriber && !autoExitRoot && (
              <SheetNote tone="warn" data-position-warning="automation">
                {AUTOMATION}
              </SheetNote>
            )}
            {nothingToCollect && shown?.stage !== 'done' && <SheetNote data-position-nothing="">There are no fees to collect right now.</SheetNote>}
            {shown && PROGRESS[shown.stage] && (
              <SheetStatus state={shown.stage === 'done' ? 'done' : 'busy'} data-position-progress={shown.stage}>
                {PROGRESS[shown.stage]}
              </SheetStatus>
            )}
            {shown?.notice && <SheetAlert data-position-notice={shown.notice.code ?? 'said'}>{shown.notice.text}</SheetAlert>}
            {/* The slippage tolerance under a closed Advanced, as New position has it (audit E5, 2026-10-01): At least, above,
                already says what it allows. Its choices are New position's, under the same name. */}
            {open === 'close' && (
              <SheetMore label={CREATE.amount.advanced} value={bps === null ? undefined : `${CREATE.amount.slippageLabel} ${slippageWritten(bps)}`} data-close-advanced="">
                <SlippageChoice id="close-slippage" label={CREATE.amount.slippageLabel} bps={slippage} onChange={setSlippage} disabled={busy || shown?.stage === 'done'} />
              </SheetMore>
            )}
          </ActionSheet>
        )}
      </div>
    </>
  )
}
