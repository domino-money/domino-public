import { useState } from 'react'
import { IconChevronRight } from '../icons'
import { LinkButton } from '../ui'
import { ChapterTitle, Stop } from './HomeType'
import { useInView } from './Vignettes'
import { useSvgId } from '../charts/series'

export const FUNDING_NETWORKS = ['Ethereum', 'Base', 'Arbitrum One', 'OP Mainnet', 'Robinhood Chain'] as const

/** The networks' own marks as V4 draws them (V4 §5.2): each in its own colour, the only place a network's colour shows. */
function V4Glyph({ network }: { network: typeof FUNDING_NETWORKS[number] }) {
  if (network === 'Ethereum') return <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="#627eea" /><path d="M10 3.6 6.1 10.1 10 12.4l3.9-2.3z" fill="#fff" /><path d="M10 13.2 6.1 10.9 10 16.4l3.9-5.5z" fill="#fff" fillOpacity="0.75" /></svg>
  if (network === 'Base') return <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="#0052ff" /><circle cx="10" cy="10" r="5.6" fill="#fff" /><rect x="3.6" y="9.2" width="7.4" height="1.6" fill="#0052ff" /></svg>
  if (network === 'Arbitrum One') return <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="#213147" /><path d="M6.4 14.6 10 5.4l3.6 9.2" stroke="#28a0f0" strokeWidth="1.7" fill="none" strokeLinejoin="round" /><path d="M8.2 12.2h3.6" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" /></svg>
  if (network === 'Robinhood Chain') return <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="#ccff00" /><path d="M6.6 14.8c.9-4.2 3.1-7.4 7-8.9-.7 3.4-2.7 6.2-5.8 7.4" fill="#1b2a0e" /></svg>
  // OP keeps its initials as text: the one lettered mark, labelled by the name beside it (render.test).
  return <span>OP</span>
}

/**
 * Identifying marks always have a network name beside them. `variant="v4"` is Home's drawing; the default output is
 * unchanged for the funding screens that share it (v2in/funds/TransferRoute.tsx).
 */
export function NetworkMark({ network, variant }: { network: typeof FUNDING_NETWORKS[number]; variant?: 'v4' }) {
  if (variant === 'v4') {
    return <span className="dm-network-mark dm-network-mark--v4" data-network={network} aria-hidden="true"><V4Glyph network={network} /></span>
  }
  return <span className="dm-network-mark" data-network={network} aria-hidden="true">
    {network === 'Ethereum' ? <svg viewBox="0 0 24 24"><path d="m12 2-6 10 6 3.5 6-3.5Zm-6 12 6 8 6-8-6 3.5Z" fill="currentColor" /></svg>
      : network === 'Base' ? <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="currentColor" /><path d="M3 12h10" stroke="var(--network-color)" strokeWidth="2" /></svg>
        : network === 'Arbitrum One' ? <svg viewBox="0 0 24 24"><path d="m12 2 9 5v10l-9 5-9-5V7Z" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m7 16 4-9h3l-4 9Zm7-5 3 5h-3l-1.5-2Z" fill="currentColor" /></svg>
          : network === 'OP Mainnet' ? <span>OP</span> : null}
  </span>
}

/* The scene, in design px (800 × 300, V4 "fs-scene"): five sources on the left, the wallet, the step between (a still
   domino over the line between networks), your position's pair. Its routes are drawn and its dots travel on one loop. */
const SOURCES = [42, 86, 130, 174, 218] as const
const route = (y: number) => `M184 ${y} C 228 ${y} 232 222 268 222`
const ACROSS = 'M390 222 C 404 150 444 150 462 226'
const LOCAL = 'M390 222 L 462 226'
const OUT_A = 'M556 226 C 610 226 640 128 688 128'
const OUT_B = 'M556 226 C 630 226 700 200 728 150'
const PIPS: ReadonlyArray<[number, number]> = [[0.31, 0.15], [0.69, 0.35], [0.28, 0.62], [0.5, 0.75], [0.72, 0.88]]

