import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Address, Hex } from 'viem'
import { personRefused } from '../../finance/nonce'
import { settleStep } from '../../finance/receiptWait'
import { connectWithdrawal, readMoreReserves, readOwnerReserves, reservesChanged, watchReservesChanged, type ReserveWithdrawalKit } from '../../finance/reservesLive'
import { RESERVE_VAULT_CAP, RESERVE_VAULT_PAGE, type FeeWithdrawal, type FeeWithdrawalRecord, type PreparedWithdrawBatch, type VaultReserves } from '../../finance/sequence'
import { errorCode, financeErrorText } from '../../finance/words'
import {
  RESERVE_PAGE_GAP_MS,
  RESERVE_STATUS_TEXT,
  heldVaults,
  holdMore,
  holdReserves,
  nextReserveRead,
  reserveReaskMs,
  reserveStatus,
  reserveTotals,
  sameWithdrawals,
  stillChecking,
  vaultsFor,
  vaultsWithReserves,
  withdrawalPlan,
  withdrawalTotals,
  withdrawals,
  type ReserveHold,
  type ReserveTotal,
} from '../../lib/automate/reserves'
import { chainToken } from '../../lib/chainTokens'
import { formatUnits } from '../../lib/read/decimal'
import { useReadSource } from '../../lib/read/screens/readContext'
import { whenVisibleAfter } from '../../lib/read/screens/quietRead'
import { readWithin } from '../../lib/read/screens/screenRead'
import { useWalletIdentity, walletKey } from '../../lib/walletIdentity'
import { CopyButton } from '../read/screens/CopyButton'
import { Button, Skeleton } from '../ui'
import { ActionSheet, SheetAlert, SheetCard, SheetFact, SheetFacts, SheetNote, SheetStatus, TokenRow, TokenRows } from './ActionSheet'
import { QuietMark, QuietMarkPair } from './visual/QuietMarks'
import { amountText, outcomeUnknown, readAfterReplaced, RECEIPT_EVERY_MS, RECEIPT_WAIT_MS } from './walletSteps'

/*
 * Fees waiting in your vault (2026-10-02; rugged97's spec rev3 §2.13, the V1 incident of that day): an owner closed his
 * vault's root position, and the fees its automation had collected and not yet reinvested (the vault's fee reserves)
 * stayed in the vault with no screen offering them back. They are shown here whenever any is above zero, whatever became
 * of the root (armed, stopped, closed, burned, moved to another wallet) and with the vault paused: on the Positions
 * screen, every vault the connected wallet created; on a vault-managed position's page, that position's vault; on the
 * page of a position NFT that no longer exists, the vault whose root it was.
 *
 * Each vault's row has Withdraw to wallet. Its dialog reads the vault again through the wallet and shows exactly what
 * comes back, per token (no USD: nothing here is a price), with the owner's approved words, then the withdrawals: one
 * transaction per balance, as the contract takes them (withdrawFeeReserves), or one batch (EIP-5792) for a wallet that
 * executes batches atomically now. Everything a money step keeps holds (finance/sequence.ts): exact calls, the nonce
 * latch, a sent step never sent again, the wallet's account and network checked on every request up to the send, and
 * the vault read again before each press, so a part already withdrawn is never offered twice.
 *
 * Changed on purpose 2026-10-02 (review of the fee withdrawal):
 * - finding 1: a withdrawal the wallet replaced counts only by the vault's own record of it (FeeReservesWithdrawn), never
 *   by its balance, which an automation run lowers and a fee credited raises; with no record the outcome is said to be
 *   unknown. So does a batch the wallet no longer answers for;
 * - finding 4: the receipt lists the transactions that paid: a batch's (from the wallet's receipt or the vault's record),
 *   and for a step the wallet sped up, the one that took its place, never the hash the chain never included;
 * - findings 2, 6 and 8: every vault the wallet created is looked in, a page at a time; a vault whose read fails keeps
 *   its last good read on screen and is asked again on its own for as long as the page is open (changed on purpose
 *   2026-10-15, pack 7, the owner: no status notices: no line says some are still being checked any more);
 * - finding 7: a token whose name could not be read is shown in its smallest units, every digit, and the review cannot
 *   be sent while any amount in it is still unnamed.
 *
 * Opened lazily by Positions and a position's page in wallet builds only, for the connected wallet on Robinhood Chain.
 */

export interface FeeReservesProps {
  /** The connected wallet, lowercase. Nothing is shown unless it is connected on Robinhood Chain. */
  owner: string
  /** Positions: every vault the wallet created. A position's page: its vault (`vault`), or the vault whose root is the page's NFT (`root`). */
  placement: 'positions' | 'position'
  vault?: string
  root?: string
}

/** The owner's words (rugged97's spec rev3 §5.6, approved by the owner). */
const RESERVES_LEDE = 'Fees the automation collected and had not reinvested yet. They’re yours: withdrawing charges no Domino fee.'
const TITLE = 'Fees waiting in your automation'
const ACTION = 'Withdraw to wallet'
const NATIVE = '0x0000000000000000000000000000000000000000'

type Stage = 'reading' | 'ready' | 'wallet' | 'chain' | 'done' | 'failed'
interface Notice {
  text: string
  code: string | null
}
interface Review {
  vault: Address
  rows: readonly FeeWithdrawal[]
  totals: readonly ReserveTotal[]
  plan: 'batch' | 'steps'
  /** The most network fee the first step (or the batch) may cost, in wei. */
  feeWei: bigint
}
interface Run {
  vault: Address
  base: string
  quote: string
  stage: Stage
  review: Review | null
  /** Steps only: which of the review's rows is in the wallet or on its way (0-based). */
  at: number
  /** The transactions sent by this press, and what reached the wallet. */
  hashes: readonly Hex[]
  received: readonly ReserveTotal[]
  notice: Notice | null
}

