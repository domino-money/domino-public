import { useEffect, useRef, useState } from 'react'
import { reasonText } from '../../../lib/read/describe'
import { COPY, failureText } from '../../../lib/read/screens/copy'
import { cataloguePoolId, createCatalogueSession, verifyCandidate, type CatalogueSession, type CatalogueSnapshot } from '../../../lib/read/screens/catalogueSession'
import { keptCreatePools, readCreatePools, type PoolsAnswer } from '../../../lib/create/poolsAhead'
import { NATIVE_CURRENCY, type AddressKey, type PoolIdKey } from '../../../lib/read/screens/identity'
import { neutralOrder, poolsRequest, projectPoolsView, type PoolOption, type PoolsView } from '../../../lib/read/screens/poolsList'
import { failureCode } from '../../../lib/read/screens/quietRead'
import { askAgainLater, readWithin } from '../../../lib/read/screens/screenRead'
import { asksAgain } from '../../../lib/read/screens/transient'
import type { ReadSource } from '../../../lib/read/types'
import { IconChevronRight } from '../../icons'
import { TokenMarkPair } from '../../TokenIcon'
import { Button, Skeleton, cx } from '../../ui'
import { Address } from './Address'
import { ProviderFigure } from './ProviderFigure'
import { rowApr, rowAprReasonText } from '../../../lib/read/screens/rowApr'
import { SymbolText } from './SymbolText'

/** A candidate's verification: `loading`, `ok`, `not_found` or a read state, and its words for the title and the live region. */
type Check = { code: string; text: string }

/** What a plain row keeps out of sight: said in its title only, and only when there is something to say. */
const plainNotes = (option: PoolOption) =>
  [option.tokenMetadata === 'partial' ? COPY.picker.partialMetadata : '', option.providerConflict ? COPY.picker.providerConflict : ''].filter(Boolean).join('. ') || undefined

/**
 * One verified pool. As a radio it is a choice inside a picker; with `open`
 * it is a way in, and `onPick` opens the pool. The accessible name is the
 * row's own text, never an attribute built from a symbol.
 *
 * `plain` is New position's row: the pair and its fee, then TVL, 24h volume
 * and APR, always in that order, a dash for a figure nobody reports. No
 * details to open and no note lines: what they said is in titles and data.
 */
