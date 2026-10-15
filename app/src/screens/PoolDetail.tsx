// The screens' own styles (styles/screens.css, F8): loaded with the first screen that needs them, never on Home's first paint.
import '../styles/screens.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { exploreHref, newPositionHref, parsePoolHash } from '../components/explore/routes'
import { useHash } from '../components/explore/useHash'
import { IconChevronLeft } from '../components/icons'
import { PoolWorkspace } from '../components/read/screens/PoolWorkspace'
import { TokenMarkPair } from '../components/TokenIcon'
import { EmptyState, LinkButton, Skeleton, Stat, StatStrip } from '../components/ui'
import { SELECTED_POOL_CATALOGUE, entryToken, inPriceOrder, type PoolCatalogueEntry } from '../config/selectedPoolCatalogue'
import { appPaint } from '../lib/read/appPaint'
import { useFeatured } from '../lib/read/featuredSource'
import { verifyCandidate } from '../lib/read/screens/catalogueSession'
import { overviewPoolOption, paintedPool } from '../lib/read/publicOverview'
import { failureText } from '../lib/read/screens/copy'
import { parseAddressInput, poolIdKey, shortAddress } from '../lib/read/screens/identity'
import { poolWarning, warningText } from '../lib/read/screens/lookalike'
import { optionUsableForDomino, type PoolOption } from '../lib/read/screens/poolsList'
import { useReadSource } from '../lib/read/screens/readContext'
import { askAgainLater, readWithin } from '../lib/read/screens/screenRead'
import { whenVisibleAfter } from '../lib/read/screens/quietRead'
import { isTransient } from '../lib/read/screens/transient'
import type { TokenDisplay } from '../lib/read/types'
import { quoteIndex } from '../lib/read/orientation'
import { useRouteTitle } from '../lib/routeTitle'

/*
 * tests/pool-workspace.test.mjs loads this file with every import but React
 * replaced by a fixed list of stubs, and React by useState, useRef,
 * useCallback and useEffect only. Looks come through class names.
 */

const POOL_ID = /^0x[0-9a-fA-F]{64}$/

/**
 * A pool the store has not collected yet (audit A12, 2026-10-01): asked again at the store's own next attempt, 5 s at
 * the soonest and 30 s at the most, 30 s while its collection is at capacity, and PENDING_ATTEMPTS times at the most.
 * It used to be asked every 5 s for as long as the page stayed open: twelve reads a minute of a budget of thirty.
 */
export const PENDING_WAIT = { soonest: 5_000, latest: 30_000, margin: 1_500 } as const
export const PENDING_ATTEMPTS = 12

type Resolution =
  /** `note`: the store is still collecting the pool, or its collection is at capacity (A12). */
  | { kind: 'verifying'; note?: 'collecting' | 'capacity' }
  /**
   * No answer to show: `code` is the read's state, `reason` its words, for the title and the live region only.
   * `passing` when it can clear by itself (transient.ts): a copy already painted stays on screen meanwhile (A25).
   */
  | { kind: 'failed'; code: string; reason: string; passing?: boolean }
  /** The pools route answered and did not include this pool. */
  | { kind: 'not_returned' }
  /** A link that names no token, where nothing can verify a pool by its id alone (B8). */
  | { kind: 'needs_token' }
  | { kind: 'verified'; option: PoolOption }

/** A catalogue side as a mark only: its bundled artwork, bound to its address where the catalogue has one. Never metadata. */
const catalogueMark = (entry: PoolCatalogueEntry, side: 0 | 1): TokenDisplay => ({
  origin: 'read',
  chainId: 4663,
  address: entry.addresses?.[side] ?? '',
  symbol: null,
  decimals: null,
  readStatus: 'unavailable',
  artwork: entry.artwork[side],
})

