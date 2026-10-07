import { Fragment, useEffect, useMemo, useState } from 'react'
import Execution, { CancelledRow, ExecutionReceiptRow, useExecutionHistory, useTokenDetails } from '../../screens/Execution'
import { Button } from '../../components/ui'
import { openWalletDialog, signedOutLine } from '../../finance/signedOut'
import { NOTHING_YET_BOTH, type CardShows } from '../../lib/automationCards'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { privateTimes, timelineRows } from './activityModel'
import { useActivityHistory } from './activity'
import { anyIn, chainsIn, useKeyed, useListsGate } from './hooks'
import { receiptViews } from './model'
import { routeQuiet } from './read'
import { ChainLines, ReceiptRow, RECEIPT_LIST } from './receiptParts'
import { OWN_PORTFOLIO } from './source'

const PAGE_ROWS = 10

/** One list and one page control. Public chain history and signed-in execution evidence keep their own authority. */
export default function Receipts({ limit, onShows }: { limit?: number; onShows?: (shows: CardShows | null) => void }) {
  const identity = useWalletIdentity()
  const wallet = identity.kind === 'connected' ? identity.address.toLowerCase() : null
  const gate = useListsGate()
  const live = anyIn(gate, 'live') && wallet !== null
  const history = useActivityHistory(live ? wallet : null)
  const portfolio = useKeyed(OWN_PORTFOLIO, live ? wallet : null)
  const privateHistory = useExecutionHistory()
  const { view, session, items } = privateHistory
  const [page, setPage] = useState({ wallet, shown: PAGE_ROWS })
  const shown = page.wallet === wallet ? page.shown : PAGE_ROWS
  const publicViews = useMemo(() => history.answer ? receiptViews(history.answer, chainsIn(gate, 'live'), portfolio?.kind === 'ok' ? portfolio.body : null) : [], [history.answer, gate, portfolio])
  const rows = useMemo(() => timelineRows(publicViews, items, privateTimes(items, history.answer?.items ?? [])), [publicViews, items, history.answer])
  const visible = rows.slice(0, limit ?? shown)
  const tokens = useTokenDetails(visible.flatMap((row) => row.kind === 'private' ? row.item.receipt?.sources.map((source) => source.currency) ?? [] : []))
  const cancelled = items.filter((item) => item.state === 'cancelled')
  const privateOut = signedOutLine(session.kind, 'history')
  const loading = history.loading || view.busy || view.reading
  const hidden = visible.length < rows.length
  const more = hidden || history.more || view.more
  const quiet = history.answer === null && routeQuiet(history.error)
  const showing = useMemo<CardShows | null>(() => {
    if (rows.length || cancelled.length) return { kind: 'content' }
    if (!history.answer && !history.error) return null
    if ((!quiet && history.error) || view.state === 'unavailable') return { kind: 'other' }
    if (history.answer) return { kind: 'none', reason: 'empty', text: NOTHING_YET_BOTH, action: null }
    return view.state === 'signed_out' ? { kind: 'none', reason: session.kind, ...signedOutLine(session.kind, 'both') } : null
  }, [rows.length, cancelled.length, history.answer, history.error, quiet, view.state, session.kind])
  useEffect(() => { if (live && !quiet) onShows?.(showing) }, [live, quiet, onShows, showing])

  if (!live || quiet) return <Execution limit={limit} onShows={onShows} />
  return (
    <section className="dm-activity-history" aria-label="Activity history" aria-busy={loading || undefined} data-unified-activity="" data-execution={view.state}
      data-execution-rows={visible.filter((row) => row.kind === 'private').length} data-v2-own-receipts={history.answer ? 'ok' : history.error?.kind ?? 'loading'}>
      {history.answer && <ChainLines answer={history.answer} />}
      {history.error && <p className="dm-rcpt-note" role="status" data-activity-error="">{history.answer ? 'Showing loaded activity. More activity will be checked again automatically.' : 'Activity is unavailable right now. We’ll try again automatically.'}</p>}
      {view.state === 'unavailable' && <p className="dm-rcpt-note" role="status" data-receipts-update={view.state}>Additional signed-in history couldn’t be updated.</p>}
      {history.catchingUp && <p className="dm-rcpt-note" role="status">Loading new activity…</p>}
      {visible.length > 0 && (
        <ol className={RECEIPT_LIST + ' dm-activity-list'} data-v2-receipts="own" data-v2-receipts-rows={visible.filter((row) => row.kind === 'public').length} data-activity-rows={visible.length}>
          {visible.map((row, index) => <Fragment key={row.id}>
            {limit === undefined && row.at === null && (index === 0 || visible[index - 1].at !== null) && <li className="dm-activity-divider">Records without a date</li>}
            {row.kind === 'public' ? <ReceiptRow view={row.receipt} /> : <ExecutionReceiptRow item={row.item} at={row.at} refreshFailed={view.refreshFailed[row.item.intentId]} tokens={tokens} />}
          </Fragment>)}
        </ol>
      )}
      {visible.length === 0 && !history.error && <p className="dm-rcpt-note" role="status">{!history.answer ? 'Loading activity…' : history.more ? 'More history is available.' : 'No activity yet.'}</p>}
      {limit === undefined && more && <div className="dm-activity-footer"><Button variant="ghost" size="sm" disabled={loading && !hidden}
        onClick={() => {
          setPage({ wallet, shown: shown + PAGE_ROWS })
          if (rows.length <= shown + PAGE_ROWS) { history.moreRows(); privateHistory.nextPage() }
        }}>{loading && !hidden ? 'Loading more…' : 'Show more'}</Button></div>}
      {cancelled.length > 0 && <details className="dm-activity-internal" data-activity-internal="">
        <summary>Internal automation checks</summary>
        <ol className="dm-rcpt-list"><CancelledRow items={cancelled} /></ol>
        <p className="dm-rcpt-note">These are loaded records, not transactions. Their dates aren’t available.</p>
      </details>}
      {view.state === 'signed_out' && <details className="dm-activity-internal" data-signed-out={session.kind}>
        <summary>Additional signed-in history</summary>
        <p className="dm-rcpt-note">{privateOut.text}</p>
        {privateOut.action && <Button variant="outline" size="sm" onClick={openWalletDialog}>{privateOut.action}</Button>}
      </details>}
    </section>
  )
}
