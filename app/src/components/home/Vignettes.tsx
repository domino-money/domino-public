import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode, Ref } from 'react'
import { cx } from '../ui'

/*
 * Domino's feature vignettes (DESIGN.md F.2 to F.4): small looping drawings
 * of what automation does with earned fees, and of Auto-exit closing a
 * position at its range's edge (2026-10-06, in Non-custodial's place).
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
  kind: 'compound' | 'seq' | 'exit'
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

/** Auto-exit's price, inside the range until it reaches the range's top edge at (198, 104) (also the moving tip's offset-path in art.css). */
const EXIT_PRICE = 'M 40 138 L 58 133 L 76 138 L 96 129 L 114 133 L 134 123 L 152 127 L 168 117 L 184 112 L 198 104'
/** The tokens' hop from the edge to the wallet's pocket (also the drops' offset-path in art.css). */
const EXIT_HOP = 'M 202 98 C 216 66, 262 60, 283 99'

/**
 * Auto-exit (Added 2026-10-06, the owner's point 5; rugged97: "when the price hits the edge of the range we close the
 * position automatically and send the tokens to the wallet"): the price climbs inside the range; at its top edge the
 * tip's ring pulses, the range empties, two drops (the two tokens) hop to the wallet and settle in its pocket, and the
 * wallet's pocket answers. The position's tile stays standing on its range (its NFT stays in the wallet). The resting
 * picture is the end of the story: the price at the edge, the range empty, the tokens in the wallet.
 */
export function VignetteExit({ className, running }: VignetteProps) {
  const [ref, seen] = useInView<SVGSVGElement>(0.4, running === undefined)
  return (
    <Frame kind="exit" className={className} live={running ?? seen} svgRef={ref}>
      <g className="scene">
        <rect className="band" x={34} y={104} width={180} height={44} rx={10} />
        <rect className="band-fill" x={34} y={104} width={180} height={44} rx={10} />
        <line className="edge" x1={34} y1={104} x2={214} y2={104} />
        <path className="hop" d={EXIT_HOP} />
        <path className="price" d={EXIT_PRICE} pathLength={100} />
        <g className="tip-rest">
          <circle className="tip-ring" cx={198} cy={104} r={8} />
          <circle className="tip-core" cx={198} cy={104} r={4} />
        </g>
        <g className="tip">
          <circle className="tip-ring" cx={0} cy={0} r={8} />
          <circle className="tip-core" cx={0} cy={0} r={4} />
        </g>
        <g transform="translate(70 65.5)">
          <g className="tile-solid">
            <ArtTile w={22} layout={[1, 2]} />
          </g>
        </g>
        <g transform="translate(232 78)">
          <rect className="wallet-card" x={8} y={-8} width={46} height={18} rx={5} />
          <rect className="wallet-body" width={70} height={48} rx={11} />
          <path className="wallet-pocket" d="M 70 15 H 46 A 8 8 0 0 0 38 23 V 25 A 8 8 0 0 0 46 33 H 70" />
          <circle className="pocket-ring" cx={55} cy={24} r={7} />
          <circle className="coin coin-1" cx={51} cy={24} r={3.5} />
          <circle className="coin coin-2" cx={60} cy={24} r={3.5} />
        </g>
        {[1, 2].map((n) => (
          <g key={n} className={`drop drop-${n}`}>
            <circle className="drop-dot" cx={0} cy={0} r={3.5} />
          </g>
        ))}
      </g>
    </Frame>
  )
}

/**
 * Auto-exit's still thumb for Automate's card (in the plain position's thumb's frame, components/automate/ModeArt.tsx
 * PlainArt): the range with its tile, and the tokens' hop out of its top edge to the wallet. No motion.
 */
export function ExitThumb({ className }: { className?: string }) {
  return (
    <svg className={cx('dm-art dm-exit-thumb', className)} width="3.5rem" height="2rem" viewBox="0 0 56 32" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">
      <rect className="band" x={2} y={24.5} width={32} height={7} rx={3.5} />
      <g transform="translate(9 7)">
        <g className="tile-solid">
          <ArtTile w={10} layout={[1, 2]} />
        </g>
      </g>
      <path className="hop" d="M 33 21 C 37 9, 48 8, 51 19" />
      <circle className="tip" cx={33} cy={24.5} r={2} />
      <circle className="coin" cx={51} cy={24} r={2.4} />
    </svg>
  )
}
