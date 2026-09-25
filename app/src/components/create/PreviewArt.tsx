import type { CSSProperties } from 'react'
import { useSvgId } from '../charts/series'
import { ArtTile, useInView } from '../home/Vignettes'
import { cx } from '../ui'

/*
 * New position's picture before a pool is chosen (owner, 2026-09-24): what a
 * position is, drawn rather than said. A price wanders across a price band;
 * inside the band its line is Tangerine and fee pips rise from it, and where
 * it leaves the band the line goes quiet and nothing rises. A domino tile,
 * the position, stands on the band. The line ends in the price's dot with a
 * dotted line on to the edge: the price now.
 *
 * Only shapes: no text, no digits, no figure, no axis, no colour literal
 * (every colour is a token in flow.css), so nothing here can be read as data.
 * The static frame (and the stilled one: reduced motion, Pause motion) is the
 * whole composition: the line drawn, the fee pips risen over the stretch in
 * the band, the tip at the line's end, so every part the legend names is in
 * it. The loop is one 10 s timeline shared by every moving part and plays
 * only while the picture is in view: the picture holds, fades, the line is
 * drawn again from the left with the tip riding its head (grey outside the
 * band), each pip rises again where the tip passes it inside the band and
 * settles, and the picture holds again. The tile follows DESIGN-V2 §0.4:
 * 1:1.75, a divider, unequal pip counts, never the mark's.
 */

/** The price's path through the view box (400 × 216), a monotone cubic through 20 hand-set points (lib/chart/paths linePath). */
const PRICE =
  'M0 120 C7.33 118.67 14.67 118.33 22 116 C29.33 113.67 36.67 110.6 44 106 C50.67 101.82 57.33 96 64 90 C70 84.6 76 76.67 82 72 C88 67.33 94 62 100 62 C106 62 112 62.67 118 66 C124 69.33 130 76 136 82 C142 88 148 96.67 154 102 C160 107.33 166 114 172 114 C178.67 114 185.33 113 192 112 C198.67 111 205.33 108 212 108 C218.67 108 225.33 113.37 232 118 C238 122.17 244 128.33 250 134 C255.33 139.04 260.67 146.33 266 150 C271.33 153.67 276.67 156 282 156 C287.33 156 292.67 150.67 298 146 C303.33 141.33 308.67 133.33 314 128 C319.33 122.67 324.67 117.33 330 114 C335.33 110.67 340.67 110 346 108'

/** The band: the price range, 84 to 140. The path leaves it above (x 70–138) and below (x 256–304). */
const BAND = { top: 84, bottom: 140 }
const END = { x: 346, y: 108 }
/** The tile (16 × 28) stands on the band's top edge, over the part of the path that stays inside. */
const TILE = { x: 192, w: 16 }

/** A path of absolute M and C commands only (its numbers alternate x, y), moved by dx, dy. */
function moved(d: string, dx: number, dy: number): string {
  let index = 0
  return d.replace(/-?\d+(?:\.\d+)?/g, (n) => String(Math.round((Number(n) + (index++ % 2 ? dy : dx)) * 100) / 100))
}

/**
 * The tip's route: PRICE moved so that it ends at 0,0. The tip's group stands at END, so at rest (offset-distance
 * 100%) the route moves it by nothing: the resting dot never depends on offset-path on an SVG element (the home
 * vignettes' rule), and only the loop uses the route.
 */
const ROUTE = moved(PRICE, -END.x, -END.y)

/**
 * The fee pips, on the path inside the band. They are drawn risen and settled (flow.css .pip-1 to .pip-4: how far
 * each has risen, how strongly it rests, and its own keyframes). In the loop the tip passes each at 15.5% + 66.5% ×
 * its share of the path's length (the draw runs from 15.5% to 82% of the loop), so at 46.6%, 50.1%, 58.1% and 77.7%,
 * where its keyframes make it rise again. The shares (0.4682, 0.5208, 0.6408, 0.935) and the band crossings that
 * flow.css times the tip's ink by (0.1925, 0.3915, 0.73, 0.871) were measured on PRICE with getPointAtLength; a
 * changed PRICE needs both measured again.
 */