const PROGRESS: Partial<Record<Stage, string>> = { wallet: 'Confirm in your wallet…', chain: 'Waiting for the network' }
const CHANGED = 'The amounts changed since you opened this. Check them, then press again.'
/** Said in this card's own words; any other code goes through finance/words.ts. */
const OWN: Readonly<Record<string, string>> = {
  empty: 'Nothing is waiting in this automation now.',
  fee_reserve_insufficient: CHANGED,
  invalid_fee_withdrawal: CHANGED,
  sequence_preparation_changed: CHANGED,
  pending_wallet_transaction: 'Your wallet has a transaction waiting. Let it finish, then try again.',
  native_gas_reserve_insufficient: 'Your ETH does not cover the network fee for this withdrawal. Nothing was sent.',
  gas_budget_exceeded: 'This withdrawal needs more gas than expected. Nothing was sent. Try again in a moment.',
  wallet_identity_changed: 'Your wallet account or network changed. Nothing was sent.',
  connect_robinhood_wallet: 'Connect your wallet on Robinhood Chain first.',
  sequence_admission_unavailable: 'Your automation can’t be checked on this page right now. Nothing was sent: your fees stay in your automation.',
  sequence_step_reverted: 'The withdrawal reverted on chain. Your fees are still in your automation; only network gas was spent.',
  sequence_step_reorged: 'The block that held the withdrawal left the chain. Check your wallet activity before trying again.',
  sequence_receipt_waiting: 'The withdrawal is still waiting to be included. Check your wallet activity: nothing is sent twice.',
  reserve_withdrawal_replaced:
    'Your wallet replaced the withdrawal with another transaction. Your automation shows no record of paying these fees, so the outcome is unknown. Check your wallet activity before trying again: your automation is read first, and nothing is sent twice.',
  batch_already_offered: 'A withdrawal of these fees is already waiting in your wallet. Check your wallet activity: nothing is sent twice.',
  batch_upgrade_declined: 'You declined turning on your wallet’s smart account. Nothing was sent.',
  batch_simulation_reverted: 'The withdrawal would fail on chain now. Nothing was sent. Try again in a moment.',
  batch_coordination_unavailable: 'This browser cannot keep track of a batch here. Nothing was sent.',
  reserve_batch_dropped: 'Your wallet did not include the withdrawal. Your fees are still in your automation. Press Withdraw in wallet again.',
  reserve_batch_reverted: 'The withdrawal reverted on chain. Your fees are still in your automation; only network gas was spent.',
  reserve_batch_unknown: 'The withdrawal’s outcome could not be read. Check your wallet activity before trying again: your automation is read first, and nothing is sent twice.',
  reserve_batch_waiting: 'The withdrawal is still waiting to be included. Check your wallet activity: nothing is sent twice.',
  review_required: 'The review expired before it reached your wallet. Nothing was sent. Press Withdraw in wallet again.',
  wallet_review_expired: 'The review expired before it reached your wallet. Nothing was sent. Press Withdraw in wallet again.',
}
/** Codes that mean the review no longer holds: the dialog reads the vault again and shows the new figures. */
const REVIEW_AGAIN = new Set(['fee_reserve_insufficient', 'invalid_fee_withdrawal', 'sequence_preparation_changed'])
/**
 * The checks a send makes before the wallet is asked (finance/sequence.ts send, sendWithdrawBatch, ./batch.ts
 * offerBatch): failing one, the wallet never saw the step, whatever wraps the failure.
 */
const BEFORE_WALLET = new Set([
  'review_required', 'wallet_review_expired', 'wallet_request_open', 'pending_wallet_transaction', 'sequence_preparation_changed',
  'fee_reserve_insufficient', 'invalid_fee_withdrawal', 'deployment_code_changed', 'deployment_identity_changed', 'chain_changed',
  'native_eth_refused', 'batch_already_offered', 'batch_coordination_unavailable', 'wallet_action_busy', 'unqualified_sequence',
])
/** Once a press sent anything, no sentence may claim that nothing was sent: such a clause is left out. */
const NOTHING = / ?(?:No (?:wallet )?transaction|Nothing) was \w+(?:[^.]*)\./g
/** Said after any failure of a press that already put part of the fees in the wallet. */
const PART = 'The fees withdrawn before this are in your wallet; the rest stays in your automation.'

/** A failure while a step was offered to the wallet, kept apart from the reads and the preparation before it. */
class Offered extends Error {
  constructor(readonly inner: unknown) {
    super('offered')
  }
}

/**
 * A press's failure in words. `sent`: the step that failed had already gone to the network (its hash, or a batch's id,
 * was given), so the sentence says what is known of it. `landed`: earlier steps of the press are in, so it says so, and
 * never that nothing was sent.
 */
