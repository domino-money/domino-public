import { useEffect, useRef, useState } from 'react'
import { reasonText } from '../../../lib/read/describe'
import { COPY, failureText } from '../../../lib/read/screens/copy'
import { cataloguePoolId, createCatalogueSession, verifyCandidate, type CatalogueSession, type CatalogueSnapshot } from '../../../lib/read/screens/catalogueSession'
import { NATIVE_CURRENCY, type AddressKey, type PoolIdKey } from '../../../lib/read/screens/identity'
import { neutralOrder, poolsRequest, projectPoolsView, type PoolOption, type PoolsView } from '../../../lib/read/screens/poolsList'
import { readWithin } from '../../../lib/read/screens/screenRead'
import type { ReadSource } from '../../../lib/read/types'
import { IconChevronRight } from '../../icons'
import { TokenMarkPair } from '../../TokenIcon'
import { Button, cx } from '../../ui'
import { Address } from './Address'
import { ProviderFigure } from './ProviderFigure'
import { ScreenStatus, type StatusLine } from './ScreenStatus'
import { SymbolText } from './SymbolText'

/**
 * One verified pool. As a radio it is a choice inside a picker; with `open`
 * it is a way in, and `onPick` opens the pool. The accessible name is the
 * row's own text, never an attribute built from a symbol.
 */
function PoolRow({ option, checked, onPick, name, compact = false, open = false }: { option: PoolOption; checked: boolean; onPick: () => void; name: string; compact?: boolean; open?: boolean }) {
  const identity = (
    <>
      <TokenMarkPair base={option.currencies[0]} quote={option.currencies[1]} size={compact ? 28 : 32} ring="var(--surface-1)" />
      <span className="grid min-w-0 flex-1 gap-0.5 text-left">
        <span className="text-body font-medium text-fg"><SymbolText token={option.currencies[0]} /> / <SymbolText token={option.currencies[1]} /></span>
        <span className="text-caption text-fg-subtle">Uniswap · <Address value={option.key} short /></span>
      </span>
      <span className="dm-chip shrink-0" data-fee="">{option.fee}</span>
    </>
  )
  return (
    <li className={cx('dm-mkt-option', checked && 'dm-mkt-option--checked')} data-pool-option={option.kind}>
      {open ? (
        <button type="button" onClick={onPick} className="dm-mkt-option-head" data-open-pool="">
          {identity}
          <IconChevronRight size={14} />
        </button>
      ) : (
        <label className="dm-mkt-option-head">
          <input type="radio" name={name} checked={checked} onChange={onPick} className="shrink-0" />
          {identity}
        </label>
      )}
      <div className="dm-mkt-option-figures">
        <ProviderFigure label="TVL" figure={option.liquidity} />
        <ProviderFigure label="24h volume" figure={option.volume} />
        <p className="dm-mkt-option-apr"><span className="text-fg-muted">Pool APR</span><span>Unavailable</span></p>
      </div>
      {option.tokenMetadata === 'partial' && <p className="dm-mkt-option-note text-money-wait">{COPY.picker.partialMetadata}</p>}
      {option.providerConflict && <p className="dm-mkt-option-note text-money-out">{COPY.picker.providerConflict}</p>}
      <details className="dm-details dm-mkt-option-details">
        <summary>Pool details · verified at block {option.block}</summary>
        <div className="grid gap-2 text-caption text-fg-muted">
          <Address value={option.key} />
          <p>{option.kind === 'discovery' ? 'Found by DexScreener discovery, verified on chain' : `From the catalogue (${option.catalogue?.source === 'initialize_event' ? 'initialize event' : 'verified observation'} at block ${option.catalogue?.block}), verified on chain`}{option.requestedById && ' · asked for by id'}</p>
          <p>
            Tick spacing <span className="tnum">{option.tickSpacing}</span> ·{' '}
            {option.integration === 'hookless_fixed_fee' ? COPY.picker.hookless : <>{COPY.picker.needsAdapter} · {option.hooks === NATIVE_CURRENCY ? 'no hooks' : <>hooks <Address value={option.hooks} /></>}</>}
          </p>
          {option.providerNote && <p data-provider-note="">{option.providerNote}</p>}
          <p>Pool APR unavailable: {reasonText(option.aprReason)}.</p>
        </div>
      </details>
    </li>
  )
}

