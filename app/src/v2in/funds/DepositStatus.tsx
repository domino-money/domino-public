import { useEffect, useRef, useState } from 'react'
import { CopyButton } from '../../components/read/screens/CopyButton'
import { Button, Card, KeyValue, KeyValueList } from '../../components/ui'
import { OriginStepError, type DepositJournal, type OriginReview, type OriginSender, type PendingBatch, type SentStep } from '../../finance/v2/crosschain'
import { amountText } from '../../v2/crosschain/amounts'
import { PROVIDER_NAME } from '../../v2/crosschain/copy'
import { createStatusPoller, type PollState } from '../../v2/crosschain/polling'
import { destinationChoices, presentStatus, shortAmountText, type Naming } from '../../v2/crosschain/present'
import type { CrosschainJournalRecord } from '../../v2/crosschain/steps'
import { v2TxUrl } from '../../v2/explorers'
import { FUNDS_FINALITY_WATCH_MS, FUNDS_RECEIPT_POLL_MS } from './constants'
import { FUNDS_TEXT, senderCopy } from './copy'
import { reconcileBalances } from './reconcile'
import type { FundsServices } from './services'
import { ZERO_ADDRESS } from '../../v2/types'
import { availableBalance, transferTitle, type TransferProgress } from './transferView'
import { TransferRoute } from './TransferRoute'

type Hex = `0x${string}`

/** A deposit the offer tracks: from the journal (after a reload), or sent from this page (with what it knows of it). */
export interface TrackedDeposit {
  record: CrosschainJournalRecord
  /** The token delivered (lowercase), when this page sent the deposit; null after a reload (the journal keeps public tracking data only). */
  destinationToken: string | null
  /** The origin token's words, for the refund sentence; null after a reload ("your deposit"). */
  originLabel: string | null
  /** The review the deposit was sent from, for its receipt (this page only). */
  review: OriginReview | null
  journaled: boolean
  /** Keep an observed pending recovery mounted until its terminal balance reconciliation finishes. */
  followedPending?: boolean
}

const RECEIPT_STOPS = new Set(['wallet_wrong_chain', 'wallet_identity_changed', 'transaction_does_not_match', 'invalid_receipt', 'receipt_not_from_this_review', 'review_required'])

/**
 * The explorer page of a transaction on a V2 chain (Changed on purpose 2026-10-04, rugged97's delta of 4 Oct §1: Base and
 * Arbitrum One too, src/v2/explorers.ts; it was Robinhood Chain's alone); else null: a deposit's origin chain may be any.
 */
const explorerLink = (chainId: number, hash: string) => v2TxUrl(chainId, hash)

function HashLine({ chainId, hash, label }: { chainId: number; hash: string; label: string }) {
  const href = explorerLink(chainId, hash)
  return (
    <KeyValue label={label} mono action={<CopyButton value={hash} label={FUNDS_TEXT.copyHash} />}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer noopener" className="underline">
          {hash}
        </a>
      ) : (
        hash
      )}
    </KeyValue>
  )
}

/**
 * Added 2026-10-06 (rugged's answer of 6 Oct, F7 delta of 6 Oct §2 step 5): a deposit sent as one batch whose transaction
 * the wallet has not named yet, kept by the sender (finance/v2/crosschain.ts PendingBatch) and found here after a
 * reload, or once the run that sent it stopped: the wallet's status for it is asked through the closed sender every
 * FUNDS_RECEIPT_POLL_MS until it names the transaction; that deposit is then followed as any other (`onSent`). When
 * nothing of it ran, or the wallet no longer knows it, that is said, and the person may remove it from the list.
 */