function noticeFor(error: unknown, sent: boolean, landed: number): Notice {
  const offered = error instanceof Offered
  const inner = offered ? error.inner : error
  const code = errorCode(inner)
  const declined = offered && personRefused(inner)
  let text: string
  if (declined) text = 'You declined in your wallet. Nothing was sent.'
  else if (code !== null && Object.hasOwn(OWN, code)) text = OWN[code]
  else if (sent) text = outcomeUnknown('withdrawal')
  else if (offered && (code === null || !BEFORE_WALLET.has(code)))
    text = 'Your wallet may or may not have sent it. Check your wallet activity before trying again. This step won’t be offered twice, even after a reload.'
  else text = financeErrorText(code, 'Your automation could not be read just now. Nothing was sent. Try again in a moment.', 'Withdraw to wallet')
  if (landed > 0) text = `${text.replace(NOTHING, '').trim()} ${PART}`.trim()
  return { text, code: declined ? 'declined' : code }
}

/* ---- Token names: this visit's chain reads first, then the read path (read-v1 `token`), as Receipts names its tokens ---- */

interface TokenName {
  symbol: string | null
  decimals: number | null
}
const names = new Map<string, TokenName>()
const asking = new Set<string>()
const nameListeners = new Set<() => void>()
const told = () => {
  for (const listener of nameListeners) listener()
}

/**
 * The read path's tries for a token's name: three, 5 and 10 s apart, and then, while the visit lasts, a few more a
 * minute or two apart. After the third, a token still unnamed is shown in its smallest units, every digit (2026-10-02,
 * review finding 7: it stayed a skeleton for the rest of the visit, in the card and in the review, which could be sent).
 */
const NAME_WAITS_MS = [0, 5_000, 10_000, 60_000, 120_000, 120_000] as const
const RAW_AFTER = 3

/** Each token's symbol and decimals: ETH, a token this visit's chain reads named, or one asked of the read path (NAME_WAITS_MS). */
function useTokenNames(addresses: readonly string[]): ReadonlyMap<string, TokenName> {
  const source = useReadSource()
  const [, setTick] = useState(0)
  const wanted = [...new Set(addresses.map((address) => address.toLowerCase()))].sort().join(',')
  useEffect(() => {
    const listener = () => setTick((n) => n + 1)
    nameListeners.add(listener)
    return () => {
      nameListeners.delete(listener)
    }
  }, [])
  useEffect(() => {
    if (!wanted) return
    let named = false
    for (const address of wanted.split(',')) {
      if (names.has(address)) continue
      const token = address === NATIVE ? { symbol: 'ETH', decimals: 18 } : chainToken(address)
      if (token) {
        names.set(address, { symbol: token.symbol, decimals: token.decimals })
        named = true
      }
    }
    if (named) queueMicrotask(told)
    if (!source) return
    // Never cancelled: a token's details are kept for the whole visit (`names`), for every card that names it.
    const signal = new AbortController().signal
    for (const address of wanted.split(',')) {
      if (names.has(address) || asking.has(address)) continue
      asking.add(address)
      void (async () => {
        for (const [tries, wait] of NAME_WAITS_MS.entries()) {
          if (tries === RAW_AFTER && !names.has(address)) {
            // Not named yet, and may be later: every digit in its smallest units meanwhile, never a skeleton.
            names.set(address, { symbol: null, decimals: null })
            told()
          }
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
          const outcome = await readWithin(source, 'token', { token: address }, { signal })
          if (outcome.state === 'ok') {
            const asset = outcome.data.asset
            names.set(address, { symbol: asset.symbol, decimals: asset.displayUnitsAvailable ? asset.decimals : null })
            break
          }
          const passing = outcome.state === 'busy' || outcome.state === 'local' || (outcome.state === 'unavailable' && outcome.retryable)
          if (!passing) break
        }
        if (!names.has(address)) names.set(address, { symbol: null, decimals: null })
        asking.delete(address)
        told()
      })()
    }
  }, [source, wanted])
  return names
}

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

/** One token's amount, every digit of it (the exact amount the vault pays), or its smallest units when its decimals are unknown. */
function Amount({ amount, currency, names }: { amount: bigint; currency: string; names: ReadonlyMap<string, TokenName> }) {
  const token = names.get(currency.toLowerCase())
  const name = token?.symbol ?? (currency === NATIVE ? 'ETH' : shortAddress(currency))
  if (!token) return <Skeleton className="dm-reserves-skel" />
  const units = token.decimals !== null ? formatUnits(amount.toString(), token.decimals) : null
  if (units?.kind === 'units')
    return (
      <span className="dm-reserves-amount tnum" title={`${units.text} ${name}`} data-reserve-currency={currency} data-reserve-raw={amount.toString()}>
        {units.text} <bdi>{name}</bdi>
      </span>
    )
  const raw = formatUnits(amount.toString(), null)
  return (
    <span className="dm-reserves-amount tnum" title={`${name}’s decimals are unknown: the amount in its smallest units.`} data-reserve-currency={currency} data-reserve-raw={amount.toString()} data-amount="raw">
      {raw?.text ?? amount.toString()} units of <bdi>{name}</bdi>
    </span>
  )
}

function Amounts({ totals, names }: { totals: readonly ReserveTotal[]; names: ReadonlyMap<string, TokenName> }) {
  return (
    <span className="dm-reserves-amounts">
      {totals.map((total, index) => (
        <span key={total.currency} className="dm-reserves-amount-item">
          {index > 0 && <span aria-hidden="true"> · </span>}
          <Amount amount={total.amount} currency={total.currency} names={names} />
        </span>
      ))}
    </span>
  )
}

/* ---- The owner's reserves, read on their own ---- */

/**
 * What the card holds of the owner's vaults: nothing to read with (`none`), nothing read yet because every read so far
 * failed (`failed`), or what was read (`ready`). `misses`: the reads in a row that failed, whole or for some vault.
 */
