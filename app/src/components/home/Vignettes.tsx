import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode, Ref } from 'react'
import { cx } from '../ui'

/*
 * Domino's feature vignettes (DESIGN.md F.2 to F.4): small looping drawings
 * of what automation does with earned fees, and of who holds the position.
 * Each one is only shapes: no text, no digits, no title, no image and no
 * colour literal (every colour is a token in art.css). A tile always stands on
 * an edge; nothing is drawn behind a tile, and no tile uses the brand mark's
 * pip layouts. A path that something travels along is written once here and
 * once, identically, in art.css.
 *
 * The drawing is the caller's to frame: Home puts each one on a dotted plate,
 * Automate on its own card. A loop plays only while the drawing is in view,
 * and its resting frame is a complete picture.
 */

export interface VignetteProps {
  className?: string
  /** Forces the loop on or off. By default it plays while at least 40% of the drawing is in view. */
  running?: boolean
}

const visibleDocument = () => typeof document === 'undefined' || !document.hidden
const serverVisibility = () => true
function subscribeVisibility(onChange: () => void) {
  if (typeof document === 'undefined') return () => undefined
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

/**
 * Whether at least `threshold` of the element is in view in a visible tab.
 * Hidden tabs pause the existing CSS timeline; returning resumes it without
 * resetting the drawing. Nothing is observed while `enabled` is false.
 */
export function useInView<T extends Element>(threshold: number, enabled = true) {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  const visible = useSyncExternalStore(subscribeVisibility, visibleDocument, serverVisibility)
  useEffect(() => {
    const node = ref.current
    if (!enabled || !node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (entry) setInView(entry.isIntersecting && entry.intersectionRatio >= threshold - 0.01)
      },
      { threshold: [0, threshold] },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [threshold, enabled])
  return [ref, enabled && inView && visible] as const
}

const round = (value: number) => Math.round(value * 1000) / 1000

/**
 * Pip centres for one half of a tile `w` wide (the half box is w × 0.875w),
 * starting at `top`: 1 is the centre; 2 the rising diagonal; 3 both plus the centre.
 */
export function tilePips(w: number, count: number, top: number): Array<[number, number]> {
  const half = w * 0.875
  const centre: [number, number] = [round(w / 2), round(top + half / 2)]
  const upper: [number, number] = [round(w * 0.75), round(top + half * 0.27)]
  const lower: [number, number] = [round(w * 0.25), round(top + half * 0.73)]
  if (count === 1) return [centre]
  if (count === 2) return [upper, lower]
  if (count === 3) return [upper, centre, lower]
  return []
}

/**
 * One domino tile at the origin: body w × 1.75w, corner radius 0.14w, the
 * divider at half height inset 0.15w each side, pips of radius 0.075w.
 * `solid` parts are styled by a `tile-solid` ancestor (Tangerine with
 * --primary-fg pips); `outline` parts are the hero's own classes.
 */
export function ArtTile({ w, layout, parts = 'solid' }: { w: number; layout: readonly [number, number]; parts?: 'solid' | 'outline' }) {
  const h = w * 1.75
  const names = parts === 'solid' ? { body: 't-body', divider: 't-div', pip: 't-pip' } : { body: 'body', divider: 'divider', pip: 'pip' }
  const pips = [...tilePips(w, layout[0], 0), ...tilePips(w, layout[1], h / 2)]
  return (
    <>
      <rect className={names.body} width={w} height={round(h)} rx={round(w * 0.14)} />
      <line className={names.divider} x1={round(w * 0.15)} y1={round(h / 2)} x2={round(w * 0.85)} y2={round(h / 2)} />
      {pips.map(([x, y], index) => (
        <circle key={index} className={names.pip} cx={x} cy={y} r={round(w * 0.075)} />
      ))}
    </>
  )
}

function Frame({ kind, className, live, still = false, svgRef, children }: {
  kind: 'compound' | 'seq' | 'wallet'
  className?: string
  live: boolean
  still?: boolean
  svgRef?: Ref<SVGSVGElement>
  children: ReactNode
}) {
  return (
    <svg
      ref={svgRef}
      className={cx('dm-art dm-vig', `dm-vig-${kind}`, live && 'is-running', still && 'dm-vig-still', className)}
      viewBox="0 0 320 200"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

const ARC = 'M 110 110 C 110 44, 210 44, 210 110'

/**
 * Auto-compound: earned fees leave the position, arc over and fall back into
 * the same range, which fills a little from the bottom each time. The
 * position's tile stands on the range, never inside it.
 */
export function VignetteCompound({ className, running }: VignetteProps) {
  const [ref, seen] = useInView<SVGSVGElement>(0.4, running === undefined)
  return (
    <Frame kind="compound" className={className} live={running ?? seen} svgRef={ref}>
      <g className="vig">
        <rect className="band" x={70} y={112} width={180} height={44} rx={10} />
        {/* The fill is clipped to the band's rounded shape by CSS; the empty rect fixes the clip's box. */}
        <g className="band-clip">
          <rect x={70} y={112} width={180} height={44} fill="none" />
          <rect className="band-fill" x={70} y={112} width={180} height={44} />
        </g>
        <rect className="band-edge" x={70} y={112} width={180} height={44} rx={10} />
        <path className="arc" d={ARC} />
        <line className="lip" x1={110} y1={106} x2={110} y2={112} />
        <line className="lip" x1={210} y1={106} x2={210} y2={112} />
        <g transform="translate(151 80.5)">
          <g className="mark tile-solid">
            <ArtTile w={18} layout={[3, 1]} />
          </g>
        </g>
        {/* Each drop travels on its group and grows on its own circle: a scale on the travelling
            element would also scale its distance along the arc and pull it off the route. */}
        {[1, 2, 3].map((n) => (
          <g key={n} className={`drop drop-${n}`}>
            <circle className="drop-dot" cx={0} cy={0} r={3.5} />
          </g>
        ))}
      </g>
    </Frame>
  )
}

/** Range A: its top edge runs on under range B, so its top-right corner is square. */
const RANGE_A = 'M 40 134 H 290 V 162 A 10 10 0 0 1 280 172 H 40 A 10 10 0 0 1 30 162 V 144 A 10 10 0 0 1 40 134 Z'
/** Range B's left, top and right edges; its floor is range A's top edge. */
const RANGE_B = 'M 160 134 V 106 A 10 10 0 0 1 170 96 H 280 A 10 10 0 0 1 290 106 V 134'
/** The price's route (also the moving tip's offset-path in art.css). Its trigger, (152, 140), is 55.69% along it. */
const PRICE = 'M 40 162 L 60 157 L 78 159 L 98 151 L 116 153 L 136 146 L 152 140 L 166 142 L 182 131 L 200 122 L 218 123 L 236 112'
/** The fees' hop from range A's top to range B's top (also the drops' offset-path in art.css). */
const HOP = 'M 136 132 C 136 96, 176 70, 204 94'

/**
 * One staircase: range A, and range B one step higher standing on it, each with
 * its tile; the price line from A into B, the tip where it rests, and the
 * dotted hop the fees take from A's top to B's. The still frame leaves out the
 * parts that only move (the moving tip, the fees and B's ghost), all hidden at rest.
 */
function SequenceDrawing({ still }: { still: boolean }) {
  return (
    <g className="scene">
      <path className="range-a" d={RANGE_A} />
      {/* Where range B will stand, while it is away. */}
      {!still && <path className="range-b-ghost" d={RANGE_B} />}
      <g className="range-b">
        <path className="range-b-fill" d={`${RANGE_B} Z`} />
        <path className="range-b-edge" d={RANGE_B} />
      </g>
      <path className="price" d={PRICE} pathLength={100} />
      <g className="tip-rest">
        <circle className="tip-ring" cx={236} cy={112} r={8} />
        <circle className="tip-core" cx={236} cy={112} r={4} />
      </g>
      {/* The tip that rides the price's route while the line draws; its ring pulses about its own centre. */}
      {!still && (
        <g className="tip">
          <circle className="tip-ring" cx={0} cy={0} r={8} />
          <circle className="tip-core" cx={0} cy={0} r={4} />
        </g>
      )}
      <path className="hop" d={HOP} />
      <line className="lip" x1={136} y1={128} x2={136} y2={134} />
      <line className="lip" x1={204} y1={90} x2={204} y2={96} />
      <g transform="translate(63 95.5)">
        <g className="tile-solid">
          <ArtTile w={22} layout={[3, 2]} />
        </g>
      </g>
      <g transform="translate(248 57.5)">
        <g className="rise tile-solid">
          <ArtTile w={22} layout={[1, 3]} />
        </g>
      </g>
      {!still &&
        [1, 2, 3].map((n) => (
          <g key={n} className={`drop drop-${n}`}>
            <circle className="drop-dot" cx={0} cy={0} r={3.5} />
          </g>
        ))}
    </g>
  )
}

/**
 * Domino Compounder: the price climbs inside range A; near its top edge the
 * tip's ring pulses, three drops of earned fees hop up, range B lights one
 * step higher, its tile rises, and the price carries on inside B. Range A and
 * its tile never move, and only fees travel.
 */
export function VignetteSequence({ className, running }: VignetteProps) {
  const [ref, seen] = useInView<SVGSVGElement>(0.4, running === undefined)
  return (
    <Frame kind="seq" className={className} live={running ?? seen} svgRef={ref}>
      <SequenceDrawing still={false} />
    </Frame>
  )
}

/** The staircase at rest, with no motion at all, for a screen that draws the next range beside real ticks. */
export function SequenceFrame({ className }: { className?: string }) {
  return (
    <Frame kind="seq" className={className} live={false} still>
      <SequenceDrawing still />
    </Frame>
  )
}

/** The signature stroke's outline: about 3 wide at the wallet, tapering to 1.6 at the range, never to a point. */
const SWASH = 'M 116 98.4 C 146 89.4, 172 135.2, 202 122.2 L 202 123.8 C 172 136.8, 146 94.6, 116 101.6 Z'
/** The stroke's centre line, which the highlight is traced along. */
const TRACE = 'M 121 100 C 146 92, 172 136, 200 123'

/**
 * Non-custodial: the owner's wallet signs, and one stroke carries that control,
 * one way only, to the position: its tile standing on its range. Once a cycle
 * the wallet's seal rings, a highlight writes along the stroke, the range's
 * edge lights and the tile answers; then a long rest. Nothing travels back,
 * and there is no badge: nothing here verifies who controls a wallet.
 */
export function VignetteWallet({ className, running }: VignetteProps) {
  const [ref, seen] = useInView<SVGSVGElement>(0.4, running === undefined)
  return (
    <Frame kind="wallet" className={className} live={running ?? seen} svgRef={ref}>
      {/* Drawn first, so both ends of the stroke tuck under the wallet and the range. */}
      <path className="swash" d={SWASH} />
      <path className="trace" d={TRACE} pathLength={100} />
      <g transform="translate(28 68)">
        <rect className="wallet-card" x={10} y={-9} width={62} height={22} rx={6} />
        <rect className="wallet-body" width={92} height={62} rx={12} />
        <path className="wallet-pocket" d="M 92 21 H 66 A 8 8 0 0 0 58 29 V 35 A 8 8 0 0 0 66 43 H 92" />
        <circle className="seal-ring" cx={71} cy={32} r={6} />
        <circle className="seal" cx={71} cy={32} r={3.5} />
      </g>
      <rect className="band" x={200} y={104} width={92} height={38} rx={10} />
      <rect className="band-lit" x={200} y={104} width={92} height={38} rx={10} />
      <g transform="translate(235 65.5)">
        <g className="pos tile-solid">
          <ArtTile w={22} layout={[2, 3]} />
        </g>
      </g>
    </Frame>
  )
}
