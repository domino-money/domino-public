import { useEffect, useRef, useState } from 'react'
import { IconChevronRight } from '../icons'
import { LinkButton } from '../ui'
import { ChapterTitle, Stop } from './HomeType'
import { useInView } from './Vignettes'
import { useSvgId } from '../charts/series'
import { homeStory, locOf, useHomeStoryState } from './homeStory'

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
   domino over the line between networks), your position's pair. While the reader is in this place (homeStory's act) its
   story plays once and holds the complete picture: the chosen source's route lights and its token travels to the wallet,
   the wallet takes it, the step lights, two tokens leave for your pair, the pair takes them and its range fills. A source
   chip (across networks) picks the route and starts the story again; so does the switch. */
const SOURCES = [42, 86, 130, 174, 218] as const
const route = (y: number) => `M184 ${y} C 228 ${y} 232 222 268 222`
const ACROSS = 'M390 222 C 404 150 444 150 462 226'
const LOCAL = 'M390 222 L 462 226'
const OUT_A = 'M556 226 C 610 226 640 128 688 128'
const OUT_B = 'M556 226 C 630 226 700 200 728 150'
const PIPS: ReadonlyArray<[number, number]> = [[0.31, 0.15], [0.69, 0.35], [0.28, 0.62], [0.5, 0.75], [0.72, 0.88]]

/** A travelling token: a soft ring and its core, one dash moving along the path (both paths inherit the dash). */
function Token({ className, d, glow }: { className: string; d: string; glow: string }) {
  return (
    <g className={`dm-funding-dot ${className}`} filter={`url(#${glow})`}>
      <path className="dm-funding-dot-ring" pathLength={100} d={d} />
      <path className="dm-funding-dot-core" pathLength={100} d={d} />
    </g>
  )
}

