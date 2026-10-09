import { useId } from 'react'
import type { CSSProperties } from 'react'
import { ArtTile, useInView } from '../home/Vignettes'
import { cx } from '../ui'
import { rem } from '../../lib/rootScale'

/*
 * The two automation modes as machines (DESIGN-V2 §14, automate.md §5.1):
 *
 * - Auto-compound, one band: earned fees wait in a small stack at the band's
 *   edge, arc over the position's tile and fall back into the same band, which
 *   fills a notch as each lands; the tile answers each one. Then new fees gather.
 * - Domino-compound, a staircase: the price climbs range A to its trigger, the
 *   fees hop up to range B, B lights and its tile rises while A's tile tips
 *   forward and back (the domino nudge); the price carries on inside B. C, the
 *   cap's next step, waits dashed.
 *
 * Only shapes: no text, digits, `%` or <title>. Tiles keep the 1:1.75 body, a
 * divider across the short axis and unequal pips, never the mark's layouts,
 * and are never smaller than 14 × 24.5. Every colour is a token (automate.css);
 * paint servers are attributes with ids from useId. The resting frame is the
 * complete picture: the static CSS and the first and last keyframe of every
 * loop draw it, so a paused, stilled or not-yet-running drawing shows it.
 *
 * `play`: `loop` runs while at least 40% is in view (never inside a clickable
 * element), `once` one short run (a mode card that was just chosen), `none`
 * the resting frame. `thumb` is always still. The keyframes live in
 * automate.css; a travelling fee rides its own path, set here as the element's
 * offset-path so each route is written once.
 */

export type ModeArtMode = 'compound' | 'domino'
export type ModeArtSize = 'stage' | 'card' | 'thumb'
type Play = 'loop' | 'once' | 'none'

/** The drawing's box per size: the Automate stage (both ground lines at y 236), a mode card or plate, a thumbnail. */
const BOX: Record<ModeArtSize, { width: number; height: number }> = {
  stage: { width: 400, height: 300 },
  card: { width: 240, height: 100 },
  thumb: { width: 56, height: 32 },
}

const route = (d: string) => ({ offsetPath: `path('${d}')` }) as CSSProperties

/** The ground both machines stand on, fading out at its ends. */
export function Ground({ id, at }: { id: string; at: readonly [number, number, number] }) {
  return (
    <>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" className="g-edge" />
          <stop offset="0.5" className="g-mid" />
          <stop offset="1" className="g-edge" />
        </linearGradient>
      </defs>
      <rect className="ground" x={at[0]} y={at[1]} width={at[2]} height={1} fill={`url(#${id})`} />
    </>
  )
}

/* ---- Auto-compound ------------------------------------------------------------------------ */

interface CompoundGeometry {
  ground: readonly [number, number, number]
  band: { x: number; y: number; w: number; h: number; r: number }
  wave: string
  tile: { x: number; y: number; w: number }
  /** The waiting fees, top first (the first to leave), stacked on the band's top edge at the arc's right foot. */
  stack: readonly number[]
  /** The arc from the band back into the band: from its right foot (the stack) over the tile to its left foot. */
  from: number
  to: number
  crest: number
  dot: number
}

/* The stage machine is as wide as Domino's staircase (the band spans 84% of the drawing) and the arc stands on the band
   at both feet, so every frame, a stilled one included, reads as a closed loop: out of the position and back into it. */
const COMPOUND: Record<'stage' | 'card', CompoundGeometry> = {
  stage: {
    ground: [8, 235.5, 384],
    band: { x: 32, y: 150, w: 336, h: 86, r: 18 },
    wave: 'M 56 212 C 80 197.6, 99.2 226.4, 128 209.6 S 176 183.2, 204.8 196.4 S 255.2 226.4, 284 206 S 324.8 188, 341.6 192.8',
    tile: { x: 182, y: 87, w: 36 },
    stack: [119, 131, 143],
    from: 330,
    to: 72,
    crest: 34,
    dot: 5.5,
  },
  card: {
    ground: [8, 91.5, 224],
    band: { x: 24, y: 62, w: 192, h: 30, r: 10 },
    wave: 'M 40.8 84 C 55.2 76, 67.2 88, 84 81 S 112.8 71, 129.6 78 S 163.2 88, 180 79 S 196.8 74, 201.6 75',
    tile: { x: 112, y: 34, w: 16 },
    stack: [43, 50.5, 58],
    from: 190,
    to: 50,
    crest: 12,
    dot: 3.5,
  },
}

