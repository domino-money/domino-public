import type { CSSProperties } from 'react'
import { useSvgId } from '../charts/series'
import { cx } from '../ui'
import { ArtTile, useInView } from './Vignettes'

/*
 * The hero's horizon (DESIGN-V2 §7.1-2a): a run of domino tiles across the
 * whole plate, standing on a ground that climbs two steps at the right, the
 * Domino-compound staircase. The run topples left to right and settles as a
 * real chain does, each tile leaning on the next; the last one leans on the
 * first step, the tile on that step tips toward the second, and a new tile
 * rises one step higher: the fees of one position opening the next one up.
 *
 * Only shapes: no text, no digits, no title, no image, no colour literal (every
 * colour is a token in art.css). The static frame (and the stilled one) is the
 * whole composition: every tile standing, the new tile on the top step.
 *
 * The loop is 12 s on one shared timeline: every moving part runs its own
 * keyframes in art.css with the same duration and delay, so the whole chain
 * resets at once and nothing drifts out of phase. Tile N of the run plays
 * `dm-hero-tip-N`, which holds its moment to tip and its resting angle; a
 * fallen tile's face warms to a tint, and only the new tile is fully lit. The
 * two halves of a tile always carry different pip counts, and no tile uses the
 * brand mark's layout (two above, one below).
 */

/** Top | bottom pip counts, left to right: 18 on the ground, one on each step. */
const CHAIN: ReadonlyArray<readonly [number, number]> = [
  [1, 3], [2, 0], [3, 1], [0, 2], [2, 3], [1, 0], [3, 2], [0, 1], [0, 3],
  [3, 2], [1, 2], [3, 0], [0, 2], [2, 3], [1, 0], [3, 1], [2, 0], [0, 3],
  [1, 2], [3, 1],
]

/** A tile is 36 × 63 (1:1.75); the ground is at y 176, step 1 at 152 (x 900–1040), step 2 at 128 (x 1040–1200). */
const W = 36
const H = 63
const GROUND = 176
const STEP_1 = 152
const STEP_2 = 128

/**
 * The run: 18 tiles on the ground and the one on the first step. Where each
 * comes to rest and when it tips live in its keyframes (art.css): a uniform
 * chain 46 apart settles where cos θ = 36 / 46 (38.5°), each tile near the
 * step leans a little more, and the last ones lean on the steps' corners.
 */
const RUN = 19

const vars = (values: Record<string, string | number>) => values as CSSProperties

/** One tile of the run: its contact shadow stays on the ground while the tile tips about its front foot. */
function ChainTile({ index, x, y }: { index: number; x: number; y: number }) {
  return (
    <g className="stand dm-art-enter" transform={`translate(${x} ${y})`} style={vars({ '--i': index })}>
      <ellipse className="shadow" cx={W / 2} cy={H} rx={14} ry={2} />
      <g className="tip" style={{ animationName: `dm-hero-tip-${index}` }}>
        <ArtTile w={W} layout={CHAIN[index]} parts="outline" />
      </g>
    </g>
  )
}

/**
 * The drawing keeps the right end (the staircase) in view at every width and
 * crops the run from the left, where it fades out. `running` forces the loop
 * on or off; by default it plays while at least 30% of the drawing is in view.
 */
export function HeroArt({ className, running }: { className?: string; running?: boolean }) {
  const [ref, seen] = useInView<SVGSVGElement>(0.3, running === undefined)
  const glow = useSvgId('dm-hero-glow')
  const rise = useSvgId('dm-hero-steps')
  return (
    <svg
      ref={ref}
      className={cx('dm-art dm-hero-art', (running ?? seen) && 'is-running', className)}
      viewBox="0 0 1200 192"
      preserveAspectRatio="xMaxYMax slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id={glow} cx="50%" cy="50%" r="50%">
          <stop offset="0%" className="glow-0" />
          <stop offset="100%" className="glow-1" />
        </radialGradient>
        <linearGradient id={rise} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="steps-0" />
          <stop offset="100%" className="steps-1" />
        </linearGradient>
      </defs>
      {/* The warmth under the staircase: it glows brighter as the new tile arrives. */}
      <ellipse className="warm" cx={1110} cy={150} rx={230} ry={76} fill={`url(#${glow})`} />
      <path className="steps" d={`M900 192 V${STEP_1} H1040 V${STEP_2} H1200 V192 Z`} fill={`url(#${rise})`} />
      <path className="ground" d={`M0 ${GROUND} H900 V${STEP_1} H1040 V${STEP_2} H1200`} />
      <g className="chain">
        {Array.from({ length: RUN - 1 }, (_, index) => (
          <ChainTile key={index} index={index} x={24 + 46 * index} y={GROUND - H} />
        ))}
        {/* The tile on the first step tips until it leans on the second step's corner. */}
        <ChainTile index={RUN - 1} x={952} y={STEP_1 - H} />
      </g>
      {/* Where the new tile will stand, while it is away. */}
      <rect className="ghost" x={1102} y={STEP_2 - H} width={W} height={H} rx={W * 0.14} />
      <g className="stand dm-art-enter" transform={`translate(1102 ${STEP_2 - H})`} style={vars({ '--i': RUN })}>
        <g className="next tile-solid">
          <ellipse className="shadow" cx={W / 2} cy={H} rx={14} ry={2} />
          <ArtTile w={W} layout={CHAIN[CHAIN.length - 1]} />
        </g>
      </g>
    </svg>
  )
}
