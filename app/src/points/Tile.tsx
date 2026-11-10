import type { CSSProperties } from 'react'

/**
 * One domino tile of the Points page's line of play (direction C, "Corrente", integ-logs/points/directions): Home's own
 * tile material (the slabs under the face, the face's light, the groove, the shaded pips), sized by one length, `--s`,
 * its short side (styles/v4-points.css .pt-tile). Nothing sits behind it; its shadow falls on the ground under it.
 *
 *   - `solid`: a tile in play. `ghost`: the outline of a place for one (Not found's ghost tile); with `dashed`, a place
 *     waiting for a referrer, with `future`, places for wallets still to join.
 *   - `set`: how many pips are set; the rest are sockets pressed into the face (a count that has not started).
 *
 * Motion hooks (styles/v4-points.css): `.pt-drop` carries a tile's arrival, `.pt-lift` its hover, `.pt-sweep` the light
 * that passes along the line, `.pt-ground` its shadow. Decoration only: hidden from assistive technology, whose words are
 * the captions beside it.
 */

const PIPS: Readonly<Record<number, readonly (readonly [number, number])[]>> = {
  0: [],
  1: [[50, 50]],
  2: [[27, 27], [73, 73]],
  3: [[25, 25], [50, 50], [75, 75]],
  4: [[28, 28], [72, 28], [28, 72], [72, 72]],
  5: [[26, 26], [74, 26], [50, 50], [26, 74], [74, 74]],
  6: [[28, 20], [72, 20], [28, 50], [72, 50], [28, 80], [72, 80]],
}

export interface TileProps {
  /** Pips on each half, 0 to 6. */
  a: number
  b: number
  /** Laid flat (the halves side by side). */
  flat?: boolean
  /** The short side, any CSS length (`var(--cs)`). */
  size: string
  kind?: 'solid' | 'ghost'
  /** How many pips are set, counted from the first half. */
  set?: number
  /** The tile's turn in space (a CSS transform). */
  turn?: string
  className?: string
  style?: CSSProperties
}

const SLABS = ['z6', 'z5', 'z4', 'z3', 'z2', 'z1'] as const

export function Tile({ a, b, flat = false, size, kind = 'solid', set = 99, turn, className, style }: TileProps) {
  const pips: { left: number; top: number; set: boolean }[] = []
  for (const [half, value] of [[0, a], [1, b]] as const) {
    for (const [x0, y0] of PIPS[value] ?? []) {
      const [x, y] = flat && value === 6 ? [y0, x0] : [x0, y0]
      pips.push({ left: flat ? half * 50 + x / 2 : x, top: flat ? y : half * 50 + y / 2, set: pips.length < set })
    }
  }
  const look = { '--s': size, ...(turn ? { '--tf': turn } : {}), ...style } as CSSProperties
  return (
    <span aria-hidden="true" className={['pt-tile', flat && 'pt-flat', kind, className].filter(Boolean).join(' ')} style={look}>
      <span className="pt-ground" />
      <span className="pt-drop">
        <span className="pt-lift">
          <span className="pt-3d">
            {kind === 'solid' && SLABS.map((slab) => <span key={slab} className={slab} />)}
            <span className="pt-face">
              <b />
              {pips.map((pip, index) => (
                <i key={index} className={pip.set ? undefined : 'o'} style={{ left: `${pip.left}%`, top: `${pip.top}%` }} />
              ))}
              <span className="pt-glint" />
              <span className="pt-sweep" />
            </span>
          </span>
        </span>
      </span>
    </span>
  )
}