/** Explanatory scene only; no wallet scan or transfer quote is requested. */
export function HomeCapabilities() {
  const [mode, setMode] = useState<'across' | 'local'>('across')
  const [ref, running] = useInView<HTMLDivElement>(0.25)
  const wallet = useSvgId('funding-wallet')
  const tile = useSvgId('funding-tile')
  const middle = mode === 'across' ? 'Transfer + swap' : 'Swap'
  return <section id="funding" className="dm-home-funding dm-home-chapter" aria-labelledby="dm-funding-title">
    <ChapterTitle id="dm-funding-title" first="Start with" second={<>what you have<Stop /></>} />
    <div className="dm-funding-grid">
      <div className="dm-funding-copy">
        <p>Use tokens in your wallet, even on another network. Domino finds a route into your chosen pair.</p>
        <LinkButton href="#/new" variant="ghost" className="dm-home-more">Find your funds <IconChevronRight size={16} /></LinkButton>
        <details className="dm-funding-details"><summary>Networks and transfers</summary><p>Domino checks Ethereum, Base, Arbitrum One, OP Mainnet and Robinhood Chain. Available transfers depend on the token and destination. Review swaps, transfer costs and network fees before you approve in your wallet.</p></details>
      </div>
      {/* The card's lit rim sits on this frame, outside the demonstration whose own motion is its loop alone. */}
      <div className="dm-funding-card dm-lit">
        <div ref={ref} className={'dm-funding-demonstration ' + (running ? 'is-running' : '')} data-funding-mode={mode}>
          <div className="dm-funding-switch" role="group" aria-label="Funding example">
            <span className="dm-funding-thumb" aria-hidden="true" />
            <button type="button" aria-pressed={mode === 'across'} onClick={() => setMode('across')}>From another network</button>
            <button type="button" aria-pressed={mode === 'local'} onClick={() => setMode('local')}>On this network</button>
          </div>
          <div className="dm-funding-scene">
            <div className="dm-funding-networks" aria-label={mode === 'across' ? 'Funding networks' : 'Current network'}>
              {mode === 'across' ? FUNDING_NETWORKS.map(network => <span key={network}><NetworkMark network={network} variant="v4" />{network}</span>) : <span className="dm-funding-current"><i aria-hidden="true" />Robinhood Chain</span>}
            </div>
            <svg className="dm-funding-art" viewBox="0 0 800 300" role="img" aria-label={mode === 'across' ? 'Tokens from another network are transferred and swapped into the two tokens for your position.' : 'A token in your wallet is swapped into the two tokens for your position.'}>
              <defs>
                <linearGradient id={wallet} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#26221d" /><stop offset="1" stopColor="#151310" /></linearGradient>
                <linearGradient id={tile} x1="0.2" y1="0" x2="0.8" y2="1"><stop offset="0" stopColor="#ffc39c" /><stop offset="0.3" stopColor="#ffa771" /><stop offset="0.55" stopColor="#ff9d62" /><stop offset="1" stopColor="#f28a4c" /></linearGradient>
              </defs>
              <line className="dm-funding-seam" x1="421" y1="40" x2="421" y2="252" />
              {SOURCES.map((y, i) => <path key={`r${y}`} className={`dm-funding-route dm-funding-route-${i}`} pathLength={100} d={route(y)} />)}
              {SOURCES.map((y, i) => <path key={`d${y}`} className={`dm-funding-dot dm-funding-dot-w dm-funding-dot-${i}`} pathLength={100} d={route(y)} />)}
              <path className="dm-funding-lane dm-funding-lane-a" d={ACROSS} />
              <path className="dm-funding-lane dm-funding-lane-l" d={LOCAL} />
              <path className="dm-funding-lane" d="M462 226 H 556" />
              <path className="dm-funding-lit" pathLength={100} d={mode === 'across' ? ACROSS : LOCAL} />
              <path className="dm-funding-dot dm-funding-dot-w dm-funding-dot-step" pathLength={100} d={mode === 'across' ? ACROSS : LOCAL} />
              <path className="dm-funding-out" pathLength={100} d={OUT_A} />
              <path className="dm-funding-out" pathLength={100} d={OUT_B} />
              <path className="dm-funding-dot dm-funding-dot-a" pathLength={100} d={OUT_A} />
              <path className="dm-funding-dot dm-funding-dot-b" pathLength={100} d={OUT_B} />
              <g transform="translate(228 50.4) scale(0.8)">
                <g className="dm-funding-wallet">
                  <path d="M62 128V112q0-10 10-10h88v26" fill="#2d2923" stroke="rgb(255 236 220 / 0.14)" />
                  <rect x="50" y="124" width="140" height="108" rx="20" fill={`url(#${wallet})`} stroke="rgb(255 236 220 / 0.14)" />
                  <rect x="150" y="152" width="52" height="40" rx="11" fill="#2d2923" stroke="rgb(255 236 220 / 0.16)" />
                  <circle cx="166" cy="172" r="4.5" fill="#ff9d62" />
                  <circle cx="98" cy="178" r="24" fill="#f3ebe0" />
                  <path d="M98 160.5 89 175.6 98 181 107 175.6Z M89 177.6 98 190.5 107 177.6 98 183Z" fill="#161411" />
                </g>
              </g>
              <g transform="rotate(-7 504 145)">
                <g className="dm-funding-domino">
                  <rect x="457" y="61" width="104" height="182" rx="17" fill="#7c4223" />
                  <rect x="452" y="54" width="104" height="182" rx="17" fill={`url(#${tile})`} />
                  <path d="M464 145h80" stroke="rgb(84 34 8 / 0.55)" strokeWidth="2" strokeLinecap="round" />
                  {PIPS.map(([x, y]) => <circle key={`${x}-${y}`} cx={452 + 104 * x} cy={54 + 182 * y} r="8" fill="#2c1a10" />)}
                </g>
              </g>
              <g className="dm-funding-pair">
                <rect x="640.5" y="80.5" width="159" height="155" rx="20" className="dm-funding-node" />
                <circle className="dm-funding-disc dm-funding-disc-a" cx="688" cy="128" r="22" />
                <text x="688" y="133" className="dm-funding-symbol">A</text>
                <circle className="dm-funding-disc dm-funding-disc-b" cx="728" cy="128" r="22" />
                <text x="728" y="133" className="dm-funding-symbol dm-funding-symbol-b">B</text>
                <rect x="662" y="176" width="116" height="4" rx="2" className="dm-funding-bar" />
                <rect x="680" y="176" width="76" height="4" rx="2" className="dm-funding-bar-in" />
                <circle cx="719" cy="178" r="5" className="dm-funding-bar-knob" />
                <text x="720" y="212" className="dm-funding-small">Your chosen pair</text>
              </g>
              <text x="329" y="282" className="dm-funding-label">Your wallet</text><text x="504" y="282" className="dm-funding-label">{middle}</text><text x="720" y="282" className="dm-funding-label">Your position</text>
            </svg>
          </div>
          <div className="dm-funding-mobile-stages" aria-hidden="true"><span>Your wallet</span><span>{middle}</span><span>Your position</span></div>
          <p className="dm-funding-caption">{mode === 'across' ? 'Bring supported tokens across networks.' : 'Use one supported token for both sides of your pair.'}<span>You approve each step.</span></p>
        </div>
      </div>
    </div>
  </section>
}
