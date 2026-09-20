import { useEffect, useRef, useState, type ReactNode } from 'react'
import { poolListings, type PoolListing } from '../../config/selectedPoolCatalogue'
import { readNow, retrievedText, type Instant, type Market } from '../../lib/markets'
import { chartMatches } from '../../lib/read/chart'
import { reasonText } from '../../lib/read/describe'
import { volumeGeometry } from '../../lib/read/priceSeries'
import { failureText } from '../../lib/read/screens/copy'
import { useReadSource } from '../../lib/read/screens/readContext'
import { readWithin, type ScreenOutcome } from '../../lib/read/screens/screenRead'
import { shownResult, useMarkets } from '../../lib/read/useMarkets'
import { useNow } from '../../lib/read/useNow'
import { IconChevronLeft, IconChevronRight } from '../icons'
import { IconButton } from '../ui'
import { MarketCard, type CardVolume } from './MarketCard'

type Side = 'base' | 'quote'

/** One card's settled hourly read: its outcome, the side it asked for, and when it settled on this page's clocks. */
interface Remembered {
  outcome: Exclude<ScreenOutcome<'pool-market'>, { state: 'aborted' }>
  side: Side
  settledAt: Instant
}

/**
 * Settled card reads by pool id, for the life of the document: going back to
 * Markets within the read service's five-minute limit shows what was already
 * read instead of asking again. Written only when a read settles, never while
 * rendering.
 */
const REMEMBERED = new Map<string, Remembered>()

/** A read of a card asks at most this often per page view: the first read, and one more when that one is due again. */
const READS_PER_VIEW = 2
/** How long a failed read waits before it may be asked again, unless the service said how long. */
const RETRY_AFTER_MS = 60_000
/** Candle reasons a later read can clear. The others are the answer. */
const TRANSIENT = new Set(['provider_capacity_busy', 'provider_rate_limited', 'provider_unavailable'])

/**
 * The token whose USD candles the pool page asks for, asked for the same way
 * here, so both send the identical read and share the read service's cache.
 */
const chartSide = (market: Market): Side => (market.chartTokens?.quote === market.tokens.base.address ? 'quote' : 'base')

const elapsedMs = (since: Instant, now: Instant) =>
  Math.max(0, since.monotonic !== undefined && now.monotonic !== undefined ? now.monotonic - since.monotonic : now.wall - since.wall)

/** Seconds since the provider's candles were retrieved: the age the read service reported plus the time since its answer arrived. */
function historyAge(outcome: Extract<ScreenOutcome<'pool-market'>, { state: 'ok' }>, now: Instant): { seconds: number; known: boolean } {
  const onScreen = Math.floor(elapsedMs({ wall: outcome.provenance.receivedAt, monotonic: outcome.provenance.receivedMonotonic }, now) / 1000)
  const reported = outcome.data.priceHistory.cache?.ageSeconds ?? null
  return reported === null ? { seconds: onScreen, known: false } : { seconds: reported + onScreen, known: true }
}

/** Whether a settled read may be asked again: expired candles, a transient answer, or a failure worth retrying, once its wait is over. */
function dueAgain(entry: Remembered, now: Instant): boolean {
  const { outcome } = entry
  if (outcome.state === 'ok') {
    const history = outcome.data.priceHistory
    if (history.status === 'available' || history.status === 'stale') return historyAge(outcome, now).seconds > history.cache.maxStaleSeconds
    if (history.status === 'unavailable' || history.status === 'rejected') return TRANSIENT.has(history.reason ?? '') && elapsedMs(entry.settledAt, now) >= RETRY_AFTER_MS
    return false
  }
  const wait = outcome.state === 'busy' ? outcome.retryAfterSeconds * 1000 : RETRY_AFTER_MS
  return failureText(outcome, 'pools').retry && elapsedMs(entry.settledAt, now) >= wait
}

const NO_PAD = { top: 0, right: 0, bottom: 0, left: 0 }

