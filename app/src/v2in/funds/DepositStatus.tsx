import { useEffect, useRef, useState } from 'react'
import { CopyButton } from '../../components/read/screens/CopyButton'
import { Button, Card, KeyValue, KeyValueList, Pill } from '../../components/ui'
import { OriginStepError, type DepositJournal, type OriginReview, type OriginSender } from '../../finance/v2/crosschain'
import { amountText } from '../../v2/crosschain/amounts'
import { PROVIDER_NAME } from '../../v2/crosschain/copy'
import { createStatusPoller, type PollState } from '../../v2/crosschain/polling'
import { presentStatus, type Naming } from '../../v2/crosschain/present'
import type { CrosschainJournalRecord } from '../../v2/crosschain/steps'
import { v2TxUrl } from '../../v2/explorers'
import { switchToChain, v2SwitchNotice } from '../../wallet/port'
import { FUNDS_FINALITY_WATCH_MS, FUNDS_RECEIPT_POLL_MS } from './constants'
import { FUNDS_TEXT } from './copy'
import { continueWith } from './model'
import type { FundsServices } from './services'

type Hex = `0x${string}`
const ZERO = '0x0000000000000000000000000000000000000000'

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
 * One deposit's tracking inside the offer (spec F7 §3.7, §3.9), copied on purpose from the rejected #/v2 section's
 * tracker (src/v2ui/s2/DepositTracker.tsx, reference only): `status` asked by v2/crosschain/polling.ts's rules
 * (previousState, then nextCheckSeconds; a held answer never moves the offer back; terminal and
 * crosschain_deposit_not_found stop it), each new state written back to the journal; the deposit transaction's own
 * receipt on the origin as "Included", then "Finalized" (a delay is never a failure). After `filled`: the real balance
 * on the position's chain, read through the wallet's own provider once the wallet is there, and the SAME position
 * continues with it ("Use {amount} for this position", the amount step's own handler). The fee's measurement only in
 * Details, and only once filled.
 */
export function DepositStatus({
  deposit,
  services,
  owner,
  journal,
  name,
  walletChainId,
  sender,
  poolTokens,
  onUse,
  onUseToken,
  onRemove,
}: {
  deposit: TrackedDeposit
  services: FundsServices
  /** The connected wallet (lowercase). */
  owner: string
  journal: DepositJournal | null
  name: Naming
  walletChainId: number | null
  sender: () => Promise<OriginSender>
  /** The position's two tokens (lowercase), in pool order: what arrived continues the same position on its side. */
  poolTokens: readonly string[]
  onUse: (side: 0 | 1, text: string) => void
  onUseToken?: (token: string, text: string) => void
  onRemove: () => void
}) {
  const { record } = deposit
  const [poll, setPoll] = useState<PollState | null>(null)
  const [receipt, setReceipt] = useState<'pending' | 'included' | 'finalized' | 'reverted' | null>(deposit.review ? 'pending' : null)
  const [balances, setBalances] = useState<{ token: string; raw: string }[] | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [switchNote, setSwitchNote] = useState<string | null>(null)
  const initial = useRef(record)

  useEffect(() => {
    const poller = createStatusPoller({
      client: services.client,
      runtime: services.runtime,
      clock: services.clock,
      owner,
      record: initial.current,
      onUpdate: (state) => {
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
  }, [services, owner, journal])

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
  const onDestination = walletChainId === record.destinationChainId

  // After the fill: what is in the wallet on the position's chain, read through the wallet's provider (§3.7
  // recommendation): the delivered token when this page sent the deposit; otherwise the position's tokens a deposit may
  // deliver there (the journal does not keep which one arrived).
  const candidates = deposit.destinationToken ? [deposit.destinationToken] : poolTokens.filter((token) => name.book(record.destinationChainId, token) !== null)
  const candidatesKey = candidates.join(',')
  useEffect(() => {
    if (!filled || !onDestination) return
    let live = true
    const tokens = candidatesKey.split(',').filter(Boolean)
    void (async () => {
      const own = await sender().catch(() => null)
      if (!own) return
      const read: { token: string; raw: string }[] = []
      for (const token of tokens) {
        try {
          read.push({ token, raw: await own.balance(record.destinationChainId, token) })
        } catch {
          // Unread: shown as nothing rather than as zero.
        }
      }
      if (live) setBalances(read)
    })()
    return () => {
      live = false
    }
  }, [filled, onDestination, candidatesKey, record.destinationChainId, sender])

  // What the same position continues with: the delivered token when this page sent the deposit, else the person's pick.
  const startToken = deposit.destinationToken ?? picked
  const startRaw = startToken !== null ? (balances?.find((b) => b.token === startToken)?.raw ?? null) : null
  const startInfo = startToken !== null ? name.book(record.destinationChainId, startToken) : null
  const found = startToken !== null ? poolTokens.indexOf(startToken) : -1
  const side: 0 | 1 | null = found === 0 || found === 1 ? found : null
  const amount = startToken !== null && (side !== null || onUseToken) ? continueWith(startRaw, startInfo?.decimals ?? null, startToken === ZERO) : null

  const notice = poll?.notice ?? null
  const stopped = poll?.stopped ?? null
  // Removable once nothing more will come of it here: terminal, or stopped for good. A deposit stopped for the session
  // (or the gate, or the route) stays: tracking resumes from the journal once that is back.
  const done = view.terminal || stopped === 'not_found' || stopped === 'account' || stopped === 'unexpected' || stopped === 'bug'
  const fee = view.feeDetail
  return (
    <Card level={2} className="p-4" data-funds-deposit={record.depositTxHash} data-funds-state={view.state ?? 'none'} data-funds-stopped={stopped ?? undefined} data-funds-transition={poll?.report?.transition ?? undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="dm-subtitle">{FUNDS_TEXT.depositFrom(origin, PROVIDER_NAME[record.provider])}</span>
        {view.terminal && (
          <Pill tone={view.state === 'filled' ? 'in' : 'wait'} dot>
            {view.state === 'filled' ? FUNDS_TEXT.arrived : FUNDS_TEXT.refunded}
          </Pill>
        )}
      </div>
      <p role="status" className="mt-2 text-body" data-funds-state-text="">
        {view.text}
      </p>
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
      {view.link && explorerLink(view.link.chainId, view.link.hash) && (
        <p className="mt-2">
          <a href={explorerLink(view.link.chainId, view.link.hash) ?? undefined} target="_blank" rel="noreferrer noopener" className="underline" data-funds-link={view.link.kind}>
            {FUNDS_TEXT.viewOnExplorer}
          </a>
        </p>
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
        <div className="mt-3 grid gap-2" data-funds-after-fill="">
          {onDestination ? (
            balances !== null &&
            balances.length > 0 && (
              <div data-funds-balances="">
                <p className="text-caption text-fg-muted">{FUNDS_TEXT.balanceTitle(destination)}</p>
                {deposit.destinationToken ? (
                  <ul className="mt-1 grid gap-1 text-body">
                    {balances.map(({ token, raw }) => (
                      <li key={token} data-funds-balance={token}>
                        {amountText(raw, token, name.book(record.destinationChainId, token))}
                      </li>
                    ))}
                  </ul>
                ) : (
                  // After a reload the journal does not say which token arrived: the person picks the one to continue with.
                  <div role="radiogroup" aria-label={FUNDS_TEXT.which} className="mt-1 grid gap-1 text-body" data-funds-pick="">
                    {balances.map(({ token, raw }) => (
                      <label key={token} className="dm-acct-check" data-funds-balance={token}>
                        <input type="radio" name={`funds-pick-${record.depositTxHash}`} value={token} checked={picked === token} onChange={() => setPicked(token)} />
                        {amountText(raw, token, name.book(record.destinationChainId, token))}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-caption text-fg-muted">{FUNDS_TEXT.balanceElsewhere(destination)}</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSwitchNote(null)
                  void switchToChain(record.destinationChainId).then((outcome) => {
                    if (outcome !== 'switched') setSwitchNote(v2SwitchNotice(outcome, destination))
                  })
                }}
              >
                {FUNDS_TEXT.switchToDestination(destination)}
              </Button>
            </div>
          )}
          {switchNote && (
            <p role="alert" className="dm-error">
              {switchNote}
            </p>
          )}
          {onDestination && balances !== null && startToken !== null && (amount !== null && (side !== null || onUseToken) ? (
            // §3.9: the same position continues with what is in the wallet now; nothing is signed here.
            <div className="grid gap-2">
              {onUseToken && <p className="dm-hint">Use this balance as your new deposit. You will review the swap before confirming.</p>}
              <Button className="justify-self-start" onClick={() => onUseToken ? onUseToken(startToken, amount.text) : side !== null && onUse(side, amount.text)} data-funds-use="">
                {FUNDS_TEXT.continueButton(amountText(amount.raw, startToken, startInfo))}
              </Button>
            </div>
          ) : (
            <p className="text-caption text-fg-muted" data-funds-nothing-to-use="">
              {FUNDS_TEXT.nothingToUse(destination)}
            </p>
          ))}
        </div>
      )}
      <details className="dm-details mt-3">
        <summary>{FUNDS_TEXT.details}</summary>
        <KeyValueList>
          <HashLine chainId={record.originChainId} hash={record.depositTxHash} label={FUNDS_TEXT.checkHash} />
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
      </details>
      {done && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={onRemove} data-funds-remove="">
          {FUNDS_TEXT.remove}
        </Button>
      )}
    </Card>
  )
}
