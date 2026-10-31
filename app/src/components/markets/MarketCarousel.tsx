import { useEffect, useRef, useState, type ReactNode } from 'react'
import { poolListings } from '../../config/selectedPoolCatalogue'
import { followCardMode, watchCard, type CardMode } from '../../lib/read/cardReads'
import { cardAsk, inAskOrder, mergeAnswer, pickSeries, type CardAnswer, type CardAsk } from '../../lib/read/cardSeries'
import { useFeatured } from '../../lib/read/featuredSource'
import { useReadSource } from '../../lib/read/screens/readContext'
import { useFallbackRows } from '../../lib/read/useFallback'
import { shownResult, useMarkets } from '../../lib/read/useMarkets'
import { useNow } from '../../lib/read/useNow'
import type { Market } from '../../lib/markets'
import { rootScale } from '../../lib/rootScale'
import { IconChevronLeft, IconChevronRight } from '../icons'
import { IconButton } from '../ui'
import { MarketCard } from './MarketCard'

const NO_ASKS: readonly CardAsk[] = []
const NO_MARKETS: readonly Market[] = []

type Rail = { start: boolean; end: boolean; perView: number; page: number }

/**
 * The page turn's curve, the prototype's e-enter (cubic-bezier(.16, 1, .3, 1)): x(t) solved by Newton's method, with
 * bisection where the slope is too flat, then y(t).
 */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const x = (t: number) => ((ax * t + bx) * t + cx) * t
  const y = (t: number) => ((ay * t + by) * t + cy) * t
  const slope = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  return (progress: number) => {
    if (progress <= 0) return 0
    if (progress >= 1) return 1
    let t = progress
    for (let i = 0; i < 8; i++) {
      const error = x(t) - progress
      if (Math.abs(error) < 1e-6) return y(t)
      const d = slope(t)
      if (Math.abs(d) < 1e-6) break
      t -= error / d
    }
    let low = 0, high = 1
    t = progress
    for (let i = 0; i < 24; i++) {
      const value = x(t)
      if (Math.abs(value - progress) < 1e-6) break
      if (value < progress) low = t
      else high = t
      t = (low + high) / 2
    }
    return y(t)
  }
}
const ENTER = bezier(0.16, 1, 0.3, 1)
/** One press moves a view of cards in a long, soft, decelerating slide (.track: transform .7s e-enter). */
const TURN_MS = 700
/** A plate's rim catches the ember only while the pointer is this close to it, in design px (markets.html measure()). */
const NEAR = 40

const stilled = () => (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) || document.documentElement.classList.contains('dm-still')
const px = (value: number) => `${Math.round(value * 10) / 10}px`

/** How far one card steps, and how many whole cards a view holds (the rail's side padding is not a card's). */
function railPitch(node: HTMLElement) {
  const cards = node.querySelectorAll<HTMLElement>('[data-market-card]')
  if (cards.length === 0) return null
  const step = cards.length > 1 ? cards[1].offsetLeft - cards[0].offsetLeft : cards[0].offsetWidth
  if (step <= 0) return null
  const gap = step - cards[0].offsetWidth
  const style = getComputedStyle(node)
  const inset = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
  return { step, perView: Math.max(1, Math.round((node.clientWidth - inset + gap) / step)) }
}

/**
 * Whether the rail can still move back, and forward, how many cards a view holds and which view is showing (for the
 * page dots); the previous value when nothing changed, so a scroll re-renders nothing.
 */
function railEdges(node: HTMLElement, prev: Rail): Rail {
  const start = node.scrollLeft <= 1
  const end = node.scrollLeft + node.clientWidth >= node.scrollWidth - 1
  const pitch = railPitch(node)
  const perView = pitch?.perView ?? 0
  const page = pitch ? Math.round(node.scrollLeft / (pitch.perView * pitch.step)) : 0
  return prev.start === start && prev.end === end && prev.perView === perView && prev.page === page ? prev : { start, end, perView, page }
}