function PoolRow({ option, checked, onPick, name, compact = false, open = false, plain = false }: { option: PoolOption; checked: boolean; onPick: () => void; name: string; compact?: boolean; open?: boolean; plain?: boolean }) {
  // New position's plain rows sit flat on the card: 32px marks ringed in the card, the pair over its id, the fee right after them.
  const identity = (
    <>
      <TokenMarkPair base={option.currencies[0]} quote={option.currencies[1]} size={plain || !compact ? 32 : 28} ring={plain ? 'var(--card)' : 'var(--surface-1)'} />
      <span className={plain ? 'dm-flow-pool-id' : 'grid min-w-0 flex-1 gap-0.5 text-left'}>
        <span className={plain ? 'dm-flow-pool-pair' : 'text-body font-medium text-fg'}><SymbolText token={option.currencies[0]} /> / <SymbolText token={option.currencies[1]} /></span>
        {/* Changed on purpose (round 6, 2026-09-27, New position for beginners): a plain row names its pair and fee only;
            the pool id is on the row's data-pool-key. */}
        {!plain && <span className="text-caption text-fg-subtle">Uniswap · <Address value={option.key} short /></span>}
      </span>
      <span className="dm-chip shrink-0" data-fee="">{option.fee}</span>
    </>
  )
  const head = open ? (
    <button type="button" onClick={onPick} className="dm-mkt-option-head" data-open-pool="">
      {identity}
      <IconChevronRight size={14} />
    </button>
  ) : (
    <label className="dm-mkt-option-head">
      <input type="radio" name={name} checked={checked} onChange={onPick} className="shrink-0" />
      {identity}
    </label>
  )
  if (plain) {
    return (
      <li
        className={cx('dm-mkt-option', checked && 'dm-mkt-option--checked')}
        data-pool-option={option.kind}
        data-pool-key={option.key}
        data-token-metadata={option.tokenMetadata}
        data-provider-conflict={option.providerConflict ? '' : undefined}
        title={plainNotes(option)}
      >
        {head}
        <div className="dm-mkt-option-figures dm-flow-pool-figures">
          <ProviderFigure label="TVL" figure={option.liquidity} dash />
          <ProviderFigure label="24h volume" figure={option.volume} dash />
          <RowAprFigure option={option} label="APR" />
        </div>
      </li>
    )
  }
  return (
    <li className={cx('dm-mkt-option', checked && 'dm-mkt-option--checked')} data-pool-option={option.kind}>
      {head}
      {/* Most pools a search turns up are not covered by any market data
          provider — for one token here, eleven of twelve. Three columns each
          reading "Unavailable", with the reason only in a title nobody hovers,
          spent the whole figure strip saying nothing three times. When there is
          nothing to report, the row says so once, in words, and keeps what IS
          known: the fee, and that the pool was verified on chain. */}
      {worthColumns(option) ? (
        <div className="dm-mkt-option-figures">
          <ProviderFigure label="TVL" figure={option.liquidity} />
          <ProviderFigure label="24h volume" figure={option.volume} />
          <RowAprFigure option={option} />
        </div>
      ) : (
        <p className="dm-mkt-option-note text-fg-muted" data-no-figures="">{COPY.picker.noFigures}</p>
      )}
      {option.tokenMetadata === 'partial' && <p className="dm-mkt-option-note text-fg-muted">{COPY.picker.partialMetadata}</p>}
      {option.providerConflict && <p className="dm-mkt-option-note text-money-out">{COPY.picker.providerConflict}</p>}
      <details className="dm-details dm-mkt-option-details">
        <summary>Pool details · verified at block {option.block}</summary>
        <div className="grid gap-2 text-caption text-fg-muted">
          <Address value={option.key} />
          <p>{option.kind === 'discovery' ? 'Found by provider discovery, verified on chain' : `From the catalogue (${option.catalogue?.source === 'initialize_event' ? 'initialize event' : 'verified observation'} at block ${option.catalogue?.block}), verified on chain`}{option.requestedById && ' · asked for by id'}</p>
          <p>
            Tick spacing <span className="tnum">{option.tickSpacing}</span> ·{' '}
            {option.integration === 'hookless_fixed_fee' ? COPY.picker.hookless : <>{COPY.picker.needsAdapter} · {option.hooks === NATIVE_CURRENCY ? 'no hooks' : <>hooks <Address value={option.hooks} /></>}</>}
          </p>
          {option.providerNote && <p data-provider-note="">{option.providerNote}</p>}
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
  const [checking, setChecking] = useState<Record<string, Check>>({})
  const session = useRef<CatalogueSession | null>(null)
  /** Quiet asks already spent on the first page, and on each candidate's verification. */
  const quiet = useRef(new Map<string, number>())
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

  /** Waits out a busy or briefly unavailable answer, then asks again, a few times at most per `slot`. */
  const again = (slot: string, failure: { state: string }, ask: () => void) => {
    const spent = quiet.current.get(slot) ?? 0
    const { mine, done } = start()
    void askAgainLater(failure, spent, mine.signal).then((yes) => {
      done()
      if (!yes || mine.signal.aborted || !mounted.current) return
      quiet.current.set(slot, spent + 1)
      ask()
    })
  }

  const step = (go: (s: CatalogueSession, signal: AbortSignal) => Promise<CatalogueSnapshot>, first = false) => {
    const current = (session.current ??= createCatalogueSession(source, token, paired))
    if (current.snapshot().loading) return
    const { mine, done } = start()
    const result = go(current, mine.signal)
    // first/more set loading synchronously; a failure stays in data and titles only.
    setSnap(current.snapshot())
    void result.then((next) => {
      done()
      if (mine.signal.aborted || !mounted.current) return
      setSnap({ ...next })
      if (next.failure && first && next.view.pages === 0) again('first', next.failure, () => step((s, signal) => s.first(signal), true))
    })
  }

  const verify = (poolId: PoolIdKey) => {
    const { mine, done } = start()
    setChecking((c) => ({ ...c, [poolId]: { code: 'loading', text: '' } }))
    void verifyCandidate(source, token, paired, poolId, { signal: mine.signal }).then((result) => {
      done()
      // A verify that comes back after the picker closed announces nothing and
      // chooses nothing: onVerified must not run for a screen that is gone.
      if (mine.signal.aborted || !mounted.current) return
      if (result.failure) {
        if (result.failure.state === 'aborted') return
        const text = failureText(result.failure, 'pools')
        setChecking((c) => ({ ...c, [poolId]: { code: text.code, text: [text.title, text.detail].filter(Boolean).join('. ') } }))
        again(poolId, result.failure, () => verify(poolId))
        return
      }
      if (result.option) {
        onVerified(result.option)
        setChecking((c) => ({ ...c, [poolId]: { code: 'ok', text: `${COPY.picker.verified} at block ${result.option?.block}.` } }))
      } else {
        setChecking((c) => ({ ...c, [poolId]: { code: 'not_found', text: 'Not verified: the pools route did not return this pool, so it cannot be chosen.' } }))
      }
    })
  }

  const view = snap?.view
  const failed = snap?.failure ? failureText(snap.failure, 'catalogue') : null
  const failureWords = failed ? [failed.title, failed.detail].filter(Boolean).join('. ') : undefined
  // With no page read, the way to the catalogue is the button that asked for it.
  const firstFailed = !!failed && view?.pages === 0 && !snap?.loading
  return (
    <section aria-labelledby="catalogue-heading" className="dm-mkt-catalogue-panel" data-catalogue="" data-catalogue-state={snap?.loading ? 'loading' : snap?.failure ? snap.failure.state : snap ? 'ok' : 'idle'}>
      <h3 id="catalogue-heading" className="text-body font-medium text-fg">
        {COPY.picker.catalogueHeading}
      </h3>
      <p className="text-caption text-fg-muted">Find more pools in the indexed catalogue, then verify one to select it.</p>
      <p role="status" className="sr-only">{snap?.loading && view?.pages === 0 ? 'Reading the catalogue…' : failureWords ?? ''}</p>
      {(!snap || firstFailed) && (
        <Button type="button" variant="outline" size="sm" className="justify-self-start" title={failureWords} onClick={() => step((s, signal) => s.first(signal), true)}>
          {COPY.picker.catalogueLoad}
        </Button>
      )}
      {snap?.loading && view?.pages === 0 && <Skeleton className="h-10 w-full" />}
      {view && view.pages > 0 && (
        <>
          {view.restarted && <p className="text-caption text-fg-muted">{COPY.picker.catalogueRestarted}</p>}
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
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="justify-self-start"
                      aria-disabled={checking[poolId]?.code === 'loading' ? true : undefined}
                      title={checking[poolId]?.code === 'loading' ? undefined : checking[poolId]?.text || undefined}
                      data-verify={checking[poolId]?.code}
                      onClick={() => checking[poolId]?.code !== 'loading' && verify(poolId)}
                    >
                      {COPY.picker.verify}
                    </Button>
                  )}
                  {checking[poolId]?.code === 'not_found' && !done && <p className="text-caption text-fg-muted">{checking[poolId].text}</p>}
                  <p role="status" className="sr-only">{checking[poolId]?.code === 'loading' ? 'Verifying…' : !done ? (checking[poolId]?.text ?? '') : ''}</p>
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
            title={failureWords}
            onClick={() => snap.canLoadMore && step((s, signal) => s.more(signal))}
          >
            {snap.loading ? 'Loading…' : snap.canLoadMore ? COPY.picker.loadMore : COPY.picker.allLoaded}
          </Button>
        </>
      )}
    </section>
  )
}