type ReservesView = { kind: 'none'; reason: string } | { kind: 'failed'; reason: string; misses: number } | { kind: 'ready'; held: ReserveHold<VaultReserves>; misses: number }

/**
 * (2026-10-15, pack 7: the owner saw "Fees waiting in your automation" come and go on Positions, saying "Your automation
 * couldn't be checked for fees just now"): what this visit last read of an owner's vaults, per owner and card filter,
 * kept outside the card. The card lost everything it held whenever it left the screen (another page, the wallet
 * reconnecting), and on its way back it showed nothing until the wallet's reads went through, which they often do not at
 * once (a node of the wallet's RPC that has not seen the read's block yet answers "header not found"). It paints from
 * here at once now, and goes on reading in the background. A withdrawal drops it with the reads kept for that owner.
 */
const lastHeld = new Map<string, ReserveHold<VaultReserves>>()
const heldKey = (owner: string, vault: string | undefined) => `${owner}|${vault?.toLowerCase() ?? '*'}`
watchReservesChanged((who) => {
  for (const key of lastHeld.keys()) if (key.startsWith(`${who}|`)) lastHeld.delete(key)
})
/** The view a card for `owner` starts from: what this visit last read for it, or nothing yet. */
function startView(owner: string | null, vault: string | undefined): ReservesView | null {
  const held = owner === null ? undefined : lastHeld.get(heldKey(owner, vault))
  return held ? { kind: 'ready', held, misses: 0 } : null
}
/**
 * (2026-10-15, pack 7): answers of "nothing to read with" that only say the wallet was not ready for this read (between
 * networks, or reconnecting), while the screen still shows it connected on Robinhood Chain (this card is not drawn
 * otherwise): a read that did not go through, asked again later, never a reason to drop what is on screen.
 */
const WALLET_PASSING = new Set(['connect_robinhood_wallet'])

/**
 * The owner's reserves for this card: the first page of its vaults read when it mounts (a read under a minute old is
 * shared), then each later page at once, one after the other, and again whenever a withdrawal changed them. A vault
 * whose read failed keeps its last good read (lib/automate/reserves.ts holdMore) and is asked again on its own, while the
 * page is visible, after reserveReaskMs, for as long as the page is open; so is a read that failed whole. Changed on
 * purpose 2026-10-15 (pack 7): it starts from what this visit last read for the same owner (lastHeld), and a read that
 * fails never takes away what is on screen.
 */
function useReserves(owner: string | null, vault: string | undefined): ReservesView | null {
  const [view, setView] = useState<ReservesView | null>(() => startView(owner, vault))
  const [seen, setSeen] = useState(`${owner ?? ''}|${vault ?? ''}`)
  if (seen !== `${owner ?? ''}|${vault ?? ''}`) {
    setSeen(`${owner ?? ''}|${vault ?? ''}`)
    setView(startView(owner, vault))
  }
  useEffect(() => {
    if (owner === null) return
    let live = true
    let held: ReserveHold<VaultReserves> | null = lastHeld.get(heldKey(owner, vault)) ?? null
    let misses = 0
    let cancel: (() => void) | null = null
    // Each read started counts; an answer to one that a newer read replaced is dropped.
    let asked = 0
    // (2026-10-15, pack 7 review): the vaults whose figures held here were read before the last withdrawal (the
    // reservesChanged that dropped lastHeld). Until each is read again, what is held may stand on screen (as main) but is
    // never written back into lastHeld, so a later visit never paints fees already withdrawn.
    let carried = new Set<string>()
    const reread = (found: readonly VaultReserves[]) => { for (const view of found) carried.delete(view.vault.toLowerCase()) }
    const later = (ms: number, run: () => void) => {
      cancel?.()
      cancel = whenVisibleAfter(ms, run)
    }
    /** What is held, on screen; nothing kept for a later visit (2026-10-15, pack 7 review: paint apart from persist). */
    const paint = () => {
      if (held) setView({ kind: 'ready', held, misses })
    }
    /** After a read that answered: on screen, and kept for a later visit unless some of it predates the last withdrawal. */
    const show = () => {
      if (!held) return
      if (carried.size === 0) lastHeld.set(heldKey(owner, vault), held)
      paint()
    }
    /**
     * A read that did not go through: what is held stays on screen as it is, and it is asked again after reserveReaskMs.
     * Changed 2026-10-15 (pack 7 review): it paints only; it never writes lastHeld, which a withdrawal may have just dropped.
     */
    const missed = (reason: string, again: () => void) => {
      const wait = reserveReaskMs(misses)
      misses += 1
      if (held) paint()
      else setView({ kind: 'failed', reason, misses })
      later(wait, again)
    }
    /** Nothing to read with (no deployment, no vault of this wallet's): nothing held is kept, for this card or a later one. */
    const nothing = (reason: string) => {
      held = null
      carried = new Set()
      lastHeld.delete(heldKey(owner, vault))
      setView({ kind: 'none', reason })
    }
    /** What comes after a read: the next page after a short gap, or the vaults whose read failed after a longer wait. */
    const onward = () => {
      if (!held) return
      const next = nextReserveRead(held, RESERVE_VAULT_PAGE)
      if (next === null) {
        misses = 0
        show()
        return
      }
      if (next.again) {
        const wait = reserveReaskMs(misses)
        misses += 1
        show()
        later(wait, () => more(next.vaults))
      } else later(RESERVE_PAGE_GAP_MS, () => more(next.vaults))
    }
    const first = (fresh: boolean) => {
      cancel?.()
      cancel = null
      const mine = ++asked
      void readOwnerReserves(owner, (vault ?? null) as Address | null, fresh).then((answer) => {
        if (!live || mine !== asked) return
        if (answer.kind === 'ready') {
          held = holdReserves(held, answer)
          reread(answer.vaults)
          const listed = new Set(held.order)
          carried = new Set([...carried].filter((at) => listed.has(at)))
          show()
          onward()
          return
        }
        if (answer.kind === 'none' && !WALLET_PASSING.has(answer.reason)) {
          nothing(answer.reason)
          return
        }
        missed(answer.reason, () => first(true))
      })
    }
    const more = (vaults: readonly string[]) => {
      const mine = ++asked
      void readMoreReserves(owner, vaults as Address[]).then((answer) => {
        if (!live || mine !== asked || !held) return
        if (answer.kind === 'none') {
          if (WALLET_PASSING.has(answer.reason)) missed(answer.reason, () => more(vaults))
          else nothing(answer.reason)
          return
        }
        held = holdMore(held, vaults, answer.kind === 'ready' ? answer : { vaults: [], failed: vaults })
        if (answer.kind === 'ready') reread(answer.vaults)
        show()
        onward()
      })
    }
    first(false)
    const stop = watchReservesChanged((who) => {
      if (who !== owner) return
      misses = 0
      carried = new Set(held?.views.keys() ?? [])
      first(false)
    })
    return () => {
      live = false
      cancel?.()
      stop()
    }
  }, [owner, vault])
  return view
}

