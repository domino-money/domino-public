import { useCallback, useEffect, useState } from 'react'
import { exploreHref, newPositionHref, parsePoolHash } from '../components/explore/routes'
import { useHash } from '../components/explore/useHash'
import { IconChevronLeft } from '../components/icons'
import { PoolWorkspace } from '../components/read/screens/PoolWorkspace'
import { TokenMarkPair } from '../components/TokenIcon'
import { EmptyState, LinkButton, Skeleton, Stat, StatStrip } from '../components/ui'
import { SELECTED_POOL_CATALOGUE, entryToken, inPoolOrder, type PoolCatalogueEntry } from '../config/selectedPoolCatalogue'
import { useFeatured } from '../lib/read/featuredSource'
import { verifyCandidate } from '../lib/read/screens/catalogueSession'
import { overviewPoolOption } from '../lib/read/publicOverview'
import { failureText } from '../lib/read/screens/copy'
import { parseAddressInput, poolIdKey, shortAddress } from '../lib/read/screens/identity'
import { poolPrice, presetRange } from '../lib/read/screens/poolRange'
import { optionUsableForDomino, type PoolOption } from '../lib/read/screens/poolsList'
import { useReadSource } from '../lib/read/screens/readContext'
import { askAgainLater, readWithin } from '../lib/read/screens/screenRead'
import { whenVisibleAfter } from '../lib/read/screens/quietRead'
import type { TokenDisplay } from '../lib/read/types'

/*
 * tests/pool-workspace.test.mjs loads this file with every import but React
 * replaced by a fixed list of stubs, and React by useState, useRef,
 * useCallback and useEffect only. Looks come through class names.
 */

const POOL_ID = /^0x[0-9a-fA-F]{64}$/

/** Two ticks on the pool's spacing: the band the range planner draws. */
type PlannedRange = { lower: number; upper: number }

type Resolution =
  | { kind: 'verifying' }
  /** No answer to show: `code` is the read's state, `reason` its words, for the title and the live region only. */
  | { kind: 'failed'; code: string; reason: string }
  /** The pools route answered and did not include this pool. */
  | { kind: 'not_returned' }
  | { kind: 'verified'; option: PoolOption; range: PlannedRange | null }

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
 * will be, so nothing jumps when it arrives. No fee tier is stated before the
 * pool is verified, in the chip or the stat. While verifying, the figures and
 * the chart are resting blocks; once verification has no answer they are
 * dashes, with the reason in their title and in the live region, never a panel.
 */