/** The option of the list row an event came from: the row's place among its siblings is its place in `options`. */
function rowAt(options: readonly PoolOption[], target: EventTarget | null): PoolOption | null {
  const row = target instanceof Element ? target.closest('li') : null
  const siblings = row?.parentElement?.children
  if (!row || !siblings) return null
  return options[Array.prototype.indexOf.call(siblings, row)] ?? null
}

/** The pools for a token (and second asset), read once, and once more for a new catalogue revision. */
async function plainPoolsRead(source: ReadSource, token: AddressKey, paired: AddressKey | null, signal: AbortSignal): Promise<PoolsAnswer> {
  const request = poolsRequest(token, paired)
  let outcome = await readWithin(source, 'pools', request, { signal })
  let restarted = false
  if (outcome.state === 'restart_required' && outcome.code === 'catalogue_revision_changed') {
    restarted = true
    // Same logical read, so the restart keeps the first attempt's deadline
    // instead of starting a fresh screen budget it has not earned.
    const deadlineAt = outcome.provenance.deadlineAt
    outcome = await readWithin(source, 'pools', request, { signal, deadlineAt })
  }
  return { outcome, restarted }
}

type PoolsResult =
  | { kind: 'loading' }
  | { kind: 'ok'; view: PoolsView; restarted: boolean }
  /** `code` is the read's state, `failure` its closed code, `reason` its words; `final` once nothing will ask again. */
  | { kind: 'failed'; code: string; failure: string; reason: string; final: boolean }

