import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import Execution, { CancelledRow, ExecutionReceiptRow, useExecutionHistory, useTokenDetails } from '../../screens/Execution'
import { Button } from '../../components/ui'
import { openWalletDialog, signedOutLine } from '../../finance/signedOut'
import { NOTHING_YET_BOTH, type CardShows } from '../../lib/automationCards'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { privateTimes, timelineRows } from './activityModel'
import { useActivityHistory } from './activity'
import { anyIn, chainsIn, useKeyed, useListsGate, useSessionReceipts } from './hooks'
import { receiptViews, sessionReceiptView } from './model'
import { ChainLines, ReceiptRow, RECEIPT_LIST } from './receiptParts'
import { OWN_PORTFOLIO } from './source'
import { routeQuiet } from './read'
import { LocalReceiptRow, useLocalReceipts } from './LocalReceiptRow'
import { activityWindow, immediateRows, sessionActivity, sessionAutomation } from './sessionActivity'
import { sessionReceipts } from './sessionReceipts'
import { SessionActivityRow } from './SessionActivityRow'
import { RELOAD_WORDS, useWaitOver } from '../../lib/readWait'

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
  const local = useLocalReceipts(wallet)
  const { view, session, items } = privateHistory
  const [page, setPage] = useState({ wallet, shown: PAGE_ROWS })
  const shown = page.wallet === wallet ? page.shown : PAGE_ROWS
  const publicViews = useMemo(() => history.answer ? receiptViews(history.answer, chainsIn(gate, 'live'), portfolio?.kind === 'ok' ? portfolio.body : null, history.receiptFinality) : [], [history.answer, history.receiptFinality, gate, portfolio])
  const rows = useMemo(() => timelineRows(publicViews, items, privateTimes(items, history.answer?.items ?? []), history.answer?.items ?? [], local), [publicViews, items, history.answer, local])
  // Changed on purpose (2026-10-15, pack 8): every own action of this browser is a row at once (a setup, any other
  // automation step, and each position action's checked receipt), until read-v6 lists the same transaction; then its
  // item takes the place in the same render (./sessionReceipts.ts). Only a setup was drawn before the index listed it.
  const sessions = useSessionReceipts(wallet)
  const pending = useMemo(() => {
    const indexed = history.answer?.items ?? []
    const named = [...(portfolio?.kind === 'ok' ? portfolio.body.tokens : []), ...(history.answer?.tokens ?? [])]
    return immediateRows(sessionActivity(wallet, history.proofs, indexed), sessionAutomation(wallet, history.proofs, indexed, named),
      sessionReceipts(wallet, sessions, indexed).map((entry) => ({ view: sessionReceiptView(entry, named, history.receiptFinality), observedAt: entry.observedAt })))
  }, [wallet, history.proofs, history.answer, history.receiptFinality, portfolio, sessions])
  const { immediate, visible, total, hidden } = activityWindow(pending, rows, limit ?? shown)
  const tokens = useTokenDetails(visible.flatMap((row) => (row.kind === 'private' ? [row.item] : row.kind === 'public' ? row.evidence : []).flatMap((item) => item.receipt?.sources.map((source) => source.currency) ?? [])))
  const cancelled = items.filter((item) => item.state === 'cancelled')
  const privateOut = signedOutLine(session.kind, 'history')
  const loading = history.loading || view.busy || view.reading
  const more = hidden || history.more || view.more
  const fill = useRef({ wallet, pages: 0 })
  useEffect(() => {
    if (fill.current.wallet !== wallet) fill.current = { wallet, pages: 0 }
    if (limit !== undefined && total < limit && history.more && !history.loading && !history.error && fill.current.pages < 3) {
      fill.current.pages++
      history.moreRows()
    }
  }, [wallet, limit, total, history])
  const showing = useMemo<CardShows | null>(() => {
    if (total || cancelled.length) return { kind: 'content' }
    if (!history.answer && !history.error) return null
    if (history.error || view.state === 'unavailable') return { kind: 'other' }
    if (history.answer) return { kind: 'none', reason: 'empty', text: NOTHING_YET_BOTH, action: null }
    return view.state === 'signed_out' ? { kind: 'none', reason: session.kind, ...signedOutLine(session.kind, 'both') } : null
  }, [total, cancelled.length, history.answer, history.error, view.state, session.kind])
  useEffect(() => { if (live) onShows?.(showing) }, [live, onShows, showing])
  // Added 2026-11-09 (core flows, the owner: nothing may load forever): a history that has only failed so far, with nothing
  // of this browser's to show, says what to do after STUCK_MS (a route simply not on says nothing, as before); the card was
  // blank under its title for good. It is still asked again by itself (./activityHistory.ts: 5 s, 15 s, 45 s, then every
  // minute), and its rows replace the line.
  const stuck = useWaitOver(live && !history.answer && history.error !== null && !routeQuiet(history.error) && visible.length + immediate.length === 0)

  if (!live) return <Execution limit={limit} onShows={onShows} />
  return (
    <section className="dm-activity-history" aria-label="Activity history" aria-busy={loading || undefined} data-unified-activity="" data-execution={view.state}
      data-execution-rows={visible.filter((row) => row.kind === 'private').length} data-v2-own-receipts={history.answer ? 'ok' : history.error?.kind ?? 'loading'}>
      {history.answer && <ChainLines answer={history.answer} />}
      {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): what is loaded stays, and what failed is asked
          again quietly. Gone: "Showing loaded activity. More activity will be checked again automatically.", "Activity is
          unavailable right now. We’ll try again automatically.", "Additional signed-in history couldn’t be updated." and
          "Loading new activity…" (the markers keep where the reads stand). */}
      {history.error && <span hidden data-activity-error="" />}
      {view.state === 'unavailable' && <span hidden data-receipts-update={view.state} />}
      {visible.length + immediate.length > 0 && (
        <ol className={RECEIPT_LIST + ' dm-activity-list'} data-v2-receipts="own" data-v2-receipts-rows={visible.filter((row) => row.kind === 'public').length} data-activity-rows={visible.length + immediate.length}>
          {immediate.map(item => item.setup ? <SessionActivityRow key={item.key} item={item.setup} /> : <ReceiptRow key={item.key} view={item.view} />)}
          {visible.map((row, index) => <Fragment key={row.id}>
            {limit === undefined && row.at === null && (index === 0 || visible[index - 1].at !== null) && <li className="dm-activity-divider">Records without a date</li>}
            {row.kind === 'public' ? <ReceiptRow view={row.receipt} effects={row.receipts} showGas={row.showGas} positionItem={row.events.find((item) => item.id === row.receipt.id)}>
              {row.evidence.length > 0 && <details className="dm-activity-internal"><summary>Signed-in execution record</summary><ol className="dm-rcpt-list">
                {row.evidence.map((item) => <ExecutionReceiptRow key={item.intentId} item={item} at={row.at} refreshFailed={view.refreshFailed[item.intentId]} tokens={tokens} />)}
              </ol></details>}
            </ReceiptRow> : row.kind === 'local' ? <LocalReceiptRow receipt={row.item} at={row.at} tokens={portfolio?.kind === 'ok' ? portfolio.body.tokens : history.answer?.tokens ?? []} />
              : <ExecutionReceiptRow item={row.item} at={row.at} refreshFailed={view.refreshFailed[row.item.intentId]} tokens={tokens} />}
          </Fragment>)}
        </ol>
      )}
      {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): nothing while the first page is on its way (it said "Loading activity…"). */}
      {/* (QA round 2, SWEEP) Said only once the whole history is in; with more to read, nothing (it said "More history is available."). */}
      {visible.length + immediate.length === 0 && !history.error && history.answer && !history.more && <p className="dm-rcpt-note" role="status">No activity yet.</p>}
      {stuck && <p className="dm-rcpt-note" role="status" data-v2-receipts-stuck="">{RELOAD_WORDS.receipts}</p>}
      {limit === undefined && more && <div className="dm-activity-footer"><Button variant="ghost" size="sm" disabled={loading && !hidden}
        onClick={() => {
          setPage({ wallet, shown: shown + PAGE_ROWS })
          if (total <= shown + PAGE_ROWS) { history.moreRows(); privateHistory.nextPage() }
        }}>{loading && !hidden ? 'Loading more…' : 'Show more'}</Button></div>}
      {limit === undefined && cancelled.length > 0 && <details className="dm-activity-internal" data-activity-internal="">
        <summary>Internal automation checks</summary>
        <ol className="dm-rcpt-list"><CancelledRow items={cancelled} /></ol>
        {/* (QA round 2, SWEEP) It added "Their dates aren’t available."; the records carry no date, and none is drawn. */}
        <p className="dm-rcpt-note">These are internal checks, not transactions.</p>
      </details>}
      {limit === undefined && view.state === 'signed_out' && <details className="dm-activity-internal" data-signed-out={session.kind}>
        <summary>Additional signed-in history</summary>
        <p className="dm-rcpt-note">{privateOut.text}</p>
        {privateOut.action && <Button variant="outline" size="sm" onClick={openWalletDialog}>{privateOut.action}</Button>}
      </details>}
    </section>
  )
}
