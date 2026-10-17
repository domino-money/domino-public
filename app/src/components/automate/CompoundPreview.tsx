import { useSvgId } from '../charts/series'
import { FeeMeter } from './ServiceFee'
import { FeeJourney } from './ModeSummary'

/*
 * Auto-compound's picture once its position is read (DESIGN-V2 §14.2, automate.md §5.5.5): what Domino's successor axis is
 * to Domino-compound. V4 (2026-10-17, the owner's approved site/sequence.html .asc-c): the position as one green range
 * with its two Tangerine handles, its outlined tile on it, and the earned fees waiting at the right, arcing back into the
 * same range. It plays once when shown (the fees pop, the arc fades in) and then rests; nothing loops. Under it, the fee
 * meter: the 2% the service keeps of what the position earns.
 *
 * Decoration only: aria-hidden, no text, digits or `%` in the drawing.
 */

export function CompoundPreview() {
  const head = useSvgId('dm-cp-head')
  return (
    <div className="dm-seq-cpv">
      <div className="dm-seq-stage" data-mode="compound">
        <svg className="dm-cp-pic" viewBox="0 0 340 170" width="100%" aria-hidden="true" focusable="false">
          <defs>
            <marker id={head} viewBox="0 0 10 10" refX="6" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
              <path d="M2 1.5 7 5 2 8.5" fill="none" stroke="rgb(255 236 220 / .45)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </marker>
          </defs>
          <rect className="cp-band" x="36" y="112" width="268" height="26" rx="7" />
          <rect className="cp-hd" x="31" y="104" width="6" height="42" rx="3" />
          <rect className="cp-hd" x="303" y="104" width="6" height="42" rx="3" />
          <g className="th-tile">
            <rect className="th-t" x="118.6" y="52.6" width="30.8" height="56.8" rx="6.4" />
            <path className="th-g" d="M123 81h22" />
            <circle className="th-p" cx="126" cy="62" r="2.4" /><circle className="th-p" cx="142" cy="70" r="2.4" />
            <circle className="th-p" cx="125.4" cy="90" r="2.4" /><circle className="th-p" cx="134" cy="96" r="2.4" /><circle className="th-p" cx="142.6" cy="102" r="2.4" />
          </g>
          <path className="cp-arc ta ta-f d5s" d="M270 60C258 6 116 2 100 104" markerEnd={`url(#${head})`} />
          <circle className="cp-fee ta ta-p d1s" cx="270" cy="98" r="5" />
          <circle className="cp-fee ta ta-p d2s" cx="270" cy="84" r="5" />
          <circle className="cp-fee ta ta-p d3s" cx="270" cy="70" r="5" />
        </svg>
      </div>
      <FeeJourney mode="compound" />
      <FeeMeter mode="compound" />
    </div>
  )
}