function CompoundDrawing({ size, id }: { size: 'stage' | 'card'; id: string }) {
  const g = COMPOUND[size]
  const { band, tile } = g
  const top = band.y
  const over = `C ${g.from} ${g.crest}, ${g.to} ${g.crest}, ${g.to} ${top}`
  return (
    <>
      <Ground id={`${id}g`} at={g.ground} />
      <defs>
        <clipPath id={`${id}b`}>
          <rect x={band.x} y={band.y} width={band.w} height={band.h} rx={band.r} />
        </clipPath>
      </defs>
      <rect className="band" x={band.x} y={band.y} width={band.w} height={band.h} rx={band.r} />
      <g clipPath={`url(#${id}b)`}>
        <rect className="band-fill" x={band.x} y={band.y} width={band.w} height={band.h} />
      </g>
      <path className="wave" d={g.wave} />
      <rect className="band-edge" x={band.x} y={band.y} width={band.w} height={band.h} rx={band.r} />
      <rect className="band-lit" x={band.x} y={band.y} width={band.w} height={band.h} rx={band.r} />
      <path className="arc" d={`M ${g.from} ${top} ${over}`} />
      <circle className="foot" cx={g.to} cy={top} r={g.dot * 0.45} />
      <circle className="ripple" cx={g.to} cy={top} r={g.dot + 2.5} />
      <g transform={`translate(${tile.x} ${tile.y})`}>
        <g className="mark tile-solid">
          <ArtTile w={tile.w} layout={[3, 1]} />
        </g>
      </g>
      {g.stack.map((cy, index) => (
        <circle key={index} className={`stack stack-${index + 1}`} cx={g.from} cy={cy} r={g.dot} />
      ))}
      {g.stack.map((cy, index) => (
        <g key={index} className={`drop drop-${index + 1}`} style={route(`M ${g.from} ${cy} ${over}`)}>
          <circle className="drop-dot" cx={0} cy={0} r={g.dot} />
        </g>
      ))}
    </>
  )
}

/* ---- Domino-compound ---------------------------------------------------------------------- */

interface DominoGeometry {
  ground: readonly [number, number, number]
  /** Range A (its top-right corner square: B stands there), then B's and C's left, top and right edges. */
  a: string
  b: string
  c: string
  trigger: readonly [number, number, number]
  /** The price's route (pathLength 100); it meets the trigger 44.5% along (automate.css). */
  price: string
  rest: readonly [number, number]
  hop: string
  tiles: { a: readonly [number, number]; b: readonly [number, number]; c: readonly [number, number]; w: number }
  dot: number
}

const DOMINO: Record<'stage' | 'card', DominoGeometry> = {
  stage: {
    ground: [8, 235.5, 384],
    a: 'M 32 192 H 380 V 224 A 12 12 0 0 1 368 236 H 32 A 12 12 0 0 1 20 224 V 204 A 12 12 0 0 1 32 192 Z',
    b: 'M 140 192 V 160 A 12 12 0 0 1 152 148 H 380 V 192',
    c: 'M 272 148 V 116 A 12 12 0 0 1 284 104 H 368 A 12 12 0 0 1 380 116 V 148',
    trigger: [20, 198, 140],
    price: 'M 36 226 L 54 220 L 72 223 L 92 213 L 108 216 L 124 206 L 136 198 L 150 200 L 166 187 L 184 177 L 202 180 L 222 168 L 240 170 L 260 160',
    rest: [260, 160],
    hop: 'M 136 190 C 136 138, 160 120, 170 144',
    tiles: { a: [62, 139.5], b: [188, 95.5], c: [314, 51.5], w: 30 },
    dot: 5,
  },
  card: {
    ground: [8, 91.5, 224],
    a: 'M 24 72 H 224 V 84 A 8 8 0 0 1 216 92 H 24 A 8 8 0 0 1 16 84 V 80 A 8 8 0 0 1 24 72 Z',
    b: 'M 88 72 V 60 A 8 8 0 0 1 96 52 H 224 V 72',
    c: 'M 156 52 V 40 A 8 8 0 0 1 164 32 H 216 A 8 8 0 0 1 224 40 V 52',
    trigger: [16, 76, 88],
    price: 'M 24 88 L 33 85 L 42 87 L 51 82 L 60 84 L 70 79 L 80 76 L 90 77 L 100 70 L 110 66 L 120 68 L 130 62 L 140 63 L 148 58',
    rest: [148, 58],
    hop: 'M 80 72 C 80 54, 92 46, 98 50',
    tiles: { a: [40, 47.5], b: [112, 27.5], c: [182, 7.5], w: 14 },
    dot: 3,
  },
}

