import { useEffect, useState } from 'react'
import { describeFailure } from '../../lib/read/describe'
import { createCataloguePager, createWalletPager, readRestartingOnce, type CatalogueView, type PageStep, type Pager, type WalletView } from '../../lib/read/pagers'
import { projectFamily, type Fact, type FamilyView, type ItemView } from '../../lib/read/project'
import type { FailedOutcome, ReadOutcome, ReadRequests, ReadRoute, ReadSource } from '../../lib/read/types'
import { TokenMark } from '../TokenIcon'
import { Button, Card, cx } from '../ui'
import { TokenLabel } from './TokenLabel'

const TONE: Record<Fact['state'], string> = {
  value: 'text-fg',
  zero: 'text-fg',
  raw: 'text-fg',
  absent: 'text-fg-subtle',
  partial: 'text-money-wait',
  stale: 'text-money-wait',
  'not-current': 'text-fg-subtle',
  unavailable: 'text-fg-subtle',
  rejected: 'text-money-out',
}

function FactValue({ fact }: { fact: Fact }) {
  return (
    <dd className={cx('flex min-w-0 items-center justify-end gap-2 text-right font-mono text-[12px]', TONE[fact.state])} data-fact-state={fact.state}>
      {fact.tokens?.map((token, i) => (
        <span key={`${token.address ?? token.symbol}-${i}`} className="inline-flex min-w-0 items-center gap-1.5">
          <TokenMark token={token} size={16} />
          <TokenLabel token={token} />
        </span>
      ))}
      {fact.untrusted ? <bdi className="inline-block max-w-[24ch] truncate align-bottom">{fact.text}</bdi> : fact.text && <span className="break-all">{fact.text}</span>}
    </dd>
  )
}

export function Facts({ facts }: { facts: Fact[] }) {
  return (
    <dl className="grid gap-0">
      {facts.map((fact) => (
        <div key={fact.label} className="flex items-baseline justify-between gap-4 border-b border-dashed py-1.5 last:border-b-0">
          <dt className="shrink-0 text-[12px] text-fg-muted">{fact.label}</dt>
          <FactValue fact={fact} />
        </div>
      ))}
    </dl>
  )
}

function Items({ items }: { items: ItemView[] }) {
  if (items.length === 0) return null
  return (
    <ul className="mt-3 grid gap-2">
      {items.map((item) => (
        <li key={item.key} className="rounded-[12px] border bg-surface-2 px-3 py-2" data-item-key={item.key} {...(item.old ? { 'data-old': '' } : {})}>
          <div className="flex items-center justify-between gap-3 text-[12px]">
            <span className="text-fg-muted">
              {item.title.label}
              {item.old && ' · from before the list restarted'}
            </span>
            <FactValue fact={item.title} />
          </div>
          <Facts facts={item.facts} />
        </li>
      ))}
    </ul>
  )
}

function Footnotes({ notes, freshness }: { notes: string[]; freshness: string[] }) {
  return (
    <>
      {notes.map((note) => (
        <p key={note} className="mt-2 text-[12px] text-fg-muted">
          {note}
        </p>
      ))}
      {freshness.length > 0 && <p className="mt-2 font-mono text-[11px] text-fg-subtle">{freshness.join(' · ')}</p>}
    </>
  )
}

export function FamilyPanel({ view, restarted }: { view: FamilyView; restarted?: boolean }) {
  return (
    <div data-read-state="ok">
      {restarted && <p className="mb-2 text-[12px] text-money-wait">The catalogue changed during the read, so it was asked again once.</p>}
      <Facts facts={view.facts} />
      <Items items={view.items} />
      <Footnotes notes={view.notes} freshness={view.freshness} />
    </div>
  )
}

export function FailureNote({ outcome }: { outcome: FailedOutcome }) {
  const text = describeFailure(outcome)
  const reason = 'reason' in outcome ? outcome.reason : 'code' in outcome ? outcome.code : outcome.state === 'unavailable' ? outcome.cause.kind : ''
  return (
    <div data-read-state={outcome.state} data-read-reason={reason}>
      <p className="text-[13px] font-medium">{text.title}</p>
      <p className="text-[12px] text-fg-muted">{text.detail}</p>
    </div>
  )
}

function Loading() {
  return (
    <p className="text-[12px] text-fg-subtle" data-loading="">
      Reading…
    </p>
  )
}