/** Whether the rail can still move back, and forward; the previous value when nothing changed, so a scroll re-renders nothing. */
function railEdges(node: HTMLElement, prev: { start: boolean; end: boolean }) {
  const start = node.scrollLeft <= 1
  const end = node.scrollLeft + node.clientWidth >= node.scrollWidth - 1
  return prev.start === start && prev.end === end ? prev : { start, end }
}

/** What one card's plot shows now, from the markets state and its own settled read only. */
function volumeOf(listing: PoolListing, settled: boolean, entry: Remembered | undefined, now: Instant): CardVolume {
  const market = listing.market
  if (!market) return settled ? { kind: 'no-figures' } : { kind: 'loading' }
  // Candles are asked for by a provider token the market read verified; without one there is nothing to ask.
  if (!market.chartTokens) return { kind: 'unavailable', reason: reasonText(market.provenance?.market.reason ?? 'provider_unavailable') }
  const side = chartSide(market)
  if (!entry || entry.side !== side) return { kind: 'reading' }
  const { outcome } = entry
  if (outcome.state !== 'ok') {
    const said = failureText(outcome, 'pools')
    return { kind: 'failed', title: said.title, detail: said.detail }
  }
  const history = outcome.data.priceHistory
  if (history.status !== 'available' && history.status !== 'stale') return { kind: 'unavailable', reason: reasonText(history.reason) }
  if (!chartMatches(outcome.data, market.chartTokens[side], side)) return { kind: 'unavailable', reason: reasonText('provider_chart_currency_mismatch') }
  const age = historyAge(outcome, now)
  if (age.seconds > history.cache.maxStaleSeconds) return { kind: 'expired' }
  const data = history.data
  if (data.candles.length === 0) return { kind: 'unavailable', reason: 'no candles reported' }
  if (!volumeGeometry(data.candles, data.intervalSeconds, 240, 96, NO_PAD, 0)) return { kind: 'unavailable', reason: 'the reported volumes could not be read' }
  const stale = history.status === 'stale' || age.seconds >= history.cache.freshForSeconds
  const title = `Reported by a market data provider, ${retrievedText(age.known ? age.seconds : null)}. Not reconciled by Domino.${stale ? ' Stale, not current.' : ''}`
  return { kind: 'bars', candles: data.candles, intervalSeconds: data.intervalSeconds, returned: data.coverage.returnedCandles, stale, title }
}

/**
 * The top of Markets: the page's title block with the rail's arrows, and the
 * rail of wide cards, one per selected pool, in the table's order.
 *
 * Reads: as soon as its own verified row is available, a card asks for its
 * pool's hourly candles once, through the
 * app's one scheduled source, but only while it is at least 60% inside the
 * rail: cards come into the queue in rail order as they come into view. The
 * view gates only the asking. A read that has been asked for is kept to its
 * end even if its card scrolls away; leaving the page cancels what is still
 * outstanding. A busy or failed read, or candles past the service's limit,
 * is asked once more, when its wait is over and its card is in view. One
 * clock ticks for the whole rail, only while a card in view has something
 * that ages.
 */
