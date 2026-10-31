import { useSvgId } from '../charts/series'
import { useInView } from './Vignettes'

export type HomeAutomationKind = 'compound' | 'domino' | 'autoexit'

/** A small dimensional Domino tile. Its two material faces follow the hero's warm sculpture. */
function Tile({ face, edge, x, y, small = false }: { face: string; edge: string; x: number; y: number; small?: boolean }) {
  return <g transform={`translate(${x} ${y}) scale(${small ? .72 : 1})`}>
    <rect x="5" y="5" width="40" height="70" rx="7" fill={`url(#${edge})`} />
    <rect width="40" height="70" rx="7" fill={`url(#${face})`} />
    <rect x="2" y="2" width="36" height="66" rx="5" className="as-tile-rim" />
    <path d="M1 35H39" className="as-tile-divider" />
    <g className="as-tile-pips"><circle cx="20" cy="17" r="3.5" /><circle cx="13" cy="46" r="3.5" /><circle cx="27" cy="59" r="3.5" /></g>
  </g>
}

/** Decorative diagrams: no market history, portfolio value, or projected return is represented. */
export function HomeAutomationArt({ kind }: { kind: HomeAutomationKind }) {
  const [ref, running] = useInView<SVGSVGElement>(.3)
  const face = useSvgId('automation-face')
  const edge = useSvgId('automation-edge')
  const glass = useSvgId('automation-glass')
  const light = useSvgId('automation-light')
  return <svg ref={ref} className={`dm-art dm-automation-story-art as-${kind}${running ? ' is-running' : ''}`} viewBox="0 0 360 280" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={face} x1="0" y1="0" x2=".8" y2="1"><stop offset="0" className="as-peach" /><stop offset=".6" className="as-orange" /><stop offset="1" className="as-copper" /></linearGradient>
      <linearGradient id={edge} x1="0" y1="0" x2="1" y2="1"><stop className="as-copper" /><stop offset="1" className="as-brown" /></linearGradient>
      <linearGradient id={glass} x1="0" y1="0" x2="0" y2="1"><stop className="as-glass-top" /><stop offset="1" className="as-glass-bottom" /></linearGradient>
      <radialGradient id={light}><stop className="as-orange" stopOpacity=".14" /><stop offset="1" className="as-orange" stopOpacity="0" /></radialGradient>
    </defs>
    <ellipse cx="180" cy="175" rx="167" ry="102" fill={`url(#${light})`} />
    {kind === 'compound' && <>
      <ellipse className="as-floor-shadow" cx="180" cy="225" rx="124" ry="14" />
      <path className="as-flow-guide" d="M90 169C90 28 270 28 270 169" />
      <path className="as-arrow" d="m263 159 7 10 7-10" />
      <text className="as-label as-label-accent" x="180" y="48">Earned fees</text>
      <rect x="68" y="177" width="226" height="49" rx="13" fill={`url(#${edge})`} />
      <rect className="as-plate" x="64" y="168" width="226" height="49" rx="13" fill={`url(#${glass})`} />
      <rect className="as-compound-fill" x="70" y="184" width="214" height="27" rx="8" />
      <path className="as-plate-lip" d="M76 170H278" />
      <Tile face={face} edge={edge} x={160} y={93} />
      <g className="as-compound-return as-motion"><circle r="5" className="as-fee-dot" /></g>
      <g className="as-compound-return as-motion as-second"><circle r="4" className="as-fee-dot" /></g>
      <g className="as-compound-return as-motion as-third"><circle r="3" className="as-fee-dot" /></g>
      <text className="as-label" x="180" y="253">Same position. Same range.</text>
    </>}
    {kind === 'domino' && <>
      <ellipse className="as-floor-shadow" cx="112" cy="238" rx="88" ry="11" />
      <path className="as-flow-guide" d="M144 190C154 114 179 77 235 124" />
      <path className="as-arrow" d="m223 123 12 1-3-12" />
      <text className="as-label as-label-accent" x="162" y="57">Only earned fees move</text>
      <rect x="40" y="199" width="137" height="40" rx="11" fill={`url(#${edge})`} />
      <rect className="as-plate" x="36" y="191" width="137" height="40" rx="11" fill={`url(#${glass})`} />
      <rect className="as-original-fill" x="42" y="211" width="125" height="14" rx="5" />
      <path className="as-plate-lip" d="M47 193H162" />
      <Tile face={face} edge={edge} x={71} y={116} />
      <g className="as-next-range">
        <rect x="207" y="138" width="118" height="39" rx="11" fill={`url(#${edge})`} />
        <rect className="as-plate" x="203" y="130" width="118" height="39" rx="11" fill={`url(#${glass})`} />
        <rect className="as-next-fill" x="209" y="149" width="106" height="14" rx="5" />
        <path className="as-plate-lip" d="M214 132H310" />
        <Tile face={face} edge={edge} x={253} y={75} small />
      </g>
      <g className="as-domino-hop as-motion"><circle r="5" className="as-fee-dot" /></g>
      <g className="as-domino-hop as-motion as-second"><circle r="4" className="as-fee-dot" /></g>
      <text className="as-label" x="105" y="261">Original stays</text>
      <text className="as-label" x="263" y="197">Higher range</text>
    </>}
    {kind === 'autoexit' && <>
      <ellipse className="as-floor-shadow" cx="116" cy="226" rx="92" ry="11" />
      <ellipse className="as-floor-shadow" cx="284" cy="199" rx="49" ry="10" />
      <rect x="33" y="151" width="173" height="71" rx="12" fill={`url(#${edge})`} />
      <rect className="as-plate" x="29" y="143" width="173" height="71" rx="12" fill={`url(#${glass})`} />
      <rect className="as-exit-fill" x="35" y="148" width="161" height="60" rx="8" />
      <path className="as-boundary" d="M30 144H201" />
      <path className="as-exit-price" pathLength="100" d="M43 199 61 187 77 191 96 179 115 183 131 168 150 173 181 144" />
      <circle className="as-price-end" cx="181" cy="144" r="4" />
      <circle className="as-price-halo" cx="181" cy="144" r="10" />
      <Tile face={face} edge={edge} x={65} y={90} small />
      <text className="as-label as-label-accent" x="117" y="65">Price reaches range end</text>
      <path className="as-flow-guide" d="M185 134C205 73 283 71 290 137" />
      <g className="as-wallet" transform="translate(243 134)">
        <rect x="10" y="-12" width="57" height="24" rx="6" className="as-wallet-card" />
        <rect x="5" y="7" width="83" height="59" rx="13" fill={`url(#${edge})`} />
        <rect className="as-wallet-body" width="83" height="59" rx="13" fill={`url(#${glass})`} />
        <path className="as-wallet-pocket" d="M83 19H59a10 10 0 0 0 0 20h24Z" />
        <circle className="as-wallet-token as-wallet-token-a" cx="62" cy="29" r="4" />
        <circle className="as-wallet-token as-wallet-token-b" cx="74" cy="29" r="4" />
      </g>
      <g className="as-exit-hop as-motion"><circle r="5" className="as-fee-dot" /></g>
      <g className="as-exit-hop as-motion as-second"><circle r="4" className="as-fee-dot as-token-two" /></g>
      <text className="as-label" x="115" y="253">Position closes</text>
      <text className="as-label" x="285" y="228">Your wallet</text>
    </>}
  </svg>
}