/**
 * The row's fee APR estimate, worked out here from the figures this row already
 * carries (rowApr.ts). The service's own estimate, on the pool page, is built on
 * a different provider's reported TVL and volume, so the two can differ for one
 * pool; neither is described as the other. Refusals say which input was missing.
 */
const ROW_APR_TITLE = 'Estimate from this pool’s fixed LP fee and the 24h volume and liquidity reported in this list, annualised. A pool estimate, not a position’s APR, not APY and not a forecast, and not the pool page’s figure, which a different provider reports.'

/**
 * Whether the figure columns have anything to say.
 *
 * Only `unavailable` is empty — nothing was retrieved at all. `not_reported`
 * (the provider answered and had no value) and `rejected` (it answered and the
 * value failed an identity check) each say something specific about this pool,
 * and keep their column.
 */
function worthColumns(option: PoolOption): boolean {
  return option.liquidity.state !== 'unavailable' || option.volume.state !== 'unavailable'
}

function RowAprFigure({ option, label = 'Pool APR' }: { option: PoolOption; label?: string }) {
  const apr = rowApr({
    integration: option.integration,
    currentLpFeePips: option.feePips,
    protocolFeeRaw: option.protocolFeeRaw,
    liquidity: option.liquidity,
    volume: option.volume,
  })
  return (
    <p className="dm-mkt-option-apr" data-row-apr={apr.kind === 'estimate' ? (apr.stale ? 'stale' : 'estimate') : 'none'} data-row-apr-reason={apr.kind === 'none' ? apr.reason : undefined}>
      <span className="text-fg-muted">{label}</span>
      {apr.kind === 'estimate' ? (
        <span className="tnum font-medium text-fg" title={ROW_APR_TITLE}>
          {apr.text}% est.
        </span>
      ) : (
        <span className="text-fg-subtle" title={rowAprReasonText(apr.reason)}>
          —
        </span>
      )}
    </p>
  )
}