/**
 * The top of Markets: the page's title block with the rail's arrows, and the
 * rail of wide cards, one per selected pool, in the table's order.
 *
 * Reads: once the table's rows are in, one capabilities check (the answer the
 * page already holds, never a read of its own) decides what every card asks
 * for: the pool's stored price history where `history` is listed, else a
 * provider's hourly candles (lib/read/cardReads.ts). While it says provider
 * it is asked again each minute; when `history` is listed again, the cards
 * stop their provider reads and ask for the chain line. Every card with a row
 * then asks at once, cards in view first and the rest in rail order, through
 * the app's one scheduled source, which paces them; nothing waits for a card
 * to scroll into view. What this browser kept for a card is drawn at once and
 * replaced when its own answer lands. Leaving the page cancels whatever is
 * still outstanding. One clock ticks for the whole rail, only while a card in
 * view has something that ages.
 */
export function MarketCarousel({ heading }: { heading: ReactNode }) {
  const source = useReadSource()
  const { state, provider } = useMarkets()
  const read = shownResult(state)?.markets ?? NO_MARKETS
  // The list on screen (lib/read/featuredSource.ts): the featured list, or the embedded one.
  const featured = useFeatured()
  const listed = __DOMINO_POOL_SET__ === 'selected' && provider.kind === 'bridge'
  const [visible, setVisible] = useState<ReadonlySet<string>>(() => new Set())
  // The same live clock chooses a stand-in and ages its presentation. A frozen selection clock kept preferring
  // old saved figures on the cards after the table had switched to a newer source. Resume when cards are visible.
  const now = useNow(visible.size > 0)
  const markets = useFallbackRows(read, listed ? featured.entries : null, now)
  // Until the list's first answer is in, resting cards with no names (audit B4, 2026-10-01).
  const unsettled = listed && !featured.settled
  const listings = unsettled ? [] : poolListings(markets, listed ? featured.entries : null)
  const settled = state.phase !== 'loading'

  const rail = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<CardMode | null>(null)
  const [reads, setReads] = useState<ReadonlyMap<string, CardAnswer>>(() => new Map())
  const [edges, setEdges] = useState<Rail>({ start: true, end: true, perView: 0, page: 0 })
  const running = useRef(new Map<string, AbortController>())
  const frame = useRef(0)
  const turn = useRef(0)

  const ids = listings.map((listing) => listing.poolId).join(',')
  const rows = listings.some((listing) => listing.market !== undefined)
  const asks = mode === 'chain' || mode === 'provider' ? listings.map((listing) => (listing.market ? cardAsk(listing.market, mode) : null)) : NO_ASKS
  const wanted = asks.flatMap((ask) => (ask ? [ask.key] : [])).join(',')

  const onScroll = () => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const node = rail.current
      if (node) setEdges((prev) => railEdges(node, prev))
    })
  }

  // Leaving the page cancels what is still outstanding; what was answered stays in this browser's memory.
  useEffect(() => {
    const flights = running.current
    return () => {
      cancelAnimationFrame(frame.current)
      frame.current = 0
      cancelAnimationFrame(turn.current)
      turn.current = 0
      for (const controller of flights.values()) controller.abort()
      flights.clear()
    }
  }, [])

  // The ember near a plate lights its rim (.p-edge): on a fine pointer, each plate gets the pointer in its own px
  // (--elx/--ely) and --ember-near, 1 only while the pointer is within 40px of it. Decoration only: one passive listener,
  // one frame at a time, custom properties through the CSSOM.
  useEffect(() => {
    const node = rail.current
    if (!node || typeof window.matchMedia !== 'function' || typeof requestAnimationFrame !== 'function') return
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return
    // Asked once here, read on every move: a pointer move makes no media query of its own.
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    const still = () => reduce.matches || document.documentElement.classList.contains('dm-still')
    let on = false
    let x = 0
    let y = 0
    let drawing = 0
    const draw = () => {
      drawing = 0
      const near = NEAR * rootScale()
      node.querySelectorAll<HTMLElement>('[data-market-card]').forEach((card) => {
        const box = card.getBoundingClientRect()
        const inside = on && x > box.left - near && x < box.right + near && y > box.top - near && y < box.bottom + near
        if (inside || card.style.getPropertyValue('--ember-near') === '1') {
          card.style.setProperty('--elx', px(x - box.left))
          card.style.setProperty('--ely', px(y - box.top))
        }
        card.style.setProperty('--ember-near', inside ? '1' : '0')
      })
    }
    const schedule = () => {
      if (!drawing) drawing = requestAnimationFrame(draw)
    }
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      // QA round 2, N90: under reduced motion (or html.dm-still) the rim light does not follow the pointer; a light already
      // drawn goes back to rest once, as EmberLight's does.
      if (still()) {
        if (on) { on = false; schedule() }
        return
      }
      on = true
      x = event.clientX
      y = event.clientY
      schedule()
    }
    const out = (event: PointerEvent) => {
      if (event.relatedTarget !== null) return
      on = false
      schedule()
    }
    window.addEventListener('pointermove', move, { passive: true })
    document.addEventListener('pointerout', out, { passive: true })
    node.addEventListener('scroll', schedule, { passive: true })
    return () => {
      cancelAnimationFrame(drawing)
      window.removeEventListener('pointermove', move)
      document.removeEventListener('pointerout', out)
      node.removeEventListener('scroll', schedule)
    }
  }, [ids])

  // Which cards are at least 60% inside the rail, for the arrows and to ask for those first.
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

  // Once there are rows: which series the cards ask for, from the capabilities the page already holds, and again
  // each minute while that says provider, so a passing failure of the check does not keep the cards off the chain line.
  useEffect(() => {
    if (!source || !rows) return
    const controller = new AbortController()
    void followCardMode(source, (next) => {
      if (!controller.signal.aborted) setMode(next)
    }, { signal: controller.signal })
    return () => controller.abort()
  }, [source, rows])

  // Every card with a row asks, those in view first; a card whose series changed stops asking for the old one.
  useEffect(() => {
    if (!source) return
    const keys = new Set(wanted.split(','))
    for (const [key, controller] of running.current) {
      if (keys.has(key)) continue
      controller.abort()
      running.current.delete(key)
    }
    for (const ask of inAskOrder(asks.flatMap((entry) => (entry ? [entry] : [])), visible)) {
      if (running.current.has(ask.key)) continue
      const controller = new AbortController()
      running.current.set(ask.key, controller)
      void watchCard(source, ask, (answer) => {
        if (controller.signal.aborted) return
        setReads((current) => new Map(current).set(ask.key, mergeAnswer(current.get(ask.key), answer)))
      }, { signal: controller.signal })
    }
    // `asks` is rebuilt on every render and `wanted` names it, so this runs often; a card already asking is left alone.
  }, [source, wanted, visible, asks])

  const scrollPage = (direction: 1 | -1) => {
    const node = rail.current
    if (!node) return
    // Whole cards per view: three on a laptop, two on a tablet, one on a phone.
    const pitch = railPitch(node)
    if (!pitch) return
    // The rail's own scroll, turned by hand on the prototype's curve (0.7s e-enter) rather than the browser's smooth
    // scroll; snapping waits until the turn ends. The arrows, the dots and the observer read the scroll as before.
    if (turn.current) {
      cancelAnimationFrame(turn.current)
      turn.current = 0
    }
    const from = node.scrollLeft
    const target = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, from + direction * pitch.perView * pitch.step))
    if (target === from) return
    if (stilled() || typeof requestAnimationFrame !== 'function') {
      node.scrollTo({ left: target, behavior: 'auto' })
      return
    }
    node.style.scrollSnapType = 'none'
    node.style.scrollBehavior = 'auto'
    const started = performance.now()
    const step = (time: number) => {
      const progress = Math.min(1, (time - started) / TURN_MS)
      node.scrollLeft = from + (target - from) * ENTER(progress)
      if (progress < 1) {
        turn.current = requestAnimationFrame(step)
        return
      }
      turn.current = 0
      node.style.scrollSnapType = ''
      node.style.scrollBehavior = ''
    }
    turn.current = requestAnimationFrame(step)
  }

  const railed = listings.length > 0
  // Page dots (DESIGN-V2 §8.1, M18): one per view of cards, as the rail measured itself; the lit one is the view
  // scrolled to, or the last view once the rail is at its end. Decoration only: the arrows and the rail itself are
  // what a person and assistive technology use.
  const views = edges.perView > 0 ? Math.ceil(listings.length / edges.perView) : 0
  const lit = edges.end && !edges.start ? views - 1 : Math.min(views - 1, edges.page)
  const dots = (place: 'bar' | 'rail') =>
    railed && views > 1 ? (
      <span aria-hidden="true" className="dm-mkt-dots" data-place={place}>
        {Array.from({ length: views }, (_, index) => (
          <span key={index} className="dm-mkt-dot" data-lit={index === lit ? '' : undefined} />
        ))}
      </span>
    ) : null
  const navigation = railed && (
    <div className="dm-mkt-nav">
      {dots('bar')}
      <div className="dm-mkt-arrows">
        {/* Changed on purpose 2026-10-30 (QA round 2, N86): aria-disabled at the rail's ends, as the approved prototype does,
            never disabled: an arrow disabled while it had the keyboard's focus dropped that focus to the page. A press at
            an end does nothing, as before. */}
        <IconButton label="Previous pools" icon={<IconChevronLeft />} variant="round" aria-controls="market-rail" aria-disabled={edges.start || undefined} onClick={() => { if (!edges.start) scrollPage(-1) }} />
        <IconButton label="Next pools" icon={<IconChevronRight />} variant="round" aria-controls="market-rail" aria-disabled={edges.end || undefined} onClick={() => { if (!edges.end) scrollPage(1) }} />
      </div>
    </div>
  )
  return (
    <>
      {heading !== null && <div className="dm-mkt-titlebar">
        <div className="min-w-0 animate-rise">{heading}</div>
        {navigation}
      </div>}
      {unsettled && (
        <div className="dm-mkt-rail" aria-hidden="true" data-featured-pending="">
          {[0, 1, 2].map((index) => (
            <div key={index} className="dm-plate dm-dots-chart dm-mkt-card">
              <div className="dm-mkt-card-head">
                <span className="dm-skel dm-mkt-skel-unit" />
                <span className="dm-skel dm-mkt-skel-tvl" />
              </div>
              <div className="dm-mkt-card-price">
                <span className="dm-skel dm-mkt-skel-close" />
                <span className="dm-skel dm-mkt-skel-delta" />
                <span className="dm-skel dm-mkt-skel-unit" />
              </div>
            </div>
          ))}
        </div>
      )}
      {railed && (
        <div id="market-rail" ref={rail} role="region" aria-label={featured.source === 'server' ? 'Top pools, last 24 hours' : 'Selected pools, last 24 hours'} className="dm-mkt-rail" onScroll={onScroll}
          data-featured-list-id={listed ? featured.listId ?? undefined : undefined}
          data-featured-revision={listed ? featured.revision ?? undefined : undefined}
          data-featured-selection-date={listed ? featured.selectionDate ?? undefined : undefined}
          data-featured-effective-at={listed ? featured.effectiveAt ?? undefined : undefined}>
          {listings.map((listing, index) => {
            const ask = asks[index] ?? null
            const own = ask ? reads.get(ask.key) : undefined
            // A card moved to the chain line keeps drawing what the provider gave it until its own answer lands.
            const earlier = own === undefined && mode === 'chain' && listing.market ? cardAsk(listing.market, 'provider') : null
            const answer = own ?? (earlier ? reads.get(earlier.key) : undefined)
            // An answer is on its way while the capabilities are unread, and while an asking card has none yet.
            const expecting = listing.market !== undefined && (mode === null || (ask !== null && answer === undefined))
            const series = pickSeries({ market: listing.market, settled, answer, expecting, now })
            return <MarketCard key={listing.poolId} listing={listing} index={index} now={now} series={series} />
          })}
        </div>
      )}
      {heading === null && <div className="dm-mkt-footer-nav">{navigation}</div>}
      {dots('rail')}
    </>
  )
}
