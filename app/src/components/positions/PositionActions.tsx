import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { suggestGasBudget } from '../../finance/gas'
import { closeMinimums, createPositionClient, positionTokenId, type PositionClient, type PositionState, type PreparedPosition } from '../../finance/position'
import type { GasBudget } from '../../finance/setup'
import { setupWallet } from '../../finance/wallet'
import { errorCode, financeErrorText } from '../../finance/words'
import { CREATE } from '../../lib/create/copy'
import { SLIPPAGE_DEFAULT_BPS, slippageBpsFrom } from '../../lib/create/slippage'
import { formatUsd, usdgValue } from '../../lib/format/usd'
import type { TokenDisplay } from '../../lib/read/types'
import { useDialog } from '../../lib/useDialog'
import { useWalletIdentity, walletKey } from '../../lib/walletIdentity'
import { SlippageChoice } from '../create/SlippageChoice'
import { IconClose } from '../icons'
import { TokenMark } from '../TokenIcon'
import { Button, IconButton, KeyValue, KeyValueList, Skeleton } from '../ui'
import { SequenceSwitch } from './SequenceSwitch'
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
 * Shown only when the connected wallet, on Robinhood Chain, is the NFT's
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
  /** Collect fees is the primary button: a plain position's (2026-09-27); a sequence's is outlined. */
  primary?: boolean
}

type Action = 'collect' | 'close'
type Stage = 'reading' | 'ready' | 'wallet' | 'chain' | 'done' | 'failed'
interface Run { action: Action; stage: Stage; prepared: PreparedPosition | null; notice: { text: string; code: string | null } | null }

const NO_HOOKS = '0x0000000000000000000000000000000000000000'
const TITLE: Readonly<Record<Action, string>> = { collect: 'Collect fees', close: 'Close position' }
const PRIMARY: Readonly<Record<Action, string>> = { collect: 'Collect in wallet', close: 'Close in wallet' }
const PROGRESS: Partial<Record<Stage, string>> = { wallet: 'Confirm in your wallet…', chain: 'Waiting for the network', done: 'Done' }
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

/** One amount of one token, or a dash with the reason in its title when the token's decimals are unknown. */
function Amount({ raw, currency, token }: { raw: bigint; currency: PositionCurrency; token?: TokenDisplay }) {
  const shown = amountText(raw, currency.decimals)
  const name = currencyName(currency)
  if (!shown) return <span title={`${name}’s decimals are unknown.`}>— {name}</span>
  return (
    <span className="dm-receipt-amount tnum" title={`${shown.exact} ${name}`}>
      {token && <TokenMark token={token} size={20} />}
      {shown.text} {name}
    </span>
  )
}
const Dash = ({ reason }: { reason: string }) => <span title={reason}>—</span>
function Pair({ amounts, currencies, tokens }: { amounts: readonly [bigint, bigint] | null; currencies: readonly [PositionCurrency, PositionCurrency]; tokens?: readonly [TokenDisplay, TokenDisplay] | null }) {
  if (!amounts) return <Skeleton className="dm-receipt-skel" />
  return (
    <span className="dm-receipt-pair">
      <Amount raw={amounts[0]} currency={currencies[0]} token={tokens?.[0]} />
      <Amount raw={amounts[1]} currency={currencies[1]} token={tokens?.[1]} />
    </span>
  )
}