const PIPS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 160, y: 107.5 },
  { x: 180, y: 113.6 },
  { x: 228, y: 115.2 },
  { x: 322, y: 120.2 },
]

const vars = (values: Record<string, string>) => values as CSSProperties

export function PreviewArt({ className }: { className?: string }) {
  const [ref, seen] = useInView<SVGSVGElement>(0.3)
  const inside = useSvgId('dm-flow-pv-art-inside')
  const across = useSvgId('dm-flow-pv-art-across')
  const edge = useSvgId('dm-flow-pv-art-edge')
  const width = TILE.w * 1.75
  return (
    <svg
      ref={ref}
      className={cx('dm-art dm-flow-pv-art', seen && 'is-running', className)}
      viewBox="0 0 400 216"
      // A narrow card crops the picture's sides from the left, where the line only fades in, so the tip and the
      // price now stay clear of the right-hand fade down to a 320 px screen. A wide card crops no side.
      preserveAspectRatio="xMaxYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* The band fades in and out at the picture's two ends. */}
        <linearGradient id={across} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" className="band-0" />
          <stop offset="18%" className="band-1" />
          <stop offset="82%" className="band-1" />
          <stop offset="100%" className="band-0" />
        </linearGradient>
        {/* In view-box units: a horizontal line's own box has no height, and a gradient on that box draws nothing. */}
        <linearGradient id={edge} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="400" y2="0">
          <stop offset="0%" className="edge-0" />
          <stop offset="14%" className="edge-1" />
          <stop offset="86%" className="edge-1" />
          <stop offset="100%" className="edge-0" />
        </linearGradient>
        <clipPath id={inside}>
          <rect x={0} y={BAND.top} width={400} height={BAND.bottom - BAND.top} />
        </clipPath>
      </defs>

      <rect className="band" x={0} y={BAND.top} width={400} height={BAND.bottom - BAND.top} fill={`url(#${across})`} />
      <line className="edge" x1={0} y1={BAND.top} x2={400} y2={BAND.top} stroke={`url(#${edge})`} />
      <line className="edge" x1={0} y1={BAND.bottom} x2={400} y2={BAND.bottom} stroke={`url(#${edge})`} />

      {/* The price: quiet everywhere, Tangerine (with its glow) where the band clips it. */}
      <g className="price">
        <path className="line line-out" d={PRICE} pathLength={100} />
        <g clipPath={`url(#${inside})`}>
          <path className="line line-glow" d={PRICE} pathLength={100} />
          <path className="line line-in" d={PRICE} pathLength={100} />
        </g>
      </g>
      <line className="now" x1={END.x + 8} y1={END.y} x2={400} y2={END.y} />

      {PIPS.map((pip, index) => (
        <g key={index} transform={`translate(${pip.x} ${pip.y})`}>
          <circle className={`pip pip-${index + 1}`} r={2.75} />
        </g>
      ))}

      {/* The position: a tile standing on the band, its shadow on the band's edge. */}
      <ellipse className="shadow" cx={TILE.x + TILE.w / 2} cy={BAND.top} rx={9} ry={1.6} />
      <g transform={`translate(${TILE.x} ${BAND.top - width})`}>
        <g className="tile tile-solid">
          <ArtTile w={TILE.w} layout={[1, 3]} />
        </g>
      </g>

      {/* The tip stands at the line's end; in the loop it travels the route (offset-path, in its group's space). */}
      <g transform={`translate(${END.x} ${END.y})`}>
        <g className="tip" style={vars({ offsetPath: `path('${ROUTE}')` })}>
          <circle className="tip-ring" r={4.5} />
          <circle className="tip-core" r={4.5} />
        </g>
      </g>
    </svg>
  )
}
