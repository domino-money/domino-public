import { useEffect, useRef, useState } from 'react'
import { reasonText } from '../../../lib/read/describe'
import { COPY, failureText } from '../../../lib/read/screens/copy'
import { cataloguePoolId, createCatalogueSession, verifyCandidate, type CatalogueSession, type CatalogueSnapshot } from '../../../lib/read/screens/catalogueSession'
import { NATIVE_CURRENCY, type AddressKey, type PoolIdKey } from '../../../lib/read/screens/identity'
import { neutralOrder, poolsRequest, projectPoolsView, type PoolOption, type PoolsView } from '../../../lib/read/screens/poolsList'
import { readWithin } from '../../../lib/read/screens/screenRead'
import type { ReadSource } from '../../../lib/read/types'
import { Button } from '../../ui'
import { Address } from './Address'
import { ProviderFigure } from './ProviderFigure'
import { ScreenStatus, type StatusLine } from './ScreenStatus'
import { SymbolText } from './SymbolText'

function PoolRow({ option, checked, onPick, name }: { option: PoolOption; checked: boolean; onPick: () => void; name: string }) {
  return (
    <li className="rounded-[var(--radius)] border bg-surface-1 px-3 py-2.5" data-pool-option={option.kind}>
      <label className="flex cursor-pointer items-start gap-3">
        <input type="radio" name={name} checked={checked} onChange={onPick} className="mt-1 h-4 w-4 shrink-0 accent-[var(--primary)]" />
        <span className="grid min-w-0 flex-1 gap-1">
          <span className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
            <span className="font-medium">
              <SymbolText token={option.currencies[0]} /> / <SymbolText token={option.currencies[1]} />
            </span>
            <span className="rounded-[6px] bg-surface-3 px-1.5 py-0.5 font-mono text-[11px]" data-fee="">
              {option.fee}
            </span>
            <span className="text-[11px] text-fg-subtle">
              {COPY.selection.verifiedAt} {option.block}
            </span>
          </span>
          <Address value={option.key} />
          <span className="text-[12px] text-fg-muted">
            {option.kind === 'discovery'
              ? 'Found by DexScreener discovery, verified on chain'
              : `From the catalogue (${option.catalogue?.source === 'initialize_event' ? 'initialize event' : 'verified observation'} at block ${option.catalogue?.block}), verified on chain`}
            {option.requestedById && ' · asked for by id'}
          </span>
          <span className="text-[12px] text-fg-muted">
            Tick spacing {option.tickSpacing} · {option.integration === 'hookless_fixed_fee' ? COPY.picker.hookless : COPY.picker.needsAdapter} ·{' '}
            {option.hooks === NATIVE_CURRENCY ? 'no hooks' : <>hooks <Address value={option.hooks} /></>}
          </span>
          {option.tokenMetadata === 'partial' && <span className="text-[12px] text-money-wait">{COPY.picker.partialMetadata}</span>}
          {option.providerConflict && <span className="text-[12px] text-money-out">{COPY.picker.providerConflict}</span>}
          <ProviderFigure label="Liquidity" figure={option.liquidity} />
          <ProviderFigure label="24h volume" figure={option.volume} />
          {option.providerNote && (
            <span className="text-[11px] leading-relaxed text-fg-subtle" data-provider-note="">
              {option.providerNote}
            </span>
          )}
          <span className="text-[12px] text-fg-subtle">Pool APR unavailable: {reasonText(option.aprReason)}.</span>
        </span>
      </label>
    </li>
  )
}

/**
 * Catalogue candidates for the token, paged (at most 5 pages). A candidate is
 * not verified at any block; "Verify at the latest block" asks the pools
 * route about that one pool id, and only a pool it returns becomes an option.
 */