/** Explanatory scene only; no wallet scan or transfer quote is requested. */
export function HomeCapabilities() {
  const [mode, setMode] = useState<'across' | 'local'>('across')
  const [picked, setPicked] = useState(0)
  // Back from "On this network", the four other networks brighten again (V4 .fs-chip.is-off leaving, .35s).
  const [returned, setReturned] = useState(false)
  const [ref, running] = useInView<HTMLDivElement>(0.25)
  const story = useHomeStoryState()
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(pending.current), [])
  const wallet = useSvgId('funding-wallet')
  const tile = useSvgId('funding-tile')
  const pip = useSvgId('funding-pip')
  const shade = useSvgId('funding-shade')
  const face = useSvgId('funding-face')
  const blur = useSvgId('funding-blur')
  const glowW = useSvgId('funding-glow-w')
  const glowA = useSvgId('funding-glow-a')
  const glowB = useSvgId('funding-glow-b')
  const node = useSvgId('funding-node')
  const nodeDrop = useSvgId('funding-node-drop')
  const nodeOut = useSvgId('funding-node-out')
  const discA = useSvgId('funding-disc-a')
  const source = mode === 'local' ? 4 : picked
  // The travelling tile stands on the step from 1280px; its place is lit only while it is away (CSS).
  const here = story.ready && locOf(story.act, story.rangeOpen) === 'fund'
  const choose = (index: number) => {
    clearTimeout(pending.current)
    if (mode === 'local' || index === picked) return
    setPicked(index)
    homeStory.restartFunding()
  }
  const hover = (index: number) => {
    clearTimeout(pending.current)
    pending.current = setTimeout(() => choose(index), 90)
  }
  const switchTo = (next: 'across' | 'local') => {
    if (next === mode) return
    setMode(next)
    setReturned(next === 'across')
    if (next === 'across') setPicked(0)
    homeStory.restartFunding()
  }
  return <section id="funding" className="dm-home-funding dm-home-chapter" aria-labelledby="dm-funding-title">
    <ChapterTitle id="dm-funding-title" first="Start with" second={<>what you have<Stop /></>} />
    <div className="dm-funding-grid">
      <div className="dm-funding-copy">
        <p>Use tokens in your wallet, even on another network. Domino finds a route into your chosen pair.</p>
        <LinkButton href="#/positions" variant="ghost" className="dm-home-more">Find your funds <IconChevronRight size={16} /></LinkButton>
        <details className="dm-funding-details"><summary>Networks and transfers</summary><p>Domino checks Ethereum, Base, Arbitrum One, OP Mainnet and Robinhood Chain. Available transfers depend on the token and destination. Review swaps, transfer costs and network fees before you approve in your wallet.</p></details>
      </div>
      {/* The card's lit rim sits on this frame, outside the demonstration whose own motion is its story alone. */}
      <div className="dm-funding-card dm-lit">
        <div ref={ref} className={'dm-funding-demonstration ' + (running ? 'is-running' : '')} data-funding-mode={mode} data-live={story.act === 'fund' ? '' : undefined} data-fp={story.fundKey}>
          {/* An empty, unseen keeper: its loop marks the scene as running for the shared motion checks (paused off
              screen and in a hidden tab, gone under reduced motion). It moves nothing a reader can see. */}
          <span className="dm-funding-hold" aria-hidden="true" />
          <div className="dm-funding-switch" role="group" aria-label="Funding example">
            <span className="dm-funding-thumb" aria-hidden="true" />
            <button type="button" aria-pressed={mode === 'across'} onClick={() => switchTo('across')}>From another network</button>
            <button type="button" aria-pressed={mode === 'local'} onClick={() => switchTo('local')}>On this network</button>
          </div>
          <div className="dm-funding-scene">
            {/* On this network the four other networks stay in their places, dimmed (V4 .fs-chip.is-off): a picture only,
                outside the list of networks, which then names the current one alone. */}
            {mode === 'local' && (
              <div className="dm-funding-ghosts" aria-hidden="true">
                {FUNDING_NETWORKS.slice(0, 4).map((network) => <span key={network}><NetworkMark network={network} variant="v4" />{network}</span>)}
              </div>
            )}
            <div className="dm-funding-networks" aria-label={mode === 'across' ? 'Funding networks' : 'Current network'}>
              {mode === 'across'
                ? FUNDING_NETWORKS.map((network, index) => (
                  <span key={network} className={returned && index < 4 ? 'is-back' : undefined} role="button" tabIndex={0} aria-pressed={index === source} onMouseEnter={() => hover(index)} onFocus={() => choose(index)} onClick={() => choose(index)}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(index) } }}>
                    <NetworkMark network={network} variant="v4" />{network}
                  </span>
                ))
                : <span className="dm-funding-current"><i aria-hidden="true" />Robinhood Chain</span>}
            </div>
            <svg className="dm-funding-art" viewBox="0 0 800 300" role="img" aria-label={mode === 'across' ? 'Tokens from another network are transferred and swapped into the two tokens for your position.' : 'A token in your wallet is swapped into the two tokens for your position.'}>
              <defs>
                <linearGradient id={wallet} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#26221d" /><stop offset="1" stopColor="#151310" /></linearGradient>
                <linearGradient id={tile} x1="0.2" y1="0" x2="0.8" y2="1"><stop offset="0" stopColor="#ffc39c" /><stop offset="0.3" stopColor="#ffa771" /><stop offset="0.55" stopColor="#ff9d62" /><stop offset="1" stopColor="#f28a4c" /></linearGradient>
                <radialGradient id={pip} cx="0.5" cy="0.38" r="0.5"><stop offset="0" stopColor="#1a110b" /><stop offset="0.7" stopColor="#3b2416" /><stop offset="1" stopColor="#4a2c1a" /></radialGradient>
                <linearGradient id={shade} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#82340e" stopOpacity="0" /><stop offset="1" stopColor="#82340e" stopOpacity="0.35" /></linearGradient>
                <clipPath id={face}><rect x="452" y="54" width="104" height="182" rx="17" /></clipPath>
                <filter id={blur} x="400" y="40" width="210" height="280" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="15" /></filter>
                <filter id={glowW} x="0" y="0" width="800" height="300" filterUnits="userSpaceOnUse"><feDropShadow dx="0" dy="0" stdDeviation="8" floodColor="#ffecdc" floodOpacity="0.35" /></filter>
                <filter id={glowA} x="0" y="0" width="800" height="300" filterUnits="userSpaceOnUse"><feDropShadow dx="0" dy="0" stdDeviation="7" floodColor="#ff9d62" floodOpacity="0.55" /></filter>
                <filter id={glowB} x="0" y="0" width="800" height="300" filterUnits="userSpaceOnUse"><feDropShadow dx="0" dy="0" stdDeviation="7" floodColor="#6fa856" floodOpacity="0.45" /></filter>
                <linearGradient id={node} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffecdc" stopOpacity="0.05" /><stop offset="1" stopColor="#ffecdc" stopOpacity="0.015" /></linearGradient>
                <filter id={nodeDrop} x="600" y="60" width="240" height="260" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="20" /></filter>
                {/* A box shadow is never drawn under its own box: the drop shows only outside the card's translucent face. */}
                <mask id={nodeOut} maskUnits="userSpaceOnUse" x="600" y="60" width="240" height="260"><rect x="600" y="60" width="240" height="260" fill="#fff" /><rect x="640" y="80" width="160" height="156" rx="20" fill="#000" /></mask>
                <linearGradient id={discA} x1="0.33" y1="0" x2="0.67" y2="1"><stop offset="0" stopColor="#ffb07f" /><stop offset="1" stopColor="#f28a4c" /></linearGradient>
              </defs>
              <line className="dm-funding-seam" x1="421" y1="40" x2="421" y2="252" />
              {SOURCES.map((y, i) => <path key={`r${y}`} className={`dm-funding-route dm-funding-route-${i} ${i === source ? 'is-lit' : 'is-dim'}`} pathLength={100} d={route(y)} />)}
              <path className="dm-funding-lane dm-funding-lane-a" d={ACROSS} />
              <path className="dm-funding-lane dm-funding-lane-l" d={LOCAL} />
              <path className="dm-funding-lane" d="M462 226 H 556" />
              <path className="dm-funding-lit dm-funding-lit-a" pathLength={100} d={ACROSS} />
              <path className="dm-funding-lit dm-funding-lit-l" pathLength={100} d={LOCAL} />
              <path className="dm-funding-out" pathLength={100} d={OUT_A} />
              <path className="dm-funding-out" pathLength={100} d={OUT_B} />
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
              <g className="dm-funding-pair">
                {/* The pair's card (V4 .fs-node): its drop under it, a soft lift, the ring and a lit top edge. */}
                <rect x="664" y="124" width="112" height="108" fill="#000" fillOpacity="0.9" filter={`url(#${nodeDrop})`} mask={`url(#${nodeOut})`} />
                <rect x="640.5" y="80.5" width="159" height="155" rx="20" fill={`url(#${node})`} className="dm-funding-node" />
                <path d="M660 81.5 H780" className="dm-funding-node-lip" />
                <circle className="dm-funding-disc dm-funding-disc-a" cx="688" cy="128" r="22" fill={`url(#${discA})`} />
                <text x="688" y="133" className="dm-funding-symbol">A</text>
                <circle className="dm-funding-disc dm-funding-disc-b" cx="728" cy="128" r="22" />
                <text x="728" y="133" className="dm-funding-symbol dm-funding-symbol-b">B</text>
                <rect x="662" y="178" width="116" height="4" rx="2" className="dm-funding-bar" />
                <rect x="680" y="178" width="76" height="4" rx="2" className="dm-funding-bar-in" />
                <circle cx="719" cy="180" r="5" className="dm-funding-bar-knob" />
                <text x="720" y="212" className="dm-funding-small">Your chosen pair</text>
              </g>
              <Token className="dm-funding-dot-w dm-funding-dot-src" d={route(SOURCES[source])} glow={glowW} />
              <Token className="dm-funding-dot-w dm-funding-dot-step dm-funding-dot-step-a" d={ACROSS} glow={glowW} />
              <Token className="dm-funding-dot-w dm-funding-dot-step dm-funding-dot-step-l" d={LOCAL} glow={glowW} />
              <Token className="dm-funding-dot-a" d={OUT_A} glow={glowA} />
              <Token className="dm-funding-dot-b" d={OUT_B} glow={glowB} />
              {/* The still tile on the step (narrower screens; from 1280px the travelling tile stands here instead): its
                  soft floor shadow, the face with its lit top edge and warm lower shade, the groove and five pips. */}
              <g transform="rotate(-7 504 145)">
                <g className="dm-funding-domino">
                  <rect x="464" y="84" width="80" height="158" rx="6" fill="#000" fillOpacity="0.75" filter={`url(#${blur})`} />
                  <rect x="452" y="54" width="104" height="182" rx="17" fill={`url(#${tile})`} />
                  <g clipPath={`url(#${face})`}>
                    <rect x="452" y="54" width="104" height="1.5" fill="#fff0e4" fillOpacity="0.7" />
                    <rect x="452" y="222" width="104" height="14" fill={`url(#${shade})`} />
                  </g>
                  <path d="M464 145h80" stroke="rgb(84 34 8 / 0.55)" strokeWidth="2" strokeLinecap="round" />
                  {PIPS.map(([x, y]) => <circle key={`${x}-${y}`} cx={452 + 104 * x} cy={54 + 182 * y} r="8" fill={`url(#${pip})`} />)}
                </g>
              </g>
              {/* The middle step's two names share one place and cross-fade with the switch (V4 .zswap). The three names sit on
                  the prototype's baseline (its labels' line box starts 270 design px down). */}
              <text x="329" y="285" className="dm-funding-label">Your wallet</text>
              <text x="504" y="285" className="dm-funding-label dm-zs-a">Transfer + swap</text><text x="504" y="285" className="dm-funding-label dm-zs-b">Swap</text>
              <text x="720" y="285" className="dm-funding-label">Your position</text>
            </svg>
            <span className={here ? 'dm-foot dm-fs-foot' : 'dm-foot dm-fs-foot is-away'} aria-hidden="true" />
          </div>
          <div className="dm-funding-mobile-stages" aria-hidden="true"><span>Your wallet</span><span className="dm-zswap"><span className="dm-zs-a">Transfer + swap</span><span className="dm-zs-b">Swap</span></span><span>Your position</span></div>
          <p className="dm-funding-caption">
            <span className="dm-zswap">
              <span className="dm-zs-a" aria-hidden={mode === 'across' ? undefined : true}>Bring supported tokens across networks.</span>
              <span className="dm-zs-b" aria-hidden={mode === 'local' ? undefined : true}>Use one supported token for both sides of your pair.</span>
            </span>
            <span>You approve each step.</span>
          </p>
        </div>
      </div>
    </div>
  </section>
}
