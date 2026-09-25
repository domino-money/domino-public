import { useId } from 'react'
import type { CSSProperties } from 'react'
import { ArtTile, useInView } from '../home/Vignettes'
import { cx } from '../ui'
import { Ground } from './ModeArt'
import { FeeMeter } from './ServiceFee'

/*
 * Auto-compound's picture once its position is read (DESIGN-V2 §14.2, automate.md §5.5.5): what Domino's successor axis is
 * to Domino-compound. The position as one range band on the axis's ground, its two edges standing as a range's handles, its
 * tile on it, and the earned fees arcing out of the band and falling back into the same band, which fills a notch as each
 * lands. Under it, the fee meter: the 2% the service keeps of what the position earns.
 *
 * Decoration only: aria-hidden, no text, digits or `%`. It shares ModeArt's classes, colours and 6 s loop (automate.css), so
 * it runs only while 40% of it is in view (.is-running) and rests, stilled or paused, at its complete first frame. It is the
 * aside's one looping picture after the read, as the aside's ModeArt is before it.
 */

const G = {
  ground: [8, 103.5, 344] as const,
  band: { x: 56, y: 76, w: 248, h: 28, r: 8 },
  tile: { x: 172, y: 48, w: 16 },
  /** The waiting fees, top first (the first to leave), on the band's top edge at the arc's right foot. */
  stack: [53.5, 62.5, 71.5],
  from: 272,
  to: 88,
  crest: -6,
  dot: 4,
}

export function CompoundPreview() {
  const [ref, seen] = useInView<SVGSVGElement>(0.4)
  const id = `dm-cp-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const { band, tile } = G
  const over = `C ${G.from} ${G.crest}, ${G.to} ${G.crest}, ${G.to} ${band.y}`
  return (
    <div className="dm-seq-cpv">
      <div className="dm-plate dm-dots-plate dm-seq-stage" data-mode="compound">
        <svg
          ref={ref}
          className={cx('dm-art dm-mode-art', seen && 'is-running')}
          data-mode="compound"
          data-size="axis"
          data-play="loop"
          viewBox="0 0 360 112"
          preserveAspectRatio="xMidYMax meet"
          aria-hidden="true"
          focusable="false"
        >
          <Ground id={`${id}g`} at={G.ground} />
          <defs>
            <clipPath id={`${id}b`}>
              <rect x={band.x} y={band.y} width={band.w} height={band.h} rx={band.r} />
            </clipPath>
          </defs>
          <rect className="band" x={band.x} y={band.y} width={band.w} height={band.h} rx={band.r} />
          <g clipPath={`url(#${id}b)`}>
            <rect className="band-fill" x={band.x} y={band.y} width={band.w} height={band.h} />
          </g>
          <rect className="band-edge" x={band.x} y={band.y} width={band.w} height={band.h} rx={band.r} />
          <rect className="band-lit" x={band.x} y={band.y} width={band.w} height={band.h} rx={band.r} />
          {[band.x, band.x + band.w].map((x) => (
            <rect key={x} className="handle" x={x - 1} y={band.y - 10} width={2} height={band.h + 10} rx={1} />
          ))}
          <path className="arc" d={`M ${G.from} ${band.y} ${over}`} />
          <circle className="foot" cx={G.to} cy={band.y} r={G.dot * 0.45} />
          <circle className="ripple" cx={G.to} cy={band.y} r={G.dot + 2.5} />
          <g transform={`translate(${tile.x} ${tile.y})`}>
            <g className="mark tile-solid">
              <ArtTile w={tile.w} layout={[3, 1]} />
            </g>
          </g>
          {G.stack.map((cy, index) => (
            <circle key={index} className={`stack stack-${index + 1}`} cx={G.from} cy={cy} r={G.dot} />
          ))}
          {G.stack.map((cy, index) => (
            <g key={index} className={`drop drop-${index + 1}`} style={{ offsetPath: `path('M ${G.from} ${cy} ${over}')` } as CSSProperties}>
              <circle className="drop-dot" cx={0} cy={0} r={G.dot} />
            </g>
          ))}
        </svg>
      </div>
      <FeeMeter mode="compound" />
    </div>
  )
}