/**
 * Catalogue candidates for the token, paged (at most 5 pages). A candidate is
 * not verified at any block; "Verify at the latest block" asks the pools
 * route about that one pool id, and only a pool it returns becomes an option.
 * `verifiedNote` is what a verified row says next: inside the picker, that
 * it now sits with the existing pools; on Markets, that it is opening.
 */
export function CatalogueCandidates({
  source,
  token,
  paired,
  onVerified,
  verified,
  verifiedNote = `${COPY.picker.verified}: listed with the existing pools above.`,
}: {
  source: ReadSource
  token: AddressKey
  paired: AddressKey | null
  onVerified: (option: PoolOption) => void
  verified: ReadonlySet<string>
  verifiedNote?: string
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
    const current = (session.current ??= createCatalogueSession(source, token, paired))
    if (current.snapshot().loading) return
    const { mine, done } = start()
    const result = go(current, mine.signal)
    // first/more set loading synchronously; retain any failure beside the busy Retry.
    setSnap(current.snapshot())
    void result.then((next) => {
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
    <section aria-labelledby="catalogue-heading" className="dm-mkt-catalogue-panel" data-catalogue="">
      <h3 id="catalogue-heading" className="text-body font-medium text-fg">
        {COPY.picker.catalogueHeading}
      </h3>
      <p className="text-caption text-fg-muted">Find more pools in the indexed catalogue, then verify one to select it.</p>
      {!snap && (
        <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => step((s, signal) => s.first(signal))}>
          {COPY.picker.catalogueLoad}
        </Button>
      )}
      {snap?.loading && view?.pages === 0 && <p className="text-caption text-fg-subtle">Reading the catalogue…</p>}
      {snap?.failure && <ScreenStatus line={failureText(snap.failure, 'catalogue')} busy={snap.loading}
        onRetry={view?.pages === 0 ? () => step((s, signal) => s.first(signal)) : undefined} />}
      {view && view.pages > 0 && (
        <>
          {view.restarted && <p className="text-caption text-money-wait">{COPY.picker.catalogueRestarted}</p>}
          <p className="text-caption text-fg-muted">{view.facts.map((fact) => fact.text).join(' ')}</p>
          {view.items.length === 0 && <p className="text-caption text-fg-muted">{COPY.picker.catalogueEmpty}</p>}
          <ul className="grid gap-2">
            {view.items.map((item) => {
              const poolId = cataloguePoolId(item.key)
              const done = verified.has(poolId)
              return (
                <li key={item.key} className="dm-mkt-candidate" data-catalogue-item="" {...(item.old ? { 'data-old': '' } : {})}>
                  <Address value={poolId} />
                  <p className="text-caption text-fg-muted">
                    {item.facts.map((fact) => `${fact.label}: ${fact.text}`).join(' · ')}
                    {item.old && ` · ${COPY.picker.fromEarlier}`}
                  </p>
                  {done ? (
                    <p className="text-caption text-money-in">{verifiedNote}</p>
                  ) : (
                    <Button type="button" variant="outline" size="sm" className="justify-self-start" aria-disabled={checking[poolId]?.code === 'loading' ? true : undefined} onClick={() => checking[poolId]?.code !== 'loading' && verify(poolId)}>
                      {COPY.picker.verify}
                    </Button>
                  )}
                  {checking[poolId] && !done && <ScreenStatus line={checking[poolId]} />}
                </li>
              )
            })}
          </ul>
          {snap.capped && <p className="text-caption text-fg-muted">Showing the first 5 pages.</p>}
          <Button
            type="button"
            variant="outline"
            size="sm"
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

type PoolsResult = { kind: 'loading'; retrying?: StatusLine } | { kind: 'ok'; view: PoolsView; restarted: boolean } | { kind: 'failed'; line: StatusLine }

/**
 * Existing pools for the chosen token (and second asset, if chosen), from the
 * pools route, in a neutral order, plus the stored catalogue on request.
 * Opening a new pool is described, never offered. With `onOpen` the rows are
 * ways into a pool rather than a choice, and the catalogue can be left to
 * the caller (`catalogue={false}`) when it is shown elsewhere on the page.
 */
export function PoolPicker({
  source,
  token,
  paired,
  pending,
  onPending,
  onOpen,
  catalogue = true,
  compact = false,
}: {
  source: ReadSource
  token: AddressKey
  paired: AddressKey | null
  pending: PoolOption | null
  onPending: (option: PoolOption | null) => void
  onOpen?: (option: PoolOption) => void
  catalogue?: boolean
  compact?: boolean
}) {
  const [result, setResult] = useState<PoolsResult>({ kind: 'loading' })
  const [verified, setVerified] = useState<PoolOption[]>([])
  const [attempt, setAttempt] = useState(0)
  const retry = () => {
    if (result.kind !== 'failed' || !result.line.retry) return
    setResult({ kind: 'loading', retrying: result.line })
    // An explicit Retry is a new logical read. Its internal 409 restart keeps that read's deadline.
    setAttempt((value) => value + 1)
  }

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
  }, [source, token, paired, attempt])

  const listed = result.kind === 'ok' ? result.view.options : []
  const options = neutralOrder([...listed, ...verified.filter((v) => !listed.some((o) => o.key === v.key))])

  return (
    <div className="grid gap-3" data-picker="pool">
      <ScreenStatus line={result.kind === 'loading' ? result.retrying ?? { code: 'loading', title: COPY.picker.poolsLoading, detail: '' } : result.kind === 'failed' ? result.line : null}
        onRetry={retry} busy={result.kind === 'loading'} />
      {result.kind === 'ok' && (
        <>
          {result.restarted && <p className="px-1 text-caption text-money-wait">{COPY.picker.catalogueRestarted}</p>}
          <details className="dm-details dm-mkt-coverage">
            <summary>{options.length} verified pool{options.length === 1 ? '' : 's'} · {result.view.complete ? 'sources & coverage' : 'partial source coverage'}</summary>
            <ul className="grid gap-1 text-caption text-fg-muted" data-pools-coverage="">
              {result.view.coverage.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </details>
          {options.length === 0 && <p className="dm-inset px-4 py-5 text-center text-body text-fg-muted">{COPY.picker.noOptions}</p>}
        </>
      )}
      {options.length > 0 && (onOpen ? (
        <ul className="grid gap-2" aria-label={COPY.picker.poolsLegend}>
          {options.map((option) => (
            <PoolRow key={option.key} option={option} name="pool-option" checked={false} onPick={() => onOpen(option)} compact={compact} open />
          ))}
        </ul>
      ) : (
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-body font-medium text-fg">{COPY.picker.poolsLegend}</legend>
          <ul className="grid gap-2">
            {options.map((option) => (
              <PoolRow key={option.key} option={option} name="pool-option" checked={pending?.key === option.key} onPick={() => onPending(option)} compact={compact} />
            ))}
          </ul>
        </fieldset>
      ))}
      {result.kind === 'ok' && result.view.rejected.length > 0 && (
        <section aria-labelledby="rejected-heading" className="grid gap-1.5" data-rejected-pools="">
          <h3 id="rejected-heading" className="text-body font-medium text-fg">
            {COPY.picker.rejectedHeading}
          </h3>
          <ul className="grid gap-1.5">
            {result.view.rejected.map((rejected) => (
              <li key={rejected.key} className="dm-inset px-3 py-2 text-caption text-fg-muted">
                <Address value={rejected.key} />
                <span className="block">Rejected: {reasonText(rejected.reason)}.</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {catalogue && (
        <details open={compact ? undefined : true} className={compact ? 'dm-details' : undefined}>
          <summary className={compact ? undefined : 'hidden'}>More sources · stored catalogue</summary>
          <div className={compact ? 'pt-2' : ''}>
            <CatalogueCandidates source={source} token={token} paired={paired} verified={new Set(verified.map((v) => v.key))} onVerified={(option) => setVerified((list) => [...list.filter((v) => v.key !== option.key), option])} />
          </div>
        </details>
      )}
      {!compact && <p className="px-1 text-caption text-fg-subtle" data-new-pool-note="">
        Choose an existing pool to continue. Creating a new pool isn’t available here.
      </p>}
    </div>
  )
}
