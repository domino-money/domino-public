import { useCallback, useEffect, useState } from 'react'
import { exploreHref, newPositionHref, parsePoolHash } from '../components/explore/routes'
import { useHash } from '../components/explore/useHash'
import { PoolWorkspace } from '../components/read/screens/PoolWorkspace'
import { ScreenStatus, type StatusLine } from '../components/read/screens/ScreenStatus'
import { TokenMarkPair } from '../components/TokenIcon'
import { Button, EmptyState, LinkButton, Skeleton, Stat, StatStrip } from '../components/ui'
import { SELECTED_POOL_CATALOGUE, SELECTED_POOLS_COMMON_TOKEN, type PoolCatalogueEntry } from '../config/selectedPoolCatalogue'
import { verifyCandidate } from '../lib/read/screens/catalogueSession'
import { failureText } from '../lib/read/screens/copy'
import { parseAddressInput, poolIdKey, shortAddress } from '../lib/read/screens/identity'
import { poolPrice, presetRange } from '../lib/read/screens/poolRange'
import type { PoolOption } from '../lib/read/screens/poolsList'
import { useReadSource } from '../lib/read/screens/readContext'
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
  | { kind: 'failed'; line: StatusLine }
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
 * The page while the pool is still only an id: the catalogue's labels for one
 * of the six, the id alone for any other, laid out as the verified page will
 * be, so nothing jumps when it arrives. While verifying, the figures and the
 * chart are resting blocks; once verification has failed they say so in
 * words instead, so a failure never sits beside a "verifying" line.
 */