function CatalogueCandidates({
  source,
  token,
  paired,
  onVerified,
  verified,
}: {
  source: ReadSource
  token: AddressKey
  paired: AddressKey | null
  onVerified: (option: PoolOption) => void
  verified: ReadonlySet<string>
}) {
  const [snap, setSnap] = useState<CatalogueSnapshot | null>(null)
  const [checking, setChecking] = useState<Record<string, StatusLine>>({})
  const session = useRef<CatalogueSession | null>(null)
  /**
   * Every read still in flight, not just the last one started. Verifying a
   * second row, or paging while one verify runs, used to overwrite the single
   * controller: the first read then outlived the picker, kept its place in the
   * shared queue, and could call back after unmount. Each read removes itself
   * when it settles; unmounting cancels whatever is left.
   */
  const running = useRef(new Set<AbortController>())
  const mounted = useRef(true)
  useEffect(() => {
    const live = running.current
    // Set on every setup, not only at first render: StrictMode replays the
    // effect in development, and a marker only ever cleared in the teardown
    // would stay false for the replayed lifetime, silencing every callback.
    mounted.current = true
    return () => {
      mounted.current = false
      for (const controller of live) controller.abort()
      live.clear()
    }
  }, [])

  /** A controller this component owns for one read, forgotten once it settles. */
  const start = () => {
    const mine = new AbortController()
    running.current.add(mine)
    return { mine, done: () => running.current.delete(mine) }
  }

  const step = (go: (s: CatalogueSession, signal: AbortSignal) => Promise<CatalogueSnapshot>) => {
    session.current ??= createCatalogueSession(source, token, paired)
    const { mine, done } = start()
    setSnap(session.current.snapshot())
    void go(session.current, mine.signal).then((next) => {
      done()
      if (!mine.signal.aborted && mounted.current) setSnap({ ...next })
    })
  }

  const verify = (poolId: PoolIdKey) => {
    const { mine, done } = start()
    setChecking((c) => ({ ...c, [poolId]: { code: 'loading', title: 'Verifying…', detail: '' } }))
    void verifyCandidate(source, token, paired, poolId, { signal: mine.signal }).then((result) => {
      done()
      // A verify that comes back after the picker closed announces nothing and
      // chooses nothing: onVerified must not run for a screen that is gone.
      if (mine.signal.aborted || !mounted.current) return
      if (result.failure) {
        if (result.failure.state !== 'aborted') setChecking((c) => ({ ...c, [poolId]: failureText(result.failure as Exclude<typeof result.failure, null>, 'pools') }))
        return
      }
      if (result.option) {
        onVerified(result.option)
        setChecking((c) => ({ ...c, [poolId]: { code: 'ok', title: `${COPY.picker.verified} at block ${result.option?.block}.`, detail: '' } }))
      } else {
        setChecking((c) => ({ ...c, [poolId]: { code: 'not_found', title: 'Not verified', detail: 'The pools route did not return this pool, so it cannot be chosen.' } }))
      }
    })
  }

  const view = snap?.view
  return (
    <section aria-labelledby="catalogue-heading" className="grid gap-2 rounded-[var(--radius)] border border-dashed p-3" data-catalogue="">
      <h3 id="catalogue-heading" className="text-[13px] font-medium">
        {COPY.picker.catalogueHeading}
      </h3>
      <p className="text-[12px] text-fg-muted">{COPY.picker.catalogueNote}</p>
      {!snap && (
        <Button type="button" variant="outline" className="justify-self-start" onClick={() => step((s, signal) => s.first(signal))}>
          {COPY.picker.catalogueLoad}
        </Button>
      )}
      {snap?.loading && view?.pages === 0 && <p className="text-[12px] text-fg-subtle">Reading the catalogue…</p>}
      {snap?.failure && <ScreenStatus line={failureText(snap.failure, 'catalogue')} />}
      {view && view.pages > 0 && (
        <>
          {view.restarted && <p className="text-[12px] text-money-wait">{COPY.picker.catalogueRestarted}</p>}
          <p className="text-[12px] text-fg-muted">{view.facts.map((fact) => fact.text).join(' ')}</p>
          {view.items.length === 0 && <p className="text-[12px] text-fg-muted">{COPY.picker.catalogueEmpty}</p>}
          <ul className="grid gap-2">
            {view.items.map((item) => {
              const poolId = cataloguePoolId(item.key)
              const done = verified.has(poolId)
              return (
                <li key={item.key} className="rounded-[var(--radius)] border bg-surface-1 px-3 py-2" data-catalogue-item="" {...(item.old ? { 'data-old': '' } : {})}>
                  <Address value={poolId} />
                  <p className="text-[12px] text-fg-muted">
                    {item.facts.map((fact) => `${fact.label}: ${fact.text}`).join(' · ')}
                    {item.old && ` · ${COPY.picker.fromEarlier}`}
                  </p>
                  {done ? (
                    <p className="text-[12px] text-money-in">{COPY.picker.verified}: listed with the existing pools above.</p>
                  ) : (
                    <Button type="button" variant="outline" className="mt-1.5" aria-disabled={checking[poolId]?.code === 'loading' ? true : undefined} onClick={() => checking[poolId]?.code !== 'loading' && verify(poolId)}>
                      {COPY.picker.verify}
                    </Button>
                  )}
                  {checking[poolId] && !done && <ScreenStatus line={checking[poolId]} className="mt-2" />}
                </li>
              )
            })}
          </ul>
          {snap.capped && <p className="text-[12px] text-fg-muted">Showing the first 5 pages.</p>}
          <Button
            type="button"
            variant="outline"
            className="justify-self-start"
            aria-disabled={!snap.canLoadMore ? true : undefined}
            onClick={() => snap.canLoadMore && step((s, signal) => s.more(signal))}
          >
            {snap.loading ? 'Loading…' : snap.canLoadMore ? COPY.picker.loadMore : COPY.picker.allLoaded}
          </Button>
        </>
      )}
    </section>
  )
}