function Pending({ id, entry, verifying = true, reason }: { id: string; entry?: PoolCatalogueEntry; verifying?: boolean; reason?: { code: string; text: string } }) {
  // A resting bubble while verifying; the same box, empty, once verification has no answer.
  const bubble = (name: string) => <span aria-hidden="true" className={verifying ? `dm-skel ${name}` : name} />
  return (
    <div aria-busy={verifying || undefined} data-pool-verification={verifying ? 'verifying' : reason?.code} title={reason?.text} className="dm-pool-layout">
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
              {/* The fee tier is the verified pool's to state, as its stat below is: until then the chip names the protocol only. */}
              {entry && <span className="dm-chip">Uniswap</span>}
              <span className="dm-chip">Robinhood Chain</span>
              <span className="dm-pool-id" title={id} translate="no">{shortAddress(id)}</span>
              {verifying && <span role="status" className="dm-pool-verifying">Verifying this pool on Robinhood Chain…</span>}
              {!verifying && <span role="status" className="sr-only">{reason?.text}</span>}
            </div>
          </div>
        </div>
        {/* Holds the New position button's place, unseen, so the title row does not move when it arrives. */}
        {entry && <div aria-hidden="true" className="dm-pool-actions"><span className="dm-pool-skel-action" /></div>}
      </div>
      {/* The verified page's grid, resting: the figures card beside the chart card, each figure a bubble, and a bubble
          under each figure that has a line under it. */}
      <div className="dm-pool-figures dm-pool-a-figs animate-rise [--delay:40ms]">
        <StatStrip cols={5} layout="list">
          {['Price', 'TVL', '24h volume', 'Est. APR', 'Fee tier'].map((label) => (
            <Stat key={label} label={label} className={label === 'Price' ? 'dm-pool-price-stat' : undefined}
              sub={verifying && (label === 'Price' || label === 'Est. APR' || label === 'Fee tier') ? <Skeleton className="dm-pool-fig-sub-skel" /> : undefined}>
              {verifying ? <Skeleton className="dm-pool-fig-skel" /> : <span className="text-fg-subtle">—</span>}
            </Stat>
          ))}
        </StatStrip>
      </div>
      {/* The chart card at the verified card's height, row for row: the source switch, the close and its date, the
          base and window switches, the plot, its time axis and the quiet row under it. Bubbles while verifying; once
          verification has no answer, the same rows hold their place, empty. */}
      <div className="dm-card dm-pool-chart dm-pool-a-chart animate-rise [--delay:80ms]">
        <div className="dm-pool-chart-head">
          <h2 className="dm-title">Pool price history</h2>
          {bubble('dm-pool-skel-switch')}
        </div>
        <div aria-hidden="true" className="dm-pool-skel-head">
          {bubble('dm-pool-skel-sub')}
          {bubble('dm-pool-skel-price')}
          {bubble('dm-pool-skel-date')}
        </div>
        <div aria-hidden="true" className="dm-pool-skel-controls">
          {bubble('dm-pool-skel-seg')}
          {bubble('dm-pool-skel-seg')}
        </div>
        {/* Stands in for the ratio chart the verified page opens on; no caption under the heading. */}
        <div className="dm-pool-plot dm-dots-chart mt-4" title="Pool ratios from verified Robinhood Chain Swap events.">
          <div className="dm-pool-plot-empty">
            {verifying ? <Skeleton className="dm-pool-plot-baseline" /> : <span className="text-fg-subtle" title={reason?.text}>—</span>}
          </div>
        </div>
        <div aria-hidden="true" className="dm-pool-skel-axis">
          {bubble('dm-pool-skel-tick')}
          {bubble('dm-pool-skel-tick')}
        </div>
        <div aria-hidden="true" className="dm-pool-skel-quiet">{bubble('dm-pool-skel-summary')}</div>
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
 */
export function PoolDetail({ poolId }: { poolId: string }) {
  const source = useReadSource()
  const linked = parsePoolHash(useHash())
  const id = POOL_ID.test(poolId) ? poolId.toLowerCase() : null
  // The list on screen first (lib/read/featuredSource.ts), then the embedded list: a pool of either is named at once.
  const featured = useFeatured()
  // Named in the pool's order, as the verified page will name it, so the heading keeps its order when it arrives.
  const listed = id ? (featured.entries.find((item) => item.poolId === id) ?? SELECTED_POOL_CATALOGUE.find((item) => item.poolId === id)) : undefined
  const entry = listed && inPoolOrder(listed)
  // Verified against a token the list names for it (USDG where it holds it), else the one the link names.
  const listedToken = entry ? entryToken(entry) : null
  const tokenInput = listedToken ? parseAddressInput(listedToken) : linked.token ? parseAddressInput(linked.token) : null
  const tokenKey = tokenInput?.ok ? tokenInput.key : null
  const key = id && tokenKey ? `${id}:${tokenKey}` : null
  const [state, setState] = useState<{ key: string; resolution: Resolution } | null>(null)
  // Quiet re-asks already spent verifying this pool. The page stays mounted from one pool to the next,
  // so the count belongs to the pool it was spent on: another pool starts from none.
  const [asked, setAsked] = useState<{ key: string; attempt: number } | null>(null)
  const attempt = key !== null && asked?.key === key ? asked.attempt : 0
  // Leaving a pool forgets its count, so coming back to it starts from none as well.
  useEffect(() => () => setAsked(null), [key])

  useEffect(() => {
    if (!source || !id || !tokenKey || !key) return
    const controller = new AbortController()
    const { signal } = controller
    let cancel: (() => void) | null = null
    void (async () => {
      const capability = source.supportsStoredReads ? await source.routeEnabled?.('overview', { signal }) : undefined
      if (signal.aborted) return
      if (capability?.state === 'enabled') {
        const overview = await readWithin(source, 'overview', { poolIds: [id] }, { signal })
        if (signal.aborted || overview.state === 'aborted') return
        if (overview.state !== 'ok') {
          const text = failureText(overview, 'pools')
          setState({ key, resolution: { kind: 'failed', code: text.code, reason: [text.title, text.detail].filter(Boolean).join('. ') } })
          if (await askAgainLater(overview, attempt, signal)) setAsked({ key, attempt: attempt + 1 })
          return
        }
        const option = overviewPoolOption(overview, id)
        if (option && option.currencies.some((currency) => currency.address === tokenKey)) {
          const price = poolPrice(option, Date.now())
          setState({ key, resolution: { kind: 'verified', option, range: price.state === 'usable' ? presetRange(price.tick, price.tickSpacing, 'standard') : null } })
        } else if (overview.data.pools.some((entry) => entry.poolId === id && entry.acquisition.status === 'pending')) {
          cancel = whenVisibleAfter(5_000, () => setAsked({ key, attempt: attempt + 1 }))
        } else setState({ key, resolution: { kind: 'not_returned' } })
        return
      }
      if (capability?.state === 'failed') {
        const text = failureText(capability.outcome, 'pools')
        setState({ key, resolution: { kind: 'failed', code: text.code, reason: [text.title, text.detail].filter(Boolean).join('. ') } })
        return
      }
      const result = await verifyCandidate(source, tokenKey, null, poolIdKey(id), { signal })
      // A verification that comes back after the page moved on to another pool lands nowhere.
      if (signal.aborted) return
      if (result.failure) {
        if (result.failure.state === 'aborted') return
        const text = failureText(result.failure, 'pools')
        setState({ key, resolution: { kind: 'failed', code: text.code, reason: [text.title, text.detail].filter(Boolean).join('. ') } })
        if (await askAgainLater(result.failure, attempt, signal)) setAsked({ key, attempt: attempt + 1 })
        return
      }
      if (!result.option) {
        setState({ key, resolution: { kind: 'not_returned' } })
        return
      }
      const price = poolPrice(result.option, Date.now())
      setState({ key, resolution: { kind: 'verified', option: result.option, range: price.state === 'usable' ? presetRange(price.tick, price.tickSpacing, 'standard') : null } })
    })()
    return () => { controller.abort(); cancel?.() }
  }, [source, id, tokenKey, key, attempt])

  // A price read again moves the pool's price; the range drawn on it stays.
  const onOption = useCallback((option: PoolOption) => setState((current) => (current && current.resolution.kind === 'verified' ? { ...current, resolution: { ...current.resolution, option } } : current)), [])
  const onRange = useCallback((range: PlannedRange) => setState((current) => (current && current.resolution.kind === 'verified' ? { ...current, resolution: { ...current.resolution, range } } : current)), [])

  const resolution: Resolution | null = key ? (state?.key === key ? state.resolution : { kind: 'verifying' }) : null

  let body: React.ReactNode
  if (!id) {
    body = (
      <div className="dm-card animate-rise">
        <h1 className="sr-only">Pool</h1>
        <EmptyState
          title="That isn’t a pool id"
          body="A pool is identified by a 32-byte id. Open a pool from Markets and the address bar carries the right one."
          action={<LinkButton href={exploreHref()} variant="outline">Go to Markets</LinkButton>}
        />
      </div>
    )
  } else if (!tokenKey) {
    // Today's words while the embedded list is on screen, so the site reads as before until the list is served
    // (2026-09-26, featured pools v1 §11.7; kept after review).
    body = (
      <div className="dm-card animate-rise">
        <h1 className="sr-only">Pool</h1>
        <EmptyState
          title="Open this pool from Markets"
          body={<>Pool <span className="font-mono" title={id}>{shortAddress(id)}</span> is not one of the {featured.source === 'bundled' ? 'selected six' : 'selected pools'}, and this link names no token to verify it with. Search one of its tokens on Markets and open the pool from there: every pool page starts from a verified read.</>}
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
          body={<>The pools route did not return pool <span className="font-mono" title={id}>{shortAddress(id)}</span> for token <span className="font-mono" title={tokenKey}>{shortAddress(tokenKey)}</span>, so nothing about it is shown. It may hold other tokens, or not exist at this block.</>}
          action={<LinkButton variant="outline" size="sm" href={exploreHref()}>Back to Markets</LinkButton>}
        />
      </div>
    )
  } else {
    // New position opens positions only in pools with no hooks and a fixed fee: any other pool has no way there.
    body = (
      <PoolWorkspace
        source={source}
        option={resolution.option}
        onOption={onOption}
        range={resolution.range}
        onRange={onRange}
        actions={optionUsableForDomino(resolution.option) ? <LinkButton href={newPositionHref(resolution.option.key)} size="lg" className="dm-pool-new" data-new-position="">New position</LinkButton> : undefined}
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
