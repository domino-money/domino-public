import { useSvgId } from '../charts/series'
import { useInView } from '../home/Vignettes'
import { cx } from '../ui'

/*
 * New position's picture before a pool is chosen (owner, 2026-09-24): what a
 * position is, drawn rather than said. Redrawn 2026-10-17 as the approved V4
 * picture (site/new.html .il, 360 x 150): a price range as a green band with
 * its two edges, one price curve across it, quiet where it leaves the band and
 * Tangerine inside it, fee pips where it earns, and the brand's domino resting
 * on the band.
 *
 * Only shapes: no text, no digits, no figure, no axis, so nothing here can be
 * read as data; the colours are set in the stylesheet (styles/v4-newposition.css).
 * It plays once, as the page's inner load moment does: the curve draws from
 * the left (a clip that opens, .6 s at .2 s), the pips pop (.3 s from .48 s),
 * the domino fades in (.35 s at .5 s). The resting frame (and the stilled one:
 * reduced motion, Pause motion) is the whole composition. The lines keep a
 * still, endless hold while the picture is in view (.is-running), the shared
 * decorative motion's mark.
 */

/** The price's path through the view box (360 × 150), as the approved picture draws it. */
const PRICE = 'M0 132C36 130 58 116 84 96S128 62 158 68S206 88 234 74S276 56 298 46S338 24 360 18'

/** The band: the price range, 52 to 98. The path enters it at about x 84 and leaves it at about x 280. */
const BAND = { top: 52, bottom: 98 }

/** The fee pips where the path runs inside the band (the legend names them; the fourth sits on the dip at x 218). */
const PIPS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 120, y: 60.8 },
  { x: 176, y: 64.8 },
  { x: 218, y: 79.4 },
  { x: 262, y: 60.8 },
]

export function PreviewArt({ className }: { className?: string }) {
  const [ref, seen] = useInView<SVGSVGElement>(0.3)
  const inside = useSvgId('dm-flow-pv-art-inside')
  const reveal = useSvgId('dm-flow-pv-art-reveal')
  return (
    <svg
      ref={ref}
      className={cx('dm-art dm-flow-pv-art', seen && 'is-running', className)}
      viewBox="0 0 360 150"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={inside}>
          <rect x={0} y={BAND.top} width={360} height={BAND.bottom - BAND.top} />
        </clipPath>
        {/* The curve is drawn by this clip opening from the left (its width), once. */}
        <clipPath id={reveal}>
          <rect className="reveal dm-art-enter" x={0} y={0} width={360} height={150} />
        </clipPath>
      </defs>

      <rect className="band" x={0} y={BAND.top} width={360} height={BAND.bottom - BAND.top} />
      <path className="edge" d={`M0 ${BAND.top + 0.5}h360M0 ${BAND.bottom - 0.5}h360`} />

      {/* The price: quiet everywhere, Tangerine where the band clips it. */}
      <g clipPath={`url(#${reveal})`}>
        <path className="line line-out" d={PRICE} />
        <path className="line line-in" d={PRICE} clipPath={`url(#${inside})`} />
      </g>

      {PIPS.map((pip, index) => (
        <g key={index} className={`pip pip-${index + 1} dm-art-enter`}>
          <circle className="pip-halo" cx={pip.x} cy={pip.y} r={4.4} />
          <circle className="pip-light" cx={pip.x} cy={pip.y + 0.8} r={2.2} />
          <circle className="pip-core" cx={pip.x} cy={pip.y} r={2.2} />
        </g>
      ))}

      {/* The position: the brand's domino (a 2|3 face), resting on the band. */}
      <g className="dom dm-art-enter" transform="translate(203 62) scale(.62)">
        <rect className="dom-face" x={0.5} y={0.5} width={16} height={28} rx={4} />
        <path className="dom-groove" d="M3.5 14.5h10" />
        <circle className="dom-pip" cx={5.6} cy={5.4} r={1.55} />
        <circle className="dom-pip" cx={11.4} cy={9.6} r={1.55} />
        <circle className="dom-pip" cx={5.2} cy={18.6} r={1.55} />
        <circle className="dom-pip" cx={8.5} cy={21.6} r={1.55} />
        <circle className="dom-pip" cx={11.8} cy={24.6} r={1.55} />
      </g>
    </svg>
  )
}
