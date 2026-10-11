import { useEffect, useMemo, useState } from 'react'
import { activityMint, type ActivityMint } from '../../lib/chart/positionOpened'
import { Button } from '../../components/ui'
import type { AutomaticAdds } from '../../components/positions/PositionActivity'
import { FeesActivity } from '../../components/positions/visual/FeesActivity'
import type { FeesEvent } from '../../components/positions/visual/model'
import { contextLimited, positionActivity, timelineRows, type ActivityPosition } from './activityModel'
import { compareChronology } from './chronology'
import { anyIn, chainsIn, useKeyed, useListsGate } from './hooks'
import { useActivityHistory } from './activity'
import { receiptViews } from './model'
import { ChainLines, RECEIPT_LIST, ReceiptRow } from './receiptParts'
import { OWN_PORTFOLIO } from './source'
import { LocalReceiptRow, useLocalReceipts } from './LocalReceiptRow'
import { activityWindow, sessionActivity } from './sessionActivity'
import { SessionActivityRow } from './SessionActivityRow'

const NO_EVENTS: readonly FeesEvent[] = []

/** The same public history as Receipts, scoped by evidenced position identities. Local fee settlements are retained:
 * one financial operation with the same position and transaction can carry them inside its receipt; ambiguous matches
 * stay independent. No wallet-wide cancellation is attributed to a position merely because the wallet matches.
 */
export default function PositionHistory({ wallet, position, events = NO_EVENTS, automatic, onMint }: {
  wallet: string | null; position: ActivityPosition; events?: readonly FeesEvent[]; automatic?: AutomaticAdds | null; onMint?: (mint: ActivityMint) => void
}) {
  const gate = useListsGate()
  const live = anyIn(gate, 'live') && wallet !== null
  const history = useActivityHistory(live ? wallet : null)
  const local = useLocalReceipts(wallet)
  const portfolioRead = useKeyed(OWN_PORTFOLIO, live ? wallet?.toLowerCase() ?? null : null)
  const portfolio = portfolioRead?.kind === 'ok' ? portfolioRead.body : null
  const scope = `${wallet ?? ''}:${position.chainId}:${position.dex}:${position.tokenId}`
  const [page, setPage] = useState({ scope, shown: 5 })
  const shown = page.scope === scope ? page.shown : 5
  const { answer, receiptFinality } = history
  const matching = useMemo(() => positionActivity((answer?.items ?? []).filter(item => receiptFinality(item.chainId, item.tx.hash, item.tx.snapshot.hash) !== 'reorged'), position, portfolio), [answer, receiptFinality, position, portfolio])
  const mint = useMemo(() => {
    const own = portfolio?.positions.find((item) => item.chainId === position.chainId && item.dex === position.dex && item.tokenId === position.tokenId)
    return activityMint({ items: matching }, { ...position, vault: own?.vault ?? null })
  }, [matching, portfolio, position])
  useEffect(() => { if (mint) onMint?.(mint) }, [mint, onMint])
  const receipts = useMemo(() => history.answer ? receiptViews({ ...history.answer, items: matching }, chainsIn(gate, 'live'), portfolio, history.receiptFinality) : [], [history.answer, history.receiptFinality, matching, gate, portfolio])
  const rows = useMemo(() => {
    const scoped = local.filter((item) => item.chainId === position.chainId && item.dex === position.dex && item.tokenIds.includes(position.tokenId))
    const operations = timelineRows(receipts, [], new Map(), matching, scoped).filter((row) => row.kind !== 'private')
    const attached = new Map<string, FeesEvent[]>()
    const loose = new Map<string, FeesEvent[]>()
    for (const event of events) {
      const candidates = operations.filter((row) => row.kind === 'local' ? row.item.hash.toLowerCase() === event.tx.toLowerCase()
        : row.events.some((item) => item.tx.hash.toLowerCase() === event.tx.toLowerCase() && ['s1_action', 'vault_execution', 'auto_exit'].includes(item.kind)))
      const key = candidates.length === 1 ? candidates[0].id : event.tx.toLowerCase()
      const map = candidates.length === 1 ? attached : loose
      map.set(key, [...(map.get(key) ?? []), event])
    }
    return [
      ...operations.map((operation) => ({ ...operation, at: operation.at ?? attached.get(operation.id)?.[0].timestamp ?? null, operation, settlements: attached.get(operation.id) ?? [] })),
      ...[...loose].map(([tx, settlements]) => ({ id: `ledger:${tx}`, at: settlements[0].timestamp, operation: null, settlements })),
    ].sort(compareChronology)
  }, [events, receipts, matching, local, position])
  const { immediate, visible, total, hidden } = activityWindow(live ? sessionActivity(wallet, history.proofs, answer?.items ?? [], position) : [], rows, shown)
  if (!live && events.length === 0) return null
  return <section className="dm-card dm-pos-card dm-pos-activity dm-activity-history" aria-labelledby="position-activity-title" data-position-activity="" data-position-activity-read={history.answer ? 'ok' : history.error?.kind ?? 'loading'}>
    <h2 className="dm-title" id="position-activity-title">Activity</h2>
    {live && history.answer && <ChainLines answer={history.answer} />}
    {live && history.error && <p className="dm-rcpt-note" role="status" data-position-activity-reason={history.error.kind === 'unavailable' ? history.error.reason : history.error.detail}>More activity couldn’t be loaded. We’ll try again automatically.</p>}
    {visible.length + immediate.length > 0 && <ol className={`${RECEIPT_LIST} dm-activity-list`} data-position-history-rows={visible.length + immediate.length}>
      {immediate.map(item => <SessionActivityRow key={`${item.proof.chainId}:${item.proof.hash}`} item={item} />)}
      {visible.map((row) => row.operation?.kind === 'local' ? <LocalReceiptRow key={row.id} receipt={row.operation.item} at={row.at} tokens={portfolio?.tokens ?? history.answer?.tokens ?? []}>
        {row.settlements.length > 0 && <FeesActivity events={row.settlements} bare automatic={automatic ?? undefined} />}
      </LocalReceiptRow>
        : row.operation ? <ReceiptRow key={row.id} view={row.operation.receipt} effects={row.operation.receipts} showGas={row.operation.showGas} positionItem={row.operation.events.find((item) => item.id === (row.operation?.kind === 'public' ? row.operation.receipt.id : null))}>
        {row.settlements.length > 0 && <FeesActivity events={row.settlements} bare automatic={automatic ?? undefined} />}
      </ReceiptRow> : <li key={row.id} data-position-ledger-transaction={row.settlements[0].tx}><FeesActivity events={row.settlements} bare automatic={automatic ?? undefined} /></li>)}
    </ol>}
    {visible.length + immediate.length === 0 && live && !history.error && <p className="dm-rcpt-note" role="status">{!history.answer || history.loading ? 'Loading activity…' : history.more ? 'No matching activity in the loaded pages.' : 'No activity found in the available history.'}</p>}
    {(hidden || (live && history.more)) && <div className="dm-activity-footer"><Button variant="ghost" size="sm" disabled={history.loading && !hidden}
      onClick={() => { setPage({ scope, shown: shown + 10 }); if (total <= shown + 10) history.moreRows() }}>{history.loading && !hidden ? 'Loading more…' : 'Show more'}</Button></div>}
    {live && history.answer && contextLimited(portfolio) && <p className="dm-rcpt-note" data-position-history-partial="">Some automation events may not yet be linked to this position.</p>}
  </section>
}