/* ---- The dialog ---- */

/** The amounts as token rows (ActionSheet.tsx): each token's quiet mark (from its address, no request), then its amount. */
function AmountRows({ totals, names, size = 'lg' }: { totals: readonly ReserveTotal[]; names: ReadonlyMap<string, TokenName>; size?: 'lg' | 'sm' }) {
  return (
    <TokenRows size={size}>
      {totals.map((total) => (
        <TokenRow key={total.currency} mark={<QuietMark address={total.currency} size={size === 'lg' ? 28 : 16} />} amount={<Amount amount={total.amount} currency={total.currency} names={names} />} />
      ))}
    </TokenRows>
  )
}

/**
 * Changed on purpose 2026-10-03 (the owner, point 9: the position dialogs were "literally ugly"): the position actions'
 * family (ActionSheet.tsx): what comes back as token rows in a card, the fees as quiet facts, the wallet's plan, the step
 * in progress and a failure as their own lines, one button. The same figures, words and hooks as before.
 */
function WithdrawDialog({ run, names, onClose, onConfirm }: { run: Run; names: ReadonlyMap<string, TokenName>; onClose: () => void; onConfirm: () => void }) {
  const { stage, review } = run
  const busy = stage === 'reading' || stage === 'wallet' || stage === 'chain'
  const done = stage === 'done'
  const count = review?.rows.length ?? 0
  const fee = review ? amountText(review.feeWei, 18) : null
  // Every amount of the review shown, in its token's units or in its smallest ones, before it can be sent (finding 7).
  const shown = review !== null && review.totals.every((total) => names.has(total.currency.toLowerCase()))
  const canSend = review !== null && shown && (stage === 'ready' || stage === 'failed')
  const progress = PROGRESS[stage]
  const step = review?.plan === 'steps' && count > 1 && (stage === 'wallet' || stage === 'chain') ? ` (${run.at + 1} of ${count})` : ''
  return (
    <ActionSheet
      id="reserves-dialog"
      title={done ? 'Returned to your wallet' : ACTION}
      lede={done ? 'These fees are in your wallet now. No Domino fee was taken.' : RESERVES_LEDE}
      onClose={onClose}
      data-reserves-dialog={stage}
      footer={
        done ? (
          <Button type="button" variant="secondary" size="lg" onClick={onClose}>
            Done
          </Button>
        ) : (
          <Button type="button" variant="primary" size="lg" disabled={!canSend} aria-busy={busy || undefined} data-reserves-send={run.vault} onClick={onConfirm}>
            Withdraw in wallet
          </Button>
        )
      }
    >
      {done ? (
        <div className="dm-pa-field" data-reserves-receipt="">
          <SheetCard caption="You received">
            <AmountRows totals={run.received} names={names} />
          </SheetCard>
          <SheetFacts>
            <SheetFact label="Domino fee">None</SheetFact>
            {run.hashes.map((hash, index) => (
              <SheetFact key={hash} label={run.hashes.length > 1 ? `Transaction ${index + 1}` : 'Transaction'} data-reserves-transaction={hash}>
                <span className="dm-pa-pair-name">
                  <span className="dm-hex" title={hash} translate="no">
                    {shortAddress(hash)}
                  </span>
                  <CopyButton value={hash} label="Copy transaction hash" />
                </span>
              </SheetFact>
            ))}
          </SheetFacts>
        </div>
      ) : (
        <>
          <div className="dm-pa-field" data-reserves-review="">
            <SheetCard caption="You receive">
              {review ? (
                <AmountRows totals={review.totals} names={names} />
              ) : stage === 'failed' ? (
                <p className="dm-pa-hero" title={run.notice?.text}>
                  —
                </p>
              ) : (
                <TokenRows>
                  <TokenRow amount={<Skeleton className="dm-receipt-skel" />} />
                </TokenRows>
              )}
            </SheetCard>
            <SheetFacts>
              <SheetFact label="Domino fee">None</SheetFact>
              <SheetFact label="Network fee" data-reserves-network-fee="">
                {fee ? (
                  <span className="tnum" title={`${fee.exact} ETH at most${review?.plan === 'steps' && count > 1 ? ' for each transaction' : ''}`}>
                    Up to {fee.text} ETH{review?.plan === 'steps' && count > 1 ? ' each' : ''}
                  </span>
                ) : stage === 'failed' ? (
                  <span title={run.notice?.text}>—</span>
                ) : (
                  <Skeleton className="ml-auto h-4 w-20" />
                )}
              </SheetFact>
            </SheetFacts>
          </div>
          {review && review.plan === 'steps' && count > 1 && (
            <SheetNote data-reserves-steps={String(count)}>Your wallet asks you to confirm {count} transactions, one after the other: your automation pays each balance on its own.</SheetNote>
          )}
          {review?.plan === 'batch' && <SheetNote data-reserves-batch="">One signature in your wallet: everything comes back together, or nothing does.</SheetNote>}
        </>
      )}
      {progress && (
        <SheetStatus data-reserves-progress={stage}>
          {progress}
          {step}
        </SheetStatus>
      )}
      {run.notice && <SheetAlert data-reserves-notice={run.notice.code ?? 'said'}>{run.notice.text}</SheetAlert>}
    </ActionSheet>
  )
}