/**
 * The page while the pool is still only an id: the catalogue's pair labels for
 * one of the six, the id alone for any other, laid out as the verified page
 * will be (round 6: the name, the sentence under it, the key figures, the
 * chart beside the earnings estimate), so nothing jumps when it arrives. No
 * fee is stated before the pool is verified, in the chip or anywhere else.
 * While verifying, the figures and the chart are resting blocks; once
 * verification has no answer they are dashes, never a panel.
 *
 * Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): no
 * words about the verification any more. Gone: the line beside the chip
 * ("Collecting data for many pools right now. This page asks again on its
 * own.", "Collecting this pool’s figures. This page asks again on its own.",
 * "Checking this pool on Robinhood Chain…"), the live region and the titles
 * that carried a failed verification's reason (e.g. "This pool’s figures are
 * not collected yet. Open it again later."). `data-pool-verification` keeps
 * the state, as data.
 */
function Pending({ id, entry, verifying = true, reason }: { id: string; entry?: PoolCatalogueEntry; verifying?: boolean; reason?: { code: string; text: string } }) {
  // A resting bubble while verifying; the same box, empty, once verification has no answer.
  const bubble = (name: string) => <span aria-hidden="true" className={verifying ? `dm-skel ${name}` : name} />
  return (
    <div aria-busy={verifying || undefined} data-pool-verification={verifying ? 'verifying' : reason?.code} className="dm-pool-layout" data-pool-pending={id}>
      <div className="dm-pool-head dm-pool-a-head animate-rise">
        <div className="dm-pool-title">
          <span className="dm-pool-marks">
            {entry ? <TokenMarkPair base={catalogueMark(entry, 0)} quote={catalogueMark(entry, 1)} size={44} ring="var(--bg)" /> : <Skeleton className="dm-pool-skel-marks" />}
          </span>
          <div className="min-w-0">
            <h1 className="dm-display dm-display-h1">
              {entry ? <><bdi>{entry.labels[0]}</bdi> / <bdi>{entry.labels[1]}</bdi></> : 'Pool'}
            </h1>
            <div className="dm-pool-chips">
              {/* The fee is the verified pool's to state: until then the chip names the protocol only. */}
              <span className="dm-chip">Uniswap</span>
            </div>
          </div>
        </div>
        {/* Holds the Create a position button's place, unseen, so the title row does not move when it arrives. */}
        {entry && <div aria-hidden="true" className="dm-pool-actions"><span className="dm-pool-skel-action" /></div>}
      </div>
      <div aria-hidden="true" className="dm-pool-intro dm-pool-a-lead">{bubble('dm-pool-skel-intro')}{bubble('dm-pool-skel-intro dm-pool-skel-intro--short')}</div>
      {/* The verified page's key figures, resting: each figure a bubble, and a bubble under it for its line. */}
      <div className="dm-pool-figures dm-pool-a-figs animate-rise [--delay:40ms]">
        <StatStrip cols={4} layout="tiles" className="dm-pool-stats">
          {['APR', '24h volume', 'TVL', 'Price'].map((label) => (
            <Stat key={label} label={label} className="dm-pool-stat" sub={verifying ? <Skeleton className="dm-pool-fig-sub-skel" /> : undefined}>
              {verifying ? <Skeleton className="dm-pool-fig-skel" /> : <span className="text-fg-subtle">—</span>}
            </Stat>
          ))}
        </StatStrip>
      </div>
      {/* The chart card at the verified card's height, row for row: the title and the window switch, the price and its
          line, the plot, its time axis and the switch under it. Bubbles while verifying; once verification has no
          answer, the same rows hold their place, empty. */}
      <div className="dm-card dm-pool-chart dm-pool-a-chart animate-rise [--delay:80ms]">
        <div className="dm-pool-chart-head">
          <h2 className="dm-title">Price history</h2>
          {bubble('dm-pool-skel-seg')}
        </div>
        <div aria-hidden="true" className="dm-pool-skel-head">
          {bubble('dm-pool-skel-price')}
          {bubble('dm-pool-skel-date')}
        </div>
        <div className="dm-pool-plot dm-dots-chart mt-4" title="Prices from swaps on Robinhood Chain.">
          <div className="dm-pool-plot-empty">
            {verifying ? <Skeleton className="dm-pool-plot-baseline" /> : <span className="text-fg-subtle">—</span>}
          </div>
        </div>
        <div aria-hidden="true" className="dm-pool-skel-axis">
          {bubble('dm-pool-skel-tick')}
          {bubble('dm-pool-skel-tick')}
        </div>
        <div aria-hidden="true" className="dm-pool-skel-quiet">{bubble('dm-pool-skel-seg')}</div>
      </div>
      {/* The estimate and the recent activity beside the chart, at their loaded heights. */}
      <div aria-hidden="true" className="dm-card dm-pool-card dm-pool-a-earn dm-pool-skel-card animate-rise [--delay:120ms]">
        <h2 className="dm-title">Estimate your earnings</h2>
        {bubble('dm-pool-skel-field')}
        {bubble('dm-pool-skel-seg')}
        {bubble('dm-pool-skel-result')}
        {bubble('dm-pool-skel-summary')}
      </div>
      <div aria-hidden="true" className="dm-card dm-pool-card dm-pool-a-recent dm-pool-skel-card animate-rise [--delay:160ms]">
        <h2 className="dm-title">Recent activity</h2>
        {bubble('dm-pool-skel-summary')}
        {bubble('dm-pool-skel-summary')}
      </div>
    </div>
  )
}

