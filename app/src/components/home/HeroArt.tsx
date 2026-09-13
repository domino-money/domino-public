import { useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { cx } from '../ui'
import { ArtTile, useInView } from './Vignettes'

/*
 * The hero's illustration (DESIGN.md F.1): a row of domino tiles on the dotted
 * ground topples left to right, and as the last one falls a new tile appears
 * one step higher: the fees of one position opening the next one up.
 *
 * Only shapes: no text, no digits, no title, no image, no colour literal (every
 * colour is a token in art.css). Positioning and motion never share an element:
 * an outer group places a tile, the inner group moves. The two halves of a tile
 * always carry different pip counts, and no tile uses the brand mark's layouts.
 */

/** Top | bottom pip counts for tiles 0 to 8, left to right (F.1). */
const CHAIN: ReadonlyArray<readonly [number, number]> = [
  [1, 3],
  [2, 0],
  [3, 1],
  [0, 2],
  [2, 3],
  [1, 0],
  [3, 2],
  [0, 1],
  [0, 3],
]

const NARROW = '(max-width: 767px)'

function subscribeNarrow(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => undefined
  const query = window.matchMedia(NARROW)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

const narrowNow = () => typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches

/**
 * Below 768px the drawing is cropped to tiles 4 to 8, the step and the new
 * tile, so the tiles keep their size instead of shrinking to specks.
 * `running` forces the loop on or off; by default it plays while at least 30%
 * of the drawing is in view.
 */
export function HeroArt({ className, running }: { className?: string; running?: boolean }) {
  const narrow = useSyncExternalStore(subscribeNarrow, narrowNow, () => false)
  const [ref, seen] = useInView<SVGSVGElement>(0.3, running === undefined)
  return (
    <svg
      ref={ref}
      className={cx('dm-art dm-hero-art', (running ?? seen) && 'is-running', className)}
      viewBox={narrow ? '224 20 336 100' : '0 0 560 120'}
      preserveAspectRatio="xMidYMax meet"
      aria-hidden="true"
      focusable="false"
    >
      {/* The baseline, with a 16px step up at x 468 where the new tile stands. */}
      <path className="ground" d="M24 108 H468 V92 H536" />
      {CHAIN.map((layout, index) => (
        <g key={index} transform={`translate(${64 + 40 * index} 59)`}>
          <g className={cx('tile', index === 7 && 'tile-7', index === 8 && 'tile-last')} style={{ '--i': index } as CSSProperties}>
            <ArtTile w={28} layout={layout} parts="outline" />
          </g>
        </g>
      ))}
      {/* Where the new tile will stand, while it is away. */}
      <rect className="next-ghost" x={476} y={43} width={28} height={49} rx={3.92} />
      <g transform="translate(476 43)">
        <g className="next tile-solid">
          <ArtTile w={28} layout={[3, 0]} />
        </g>
      </g>
    </svg>
  )
}