function DominoDrawing({ size, id }: { size: 'stage' | 'card'; id: string }) {
  const g = DOMINO[size]
  const { tiles } = g
  const ring = g.dot + (size === 'stage' ? 4 : 2.5)
  return (
    <>
      <Ground id={`${id}g`} at={g.ground} />
      <path className="ra" d={g.a} />
      <path className="rc" d={`${g.c} Z`} />
      {/* Where B stands while it is away; B itself lights once the fees arrive. */}
      <path className="rb-ghost" d={g.b} />
      <g className="rb">
        <path className="rb-fill" d={`${g.b} Z`} />
        <path className="rb-edge" d={g.b} />
      </g>
      <line className="trigger" x1={g.trigger[0]} y1={g.trigger[1]} x2={g.trigger[2]} y2={g.trigger[1]} />
      <path className="price" d={g.price} pathLength={100} />
      <g className="tip-rest">
        <circle className="tip-ring" cx={g.rest[0]} cy={g.rest[1]} r={ring} />
        <circle className="tip-core" cx={g.rest[0]} cy={g.rest[1]} r={g.dot} />
      </g>
      <g className="tip" style={route(g.price)}>
        <circle className="tip-ring" cx={0} cy={0} r={ring} />
        <circle className="tip-core" cx={0} cy={0} r={g.dot} />
      </g>
      <path className="hop" d={g.hop} />
      <g transform={`translate(${tiles.c[0]} ${tiles.c[1]})`}>
        <g className="ghost">
          <ArtTile w={tiles.w} layout={[0, 3]} parts="outline" />
        </g>
      </g>
      <g transform={`translate(${tiles.a[0]} ${tiles.a[1]})`}>
        <g className="tile-a tile-solid">
          <ArtTile w={tiles.w} layout={[3, 2]} />
        </g>
      </g>
      <g transform={`translate(${tiles.b[0]} ${tiles.b[1]})`}>
        <g className="tile-b tile-solid">
          <ArtTile w={tiles.w} layout={[1, 3]} />
        </g>
      </g>
      {[1, 2, 3].map((n) => (
        <g key={n} className={`drop drop-${n}`} style={route(g.hop)}>
          <circle className="drop-dot" cx={0} cy={0} r={g.dot} />
        </g>
      ))}
    </>
  )
}

/* ---- Thumbnails: still, one tile, the mode's shape ---------------------------------------- */

function Thumb({ mode }: { mode: ModeArtMode }) {
  return mode === 'compound' ? (
    <>
      <rect className="band" x={6} y={24.5} width={44} height={7} rx={3.5} />
      <rect className="band-edge" x={6} y={24.5} width={44} height={7} rx={3.5} />
      <g transform="translate(21 0)">
        <g className="tile-solid">
          <ArtTile w={14} layout={[3, 1]} />
        </g>
      </g>
    </>
  ) : (
    <>
      <rect className="rc" x={40} y={15} width={14} height={5.5} rx={2} />
      <rect className="rb-fill" x={26} y={20.5} width={28} height={5.5} rx={2} />
      <rect className="rb-edge" x={26} y={20.5} width={28} height={5.5} rx={2} />
      <rect className="ra" x={2} y={26} width={52} height={5.5} rx={2.5} />
      <g transform="translate(6 1.5)">
        <g className="tile-solid">
          <ArtTile w={14} layout={[3, 2]} />
        </g>
      </g>
    </>
  )
}

/**
 * Auto-compound or Domino-compound as an illustration. Decoration only:
 * aria-hidden, no text. The stage fills its plate's height; the card and the
 * thumbnail draw at their own size, centred and standing on the bottom edge.
 */