/**
 * One pool, by the id in the address bar. The id is untrusted until the
 * pools route returns exactly that pool: one of the six selected pools is
 * verified against the token they all hold, any other against the token the
 * link names (`#/pool/<id>/<token>`), and a pool with neither is not read at
 * all. Only a verified pool gets a page; nothing is shown from a label alone.
 * A verification the read service was too busy for, or briefly could not
 * answer, is asked again on its own, a few times, while the page stays open.
 *
 * Changed 2026-10-01 (audit):
 *   - B8: a link with no token waits for the list's first answer (it may name the pool) under the page's resting
 *     layout, never a false "not one of the selected" message; where the stored overview is listed, the pool is
 *     then verified by its id alone and its own currencies name it;
 *   - A12: a pool the store is still collecting is asked again at the store's own pace (PENDING_WAIT), a bounded number
 *     of times, and after the first such answer it is checked on chain through the pools route, so its page can open;
 *   - A25: a copy already painted stays on screen through a failure that can clear by itself;
 *   - I1: a pool with a token that passes for one of the site's main tokens, or has a misleading name, gets its page
 *     with a plain warning and no way into New position; a pool on neither list says so, with both contracts;
 *   - B2: a pool the list withdrew for safety gets no way into New position, as New position refuses its link; one
 *     that left only because its figures were unavailable keeps it.
 */
/** A verified pool's pair for its tab, base first as its price is written ("UFG / USDG"); symbols cut at 14 characters. */
function pairTitle(option: PoolOption): string {
  const [first, second] = option.currencies
  const quote = quoteIndex(first.address, second.address)
  const name = (token: { symbol?: string | null; address: string }) => (token.symbol ?? shortAddress(token.address)).slice(0, 14)
  return quote === 1 ? `${name(first)} / ${name(second)}` : `${name(second)} / ${name(first)}`
}

