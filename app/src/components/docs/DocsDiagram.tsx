import { FEATURES, FEATURE_ORDER, type FeatureKey } from '../../lib/automate/features'
import type { DiagramName } from '../../lib/docs/types'

/**
 * The docs' drawings (lib/docs/types.ts DiagramName): ideas, not screens, so they are drawn here rather than shot. The
 * shapes are plain SVG coloured by the page's tokens (docs.css, .dm-docs-dg-*); every word is HTML beside them, so it
 * stays readable on a phone and is read out with the figure.
 */

/**
 * A price that starts low outside the range, rises through it, peaks above it and comes back (V4, site/docs-article.html:
 * a Catmull-Rom curve through its points): 480 × 200, the range from y 60 to 140.
 */
const PRICE = 'M0 172 C6.7 170.7 27 169 40 164 C53 159 66.7 150.7 78 142 C89.3 133.3 97.7 120 108 112 C118.3 104 129.3 95.3 140 94 C150.7 92.7 161.3 100.3 172 104 C182.7 107.7 193.3 117 204 116 C214.7 115 226.3 105 236 98 C245.7 91 253 80.3 262 74 C271 67.7 280.7 65.3 290 60 C299.3 54.7 308.3 46.3 318 42 C327.7 37.7 338 33.7 348 34 C358 34.3 368.7 39 378 44 C387.3 49 395 55.3 404 64 C413 72.7 423 89.3 432 96 C441 102.7 450 103.7 458 104 C466 104.3 476.3 99 480 98'
/** Points on the price line where it is inside the range: a fee dot floats 20 above each, each a beat after the last. */
const EARNING_DOTS: readonly (readonly [number, number])[] = [[108, 112], [140, 94], [172, 104], [204, 116], [236, 98], [432, 96], [458, 104]]

function Earning({ alt }: { alt: string }) {
  return (
    <>
      <svg viewBox="0 0 480 200" role="img" aria-label={alt} className="dm-docs-dg-svg">
        <defs>
          <clipPath id="dm-docs-dg-range">
            <rect x="0" y="60" width="480" height="80" />
          </clipPath>
        </defs>
        <rect x="0" y="60" width="480" height="80" className="dm-docs-dg-band" />
        <line x1="0" x2="480" y1="60" y2="60" className="dm-docs-dg-edge" />
        <line x1="0" x2="480" y1="140" y2="140" className="dm-docs-dg-edge" />
        <path d={PRICE} className="dm-docs-dg-out" />
        <path d={PRICE} clipPath="url(#dm-docs-dg-range)" className="dm-docs-dg-in" />
        {EARNING_DOTS.map(([x, y], index) => (
          <circle key={x} cx={x} cy={y - 20} r="4" className="dm-docs-dg-fee" style={{ transitionDelay: `${index * 0.035}s` }} />
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

/**
 * One of the three ways, as a small scene (V4, site/docs-article.html .tws, 180 × 100): the position a thin plate holding
 * its liquidity, its fees as green dots, and where they go, which plays while the card is hovered: a fourth fee drops on
 * the pile; a fee rides the arc back in and the position's green share grows; a fee rides up to the next range, which
 * fills in. The riding fee follows a CSS motion path in the drawing's own units; where that is not supported (and under
 * reduced motion) a still dot stands at the arc's start (docs.css).
 */
function Way({ feature }: { feature: FeatureKey }) {
  return (
    <svg width="180" height="100" viewBox="0 0 180 100" fill="none" aria-hidden="true" className="dm-docs-dg-scene">
      {feature === 'plain' && (
        <>
          <rect className="dm-sc-plate" x="20.5" y="56.5" width="104" height="22" rx="7" />
          <rect className="dm-sc-liq" x="27" y="63" width="90" height="8" rx="3" />
          <g>
            <circle className="dm-sc-fee" cx="142" cy="71" r="3.6" />
            <circle className="dm-sc-fee" cx="153" cy="71" r="3.6" />
            <circle className="dm-sc-fee" cx="147.5" cy="62.5" r="3.6" />
          </g>
          <circle className="dm-sc-fee dm-sc-drop" cx="158.5" cy="62.5" r="3.6" />
        </>
      )}
      {feature === 'compound' && (
        <>
          <rect className="dm-sc-plate" x="20.5" y="56.5" width="124" height="22" rx="7" />
          <rect className="dm-sc-liq" x="27" y="63" width="92" height="8" rx="3" />
          <rect className="dm-sc-fee dm-sc-grow" x="121" y="63" width="16" height="8" rx="3" fillOpacity=".85" />
          <path className="dm-sc-arc" d="M132 52 C132 14 74 14 74 50" />
          <path className="dm-sc-head" d="M70 45.5 74 50.5 78 45.5" />
          <circle className="dm-sc-fee dm-sc-st" cx="132" cy="52" r="3.5" />
          <circle className="dm-sc-tdot dm-sc-td-c" r="3.5" />
        </>
      )}
      {feature === 'domino' && (
        <>
          <rect className="dm-sc-plate" x="12.5" y="62.5" width="84" height="20" rx="7" />
          <rect className="dm-sc-liq" x="18" y="68.5" width="72" height="8" rx="3" />
          <rect className="dm-sc-next" x="104.5" y="30.5" width="66" height="20" rx="7" />
          <path className="dm-sc-arc" d="M80 58 C82 34 92 30 102 36" />
          <path className="dm-sc-head" d="M96.6 32.2 102.2 36.4 96.8 39.6" />
          <circle className="dm-sc-fee dm-sc-st" cx="80" cy="58" r="3.5" />
          <circle className="dm-sc-tdot dm-sc-td-d" r="3.5" />
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