export function ModeArt({ mode, size, play = 'none', className }: { mode: ModeArtMode; size: ModeArtSize; play?: Play; className?: string }) {
  const still = size === 'thumb'
  const [ref, seen] = useInView<SVGSVGElement>(0.4, play === 'loop' && !still)
  const id = `dm-ma-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const box = BOX[size]
  const run = !still && (play === 'once' || (play === 'loop' && seen))
  return (
    <svg
      ref={ref}
      className={cx('dm-art dm-mode-art', run && 'is-running', className)}
      data-mode={mode}
      data-size={size}
      data-play={still ? 'none' : play}
      width={size === 'stage' ? undefined : rem(box.width)}
      height={size === 'stage' ? undefined : rem(box.height)}
      viewBox={`0 0 ${box.width} ${box.height}`}
      preserveAspectRatio="xMidYMax meet"
      aria-hidden="true"
      focusable="false"
    >
      {size === 'thumb' ? <Thumb mode={mode} /> : mode === 'compound' ? <CompoundDrawing size={size} id={id} /> : <DominoDrawing size={size} id={id} />}
    </svg>
  )
}

/**
 * A plain position as a thumbnail beside the two modes' (2026-09-24, the three features side by side): one range with
 * its tile standing on it, nothing travelling. Still, like every thumbnail; decoration only.
 */
export function PlainArt({ className }: { className?: string }) {
  return (
    <svg className={cx('dm-art dm-mode-art', className)} data-mode="plain" data-size="thumb" width="3.5rem" height="2rem" viewBox="0 0 56 32" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">
      <rect className="plain-band" x={6} y={24.5} width={44} height={7} rx={3.5} />
      <g transform="translate(21 0)">
        <g className="tile-solid">
          <ArtTile w={14} layout={[2, 1]} />
        </g>
      </g>
    </svg>
  )
}

/** The two non-compounding choices use the same tiles, palette and visibility-aware loop as ModeArt. */
export function PositionChoiceArt({ kind }: { kind: 'plain' | 'protection' }) {
  const [ref, seen] = useInView<SVGSVGElement>(0.4)
  const id = `dm-choice-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return <svg ref={ref} className={cx('dm-art dm-mode-art dm-position-choice-art', seen && 'is-running')} data-choice={kind}
    width={rem(240)} height={rem(100)} viewBox="0 0 240 100" aria-hidden="true" focusable="false">
    <Ground id={id} at={[8, 91.5, 224]} />
    {kind === 'plain' ? <>
      <rect className="choice-band choice-create-band" x="94" y="58" width="126" height="34" rx="10" />
      <path className="choice-price choice-create-price" pathLength="100" d="M 108 82 L 128 77 L 148 81 L 168 74 L 187 77 L 206 70" />
      <g transform="translate(148 26.5)"><g className="tile-solid choice-create-tile"><ArtTile w={18} layout={[2, 1]} /></g></g>
      <path className="choice-create-plus" d="M 151 75 H 163 M 157 69 V 81" />
      {[0, 1].map((n) => <circle key={n} className={`choice-token choice-fund choice-fund-${n}`} r="9" style={route(n === 0 ? 'M 34 43 C 72 43 92 68 141 75' : 'M 34 75 C 78 75 106 85 174 75')} />)}
    </> : <>
      <rect className="choice-band choice-exit-band" x="18" y="58" width="132" height="34" rx="10" />
      <path className="choice-price choice-exit-price" pathLength="100" d="M 30 82 L 55 77 L 77 81 L 99 71 L 120 74 L 150 58" />
      <g transform="translate(64 26.5)"><g className="tile-solid choice-exit-tile"><ArtTile w={18} layout={[2, 1]} /></g></g>
      <line className="choice-edge" x1="150" x2="150" y1="35" y2="86" />
      <circle className="choice-tip" r="3.5" style={route('M 30 82 L 55 77 L 77 81 L 99 71 L 120 74 L 150 58')} />
      <path className="choice-wallet" d="M 185 45 H 221 V 86 H 185 Q 179 86 179 80 V 51 Q 179 45 185 45 Z M 221 60 H 208 V 72 H 221" />
      {[0, 1].map((n) => <circle key={n} className={`choice-token choice-transfer choice-transfer-${n}`} r="5" style={route(`M 131 ${71 + n * 11} C 161 ${42 + n * 12}, 175 ${42 + n * 12}, 195 ${59 + n * 15}`)} />)}
    </>}
  </svg>
}