export function PoolDetail({ poolId }: { poolId: string }) {
  const source = useReadSource()
  const linked = parsePoolHash(useHash())
  const id = POOL_ID.test(poolId) ? poolId.toLowerCase() : null
  // The list on screen first (lib/read/featuredSource.ts), then the embedded list: a pool of either is named at once.
  const featured = useFeatured()
  // Named as its price is written ("TOKEN/USDG", audit E21), as the verified page will name it, so the heading keeps its
  // order when it arrives.
  const listed = id ? (featured.entries.find((item) => item.poolId === id) ?? SELECTED_POOL_CATALOGUE.find((item) => item.poolId === id)) : undefined
  const entry = listed && inPriceOrder(listed)
  // Verified against a token the list names for it (USDG where it holds it), else the one the link names.
  const listedToken = entry ? entryToken(entry) : null
  const tokenInput = listedToken ? parseAddressInput(listedToken) : linked.token ? parseAddressInput(linked.token) : null
  const tokenKey = tokenInput?.ok ? tokenInput.key : null
  // B8: a link that names no token waits for the list's first answer, which may name the pool; then, where the stored
  // overview is listed, the pool is verified by its id alone. Without the overview there is nothing to verify it with.
  const byId = id !== null && tokenKey === null
  const waitingForList = byId && !featured.settled
  const nothingToVerify = byId && featured.settled && !source?.supportsStoredReads
  const key = id && !waitingForList && !nothingToVerify ? `${id}:${tokenKey ?? ''}` : null
  const [state, setState] = useState<{ key: string; resolution: Resolution } | null>(null)
  // Quiet re-asks already spent verifying this pool. The page stays mounted from one pool to the next,
  // so the count belongs to the pool it was spent on: another pool starts from none.
  const [asked, setAsked] = useState<{ key: string; attempt: number } | null>(null)
  const attempt = key !== null && asked?.key === key ? asked.attempt : 0
  // Leaving a pool forgets its count, so coming back to it starts from none as well.
  useEffect(() => () => setAsked(null), [key])

  useEffect(() => {
    if (!source || !id || !key) return
    const controller = new AbortController()
    const { signal } = controller
    let cancel: (() => void) | null = null
    void (async () => {
      // The page asks read-v1's capabilities too (its chain reads) and read-v2's (the market read where the overview is
      // not listed): now, beside read-v3's, not one after the other once the pool is verified (speed wave, item 12,
      // 2026-09-28). A capabilities GET is the Worker's own answer: no read of the budget.
      if (source.routeEnabled) void source.routeEnabled('pool-activity', { signal }).catch(() => undefined)
      const capability = source.supportsStoredReads ? await source.routeEnabled?.('overview', { signal }) : undefined
      if (signal.aborted) return
      if (capability?.state === 'enabled') {
        const overview = await readWithin(source, 'overview', { poolIds: [id] }, { signal })
        if (signal.aborted || overview.state === 'aborted') return
        if (overview.state !== 'ok') {
          const text = failureText(overview, 'pools')
          setState({ key, resolution: { kind: 'failed', code: text.code, reason: [text.title, text.detail].filter(Boolean).join('. '), ...(overview.state !== 'local' && isTransient(overview) ? { passing: true } : {}) } })
          if (await askAgainLater(overview, attempt, signal)) setAsked({ key, attempt: attempt + 1 })
          return
        }
        const option = overviewPoolOption(overview, id)
        // Verified by its id; a token the link or the list names must be one of the pool's own (B8).
        if (option && (tokenKey === null || option.currencies.some((currency) => currency.address === tokenKey))) {
          setState({ key, resolution: { kind: 'verified', option } })
          return
        }
        const pending = overview.data.pools.find((entry) => entry.poolId === id && entry.acquisition.status === 'pending')
        if (!pending) {
          setState({ key, resolution: { kind: 'not_returned' } })
          return
        }
        // A12: still being collected. The page says so in plain words, is checked on chain once through the pools route
        // so it can open meanwhile, and asks the store again at its own pace, a bounded number of times.
        const accepted = overview.data.acquisitionAccepted !== false
        setState({ key, resolution: { kind: 'verifying', note: accepted ? 'collecting' : 'capacity' } })
        if (attempt === 0 && tokenKey !== null) {
          const onChain = await verifyCandidate(source, tokenKey, null, poolIdKey(id), { signal })
          if (signal.aborted) return
          if (onChain.option) {
            setState({ key, resolution: { kind: 'verified', option: onChain.option } })
            return
          }
        }
        if (attempt + 1 >= PENDING_ATTEMPTS) {
          setState({ key, resolution: { kind: 'failed', code: 'collecting', reason: 'This pool’s figures are not collected yet. Open it again later.' } })
          return
        }
        const due = pending.acquisition.nextAttemptAt === null ? PENDING_WAIT.latest : Math.max(0, pending.acquisition.nextAttemptAt - overview.data.generatedAt) * 1000 + PENDING_WAIT.margin
        const wait = accepted ? Math.min(PENDING_WAIT.latest, Math.max(PENDING_WAIT.soonest, due)) : PENDING_WAIT.latest
        cancel = whenVisibleAfter(wait, () => setAsked({ key, attempt: attempt + 1 }))
        return
      }
      // A link that names no token has nothing to verify the pool with but the overview (B8): when that cannot be asked,
      // for good, the page says how to open the pool instead.
      if (tokenKey === null && (capability?.state !== 'failed' || !isTransient(capability.outcome))) {
        setState({ key, resolution: { kind: 'needs_token' } })
        return
      }
      if (capability?.state === 'failed') {
        const text = failureText(capability.outcome, 'pools')
        setState({ key, resolution: { kind: 'failed', code: text.code, reason: [text.title, text.detail].filter(Boolean).join('. '), ...(isTransient(capability.outcome) ? { passing: true } : {}) } })
        // A check that failed in passing is a failure now, not the older path (publicSource.ts, speed wave item 3): asked
        // again on its own, as a verification is.
        if (await askAgainLater(capability.outcome, attempt, signal)) setAsked({ key, attempt: attempt + 1 })
        return
      }
      if (tokenKey === null) return
      const result = await verifyCandidate(source, tokenKey, null, poolIdKey(id), { signal })
      // A verification that comes back after the page moved on to another pool lands nowhere.
      if (signal.aborted) return
      if (result.failure) {
        if (result.failure.state === 'aborted') return
        const text = failureText(result.failure, 'pools')
        setState({ key, resolution: { kind: 'failed', code: text.code, reason: [text.title, text.detail].filter(Boolean).join('. '), ...(result.failure.state !== 'local' && isTransient(result.failure) ? { passing: true } : {}) } })
        if (await askAgainLater(result.failure, attempt, signal)) setAsked({ key, attempt: attempt + 1 })
        return
      }
      if (!result.option) {
        setState({ key, resolution: { kind: 'not_returned' } })
        return
      }
      setState({ key, resolution: { kind: 'verified', option: result.option } })
    })()
    return () => { controller.abort(); cancel?.() }
  }, [source, id, tokenKey, key, attempt])

  // A price read again moves the pool's price, and the typical range the workspace draws on it moves with it.
  const onOption = useCallback((option: PoolOption) => setState((current) => (current && current.resolution.kind === 'verified' ? { ...current, resolution: { ...current.resolution, option } } : current)), [])

  // This browser's copy of the last overview (lib/read/appPaint.ts): a pool it names with the token this page verifies it
  // against is painted from it, every figure as old as it is, while the page's own verification is on its way, and the
  // answer replaces it (speed wave, item 44, 2026-09-28, the owner's OK: a figure may change on screen when it lands).
  // A link that names no token (B8) has none to paint against: its key ends at the colon, and the copy names no such token.
  const painted = useMemo(() => (key ? paintedPool(appPaint, key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)) : null), [key])
  const own = state?.key === key ? state.resolution : null
  // A25: a failure that can clear by itself never replaces a copy already painted; it is asked again behind it.
  const resolution: Resolution | null = key
    ? own && !(own.kind === 'failed' && own.passing && painted) ? own : painted ? { kind: 'verified', option: painted.option } : { kind: 'verifying' }
    : null
  // The tab names the pool as its heading does, base first (lib/routeTitle.ts, audit E11): from the list at once, else
  // from the verified pool.
  useRouteTitle(entry ? `${entry.labels[0]} / ${entry.labels[1]}` : resolution?.kind === 'verified' ? pairTitle(resolution.option) : 'Pool')

  let body: React.ReactNode
  if (!id) {
    body = (
      <div className="dm-card animate-rise">
        <h1 className="sr-only">Pool</h1>
        <EmptyState
          title="That isn’t a pool id"
          body="This link doesn’t name a pool. Open a pool from Markets and the address bar carries the right one."
          action={<LinkButton href={exploreHref()} variant="outline">Go to Markets</LinkButton>}
        />
      </div>
    )
  } else if (waitingForList) {
    // B8: the list's first answer may name the pool; until it is in, the page rests as it will be laid out.
    body = <Pending id={id} entry={entry} />
  } else if (nothingToVerify || resolution?.kind === 'needs_token') {
    body = (
      <div className="dm-card animate-rise">
        <h1 className="sr-only">Pool</h1>
        <EmptyState
          title="Open this pool from Markets"
          body="This link doesn’t say which token to check the pool with. Search one of its tokens on Markets and open the pool from there."
          action={<LinkButton href={exploreHref()} variant="outline">Go to Markets</LinkButton>}
        />
      </div>
    )
  } else if (!source || !resolution || resolution.kind === 'verifying') {
    body = <Pending id={id} entry={entry} />
  } else if (resolution.kind === 'failed') {
    body = <Pending id={id} entry={entry} verifying={false} reason={{ code: resolution.code, text: resolution.reason }} />
  } else if (resolution.kind === 'not_returned') {
    body = (
      <div className="dm-card animate-rise">
        <h1 className="sr-only">Pool</h1>
        <EmptyState
          title="This pool could not be verified"
          body={tokenKey
            ? <>The pools route did not return pool <span className="font-mono" title={id}>{shortAddress(id)}</span> for token <span className="font-mono" title={tokenKey}>{shortAddress(tokenKey)}</span>, so nothing about it is shown. It may hold other tokens, or not exist at this block.</>
            : 'Robinhood Chain has no pool by this link, so nothing about it is shown. Open a pool from Markets and the address bar carries the right one.'}
          action={<LinkButton variant="outline" size="sm" href={exploreHref()}>Back to Markets</LinkButton>}
        />
      </div>
    )
  } else {
    // New position opens positions only in pools with no hooks and a fixed fee: any other pool has no way there. The
    // button opens the same New position flow as everywhere else, with this pool already chosen. A pool with a token
    // that passes for a main token, or with a misleading name (I1), and one the list withdrew for safety (B2), have no
    // way there either, and say why above everything else.
    const option = resolution.option
    const warning = poolWarning(option.currencies)
    const withdrawn = featured.withdrawn.has(option.key)
    const offList = !featured.entries.some((item) => item.poolId === option.key) && !SELECTED_POOL_CATALOGUE.some((item) => item.poolId === option.key)
    const notice = warning ? (
      <p role="alert" className="dm-pool-warning" data-pool-warning={warning.kind}>{warningText(warning)}</p>
    ) : withdrawn ? (
      <p className="dm-pool-warning" data-pool-warning="withdrawn">Domino took this pool off its list for safety, so positions can’t be opened here from Domino.</p>
    ) : offList ? (
      <p className="dm-pool-offlist" data-pool-offlist="">
        Not on Domino’s list. Before adding money, check both tokens’ contracts: <span className="font-mono break-all">{option.currencies[0].address}</span> and <span className="font-mono break-all">{option.currencies[1].address}</span>.
      </p>
    ) : undefined
    body = (
      <PoolWorkspace
        source={source}
        option={option}
        painted={painted?.overview}
        onOption={onOption}
        notice={notice}
        actions={optionUsableForDomino(option) && !warning && !withdrawn ? <LinkButton href={newPositionHref(option.key, linked.token)} size="lg" className="dm-pool-new" data-new-position="">Create a position</LinkButton> : undefined}
      />
    )
  }

  return (
    <main className="dm-page dm-page--pool" data-pool-page={id ?? ''}>
      <nav aria-label="Breadcrumb" className="dm-pool-breadcrumb">
        <a href={exploreHref()} className="dm-pool-back">
          <IconChevronLeft size={14} />
          Markets
        </a>
      </nav>
      <div className="mt-4">{body}</div>
    </main>
  )
}
