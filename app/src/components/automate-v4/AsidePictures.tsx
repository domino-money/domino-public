import { useSvgId } from '../charts/series'

/*
 * The pictures of Set up automation's aside (V4, the owner's approved site/sequence.html .pic .asc): the empty plate before
 * a position and a choice (a dashed range and a dashed tile), and Auto-exit's (the price reaches the range's limit, the
 * position closes, a coin goes into the wallet), which plays once when shown. Decoration only: aria-hidden, no text.
 */

export function EmptyPlatePicture() {
  return (
    <svg className="dm-seq-empty-plate" viewBox="0 0 340 150" aria-hidden="true" focusable="false">
      <rect className="ep-ring" x="40" y="88" width="260" height="26" rx="7" />
      <rect className="ep-t" x="155.6" y="30.6" width="28.8" height="52.8" rx="6" />
    </svg>
  )
}

export function ExitPicture() {
  const head = useSvgId('dm-xp-head')
  return (
    <svg className="dm-seq-exit-pic" viewBox="0 0 340 190" aria-hidden="true" focusable="false">
      <defs>
        <marker id={head} viewBox="0 0 10 10" refX="6" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M2 1.5 7 5 2 8.5" fill="none" stroke="rgb(255 236 220 / .45)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>
      <rect className="x-plate" x="18" y="40" width="200" height="120" rx="14" />
      <path className="x-lim" d="M26 52h184" />
      <rect className="th-t" x="30.6" y="110.6" width="15.8" height="28.8" rx="3.6" />
      <path className="th-g" d="M33.5 125h10" />
      <path className="x-line ta ta-d d1s" pathLength="1" d="M54 148 74 138 92 142 112 126 130 130 150 108 168 112 186 88 202 52" />
      <circle className="x-halo ta ta-p d6s" cx="202" cy="52" r="10" />
      <circle className="x-end ta ta-p d6s" cx="202" cy="52" r="4" />
      <path className="x-arc ta ta-f d7s" d="M210 48C244 10 290 22 296 106" markerEnd={`url(#${head})`} />
      <rect className="x-wal" x="258" y="112" width="70" height="50" rx="12" />
      <path className="x-slot" d="M328 126h-22a11 11 0 0 0 0 22h22Z" />
      <circle className="th-coin ta ta-p d8s" cx="306" cy="137" r="5" />
    </svg>
  )
}
