import { useEffect, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import { cx } from '../ui'

/*
 * Domino's feature vignettes (DESIGN.md F.2 to F.4): small looping drawings
 * of what automation does with earned fees. Each one is only shapes: no text,
 * no digits, no title, no image and no colour literal (every colour is a token
 * in art.css). A tile always stands on an edge or rests in the wallet; nothing
 * is drawn behind a tile, and no tile uses the brand mark's pip layouts.
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

/**
 * Whether at least `threshold` of the element is in view, from an
 * IntersectionObserver. Nothing is observed while `enabled` is false.
 */
export function useInView<T extends Element>(threshold: number, enabled = true) {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
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
  return [ref, inView] as const
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

/** Range A, the price line climbing to its trigger, and range B one step higher with its own tile. */
function SequenceDrawing() {
  return (
    <g className="scene">
      <rect className="range-a" x={40} y={104} width={150} height={56} rx={10} />
      <line className="trigger" x1={44} y1={114} x2={186} y2={114} />
      <g className="arrive">
        <rect className="range-b" x={150} y={60} width={150} height={56} rx={10} />
        <g transform="translate(158 28.5)">
          <g className="tile-solid">
            <ArtTile w={18} layout={[1, 3]} />
          </g>
        </g>
      </g>
      <polyline className="price" points="44,150 62,142 78,146 96,134 112,138 128,126 146,128 162,118 176,116" />
      <g className="dot">
        <circle className="dot-ring" cx={176} cy={116} r={8} />
        <circle className="dot-core" cx={176} cy={116} r={4} />
      </g>
    </g>
  )
}

/**
 * Domino sequences: the price climbs inside a range; near its top edge the
 * trigger lights and the next range appears one step higher with its own tile.
 * The first range stays where it is.
 */
export function VignetteSequence({ className, running }: VignetteProps) {
  const [ref, seen] = useInView<SVGSVGElement>(0.4, running === undefined)
  return (
    <Frame kind="seq" className={className} live={running ?? seen} svgRef={ref}>
      <SequenceDrawing />
    </Frame>
  )
}

/** The sequence drawing at rest, with no motion at all (New position's automation step). */
export function SequenceFrame({ className }: { className?: string }) {
  return (
    <Frame kind="seq" className={className} live={false} still>
      <SequenceDrawing />
    </Frame>
  )
}

/**
 * Non-custodial: the position is a tile resting in its owner's wallet, under a
 * slow dotted orbit; the wallet's flap lights once a cycle as it closes on the
 * tile. No check mark: nothing here verifies who controls a wallet.
 */
export function VignetteWallet({ className, running }: VignetteProps) {
  const [ref, seen] = useInView<SVGSVGElement>(0.4, running === undefined)
  return (
    <Frame kind="wallet" className={className} live={running ?? seen} svgRef={ref}>
      {/* pathLength makes the dash pattern close without a seam. */}
      <circle className="orbit" cx={160} cy={104} r={70} pathLength={441} />
      <g transform="translate(149 60)">
        <g className="bob tile-solid">
          <ArtTile w={22} layout={[2, 3]} />
        </g>
      </g>
      <g transform="translate(112 96)">
        <rect className="w-body" width={96} height={64} rx={12} />
        <path className="flap" d="M0 20 H96" />
        <rect className="clasp" x={70} y={30} width={26} height={16} rx={8} />
        <circle className="clasp-dot" cx={83} cy={38} r={3} />
      </g>
    </Frame>
  )
}
