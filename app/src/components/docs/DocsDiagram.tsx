import { FEATURES, FEATURE_ORDER, type FeatureKey } from '../../lib/automate/features'
import type { DiagramName } from '../../lib/docs/types'

/**
 * The docs' drawings (lib/docs/types.ts DiagramName): ideas, not screens, so they are drawn here rather than shot. The
 * shapes are plain SVG coloured by the page's tokens (docs.css, .dm-docs-dg-*); every word is HTML beside them, so it
 * stays readable on a phone and is read out with the figure.
 */

/** A price that wanders in and out of a range over time: 480 × 200, the range from y 60 to 132. */
const PRICE = 'M0 104 C 40 96, 60 70, 96 76 S 150 30, 178 38 S 214 70, 240 92 S 290 130, 318 150 S 352 176, 380 150 S 420 100, 446 96 S 470 104, 480 100'
/** Points on the price line where it is inside the range (sampled from PRICE): a fee dot floats just above each. */
const EARNING_DOTS: readonly (readonly [number, number])[] = [[24, 96], [64, 79], [108, 73], [236, 88], [262, 110], [424, 106], [456, 97]]

function Earning({ alt }: { alt: string }) {
  return (
    <>
      <svg viewBox="0 0 480 200" role="img" aria-label={alt} className="dm-docs-dg-svg">
        <defs>
          <clipPath id="dm-docs-dg-range">
            <rect x="0" y="60" width="480" height="72" />
          </clipPath>
        </defs>
        <rect x="0" y="60" width="480" height="72" className="dm-docs-dg-band" />
        <line x1="0" x2="480" y1="60" y2="60" className="dm-docs-dg-edge" />
        <line x1="0" x2="480" y1="132" y2="132" className="dm-docs-dg-edge" />
        <path d={PRICE} className="dm-docs-dg-out" />
        <path d={PRICE} clipPath="url(#dm-docs-dg-range)" className="dm-docs-dg-in" />
        {EARNING_DOTS.map(([x, y]) => (
          <circle key={x} cx={x} cy={y - 12} r="4" className="dm-docs-dg-fee" />
        ))}
      </svg>
      <ul className="dm-docs-dg-legend" aria-hidden="true">
        <li>
          <span className="dm-docs-dg-key" data-key="band" />
          Your range
        </li>
        <li>
          <span className="dm-docs-dg-key" data-key="in" />
          Price inside it: earning
        </li>
        <li>
          <span className="dm-docs-dg-key" data-key="fee" />
          A fee from a trade
        </li>
        <li>
          <span className="dm-docs-dg-key" data-key="out" />
          Price outside it: not earning
        </li>
      </ul>
    </>
  )
}

/** One of the three ways, as a small scene: the position as a band, its fees as dots, and where they go. */
function Way({ feature }: { feature: FeatureKey }) {
  return (
    <svg viewBox="0 0 160 96" aria-hidden="true" className="dm-docs-dg-way">
      {feature === 'plain' && (
        <>
          <rect x="16" y="40" width="84" height="40" rx="8" className="dm-docs-dg-pos" />
          {[0, 1, 2].map((n) => (
            <circle key={n} cx={124 + (n % 2) * 12} cy={72 - n * 12} r="5" className="dm-docs-dg-fee" />
          ))}
        </>
      )}
      {feature === 'compound' && (
        <>
          <rect x="16" y="28" width="104" height="52" rx="8" className="dm-docs-dg-pos" />
          <rect x="16" y="44" width="104" height="36" rx="8" className="dm-docs-dg-pos" />
          <path d="M132 58 C 150 40, 146 16, 118 14 S 76 20, 70 30" className="dm-docs-dg-arrow" />
          <circle cx="140" cy="58" r="5" className="dm-docs-dg-fee" />
          <path d="M64 22 l6 8 l8 -5" className="dm-docs-dg-arrow" />
        </>
      )}
      {feature === 'domino' && (
        <>
          <rect x="8" y="52" width="72" height="32" rx="8" className="dm-docs-dg-pos" />
          <rect x="72" y="20" width="72" height="32" rx="8" className="dm-docs-dg-pos" data-next="" />
          <path d="M40 46 C 40 30, 50 24, 62 30" className="dm-docs-dg-arrow" />
          <circle cx="40" cy="46" r="5" className="dm-docs-dg-fee" />
          <path d="M56 24 l7 6 l-8 4" className="dm-docs-dg-arrow" />
        </>
      )}
    </svg>
  )
}

function ThreeWays({ alt }: { alt: string }) {
  return (
    <ol className="dm-docs-dg-ways" aria-label={alt}>
      {FEATURE_ORDER.map((key) => (
        <li key={key} className="dm-docs-dg-waycard">
          <Way feature={key} />
          <p className="dm-docs-dg-name">{FEATURES[key].name}</p>
          <p className="dm-docs-dg-line">{FEATURES[key].line}</p>
          {/* The fee in full ink (V4, 2026-10-16): the same words, the share in a <b>. */}
          <p className="dm-docs-dg-fee-line">
            {FEATURES[key].fee ? (
              <>
                <b>{FEATURES[key].fee}</b> of the fees it uses
              </>
            ) : (
              'No Domino fee'
            )}
          </p>
        </li>
      ))}
    </ol>
  )
}

export function DocsDiagram({ name, alt }: { name: DiagramName; alt: string }) {
  return name === 'earning' ? <Earning alt={alt} /> : <ThreeWays alt={alt} />
}