/**
 * Existing pools for the chosen token (and second asset, if chosen), from the
 * pools route, in a neutral order, plus the stored catalogue on request. With
 * `onOpen` the rows are ways into a pool rather than a choice, and the
 * catalogue can be left to the caller (`catalogue={false}`) when it is shown
 * elsewhere on the page. While the list is read its rows rest, and they keep
 * resting while a busy or briefly unavailable read waits to be asked again on
 * its own. A list that failed for good is one plain muted line, its code in
 * data and its reason in the title.
 *
 * `variant="create"` is New position's first step. It lists only the pools
 * Domino can open a position in (no hooks, a fixed fee: poolsList.ts
 * `usableForDomino`), the largest reported TVL first, every row with its TVL,
 * 24h volume and APR. Before the one pools read it asks which pools are worth
 * verifying (poolHints.ts, waiting at most 2.5 s) and names them in it. No
 * coverage summary, no rejected candidates and no catalogue: how many pools
 * were left out is data only, and an empty list is the same muted line.
 * That read is the flow's (lib/create/poolsAhead.ts, 2026-09-28): the search
 * starts it when the token is chosen, and an ok answer is shown again, with
 * no read, when the list mounts again for the same token within a minute.
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
  variant,
  onPreview,
}: {
  source: ReadSource
  token: AddressKey
  paired: AddressKey | null
  pending: PoolOption | null
  onPending: (option: PoolOption | null) => void
  onOpen?: (option: PoolOption) => void
  catalogue?: boolean
  compact?: boolean
  variant?: 'create'
  /**
   * New position's preview: the row the pointer or focus is on, and null once
   * both have left the list. Handlers only, so the rendered markup is the same.
   */
  onPreview?: (option: PoolOption | null) => void
}) {
  const create = variant === 'create'
  const question = `${token}:${paired ?? ''}`
  // New position's list shows an answer the flow already has at once (lib/create/poolsAhead.ts): Change pool, or the
  // same token chosen again within a minute, reads nothing (speed wave, 2026-09-28).
  const [answer, setAnswer] = useState<{ question: string; result: PoolsResult } | null>(() => {
    const kept = create ? keptCreatePools(source, token, paired) : null
    return kept?.outcome.state === 'ok' ? { question, result: { kind: 'ok', view: projectPoolsView(kept.outcome.data, kept.outcome.provenance.receivedAt, { only: 'domino' }), restarted: kept.restarted } } : null
  })
  const result: PoolsResult = answer?.question === question ? answer.result : { kind: 'loading' }
  const [verified, setVerified] = useState<PoolOption[]>([])
  // Quiet re-asks spent on this token and pair; another question starts from none.
  const [asked, setAsked] = useState<{ question: string; attempt: number } | null>(null)
  const attempt = asked?.question === question ? asked.attempt : 0
  useEffect(() => () => setAsked(null), [question])

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    void (async () => {
      // New position's read is the flow's (lib/create/poolsAhead.ts): started when the token was chosen, with the pools
      // worth verifying named first (poolHints.ts), or kept from a minute ago. Changed on purpose 2026-09-28 (speed wave).
      const read = create ? await readCreatePools(source, token, paired, signal) : await plainPoolsRead(source, token, paired, signal)
      if (!read) return
      const { outcome, restarted } = read
      if (signal.aborted || outcome.state === 'aborted') return
      if (outcome.state === 'ok') {
        setAnswer({ question, result: { kind: 'ok', view: projectPoolsView(outcome.data, outcome.provenance.receivedAt, create ? { only: 'domino' } : {}), restarted } })
        return
      }
      const text = failureText(outcome, 'pools')
      const final = !asksAgain(outcome, attempt)
      setAnswer({ question, result: { kind: 'failed', code: text.code, failure: failureCode(outcome), reason: [text.title, text.detail].filter(Boolean).join('. '), final } })
      // Asked again on its own when that could help: a new logical read, whose own 409 restart keeps its deadline.
      if (await askAgainLater(outcome, attempt, signal)) setAsked({ question, attempt: attempt + 1 })
    })()
    return () => controller.abort()
  }, [source, token, paired, question, attempt, create])

  const listed = result.kind === 'ok' ? result.view.options : []
  // New position's list is the reply's own, already in TVL order; it verifies nothing else.
  const options = create ? listed : neutralOrder([...listed, ...verified.filter((v) => !listed.some((o) => o.key === v.key))])
  // Still being read, or waiting to be asked again: the rows rest either way.
  const resting = result.kind === 'loading' || (result.kind === 'failed' && !result.final)
  const list = (
    <ul className={create ? 'dm-flow-pool-rows' : 'grid gap-2'}>
      {options.map((option) => (
        <PoolRow key={option.key} option={option} name="pool-option" checked={pending?.key === option.key} onPick={() => onPending(option)} compact={compact} plain={create} />
      ))}
    </ul>
  )
  const counts = create && result.kind === 'ok' ? { 'data-pools-hidden': result.view.hidden, 'data-pools-rejected': result.view.rejected.length, 'data-pools-restarted': result.restarted ? '' : undefined } : {}

  return (
    <div className="grid gap-3" data-picker="pool" data-picker-variant={variant} data-pools-state={result.kind === 'failed' ? result.code : result.kind} {...counts}>
      <p role="status" aria-live="polite" className="sr-only">{result.kind === 'loading' ? COPY.picker.poolsLoading : result.kind === 'failed' ? result.reason : ''}</p>
      {resting && options.length === 0 && (
        <div className="grid gap-3" aria-hidden="true">
          {/* The coverage summary and the legend land with the read too; without a resting
              shape they alone push the list 80px down the moment the pools arrive. */}
          {!create && <Skeleton className="h-10 w-full rounded-[var(--radius)]" />}
          <div className="grid">
            {!onOpen && <Skeleton className="mb-2 h-5 w-28" />}
            <ul className="grid gap-2">
              {[0, 1].map((row) => (
                <li key={row} className="dm-mkt-option">
                  <div className="flex min-h-14 items-center gap-3 px-3">
                    {/* TokenMarkPair overlaps two marks at -30%, so the pair is 1.7x its size: a pill, not a circle. */}
                    <Skeleton className={cx('shrink-0 rounded-full', compact ? 'h-7 w-12' : 'h-8 w-14')} />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <Skeleton className="h-5 w-40 max-w-full" />
                      <Skeleton className="h-4 w-28 max-w-full" />
                    </span>
                    <Skeleton className="h-5 w-12 shrink-0 rounded-full" />
                  </div>
                  {create ? (
                    <div className="dm-mkt-option-figures dm-flow-pool-figures">
                      {[0, 1, 2].map((cell) => <Skeleton key={cell} className="h-[18px] w-full" />)}
                    </div>
                  ) : (
                    <>
                      <div className="dm-mkt-option-figures">
                        <Skeleton className="h-[18px] w-full" />
                      </div>
                      <Skeleton className="mx-3 h-9 w-56 max-w-[calc(100%-24px)]" />
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {result.kind === 'failed' && result.final && options.length === 0 && (
        <p className="px-1 py-4 text-center text-body text-fg-muted" title={result.reason} data-pools-unavailable={result.failure}>
          {paired ? COPY.picker.poolsNonePair : COPY.picker.poolsNone}
        </p>
      )}
      {create && result.kind === 'ok' && options.length === 0 && (
        <p className="px-1 py-4 text-center text-body text-fg-muted" data-pools-empty="">
          {paired ? COPY.picker.poolsNonePair : COPY.picker.poolsNone}
        </p>
      )}
      {!create && result.kind === 'ok' && (
        <>
          {result.restarted && <p className="px-1 text-caption text-fg-muted">{COPY.picker.catalogueRestarted}</p>}
          <details className="dm-details dm-mkt-coverage">
            <summary>{options.length} verified pool{options.length === 1 ? '' : 's'} · {result.view.complete ? 'sources & coverage' : 'partial source coverage'}</summary>
            <ul className="grid gap-1 text-caption text-fg-muted" data-pools-coverage="">
              {result.view.coverage.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </details>
          {options.length === 0 && <p className="px-1 py-4 text-center text-body text-fg-muted">{COPY.picker.noOptions}</p>}
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
          <legend className={create ? 'dm-flow-pools-legend' : 'mb-2 text-body font-medium text-fg'}>{COPY.picker.poolsLegend}</legend>
          {onPreview ? (
            // New position's preview follows the pointer and the focus through the rows. One listener pair for the
            // list, on a wrapper that is presentation only; the rows' own markup stays exactly as it renders anywhere.
            <div
              role="presentation"
              onPointerOver={(event) => {
                const option = rowAt(options, event.target)
                if (option) onPreview(option)
              }}
              onPointerLeave={() => onPreview(null)}
              onFocus={(event) => {
                const option = rowAt(options, event.target)
                if (option) onPreview(option)
              }}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onPreview(null)
              }}
            >
              {list}
            </div>
          ) : (
            list
          )}
        </fieldset>
      ))}
      {!create && result.kind === 'ok' && result.view.rejected.length > 0 && (
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
      {catalogue && !create && (
        <details open={compact ? undefined : true} className={compact ? 'dm-details' : undefined}>
          <summary className={compact ? undefined : 'hidden'}>More sources · stored catalogue</summary>
          <div className={compact ? 'pt-2' : ''}>
            <CatalogueCandidates source={source} token={token} paired={paired} verified={new Set(verified.map((v) => v.key))} onVerified={(option) => setVerified((list) => [...list.filter((v) => v.key !== option.key), option])} />
          </div>
        </details>
      )}
    </div>
  )
}