/**
 * Reads a sent batch until it is known withdrawn, with the transaction that carried it when the wallet or the vault names
 * one; throws when it cannot, and stops quietly (null) once the page moved on.
 */
async function settleBatch(kit: ReserveWithdrawalKit, id: string, prepared: PreparedWithdrawBatch, alive: () => boolean): Promise<{ hash: Hex | null } | null> {
  const until = Date.now() + RECEIPT_WAIT_MS
  for (let beat = 0; ; beat++) {
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_EVERY_MS))
    if (!alive()) return null
    let outcome: Awaited<ReturnType<ReserveWithdrawalKit['client']['withdrawBatchStatus']>> | null = null
    try {
      outcome = await kit.client.withdrawBatchStatus(id, prepared)
    } catch (error) {
      if (Date.now() > until) throw error
    }
    if (!alive()) return null
    if (outcome?.state === 'withdrawn') return { hash: outcome.hash }
    if (outcome?.state === 'dropped') throw new Error('reserve_batch_dropped')
    if (outcome?.state === 'reverted') throw new Error('reserve_batch_reverted')
    if (outcome?.state === 'unknown') throw new Error('reserve_batch_unknown')
    if (Date.now() > until) throw new Error('reserve_batch_waiting')
  }
}

/* ---- The card ---- */

/** The automation's state for a vault's row, quietly beside its position. */
function StatusWord({ view }: { view: VaultReserves }) {
  const status = reserveStatus(view)
  return (
    <span className="dm-reserves-status" data-reserve-status={status}>
      {RESERVE_STATUS_TEXT[status]}
    </span>
  )
}