export function MarketCarousel({ heading }: { heading: ReactNode }) {
  const source = useReadSource()
  const { state, provider } = useMarkets()
  const markets = shownResult(state)?.markets ?? []
  const listings = poolListings(markets, __DOMINO_POOL_SET__ === 'selected' && provider.kind === 'bridge')
  const settled = state.phase !== 'loading'

  const rail = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState<ReadonlySet<string>>(() => new Set())
  const [reads, setReads] = useState<ReadonlyMap<string, Remembered>>(() => new Map(REMEMBERED))
  const [edges, setEdges] = useState({ start: true, end: true })
  const running = useRef(new Map<string, AbortController>())
  const asked = useRef(new Map<string, number>())
  const frame = useRef(0)

  const ids = listings.map((listing) => listing.poolId).join(',')
  const active = listings.some((listing) => visible.has(listing.poolId) && (listing.market !== undefined || reads.has(listing.poolId)))
  const now = useNow(active)

  const onScroll = () => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const node = rail.current
      if (node) setEdges((prev) => railEdges(node, prev))
    })
  }

  // Leaving the page cancels what is still outstanding; a read already settled stays remembered.
  useEffect(() => {
    const flights = running.current
    const counts = asked.current
    return () => {
      cancelAnimationFrame(frame.current)
      frame.current = 0
      for (const controller of flights.values()) controller.abort()
      flights.clear()
      counts.clear()
    }
  }, [])

  // Which cards are at least 60% inside the rail, and whether the rail can move either way.
  useEffect(() => {
    const node = rail.current
    if (!node) return
    const update = () => setEdges((prev) => railEdges(node, prev))
    update()
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    resize?.observe(node)
    if (typeof IntersectionObserver === 'undefined') return () => resize?.disconnect()
    const inView = new Set<string>()
    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false
        for (const entry of entries) {
          const id = entry.target.getAttribute('data-market-card')
          if (!id) continue
          const seen = entry.isIntersecting && entry.intersectionRatio >= 0.59
          if (seen === inView.has(id)) continue
          changed = true
          if (seen) inView.add(id)
          else inView.delete(id)
        }
        if (changed) setVisible(new Set(inView))
      },
      { root: node, threshold: [0, 0.6, 1] },
    )
    node.querySelectorAll('[data-market-card]').forEach((card) => observer.observe(card))
    return () => {
      observer.disconnect()
      resize?.disconnect()
    }
  }, [ids])

  // Ask for the hourly candles of each card in view that needs them, in rail order.
  useEffect(() => {
    if (!source) return
    for (const { poolId, market } of listings) {
      if (!market?.chartTokens || !visible.has(poolId) || running.current.has(poolId)) continue
      const side = chartSide(market)
      const entry = reads.get(poolId)
      const count = asked.current.get(poolId) ?? 0
      if (count >= READS_PER_VIEW) continue
      if (entry && entry.side === side && !dueAgain(entry, now)) continue
      const controller = new AbortController()
      running.current.set(poolId, controller)
      asked.current.set(poolId, count + 1)
      void readWithin(source, 'pool-market', { poolId, includePriceHistory: true, priceToken: side }, { signal: controller.signal }).then((outcome) => {
        if (running.current.get(poolId) === controller) running.current.delete(poolId)
        if (controller.signal.aborted || outcome.state === 'aborted') return
        const remembered: Remembered = { outcome, side, settledAt: readNow() }
        REMEMBERED.set(poolId, remembered)
        setReads((current) => new Map(current).set(poolId, remembered))
      })
    }
  }, [source, listings, visible, reads, now])

  const scrollPage = (direction: 1 | -1) => {
    const node = rail.current
    if (!node) return
    const cards = node.querySelectorAll<HTMLElement>('[data-market-card]')
    if (cards.length === 0) return
    const step = cards.length > 1 ? cards[1].offsetLeft - cards[0].offsetLeft : cards[0].offsetWidth
    const gap = step - cards[0].offsetWidth
    // Whole cards per view: two on a laptop, one on a phone. The rail's 6px padding is not a card's.
    const perView = Math.max(1, Math.round((node.clientWidth - 12 + gap) / step))
    node.scrollBy({ left: direction * perView * step })
  }

  const railed = listings.length > 0
  return (
    <>
      <div className="dm-mkt-titlebar">
        <div className="min-w-0 animate-rise">{heading}</div>
        {railed && (
          <div className="dm-mkt-arrows">
            <IconButton label="Previous pools" icon={<IconChevronLeft />} aria-controls="market-rail" disabled={edges.start} onClick={() => scrollPage(-1)} />
            <IconButton label="Next pools" icon={<IconChevronRight />} aria-controls="market-rail" disabled={edges.end} onClick={() => scrollPage(1)} />
          </div>
        )}
      </div>
      {railed && (
        <div id="market-rail" ref={rail} role="region" aria-label="Selected pools, hourly volume" className="dm-mkt-rail" onScroll={onScroll}>
          {listings.map((listing, index) => (
            <MarketCard key={listing.poolId} listing={listing} index={index} now={now} volume={volumeOf(listing, settled, reads.get(listing.poolId), now)} />
          ))}
        </div>
      )}
    </>
  )
}
