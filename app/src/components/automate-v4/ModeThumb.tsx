import { useSvgId } from '../charts/series'

/*
 * The small picture in each "What Domino does for it" row (V4, the owner's approved site/sequence.html .ma): 128 x 80,
 * green ranges, an outlined Tangerine tile, dotted arcs ending in a small arrowhead, green fees and the wallet's two
 * coins. When its row is chosen, its .ta-p parts pop and its .ta-f parts fade in once (v4-automate.css); otherwise it is
 * still. Its tile tips on the row's hover. Decoration only: aria-hidden, no text.
 */

export type ThumbMode = 'compound' | 'domino' | 'protection'

export function ModeThumb({ mode }: { mode: ThumbMode }) {
  const head = useSvgId('dm-mt-head')
  const marker = `url(#${head})`
  return (
    <svg className="dm-mode-thumb" data-mode={mode} viewBox="0 0 128 80" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <marker id={head} viewBox="0 0 10 10" refX="6" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M2 1.5 7 5 2 8.5" fill="none" stroke="rgb(255 236 220 / .45)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>
      {mode === 'compound' && <>
        <rect className="th-band" x="10" y="52" width="88" height="14" rx="4" />
        <path className="th-wave" d="M15 60c5-3.5 9-3.5 14 0s9 3.5 14 0 9-3.5 14 0 9 3.5 14 0 9-3.5 14 0" />
        <g className="th-tile">
          <rect className="th-t" x="40.6" y="22.6" width="15.8" height="28.8" rx="3.6" />
          <path className="th-g" d="M43.5 37h10" />
          <circle className="th-p" cx="45" cy="28.4" r="1.3" /><circle className="th-p" cx="52" cy="32" r="1.3" />
          <circle className="th-p" cx="44.6" cy="42" r="1.3" /><circle className="th-p" cx="48.5" cy="45" r="1.3" /><circle className="th-p" cx="52.4" cy="48" r="1.3" />
        </g>
        <path className="th-arc ta ta-f d4s" d="M112 32C104 2 38 2 28 47" markerEnd={marker} />
        <circle className="th-fee ta ta-p d1s" cx="112" cy="60" r="3.4" />
        <circle className="th-fee ta ta-p d2s" cx="112" cy="50.5" r="3.4" />
        <circle className="th-fee ta ta-p d3s" cx="112" cy="41" r="3.4" />
      </>}
      {mode === 'domino' && <>
        <rect className="th-dim" x="8" y="58" width="44" height="10" rx="3" />
        <rect className="th-band" x="44" y="42" width="44" height="10" rx="3" />
        <rect className="th-ghost" x="80" y="26" width="40" height="10" rx="3" />
        <path className="th-trig" d="M47 12v62" />
        <path className="th-price" d="M8 74 20 70l10 2 12-8 12-6 10-3" />
        <g className="th-tile">
          <rect className="th-t" x="24.6" y="41.6" width="9.8" height="15.8" rx="2.4" />
          <path className="th-g" d="M26.5 49.5h6" />
        </g>
        <g className="th-tile">
          <rect className="th-t ta ta-p d4s" x="60.6" y="25.6" width="9.8" height="15.8" rx="2.4" />
        </g>
        <rect className="th-tg" x="95.6" y="9.6" width="9.8" height="15.8" rx="2.4" />
        <circle className="th-fee ta ta-p d1s" cx="40" cy="42" r="2.6" />
        <circle className="th-fee ta ta-p d2s" cx="52" cy="35" r="2.6" />
      </>}
      {mode === 'protection' && <>
        <rect className="th-dim" x="12" y="48" width="56" height="16" rx="4" />
        <g className="th-tile">
          <rect className="th-t" x="30.6" y="19.6" width="13.8" height="27.8" rx="3.2" />
          <path className="th-g" d="M33 33.5h9" />
        </g>
        <path className="th-arc ta ta-f d2s" d="M66 42C78 20 98 22 104 48" markerEnd={marker} />
        <circle className="th-coin ta ta-p d4s" cx="106" cy="57" r="6" />
        <circle className="th-coin2 ta ta-p d5s" cx="117" cy="60" r="4.5" />
      </>}
    </svg>
  )
}
