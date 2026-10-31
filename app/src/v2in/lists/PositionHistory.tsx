import { useEffect, useMemo, useState } from 'react'
import { activityMint, type ActivityMint } from '../../lib/chart/positionOpened'
import { Button } from '../../components/ui'
import type { AutomaticAdds } from '../../components/positions/PositionActivity'
import { FeesActivity } from '../../components/positions/visual/FeesActivity'
import type { FeesEvent } from '../../components/positions/visual/model'
import { contextLimited, positionActivity, timelineRows, type ActivityPosition } from './activityModel'
import { compareChronology } from './chronology'
import { anyIn, chainsIn, useKeyed, useListsGate, useSessionReceipts } from './hooks'
import { useActivityHistory } from './activity'
import { receiptViews, sessionReceiptView } from './model'
import { ChainLines, RECEIPT_LIST, ReceiptRow } from './receiptParts'
import { OWN_PORTFOLIO } from './source'
import { LocalReceiptRow, useLocalReceipts } from './LocalReceiptRow'
import { activityWindow, immediateRows, sessionActivity, sessionAutomation } from './sessionActivity'
import { sessionReceipts } from './sessionReceipts'
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
  // Changed on purpose (2026-10-15, pack 8): this position's own actions of this browser are rows at once, until read-v6
  // lists the same transaction (as in ./Receipts.tsx); only a setup was drawn before.
  const sessions = useSessionReceipts(live ? wallet : null)
  const pending = useMemo(() => {
    if (!live) return []
    const indexed = answer?.items ?? []
    const named = [...(portfolio?.tokens ?? []), ...(answer?.tokens ?? [])]
    return immediateRows(sessionActivity(wallet, history.proofs, indexed, position), sessionAutomation(wallet, history.proofs, indexed, named, position),
      sessionReceipts(wallet, sessions, indexed, position).map((entry) => ({ view: sessionReceiptView(entry, named, receiptFinality), observedAt: entry.observedAt })))
  }, [live, wallet, history.proofs, answer, receiptFinality, portfolio, sessions, position])
  const { immediate, visible, total, hidden } = activityWindow(pending, rows, shown)
  if (!live && events.length === 0) return null
  return <section className="dm-card dm-pos-card dm-pos-activity dm-activity-history" aria-labelledby="position-activity-title" data-position-activity="" data-position-activity-read={history.answer ? 'ok' : history.error?.kind ?? 'loading'}>
    <h2 className="dm-title" id="position-activity-title">Activity</h2>
    {live && history.answer && <ChainLines answer={history.answer} />}
    {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): a page that failed is asked again quietly; it said
        "More activity couldn’t be loaded. We’ll try again automatically." */}
    {live && history.error && <span hidden data-position-activity-reason={history.error.kind === 'unavailable' ? history.error.reason : history.error.detail} />}
    {visible.length + immediate.length > 0 && <ol className={`${RECEIPT_LIST} dm-activity-list`} data-position-history-rows={visible.length + immediate.length}>
      {immediate.map(item => item.setup ? <SessionActivityRow key={item.key} item={item.setup} /> : <ReceiptRow key={item.key} view={item.view} />)}
      {visible.map((row) => row.operation?.kind === 'local' ? <LocalReceiptRow key={row.id} receipt={row.operation.item} at={row.at} tokens={portfolio?.tokens ?? history.answer?.tokens ?? []}>
        {row.settlements.length > 0 && <FeesActivity events={row.settlements} bare automatic={automatic ?? undefined} />}
      </LocalReceiptRow>
        : row.operation ? <ReceiptRow key={row.id} view={row.operation.receipt} effects={row.operation.receipts} showGas={row.operation.showGas} positionItem={row.operation.events.find((item) => item.id === (row.operation?.kind === 'public' ? row.operation.receipt.id : null))}>
        {row.settlements.length > 0 && <FeesActivity events={row.settlements} bare automatic={automatic ?? undefined} />}
      </ReceiptRow> : <li key={row.id} data-position-ledger-transaction={row.settlements[0].tx}><FeesActivity events={row.settlements} bare automatic={automatic ?? undefined} /></li>)}
    </ol>}
    {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): nothing while a page is on its way (it said "Loading activity…"). */}
    {/* (QA round 2, SWEEP) Said only once the whole history is in, in the Receipts card's words; with more to read, Show
        more alone (it said "No matching activity in the loaded pages.", or "No activity found in the available history."). */}
    {visible.length + immediate.length === 0 && live && !history.error && history.answer && !history.loading && !history.more && <p className="dm-rcpt-note" role="status">No activity yet.</p>}
    {/* (QA round 2, N67) Show more pages the wallet's whole history, so once this position's own creation is listed nothing
        older can be its own: the button goes (it stayed, and a click added nothing). Without that row, as before. */}
    {(hidden || (live && history.more && !mint)) && <div className="dm-activity-footer"><Button variant="ghost" size="sm" disabled={history.loading && !hidden}
      onClick={() => { setPage({ scope, shown: shown + 10 }); if (total <= shown + 10) history.moreRows() }}>{history.loading && !hidden ? 'Loading more…' : 'Show more'}</Button></div>}
    {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): it said "Some automation events may not yet be linked to this position." */}
    {live && history.answer && contextLimited(portfolio) && <span hidden data-position-history-partial="" />}
  </section>
}