function Pending({ id, entry, verifying = true, status }: { id: string; entry?: PoolCatalogueEntry; verifying?: boolean; status?: React.ReactNode }) {
  return (
    <div aria-busy={verifying || undefined}>
      <div className="flex min-w-0 animate-rise items-center gap-4">
        <span className="dm-pool-marks">
          {entry ? <TokenMarkPair base={catalogueMark(entry, 0)} quote={catalogueMark(entry, 1)} size={44} ring="var(--bg)" /> : <Skeleton className="size-11 rounded-full" />}
        </span>
        <div className="min-w-0">
          <h1 className="dm-display dm-display-title">
            {entry ? <><bdi>{entry.labels[0]}</bdi> / <bdi>{entry.labels[1]}</bdi></> : 'Pool'}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            {entry && <span className="dm-chip">Uniswap · {entry.fee}</span>}
            <span className="dm-chip">Robinhood Chain</span>
            <span className="dm-pool-id" title={id} translate="no">{shortAddress(id)}</span>
            {verifying && <span role="status" className="text-caption text-fg-muted">Verifying this pool on Robinhood Chain…</span>}
          </div>
        </div>
      </div>
      <div className="dm-pool-figures mt-8 animate-rise [--delay:60ms]">
        <StatStrip cols={5}>
          {['Price', 'TVL', '24h volume', 'Est. APR', 'Fee tier'].map((label) => (
            <Stat
              key={label}
              label={label}
              className={label === 'Price' ? 'dm-pool-price-stat' : undefined}
              sub={verifying ? <span className="mt-2 grid gap-1.5">{(label === 'TVL' || label === '24h volume' ? [20, 24] : [24]).map((width) => <Skeleton key={width} className={width === 20 ? 'h-2.5 w-20' : 'h-2.5 w-24'} />)}</span> : undefined}
            >
              {verifying ? <Skeleton className="mt-1 h-6 w-24" /> : <span className="text-fg-subtle">—</span>}
            </Stat>
          ))}
        </StatStrip>
      </div>
      {status}
      <div className="dm-card mt-8 animate-rise p-5 [--delay:120ms]">
        <h2 className="dm-display dm-display-card">USD price and volume</h2>
        <p className="mt-1 text-caption text-fg-subtle">Hourly candles · GeckoTerminal</p>
        <div className="dm-pool-plot dm-dots-chart mt-4">
          <div className="dm-pool-plot-empty">
            {verifying ? (
              <Skeleton className="dm-pool-plot-baseline" />
            ) : (
              <p className="max-w-[44ch] text-[13px] leading-[18px] text-fg-muted">The price chart, the figures and the range planner appear once this pool has been verified on chain.</p>
            )}
          </div>
        </div>
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
 */
export function PoolDetail({ poolId }: { poolId: string }) {
  const source = useReadSource()
  const linked = parsePoolHash(useHash())
  const id = POOL_ID.test(poolId) ? poolId.toLowerCase() : null
  const entry = id ? SELECTED_POOL_CATALOGUE.find((item) => item.poolId === id) : undefined
  const tokenInput = entry ? parseAddressInput(SELECTED_POOLS_COMMON_TOKEN) : linked.token ? parseAddressInput(linked.token) : null
  const tokenKey = tokenInput?.ok ? tokenInput.key : null
  const key = id && tokenKey ? `${id}:${tokenKey}` : null
  const [state, setState] = useState<{ key: string; resolution: Resolution } | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!source || !id || !tokenKey || !key) return
    const controller = new AbortController()
    void verifyCandidate(source, tokenKey, null, poolIdKey(id), { signal: controller.signal }).then((result) => {
      // A verification that comes back after the page moved on to another pool lands nowhere.
      if (controller.signal.aborted) return
      if (result.failure) {
        if (result.failure.state !== 'aborted') setState({ key, resolution: { kind: 'failed', line: failureText(result.failure, 'pools') } })
        return
      }
      if (!result.option) {
        setState({ key, resolution: { kind: 'not_returned' } })
        return
      }
      const price = poolPrice(result.option, Date.now())
      setState({ key, resolution: { kind: 'verified', option: result.option, range: price.state === 'usable' ? presetRange(price.tick, price.tickSpacing, 'standard') : null } })
    })
    return () => controller.abort()
  }, [source, id, tokenKey, key, attempt])

  // A price read again moves the pool's price; the range drawn on it stays.
  const onOption = useCallback((option: PoolOption) => setState((current) => (current && current.resolution.kind === 'verified' ? { ...current, resolution: { ...current.resolution, option } } : current)), [])
  const onRange = useCallback((range: PlannedRange) => setState((current) => (current && current.resolution.kind === 'verified' ? { ...current, resolution: { ...current.resolution, range } } : current)), [])

  const resolution: Resolution | null = key ? (state?.key === key ? state.resolution : { kind: 'verifying' }) : null
  const retry = () => { setState(null); setAttempt((n) => n + 1) }

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
    body = (
      <div className="dm-card animate-rise">
        <h1 className="sr-only">Pool</h1>
        <EmptyState
          title="Open this pool from Markets"
          body={<>Pool <span className="font-mono" title={id}>{shortAddress(id)}</span> is not one of the selected six, and this link names no token to verify it with. Search one of its tokens on Markets and open the pool from there: every pool page starts from a verified read.</>}
          action={<LinkButton href={exploreHref()} variant="outline">Go to Markets</LinkButton>}
        />
      </div>
    )
  } else if (!source || !resolution || resolution.kind === 'verifying') {
    body = <Pending id={id} entry={entry} />
  } else if (resolution.kind === 'failed') {
    body = (
      <Pending
        id={id}
        entry={entry}
        verifying={false}
        status={<>
          <ScreenStatus line={resolution.line} className="mt-4" onRetry={retry} />
          {!resolution.line.retry && <Button variant="outline" size="sm" className="mt-3" onClick={retry}>Verify again</Button>}
        </>}
      />
    )
  } else if (resolution.kind === 'not_returned') {
    body = (
      <div className="dm-card animate-rise">
        <h1 className="sr-only">Pool</h1>
        <EmptyState
          title="This pool could not be verified"
          body={<>The pools route did not return pool <span className="font-mono" title={id}>{shortAddress(id)}</span> for token <span className="font-mono" title={tokenKey}>{shortAddress(tokenKey)}</span>, so nothing about it is shown. It may hold other tokens, or not exist at this block.</>}
          action={<div className="flex flex-wrap items-center justify-center gap-2"><Button variant="outline" size="sm" onClick={retry}>Verify again</Button><LinkButton variant="ghost" size="sm" href={exploreHref()}>Back to Markets</LinkButton></div>}
        />
      </div>
    )
  } else {
    body = (
      <PoolWorkspace
        source={source}
        option={resolution.option}
        onOption={onOption}
        range={resolution.range}
        onRange={onRange}
        actions={<LinkButton href={newPositionHref(resolution.option.key)} className="dm-pool-new" data-new-position="">New position</LinkButton>}
      />
    )
  }

  return (
    <main className="dm-page dm-page--pool" data-pool-page={id ?? ''}>
      <nav aria-label="Breadcrumb" className="dm-pool-breadcrumb">
        <a href={exploreHref()} className="dm-pool-back">
          <span aria-hidden="true" className="dm-pool-back-glyph">‹</span>
          Markets
        </a>
      </nav>
      <div className="mt-4">{body}</div>
    </main>
  )
}