export function PendingDeposit({
  entry,
  services,
  sender,
  name,
  onSent,
  onRemove,
  onOutcome,
}: {
  entry: PendingBatch
  services: FundsServices
  sender: () => Promise<OriginSender>
  name: Naming
  /** The wallet named the batch's transaction: the deposit's, its record kept (or not: `journaled`). */
  onSent: (sent: SentStep) => void
  onRemove: () => void
  /** A wallet-confirmed terminal failure can resume its funding leg; an unknown result must remain quarantined. */
  onOutcome?: (state: 'not_included' | 'reverted' | 'unknown') => void
}) {
  const [said, setSaid] = useState<'pending' | 'batch_not_included' | 'batch_reverted' | 'batch_unknown'>('pending')
  const [retry, setRetry] = useState(0)
  const sent = useRef(onSent)
  const outcome = useRef(onOutcome)
  useEffect(() => {
    sent.current = onSent
    outcome.current = onOutcome
  })
  const reported = useRef<string | null>(null)
  useEffect(() => {
    if (said === 'pending' || reported.current === said) return
    reported.current = said
    outcome.current?.(said === 'batch_not_included' ? 'not_included' : said === 'batch_reverted' ? 'reverted' : 'unknown')
  }, [said])
  useEffect(() => {
    let live = true
    void (async () => {
      while (live) {
        try {
          const state = await (await sender()).batchStatus(entry)
          if (!live) return
          if (state.state === 'sent') return sent.current(state.sent)
          if (state.state === 'gone') return setSaid(state.reverted ? 'batch_reverted' : 'batch_not_included')
          if (state.state === 'unknown') return setSaid('batch_unknown')
        } catch {
          // Asked again: the wallet away for a moment, or a read that failed.
        }
        await services.wait(FUNDS_RECEIPT_POLL_MS)
      }
    })()
    return () => {
      live = false
    }
  }, [entry, sender, services, retry])
  const origin = name.origin(entry.originChainId) ?? `network ${entry.originChainId}`
  return (
    <Card level={2} className="p-4" data-funds-pending-batch={entry.originChainId} data-funds-batch-state={said}>
      <span className="dm-subtitle">{FUNDS_TEXT.depositFrom(origin)}</span>
      <p role="status" className={said === 'pending' ? 'mt-2 text-body' : 'dm-error mt-2'} data-error-code={said === 'pending' ? undefined : said} data-funds-state-text="">
        {said === 'pending' ? FUNDS_TEXT.stepWords.sent : senderCopy(said, { origin, native: '' })}
      </p>
      <details className="dm-details mt-3">
        <summary>{FUNDS_TEXT.details}</summary>
        <KeyValueList>
          <KeyValue label={FUNDS_TEXT.bridge}>{PROVIDER_NAME[entry.provider]}</KeyValue>
          {entry.requestId && (
            <KeyValue label="Relay request" mono>
              {entry.requestId}
            </KeyValue>
          )}
        </KeyValueList>
      </details>
      {said === 'batch_unknown' && (
        <Button variant="secondary" size="sm" className="mt-2" data-funds-status-retry="" onClick={() => { setSaid('pending'); setRetry((n) => n + 1) }}>
          Check transfer
        </Button>
      )}
      {(said === 'batch_not_included' || said === 'batch_reverted') && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={onRemove} data-funds-remove="">
          {FUNDS_TEXT.remove}
        </Button>
      )}
    </Card>
  )
}

/**
 * One deposit's tracking inside the offer (spec F7 §3.7, §3.9), copied on purpose from the rejected #/v2 section's
 * tracker (src/v2ui/s2/DepositTracker.tsx, reference only): `status` asked by v2/crosschain/polling.ts's rules
 * (previousState, then nextCheckSeconds; a held answer never moves the offer back; terminal and
 * crosschain_deposit_not_found stop it), each new state written back to the journal; the deposit transaction's own
 * receipt on the origin as "Included", then "Finalized" (a delay is never a failure). After `filled`: the real balance
 * on the position's chain is reconciled through the read service, independent of the active wallet network, and the
 * SAME entered position amount is preserved. The fee's measurement only in
 * Details, and only once filled.
 */