function SingleRead<R extends ReadRoute>({ source, route, request }: { source: ReadSource; route: R; request: ReadRequests[R] }) {
  const [result, setResult] = useState<{ outcome: ReadOutcome<R>; restarted: boolean } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void readRestartingOnce(source, route, request, controller.signal).then((next) => {
      if (!controller.signal.aborted) setResult(next)
    })
    return () => controller.abort()
  }, [source, route, request])
  if (!result) return <Loading />
  if (result.outcome.state !== 'ok') return <FailureNote outcome={result.outcome} />
  return <FamilyPanel view={projectFamily(result.outcome)} restarted={result.restarted} />
}

/**
 * A paged list. "Load more" stays mounted and keeps focus through every page,
 * saying when it is busy or done, and a polite status line reports what each
 * page added. The continuation handle never reaches this component.
 */
function PagedList<V extends { hasMore: boolean; restarted: boolean; pages: number }>({
  pager,
  render,
}: {
  pager: Pager<V>
  render: (view: V) => React.ReactNode
}) {
  const [step, setStep] = useState<PageStep<V> | null>(null)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void pager.first(controller.signal).then((next) => {
      if (!controller.signal.aborted) setStep(next)
    })
    return () => controller.abort()
  }, [pager])

  if (!step) return <Loading />
  if (step.view.pages === 0 && step.failure) return <FailureNote outcome={step.failure} />

  const more = async () => {
    if (busy || !step.view.hasMore) return
    setBusy(true)
    const next = await pager.more()
    setStep(next)
    setBusy(false)
    setSaid(next.failure ? describeFailure(next.failure).title : next.view.restarted && !step.view.restarted ? 'The list restarted from the first page.' : `${next.added} more loaded.`)
  }
  return (
    <div data-read-state="ok" data-pages={step.view.pages}>
      {step.view.restarted && <p className="mb-2 text-[12px] text-money-wait">The page handle expired or the list changed, so it restarted from the first page.</p>}
      {render(step.view)}
      {step.failure && <FailureNote outcome={step.failure} />}
      <div className="mt-3 flex items-center gap-3">
        <Button variant="outline" aria-disabled={busy || !step.view.hasMore ? true : undefined} onClick={() => void more()}>
          {busy ? 'Loading…' : step.view.hasMore ? 'Load more' : 'All pages loaded'}
        </Button>
        <p role="status" aria-live="polite" className="text-[12px] text-fg-muted">
          {said}
        </p>
      </div>
    </div>
  )
}

function WalletList({ source, request }: { source: ReadSource; request: ReadRequests['wallet-assets'] }) {
  const [pager] = useState(() => createWalletPager(source, request))
  return (
    <PagedList<WalletView>
      pager={pager}
      render={(view) => (
        <>
          <ul className="grid gap-1">
            {view.rows.map((row) => (
              <li key={row.key} className="flex items-center justify-between gap-3 text-[12px]" data-item-key={row.key} {...(row.old ? { 'data-old': '' } : {})}>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <TokenMark token={row.token} size={16} />
                  <TokenLabel token={row.token} />
                  <span className="text-fg-subtle">
                    page {row.page}
                    {row.old && ' · from before the list restarted'}
                  </span>
                </span>
                <FactValue fact={row.amount} />
              </li>
            ))}
          </ul>
          <Items items={view.unavailable} />
          <Footnotes notes={view.notes} freshness={view.freshness} />
        </>
      )}
    />
  )
}

function CatalogueList({ source, request }: { source: ReadSource; request: ReadRequests['catalogue'] }) {
  const [pager] = useState(() => createCataloguePager(source, request))
  return (
    <PagedList<CatalogueView>
      pager={pager}
      render={(view) => (
        <>
          <Facts facts={view.facts} />
          <Items items={view.items} />
          <Footnotes notes={view.notes} freshness={view.freshness} />
        </>
      )}
    />
  )
}

export function FamilyCaseView({
  source,
  route,
  request,
  pager,
}: {
  source: ReadSource
  route: ReadRoute
  request: ReadRequests[ReadRoute]
  pager?: 'wallet' | 'catalogue'
}) {
  return (
    <Card className="p-4">
      {pager === 'wallet' ? (
        <WalletList source={source} request={request as ReadRequests['wallet-assets']} />
      ) : pager === 'catalogue' ? (
        <CatalogueList source={source} request={request as ReadRequests['catalogue']} />
      ) : (
        <SingleRead source={source} route={route} request={request} />
      )}
    </Card>
  )
}
