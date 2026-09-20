import { useEffect, useMemo, useState } from 'react'
import type { ReadRequests, ReadSource } from '../../../lib/read/types'
import type { MarketsProvider, MarketsState } from '../../../lib/read/marketsProvider'
import { overviewRows } from '../../../lib/read/publicOverview'
import { candidateFromToken } from '../../../lib/read/screens/tokens'
import { readWithin, type ScreenOutcome } from '../../../lib/read/screens/screenRead'
import { whenVisibleAfter } from '../../../lib/read/screens/quietRead'
import { failureText } from '../../../lib/read/screens/copy'
import { MarketsContext } from '../../../lib/read/useMarkets'
import { MarketsTable } from '../../MarketsTable'
import { Button, Card, Skeleton } from '../../ui'
import { Address } from './Address'
import { SymbolText } from './SymbolText'

type Page = Pick<ReadRequests['overview'], 'afterPoolId' | 'revision'>
type Success = Extract<ScreenOutcome<'overview'>, { state: 'ok' }>

/** One bounded page at a time. Storage acquisition survives leaving the page;
 * this consumer only refreshes visible observations and never waits for full
 * historical coverage before showing current values. */
export function StoredTokenExplorer({ source, token }: { source: ReadSource; token: string }) {
  const [pages, setPages] = useState<Page[]>([{}])
  const [refresh, setRefresh] = useState(0)
  const [answer, setAnswer] = useState<{ key: string; outcome: ScreenOutcome<'overview'> } | null>(null)
  const [retained, setRetained] = useState<{ key: string; outcome: Success } | null>(null)
  const page = pages[pages.length - 1]
  const key = `${token}:${page.afterPoolId ?? ''}:${page.revision ?? ''}`
  const outcome = answer?.key === key ? answer.outcome : null
  const value = outcome?.state === 'ok' ? outcome : retained?.key === key ? retained.outcome : null

  useEffect(() => {
    const controller = new AbortController()
    let cancel: (() => void) | null = null
    const load = async () => {
      const read = await readWithin(source, 'overview', { token, ...page, limit: 24 }, { signal: controller.signal })
      if (controller.signal.aborted || read.state === 'aborted') return
      if (read.state === 'restart_required' && pages.length > 1) {
        setPages([{}]); setAnswer(null); setRetained(null)
        return
      }
      setAnswer({ key, outcome: read })
      if (read.state === 'ok') setRetained({ key, outcome: read })
      // Successful pages and acquisition pending pages refresh every five
      // seconds. Failures slow to a minute; gate/config failures stop.
      const stop = ['gate_required', 'gate_unavailable', 'access_required', 'disabled', 'not_connected', 'incompatible', 'invalid'].includes(read.state)
      if (!stop) cancel = whenVisibleAfter(read.state === 'ok' ? 5_000 : 60_000, () => setRefresh((n) => n + 1))
    }
    if (typeof document === 'undefined' || !document.hidden) void load()
    else cancel = whenVisibleAfter(0, () => void load())
    return () => { controller.abort(); cancel?.() }
  }, [source, token, page, key, pages.length, refresh])

  const rows = useMemo(() => value ? overviewRows(value) : [], [value])
  const provider = useMemo<MarketsProvider>(() => {
    const state: MarketsState = { phase: 'ready', result: { source: 'live', chainId: 4663, network: 'Robinhood Chain', markets: rows }, problems: [] }
    return { kind: 'bridge', getSnapshot: () => state, subscribe: () => () => {}, ensure() {}, refresh() { setRefresh((n) => n + 1) } }
  }, [rows])
  const selected = value?.data.tokens.find((entry) => entry.address === token)
  const candidate = selected?.value ? candidateFromToken(selected.value, token) : null
  const pending = value?.data.tokens.some((entry) => entry.acquisition.status === 'pending') || value?.data.pools.some((entry) => entry.acquisition.status === 'pending')
  const failure = outcome && outcome.state !== 'ok' && outcome.state !== 'aborted' ? failureText(outcome, 'pools').title : null

  return (
    <section className="mt-6 grid gap-4" data-stored-token={token}>
      <Card className="p-5">
        <h2 className="text-title font-medium">{candidate ? <SymbolText token={candidate.token} /> : 'Token data'}</h2>
        <p className="mt-2 text-caption text-fg-muted"><Address value={token} /></p>
        {!value && !failure && <Skeleton className="mt-3 h-5 w-48" />}
        <p role="status" className="mt-3 text-caption text-fg-muted">{failure ?? (pending ? 'Collecting data. Available figures are shown below.' : selected?.acquisition.status === 'rejected' ? 'This token could not be verified.' : 'Known verified pools. This list does not imply complete chain history.')}</p>
      </Card>
      {value && <MarketsContext.Provider value={provider}><MarketsTable variant="full" includeCatalogue={false} poolToken={token} empty={<p className="p-5 text-body text-fg-muted">{pending ? 'Pool data is being collected.' : 'No verified pools are stored for this token yet.'}</p>} /></MarketsContext.Provider>}
      <div className="flex gap-3">
        {pages.length > 1 && <Button variant="ghost" onClick={() => { setPages((prior) => prior.slice(0, -1)); setAnswer(null); setRetained(null) }}>Previous pools</Button>}
        {value?.data.hasMore && value.data.nextAfterPoolId && <Button onClick={() => { setPages((prior) => [...prior, { afterPoolId: value.data.nextAfterPoolId, revision: value.data.revision }]); setAnswer(null); setRetained(null) }}>More pools</Button>}
      </div>
    </section>
  )
}
