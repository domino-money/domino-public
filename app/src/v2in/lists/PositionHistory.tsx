import { useMemo, useState } from 'react'
import { Button } from '../../components/ui'
import type { AutomaticAdds } from '../../components/positions/PositionActivity'
import { FeesActivity } from '../../components/positions/visual/FeesActivity'
import type { FeesEvent } from '../../components/positions/visual/model'
import { contextLimited, positionActivity, type ActivityPosition } from './activityModel'
import { anyIn, chainsIn, useKeyed, useListsGate } from './hooks'
import { useActivityHistory } from './activity'
import { receiptViews } from './model'
import { routeQuiet } from './read'
import { ChainLines, RECEIPT_LIST, ReceiptRow } from './receiptParts'
import { OWN_PORTFOLIO } from './source'

const NO_EVENTS: readonly FeesEvent[] = []

/** The same public history as Receipts, scoped by evidenced position identities. Local fee settlements are retained:
 * one financial operation with the same position and transaction can carry them inside its receipt; ambiguous matches
 * stay independent. No wallet-wide cancellation is attributed to a position merely because the wallet matches.
 */
export default function PositionHistory({ wallet, position, events = NO_EVENTS, automatic }: {
  wallet: string | null; position: ActivityPosition; events?: readonly FeesEvent[]; automatic?: AutomaticAdds | null
}) {
  const gate = useListsGate()
  const live = anyIn(gate, 'live') && wallet !== null
  const history = useActivityHistory(live ? wallet : null)
  const portfolioRead = useKeyed(OWN_PORTFOLIO, live ? wallet?.toLowerCase() ?? null : null)
  const portfolio = portfolioRead?.kind === 'ok' ? portfolioRead.body : null
  const scope = `${wallet ?? ''}:${position.chainId}:${position.dex}:${position.tokenId}`
  const [page, setPage] = useState({ scope, shown: 5 })
  const shown = page.scope === scope ? page.shown : 5
  const matching = useMemo(() => positionActivity(history.answer?.items ?? [], position, portfolio), [history.answer, position, portfolio])
  const receipts = useMemo(() => history.answer ? receiptViews({ ...history.answer, items: matching }, chainsIn(gate, 'live'), portfolio) : [], [history.answer, matching, gate, portfolio])
  const rows = useMemo(() => {
    const attached = new Map<string, FeesEvent[]>()
    const loose = new Map<string, FeesEvent[]>()
    for (const event of events) {
      const candidates = matching.filter((item) => item.tx.hash.toLowerCase() === event.tx.toLowerCase() && ['s1_action', 'vault_execution', 'auto_exit'].includes(item.kind))
      const key = candidates.length === 1 ? candidates[0].id : event.tx.toLowerCase()
      const map = candidates.length === 1 ? attached : loose
      map.set(key, [...(map.get(key) ?? []), event])
    }
    return [
      ...receipts.map((receipt) => ({ id: receipt.id, at: receipt.at, receipt, settlements: attached.get(receipt.id) ?? [] })),
      ...[...loose].map(([tx, settlements]) => ({ id: `ledger:${tx}`, at: settlements[0].timestamp, receipt: null, settlements })),
    ].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
  }, [events, receipts, matching])
  const visible = rows.slice(0, shown)
  const quiet = history.answer === null && routeQuiet(history.error)
  if ((!live || quiet) && events.length === 0) return null
  return <section className="dm-card dm-pos-card dm-pos-activity dm-activity-history" aria-labelledby="position-activity-title" data-position-activity="" data-position-activity-read={history.answer ? 'ok' : history.error?.kind ?? 'loading'}>
    <h2 className="dm-title" id="position-activity-title">Activity</h2>
    {live && history.answer && <ChainLines answer={history.answer} />}
    {live && history.error && !quiet && <p className="dm-rcpt-note" role="status" data-position-activity-reason={history.error.kind === 'unavailable' ? history.error.reason : history.error.detail}>More activity couldn’t be loaded. We’ll try again automatically.</p>}
    {visible.length > 0 && <ol className={`${RECEIPT_LIST} dm-activity-list`} data-position-history-rows={visible.length}>
      {visible.map((row) => row.receipt ? <ReceiptRow key={row.id} view={row.receipt} positionItem={matching.find((item) => item.id === row.id)}>
        {row.settlements.length > 0 && <FeesActivity events={row.settlements} bare automatic={automatic ?? undefined} />}
      </ReceiptRow> : <li key={row.id} data-position-ledger-transaction={row.settlements[0].tx}><FeesActivity events={row.settlements} bare automatic={automatic ?? undefined} /></li>)}
    </ol>}
    {visible.length === 0 && live && !history.error && <p className="dm-rcpt-note" role="status">{!history.answer || history.loading ? 'Loading activity…' : history.more ? 'No matching activity in the loaded pages.' : 'No activity found in the available history.'}</p>}
    {(rows.length > shown || (live && history.more)) && <div className="dm-activity-footer"><Button variant="ghost" size="sm" disabled={history.loading && rows.length <= shown}
      onClick={() => { setPage({ scope, shown: shown + 10 }); if (rows.length <= shown + 10) history.moreRows() }}>{history.loading && rows.length <= shown ? 'Loading more…' : 'Show more'}</Button></div>}
    {live && history.answer && contextLimited(portfolio) && <p className="dm-rcpt-note" data-position-history-partial="">Some automation events may not yet be linked to this position.</p>}
  </section>
}