export default function FeeReserves({ owner, placement, vault, root }: FeeReservesProps) {
  const identity = useWalletIdentity()
  const key = walletKey(identity)
  const mine = key !== null && identity.kind === 'connected' && identity.address.toLowerCase() === owner.toLowerCase()
  const read = useReserves(mine ? owner.toLowerCase() : null, vault)
  const [run, setRun] = useState<Run | null>(null)
  // Whether the dialog is open. Closing it while a press is on its way leaves the press going; its row reopens it.
  const [dialogOpen, setDialogOpen] = useState(false)
  const generation = useRef(0)
  const running = useRef(false)
  useEffect(() => () => void generation.current++, [])
  // Another wallet or network: nothing a press said for the previous one applies.
  const [seenKey, setSeenKey] = useState(key)
  if (seenKey !== key) {
    setSeenKey(key)
    setRun(null)
    setDialogOpen(false)
  }
  useEffect(() => {
    generation.current++
    running.current = false
  }, [key])

  const all = read?.kind === 'ready' ? vaultsFor(heldVaults(read.held), { vault, root }) : []
  const shown = mine ? vaultsWithReserves(all) : []
  const names = useTokenNames([...shown.flatMap((view) => [view.baseCurrency, view.quoteCurrency]), ...(run ? [run.base, run.quote] : [])])

  if (!mine) return null
  const pressing = run !== null && (run.stage === 'wallet' || run.stage === 'chain')
  // Vaults still being looked in: a page not read yet, or a vault every read of which failed so far.
  const checking = read?.kind === 'ready' ? stillChecking(read.held) : 0
  const misses = read?.kind === 'ready' || read?.kind === 'failed' ? read.misses : 0
  const beyond = read?.kind === 'ready' && read.held.beyond

  /** Reads the vault again through the wallet and prepares what the review shows: a batch's network fee, or the first step's. */
  async function review(kit: ReserveWithdrawalKit, at: Address): Promise<Review | null> {
    const rows = withdrawals(await kit.reserves(at)) as FeeWithdrawal[]
    if (rows.length === 0) return null
    let plan = withdrawalPlan(rows.length, rows.length >= 2 ? await kit.atomic() : null)
    let feeWei = 0n
    if (plan === 'batch') {
      try {
        const prepared = await kit.client.prepareWithdrawBatch(at, rows, kit.gas)
        feeWei = prepared.gasLimit * kit.gas.maxFeePerGas
      } catch (error) {
        if (errorCode(error) !== 'batch_simulation_unavailable') throw error
        plan = 'steps'
      }
    }
    if (plan === 'steps') {
      const first = await kit.client.recover(at, 'withdraw-fees', kit.gas, rows[0])
      feeWei = BigInt(first.transaction.gas) * BigInt(first.transaction.maxFeePerGas)
    }
    return { vault: at, rows, totals: withdrawalTotals(rows), plan, feeWei }
  }

  /** Opens a vault's dialog. A withdrawal on its way is shown, never prepared again; otherwise the vault is read fresh. */
  async function open(view: VaultReserves) {
    if (running.current) {
      if (run?.vault === view.vault) setDialogOpen(true)
      return
    }
    const gen = ++generation.current
    const base = { vault: view.vault, base: view.baseCurrency, quote: view.quoteCurrency, at: 0, hashes: [], received: [] }
    setDialogOpen(true)
    setRun({ ...base, stage: 'reading', review: null, notice: null })
    try {
      const kit = await connectWithdrawal()
      const prepared = await review(kit, view.vault)
      if (generation.current !== gen) return
      if (!prepared) {
        setRun({ ...base, stage: 'failed', review: null, notice: { text: OWN.empty, code: 'empty' } })
        reservesChanged(owner)
        return
      }
      setRun({ ...base, stage: 'ready', review: prepared, notice: null })
    } catch (error) {
      if (generation.current === gen) setRun({ ...base, stage: 'failed', review: null, notice: noticeFor(error, false, 0) })
    }
  }

  /**
   * The press: the vault read again (anything other than what was reviewed is a new review, never a send), then the
   * withdrawals, each offered to the wallet once and read back until it is in a block. A step the wallet replaced counts
   * only by the vault's own record of the withdrawal (finance/sequence.ts withdrawalRecord), never by its balance.
   * Nothing is ever sent again from here.
   */
  async function confirm() {
    if (!run || !run.review || running.current) return
    const reviewed = run.review
    running.current = true
    const gen = ++generation.current
    const alive = () => generation.current === gen
    const base = { vault: run.vault, base: run.base, quote: run.quote }
    // The transactions known to have paid: each step's own once in a block, the one that took a replaced step's place,
    // the batch's (finding 4). Never a hash the chain did not include.
    const hashes: Hex[] = []
    const landed: FeeWithdrawal[] = []
    // Whether the step under way had gone to the network when it failed.
    let sent = false
    setRun({ ...base, stage: 'wallet', review: reviewed, at: 0, hashes: [], received: [], notice: null })
    try {
      const kit = await connectWithdrawal()
      const read = await kit.reserves(reviewed.vault)
      const now = withdrawals(read)
      if (!alive()) return
      if (!sameWithdrawals(reviewed.rows, now)) {
        const again = await review(kit, reviewed.vault)
        if (!alive()) return
        setRun(
          again
            ? { ...base, stage: 'ready', review: again, at: 0, hashes: [], received: [], notice: { text: CHANGED, code: 'changed' } }
            : { ...base, stage: 'failed', review: null, at: 0, hashes: [], received: [], notice: { text: OWN.empty, code: 'empty' } },
        )
        reservesChanged(owner)
        return
      }
      // The vault as read before anything is sent: a withdrawal's own record is looked for after it.
      const since = { block: read.blockNumber, stateNonce: read.stateNonce }
      let plan = reviewed.plan
      if (plan === 'batch') {
        let prepared: PreparedWithdrawBatch | null = null
        try {
          prepared = await kit.client.prepareWithdrawBatch(reviewed.vault, reviewed.rows, kit.gas)
        } catch (error) {
          if (errorCode(error) !== 'batch_simulation_unavailable') throw error
        }
        let id: string | null = null
        if (prepared) {
          try {
            id = await kit.client.sendWithdrawBatch(prepared, true)
          } catch (error) {
            if (errorCode(error) !== 'batch_unsupported') throw new Offered(error)
          }
        }
        if (prepared && id !== null) {
          sent = true
          if (!alive()) return
          setRun({ ...base, stage: 'chain', review: reviewed, at: 0, hashes: [], received: [], notice: null })
          const settled = await settleBatch(kit, id, prepared, alive)
          if (!settled) return
          landed.push(...reviewed.rows)
          if (settled.hash) hashes.push(settled.hash)
        } else plan = 'steps'
      }
      if (plan === 'steps') {
        const stepped = { ...reviewed, plan }
        for (const [index, row] of reviewed.rows.entries()) {
          if (!alive()) return
          sent = false
          setRun({ ...base, stage: 'wallet', review: stepped, at: index, hashes: [...hashes], received: withdrawalTotals(landed), notice: null })
          const step = await kit.client.recover(reviewed.vault, 'withdraw-fees', kit.gas, row)
          let hash: Hex
          try {
            hash = await kit.client.send(step, true)
          } catch (error) {
            throw new Offered(error)
          }
          sent = true
          if (!alive()) return
          setRun({ ...base, stage: 'chain', review: stepped, at: index, hashes: [...hashes], received: withdrawalTotals(landed), notice: null })
          const settled = await settleStep(kit.client, hash, alive)
          if (settled === 'left' || !alive()) return
          let paid = hash
          if (settled === 'replaced') {
            // 2026-10-01 (audit C14): replaced in the wallet ("Speed up" or "Cancel"). Changed on purpose 2026-10-02 (review
            // finding 1): withdrawn only by the vault's own record of this row's withdrawal since the press read it, which a
            // sped-up step writes under another hash and a cancelled one never does. Its balance cannot say: an automation
            // run spends a reserve on liquidity, and a fee credited raises one. With no record, the outcome is unknown and
            // said so. Nothing is sent again.
            const proof: { record: FeeWithdrawalRecord | null } = { record: null }
            const taken = await readAfterReplaced(() => kit.client.withdrawalRecord(reviewed.vault, [row], since), (found) => (proof.record = found[0]) !== null, alive)
            if (taken === null || !alive()) return
            if (!taken || !proof.record) throw new Error('reserve_withdrawal_replaced')
            paid = proof.record.transactionHash
          }
          landed.push(row)
          hashes.push(paid)
        }
      }
      kit.verified()
      setRun({ ...base, stage: 'done', review: reviewed, at: 0, hashes: [...hashes], received: withdrawalTotals(landed), notice: null })
      reservesChanged(owner)
    } catch (error) {
      if (!alive()) return
      const code = errorCode(error instanceof Offered ? error.inner : error)
      setRun({ ...base, stage: 'failed', review: reviewed, at: 0, hashes: [...hashes], received: withdrawalTotals(landed), notice: noticeFor(error, sent, landed.length) })
      // Anything that reached the network, or a review that no longer holds: the card reads the vault again.
      if (sent || landed.length > 0 || (code !== null && REVIEW_AGAIN.has(code))) reservesChanged(owner)
    } finally {
      if (alive()) running.current = false
    }
  }

  const close = () => {
    setDialogOpen(false)
    // A read on its way is dropped; a press on its way keeps going to its end, and its row opens it again.
    if (run && !(run.stage === 'wallet' || run.stage === 'chain')) {
      generation.current++
      setRun(null)
    }
  }

  const dialog = run && dialogOpen && <WithdrawDialog run={run} names={names} onClose={close} onConfirm={() => void confirm()} />
  // Where the read stands, for the tests: reading, ready (every vault looked in), checking (some still to be), none, failed.
  const state = read === null ? 'reading' : read.kind === 'ready' && checking > 0 ? 'checking' : read.kind
  const head = (
    <div className="dm-acct-card-head">
      <h2 id={`reserves-title-${placement}`} className="dm-title">
        {TITLE}
      </h2>
    </div>
  )
  // Nothing to withdraw (or not read yet): nothing on screen, and where the read stands is a hidden marker's data.
  // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): reads that kept failing with nothing to show
  // put up this card with "Your automation couldn't be checked for fees just now. This page asks again on its own." and
  // took it down once a read went through, so it came and went. Nothing is shown now until there are fees to withdraw;
  // the reads go on quietly, and how many failed in a row is the marker's data.
  if (shown.length === 0)
    return (
      <>
        <span hidden data-fee-reserves-read={placement} data-fee-reserves-state={state} data-fee-reserves-reason={read && read.kind !== 'ready' ? read.reason : undefined} data-fee-reserves-misses={misses || undefined} />
        {dialog}
      </>
    )

  const rows: ReactNode = shown.map((view) => {
    const totals = reserveTotals(view)
    const mineRun = run !== null && run.vault === view.vault
    const busy = mineRun && (run.stage === 'reading' || pressing)
    return (
      <li key={view.vault} className="dm-held-row dm-reserves-row" title={view.vault} data-reserve-vault={view.vault} data-reserve-root={view.rootTokenId.toString()}>
        <div className="dm-held-main">
          <QuietMarkPair addresses={[view.baseCurrency, view.quoteCurrency]} size={32} />
          <div className="dm-held-text">
            {placement === 'positions' ? (
              <>
                <span className="dm-held-pair">
                  <a href={`#/positions/${view.rootTokenId.toString()}`} className="dm-reserves-link">
                    Position #{view.rootTokenId.toString()}
                  </a>
                  <StatusWord view={view} />
                </span>
                <span className="dm-held-amounts">
                  <Amounts totals={totals} names={names} />
                </span>
              </>
            ) : (
              <span className="dm-held-pair">
                <Amounts totals={totals} names={names} />
              </span>
            )}
          </div>
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="dm-held-refund"
            disabled={pressing && !mineRun}
            aria-busy={busy || undefined}
            data-reserve-withdraw={view.vault}
            onClick={() => void open(view)}
          >
            {ACTION}
          </Button>
        </div>
        {mineRun && !dialogOpen && pressing && (
          <p role="status" className="dm-held-line dm-held-line--strong" data-reserve-progress={run.stage}>
            {PROGRESS[run.stage]}
          </p>
        )}
      </li>
    )
  })

  return (
    <>
      <section className="dm-card dm-acct-card dm-reserves" aria-labelledby={`reserves-title-${placement}`} data-fee-reserves={placement} data-fee-reserves-vaults={shown.length} data-fee-reserves-read={placement} data-fee-reserves-state={state}>
        {head}
        <p className="dm-reserves-lede">{RESERVES_LEDE}</p>
        <ul className="dm-held-list">{rows}</ul>
        {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the line under the rows while some vaults
            were still to be looked in ("Your older automations are still being checked…", "Some of your automations
            couldn't be checked just now. This page asks again on its own.") is gone; their rows join the card as their
            reads go through, and the section's data-fee-reserves-state says "checking" meanwhile. */}
        {beyond && checking === 0 && (
          <p className="dm-reserves-more" data-reserves-beyond="">
            Only your {RESERVE_VAULT_CAP.toLocaleString('en-US')} newest automations are checked here.
          </p>
        )}
      </section>
      {dialog}
    </>
  )
}