function ActionDialog({ action, onClose, children, footer }: { action: Action; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const dialog = useDialog(true, onClose)
  const id = `position-${action}-title`
  return createPortal(
    <div role="presentation" className="dm-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={id} className="dm-dialog dm-flow-dialog" data-position-dialog={action}>
        <div className="dm-flow-dialog-head">
          <h2 id={id} tabIndex={-1} className="dm-dialog-title outline-none">{TITLE[action]}</h2>
          <IconButton label="Close" icon={<IconClose />} variant="ghost" size="sm" className="dm-dialog-close" onClick={onClose} />
        </div>
        <div className="dm-flow-dialog-body grid gap-3">{children}</div>
        <div className="dm-flow-dialog-foot">{footer}</div>
      </div>
    </div>,
    document.body,
  )
}

export default function PositionActions({ tokenId, owner, liquidityRaw, unsettledFeesRaw, currencies, hooks, onChanged, usd = null, tokens = null, automate = null, primary }: PositionActionsProps) {
  const identity = useWalletIdentity()
  const wallet = walletKey(identity)
  const mine = wallet !== null && identity.kind === 'connected' && identity.address.toLowerCase() === owner.toLowerCase()
  const [open, setOpen] = useState<Action | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [slippage, setSlippage] = useState(String(SLIPPAGE_DEFAULT_BPS))
  const generation = useRef(0)
  const client = useRef<PositionClient | null>(null)
  const changed = useRef(onChanged)
  useEffect(() => {
    changed.current = onChanged
  }, [onChanged])
  // Another wallet or network: nothing prepared or watched for the previous one applies.
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

  async function connect(): Promise<{ positions: PositionClient; gas: GasBudget }> {
    const rpc = await setupWallet()
    if (!client.current) client.current = createPositionClient(rpc)
    return { positions: client.current, gas: await suggestGasBudget(rpc) }
  }
  async function prepareFor(action: Action, positions: PositionClient, gas: GasBudget, bps: number) {
    const id = positionTokenId(tokenId)
    return action === 'collect' ? positions.prepareCollect(id, gas) : positions.prepareClose(id, bps, gas)
  }
  const bps = slippageBpsFrom(slippage)

  /** Opens an action's dialog. A step already on its way is shown, never prepared again; otherwise the position is read fresh. */
  async function show(action: Action) {
    setOpen(action)
    if (run?.action === action && (run.stage === 'wallet' || run.stage === 'chain')) return
    const gen = ++generation.current
    setRun({ action, stage: 'reading', prepared: null, notice: null })
    try {
      const { positions, gas } = await connect()
      const prepared = await prepareFor(action, positions, gas, bps ?? SLIPPAGE_DEFAULT_BPS)
      if (generation.current === gen) setRun({ action, stage: 'ready', prepared, notice: null })
    } catch (error) {
      if (generation.current === gen) setRun({ action, stage: 'failed', prepared: null, notice: failureText(error) })
    }
  }

  /**
   * The press: the position read and simulated once more, offered to the wallet once, then watched until it is in a
   * block. What is offered is never less than what the dialog showed: a collect with nothing left to collect stops
   * with that said, and a step that now pays less stops at its new figures for a second press.
   */
  async function confirm(action: Action) {
    if (bps === null && action === 'close') return
    const gen = ++generation.current
    const alive = () => generation.current === gen
    const reviewed = run?.action === action ? run.prepared : null
    let prepared = reviewed
    let sent = false
    setRun({ action, stage: 'wallet', prepared, notice: null })
    try {
      const { positions, gas } = await connect()
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
    }
  }

  const hooked = hooks.toLowerCase() !== NO_HOOKS
  const empty = liquidityRaw === '0'
  // As the shared contract has it: nothing to collect when both reported fees are zero, or when the read service
  // reported none (unknown counts as zero). The dialog itself always reads the fees again on chain.
  const noFees = unsettledFeesRaw === null || (unsettledFeesRaw[0] === '0' && unsettledFeesRaw[1] === '0')
  const collectReason = hooked ? HOOKED : empty ? 'This position is closed: it holds no liquidity.' : unsettledFeesRaw === null ? 'The fees could not be read just now.' : noFees ? 'No fees to collect yet.' : undefined
  const pending = run !== null && (run.stage === 'wallet' || run.stage === 'chain')
  const shown = open && run?.action === open ? run : null
  const prepared = shown?.prepared ?? null
  const busy = shown !== null && (shown.stage === 'reading' || shown.stage === 'wallet' || shown.stage === 'chain')
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

  return (
    <>
      <SequenceSwitch tokenId={tokenId} holder={owner} liquid={!empty} fallback={automate} />
      <div className="flex flex-wrap items-center gap-2" data-position-actions={hooked ? 'hooks' : ''}>
        {/* One primary (2026-09-27, Domino's buttons): Collect fees for a plain position; for one of Domino's sequences,
            which collects and re-adds its fees itself, outlined, and the sequence's own Turn on is the primary. */}
        <Button
          type="button"
          variant={primary ? 'primary' : 'outline'}
          disabled={hooked || empty || noFees || (pending && run?.action !== 'collect')}
          title={collectReason}
          aria-busy={(pending && run?.action === 'collect') || undefined}
          data-position-action="collect"
          onClick={() => void show('collect')}
        >
          Collect fees
        </Button>
        {!empty && (
          <Button
            type="button"
            variant="danger"
            disabled={hooked || (pending && run?.action !== 'close')}
            title={hooked ? HOOKED : undefined}
            aria-busy={(pending && run?.action === 'close') || undefined}
            data-position-action="close"
            onClick={() => void show('close')}
          >
            Close position
          </Button>
        )}
        {open && (
          <ActionDialog
            action={open}
            onClose={() => setOpen(null)}
            footer={
              shown?.stage === 'done' ? (
                <Button type="button" variant="outline" size="lg" className="w-full" onClick={() => setOpen(null)}>
                  Back to position
                </Button>
              ) : (
                <Button type="button" variant="primary" size="lg" className="w-full" disabled={!canSend} aria-busy={busy || undefined} data-position-send={open} onClick={() => void confirm(open)}>
                  {PRIMARY[open]}
                </Button>
              )
            }
          >
            <p className="dm-receipt-lede">
              {/* Changed on purpose 2026-10-01 (audit E5): plain words, no "liquidity" and no "NFT" on the dialog. */}
              {open === 'collect'
                ? 'The fees this position has earned go to your wallet. The position stays open.'
                : 'Your tokens and fees return to your wallet. The position, now empty, stays in your wallet.'}
            </p>
            <KeyValueList className="dm-receipt" data-position-receive={open}>
              <KeyValue label="You receive">
                {prepared || !unread ? <Pair amounts={prepared ? prepared.receive : null} currencies={currencies} tokens={tokens} /> : <Dash reason={unread} />}
              </KeyValue>
              {receiveUsd && usd && (
                <p className="dm-usd-line" title={`Pool price at block ${usd.block}`}>
                  {receiveUsd}
                </p>
              )}
              {open === 'close' && (
                <KeyValue label="At least" data-position-at-least="">
                  {atLeast ? <Pair amounts={atLeast} currencies={currencies} tokens={tokens} /> : prepared ? <Dash reason="Choose a slippage limit from 0.1% to 5%." /> : unread ? <Dash reason={unread} /> : <Pair amounts={null} currencies={currencies} />}
                </KeyValue>
              )}
              <KeyValue label="Network fee" data-position-network-fee="">
                {fee ? <span className="tnum" title={`${fee.exact} ETH at most`}>Up to {fee.text} ETH</span> : unread ? <Dash reason={unread} /> : <Skeleton className="ml-auto h-4 w-20" />}
              </KeyValue>
            </KeyValueList>
            {/* The slippage tolerance under a closed Advanced, as New position has it (audit E5, 2026-10-01): At least, above,
                already says what it allows. Its choices are New position's, under the same name. */}
            {open === 'close' && (
              <details className="dm-details dm-flow-advanced" data-close-advanced="">
                <summary>
                  <span>{CREATE.amount.advanced}</span>
                </summary>
                <SlippageChoice id="close-slippage" label={CREATE.amount.slippageLabel} bps={slippage} onChange={setSlippage} disabled={busy || shown?.stage === 'done'} />
              </details>
            )}
            {prepared?.state.hasSubscriber && (
              <p className="text-body text-fg-muted" data-position-warning="automation">
                {AUTOMATION}
              </p>
            )}
            {nothingToCollect && shown?.stage !== 'done' && (
              <p className="text-body text-fg-muted" data-position-nothing="">
                There are no fees to collect right now.
              </p>
            )}
            {shown && PROGRESS[shown.stage] && (
              <p role="status" className="text-body font-medium text-fg" data-position-progress={shown.stage}>
                {PROGRESS[shown.stage]}
              </p>
            )}
            {shown?.notice && (
              <p role="alert" className="text-body text-fg-muted" data-position-notice={shown.notice.code ?? 'said'}>
                {shown.notice.text}
              </p>
            )}
          </ActionDialog>
        )}
      </div>
    </>
  )
}