export function DepositStatus({
  deposit,
  services,
  owner,
  journal,
  name,
  access,
  onArrived,
  sender,
  poolTokens,
  keep = null,
  onUse,
  onRemove,
  onSettled,
  onProgress,
  currentIntent = true,
  onContinue,
}: {
  deposit: TrackedDeposit
  services: FundsServices
  /** The connected wallet (lowercase). */
  owner: string
  journal: DepositJournal | null
  name: Naming
  walletChainId: number | null
  /**
   * Added 2026-10-05: the session's state as the offer reads it. Tracking starts again whenever it changes (a network
   * switch moves the session's epoch, and an answer refused for the moment stopped it for good).
   */
  access: string
  /** Refresh amount-step balances after each observed destination snapshot, regardless of the wallet's active chain. */
  onArrived?: () => void
  sender: () => Promise<OriginSender>
  /** The position's two tokens (lowercase), in pool order: what arrived continues the same position on its side. */
  poolTokens: readonly string[]
  /**
   * Added 2026-10-06 (the 2026-10-06 study: Use resized the position to the whole balance): the amount typed in the step,
   * once the wallet covers it with what arrived; Use then keeps it, and the card is done. Null: Use takes the balance.
   */
  keep?: { side: 0 | 1; text: string; label: string } | null
  /**
   * Added 2026-10-06 (the integration review): the one pool token a range beside today's price takes. What arrived of the
   * other one is never made the amount's token (the range could take none of it): a hint says to type the amount instead.
   */
  takes?: { side: 0 | 1; symbol: string | null } | null
  onUse: (side: 0 | 1, text: string) => void
  onUseToken?: (token: string, text: string) => void
  onRemove: () => void
  /**
   * Called once for a confirmed terminal deposit, after balance reconciliation for a fill. A tracking error or a
   * missing status is not proof that the transfer failed and must not unlock a replacement transfer.
   */
  onSettled?: () => void
  /** Presentation only; never releases a transfer lock or starts another operation. */
  onProgress?: (progress: TransferProgress) => void
  /** A recovered transfer for another position is tracked without claiming it funds this one. */
  currentIntent?: boolean
  onContinue?: () => void
}) {
  const { record } = deposit
  const [poll, setPoll] = useState<PollState | null>(null)
  const [receipt, setReceipt] = useState<'pending' | 'included' | 'finalized' | 'reverted' | null>(deposit.review ? 'pending' : null)
  const [balances, setBalances] = useState<readonly { token: string; raw: string }[] | null>(null)
  const [balanceState, setBalanceState] = useState<'updating' | 'ready' | 'unavailable'>('updating')
  const [balanceRetry, setBalanceRetry] = useState(0)
  const [statusRetry, setStatusRetry] = useState(0)
  // The record as tracking last left it: tracking starts again from there (Changed on purpose 2026-10-05).
  const initial = useRef(record)

  useEffect(() => {
    if (!access.startsWith('ready:')) return
    const poller = createStatusPoller({
      client: services.client,
      runtime: services.runtime,
      clock: services.clock,
      owner,
      record: initial.current,
      onUpdate: (state) => {
        initial.current = state.record
        setPoll(state)
        try {
          journal?.put(owner, state.record)
        } catch {
          // The page keeps tracking in memory; the record already kept stays as it was.
        }
      },
    })
    poller.start()
    return () => poller.stop()
  }, [services, owner, journal, access, statusRetry])

  // The deposit transaction's own receipt on the origin, for a deposit this page sent: "Included", then "Finalized".
  useEffect(() => {
    const review = deposit.review
    if (!review) return
    let live = true
    const started = services.clock.monoMs()
    let includedAt: number | null = null
    void (async () => {
      const own = await sender().catch(() => null)
      while (live && own) {
        try {
          const read = await own.receipt(review, record.depositTxHash as Hex)
          if (!live) return
          if (read.state === 'reverted' || read.state === 'finalized') {
            setReceipt(read.state)
            return
          }
          if (read.state === 'included') {
            setReceipt('included')
            includedAt ??= services.clock.monoMs()
            if (services.clock.monoMs() - includedAt > FUNDS_FINALITY_WATCH_MS) return
          }
        } catch (error) {
          if (error instanceof OriginStepError && RECEIPT_STOPS.has(error.code)) return
        }
        if (services.clock.monoMs() - started > 4 * FUNDS_FINALITY_WATCH_MS) return
        await services.wait(FUNDS_RECEIPT_POLL_MS)
      }
    })()
    return () => {
      live = false
    }
  }, [deposit.review, record.depositTxHash, sender, services])

  const shown = poll?.record.lastState ?? record.lastState
  const view = presentStatus({
    report: poll?.report ?? null,
    shown,
    fillTxHash: poll?.fillTxHash,
    refundTxHash: poll?.refundTxHash,
    provider: record.provider,
    originChainId: record.originChainId,
    destinationChainId: record.destinationChainId,
    originToken: deposit.originLabel,
    name,
  })
  const origin = name.origin(record.originChainId) ?? `network ${record.originChainId}`
  const destination = name.destination(record.destinationChainId) ?? `network ${record.destinationChainId}`
  const filled = view.state === 'filled'
  const arrived = useRef(onArrived)
  useEffect(() => {
    arrived.current = onArrived
  })

  // The destination reader is independent of the wallet's active network. The first answer may still be the backend's
  // pre-fill ten-second cache; a later, advancing snapshot refreshes every consumer without another wallet prompt.
  const candidates = deposit.destinationToken ? [...new Set([deposit.destinationToken, ZERO_ADDRESS])] : [...new Set([
    ...poolTokens.filter((token) => name.book(record.destinationChainId, token) !== null),
    // Older journals did not retain the delivered token. Read only the supported destination assets so changing the
    // position cannot strand a confirmed arrival; none of these balances is used to replace an entered amount.
    ...(destinationChoices().find((chain) => chain.chainId === record.destinationChainId)?.tokens.map((token) => token.address.toLowerCase()) ?? []),
  ])]
  const candidatesKey = candidates.join(',')
  useEffect(() => {
    if (!filled) return
    let live = true
    const tokens = candidatesKey.split(',').filter(Boolean)
    const current = () => live && services.owner === owner
    void Promise.resolve().then(async () => {
      if (!current()) return
      setBalances(null)
      setBalanceState('updating')
      const result = await reconcileBalances({
        read: () => services.readBalances?.(record.destinationChainId, tokens) ?? Promise.resolve({ kind: 'unavailable' }),
        monoMs: services.clock.monoMs,
        wait: services.wait,
        current,
        onSnapshot: (snapshot) => {
          setBalances(snapshot.balances)
          arrived.current?.()
        },
      })
      if (current() && result !== 'cancelled') setBalanceState(result)
    })
    return () => {
      live = false
    }
  }, [filled, candidatesKey, record.destinationChainId, record.depositTxHash, services, owner, balanceRetry])

  const notice = poll?.notice ?? null
  const stopped = poll?.stopped ?? null
  // A failed status read is not a failed transfer. Keep unknown deposits tracked and reserved until a terminal answer.
  const done = view.terminal
  const progress = useRef(onProgress)
  useEffect(() => { progress.current = onProgress })
  useEffect(() => { progress.current?.({ state: view.state, balance: balanceState }) }, [view.state, balanceState])
  const settled = useRef(onSettled)
  useEffect(() => {
    settled.current = onSettled
  })
  const saidSettled = useRef(false)
  useEffect(() => {
    if (!done || (filled && balanceState !== 'ready') || saidSettled.current) return
    saidSettled.current = true
    settled.current?.()
  }, [done, filled, balanceState])
  const fee = view.feeDetail
  const available = balanceState === 'ready' ? balances?.map(({ token, raw }) => ({ token, raw: availableBalance(token, raw) })).filter(({ raw }) => BigInt(raw) > 0n) ?? [] : []
  const moving = !done && (view.state === null || view.state === 'awaiting_deposit' || view.state === 'pending')
  return (
    <div className="dm-transfer" data-funds-deposit={record.depositTxHash} data-funds-state={view.state ?? 'none'} data-funds-stopped={stopped ?? undefined} data-funds-transition={poll?.report?.transition ?? undefined}>
      <TransferRoute originChainId={record.originChainId} destinationChainId={record.destinationChainId}
        token={deposit.destinationToken ? { chainId: record.destinationChainId, address: deposit.destinationToken } : null}
        originToken={deposit.review?.quote.request.originChainId === record.originChainId ? { chainId: record.originChainId, address: deposit.review.quote.request.originToken } : null}
        progress={{ state: view.state, balance: balanceState }} paused={Boolean(stopped)} />
      <p role="status" className="dm-transfer-title" data-funds-state-text="">{currentIntent ? transferTitle(view.state, destination) : `Previous transfer to ${destination}`}</p>
      {!moving && !filled && <p className="dm-hint">{view.text}</p>}
      {notice && notice.copy && (
        <p role="alert" className="dm-error mt-2" data-error-code={notice.code ?? undefined} data-funds-notice="">
          {notice.copy}
        </p>
      )}
      {stopped === 'not_found' && (
        <div className="mt-2" data-funds-not-found-hash="">
          <KeyValueList>
            <HashLine chainId={record.originChainId} hash={record.depositTxHash} label={FUNDS_TEXT.checkHash} />
          </KeyValueList>
        </div>
      )}
      {!view.terminal && (stopped === 'not_found' || stopped === 'unexpected' || stopped === 'bug') && (
        <Button variant="secondary" size="sm" className="mt-2" data-funds-status-retry="" onClick={() => setStatusRetry((n) => n + 1)}>
          Check transfer
        </Button>
      )}
      {receipt === 'reverted' && (
        <p role="alert" className="dm-error mt-2" data-funds-deposit-reverted="">
          {FUNDS_TEXT.depositReverted(origin)}
        </p>
      )}
      {!deposit.journaled && deposit.review && (
        <p className="dm-hint mt-2" data-funds-not-saved="">
          {FUNDS_TEXT.notSaved}
        </p>
      )}
      {filled && (
        <div className="mt-3 grid gap-2" data-funds-after-fill="" data-funds-balance-state={balanceState}>
          {balanceState !== 'ready' && (
            <p role="status" className="text-caption text-fg-muted">
              {balanceState === 'updating' ? 'Updating your balance…' : 'Your funds arrived. Your balance is taking longer to update.'}
            </p>
          )}
          {balanceState === 'unavailable' && (
            <Button variant="secondary" size="sm" className="justify-self-start" onClick={() => setBalanceRetry((n) => n + 1)} data-funds-balance-retry="">
              Check balance
            </Button>
          )}
          {balanceState === 'ready' && <p className="dm-transfer-available" data-funds-available="">
            {available.length ? `Available now: ${available.map(({ token, raw }) => shortAmountText(raw, token, name.book(record.destinationChainId, token))).join(' · ')}` : 'No spendable funds available for this position yet.'}
          </p>}
          {currentIntent && balanceState === 'ready' && keep !== null && (
            // Changed on purpose 2026-10-06 (the 2026-10-06 study): the wallet now covers the amount typed in the step, so
            // the same position continues with it, unchanged; the card is done.
            <Button
              className="justify-self-start"
              onClick={() => {
                if (onContinue) onContinue()
                else { onUse(keep.side, keep.text); onRemove() }
              }}
              data-funds-use="keep"
            >
              Continue with this amount
            </Button>
          )}
        </div>
      )}
      <details className="dm-details mt-3">
        <summary>{FUNDS_TEXT.details}</summary>
        {filled && balanceState === 'ready' && balances !== null && <div data-funds-balances="" className="dm-transfer-balances">
          <p>{FUNDS_TEXT.balanceTitle(destination)}</p>
          <ul>{balances.map(({ token, raw }) => <li key={token} data-funds-balance={token} title={amountText(raw, token, name.book(record.destinationChainId, token))}>{shortAmountText(raw, token, name.book(record.destinationChainId, token))}</li>)}</ul>
          <p>Available funds keep ETH aside for network fees. These are current wallet balances, not transfer receipt amounts.</p>
        </div>}
        {view.link && explorerLink(view.link.chainId, view.link.hash) && <a href={explorerLink(view.link.chainId, view.link.hash) ?? undefined} target="_blank" rel="noreferrer noopener" className="underline" data-funds-link={view.link.kind}>{FUNDS_TEXT.viewOnExplorer}</a>}
        <KeyValueList>
          <HashLine chainId={record.originChainId} hash={record.depositTxHash} label={FUNDS_TEXT.checkHash} />
          <KeyValue label={FUNDS_TEXT.bridge}>{PROVIDER_NAME[record.provider]}</KeyValue>
          {receipt && receipt !== 'reverted' && <KeyValue label={`On ${origin}`}>{receipt === 'pending' ? FUNDS_TEXT.stepWords.sent : FUNDS_TEXT.stepWords[receipt]}</KeyValue>}
          {record.requestId && (
            <KeyValue label="Relay request" mono>
              {record.requestId}
            </KeyValue>
          )}
          {view.link && <HashLine chainId={view.link.chainId} hash={view.link.hash} label={view.link.kind === 'fill' ? `Arrival on ${destination}` : `Refund on ${origin}`} />}
          {fee && (
            <KeyValue label="Domino fee" data-funds-fee={fee.status}>
              {fee.amount ? `${fee.words}: ${fee.amount}` : fee.words}
            </KeyValue>
          )}
        </KeyValueList>
        {done && !currentIntent && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={onRemove} data-funds-remove="">
          {FUNDS_TEXT.remove}
        </Button>
        )}
      </details>
    </div>
  )
}