type PoolsResult = { kind: 'loading' } | { kind: 'ok'; view: PoolsView; restarted: boolean } | { kind: 'failed'; line: StatusLine }

/**
 * Existing pools for the chosen token (and second asset, if chosen), from the
 * pools route, in a neutral order, plus the stored catalogue on request.
 * Opening a new pool is described, never offered.
 */
export function PoolPicker({
  source,
  token,
  paired,
  pending,
  onPending,
}: {
  source: ReadSource
  token: AddressKey
  paired: AddressKey | null
  pending: PoolOption | null
  onPending: (option: PoolOption | null) => void
}) {
  const [result, setResult] = useState<PoolsResult>({ kind: 'loading' })
  const [verified, setVerified] = useState<PoolOption[]>([])

  useEffect(() => {
    const controller = new AbortController()
    const request = poolsRequest(token, paired)
    void (async () => {
      let outcome = await readWithin(source, 'pools', request, { signal: controller.signal })
      let restarted = false
      if (outcome.state === 'restart_required' && outcome.code === 'catalogue_revision_changed') {
        restarted = true
        // Same logical read, so the restart keeps the first attempt's deadline
        // instead of starting a fresh screen budget it has not earned.
        const deadlineAt = outcome.provenance.deadlineAt
        outcome = await readWithin(source, 'pools', request, { signal: controller.signal, deadlineAt })
      }
      if (controller.signal.aborted || outcome.state === 'aborted') return
      setResult(outcome.state === 'ok' ? { kind: 'ok', view: projectPoolsView(outcome.data, outcome.provenance.receivedAt), restarted } : { kind: 'failed', line: failureText(outcome, 'pools') })
    })()
    return () => controller.abort()
  }, [source, token, paired])

  const listed = result.kind === 'ok' ? result.view.options : []
  const options = neutralOrder([...listed, ...verified.filter((v) => !listed.some((o) => o.key === v.key))])

  return (
    <div className="grid gap-4" data-picker="pool">
      <ScreenStatus line={result.kind === 'loading' ? { code: 'loading', title: COPY.picker.poolsLoading, detail: '' } : result.kind === 'failed' ? result.line : null} />
      {result.kind === 'ok' && (
        <>
          {result.restarted && <p className="text-[12px] text-money-wait">{COPY.picker.catalogueRestarted}</p>}
          <ul className="grid gap-1 text-[12px] text-fg-muted" data-pools-coverage="">
            {result.view.coverage.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
      {options.length > 0 && (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[13px] font-medium">{COPY.picker.poolsLegend}</legend>
          <ul className="grid gap-2">
            {options.map((option) => (
              <PoolRow key={option.key} option={option} name="pool-option" checked={pending?.key === option.key} onPick={() => onPending(option)} />
            ))}
          </ul>
        </fieldset>
      )}
      {result.kind === 'ok' && result.view.rejected.length > 0 && (
        <section aria-labelledby="rejected-heading" className="grid gap-1.5" data-rejected-pools="">
          <h3 id="rejected-heading" className="text-[13px] font-medium">
            {COPY.picker.rejectedHeading}
          </h3>
          <ul className="grid gap-1.5">
            {result.view.rejected.map((rejected) => (
              <li key={rejected.key} className="rounded-[var(--radius)] border border-dashed px-3 py-2 text-[12px] text-fg-muted">
                <Address value={rejected.key} />
                <span className="block">Rejected: {reasonText(rejected.reason)}.</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <CatalogueCandidates source={source} token={token} paired={paired} verified={new Set(verified.map((v) => v.key))} onVerified={(option) => setVerified((list) => [...list.filter((v) => v.key !== option.key), option])} />
      <p className="rounded-[var(--radius)] border border-dashed p-3 text-[12px] leading-relaxed text-fg-muted" data-new-pool-note="">
        {COPY.picker.newPool}
      </p>
    </div>
  )
}
