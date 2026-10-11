import { useState } from 'react'
import { IconChevronRight } from '../icons'
import { Display, LinkButton } from '../ui'
import { useInView } from './Vignettes'
import { useSvgId } from '../charts/series'

export const FUNDING_NETWORKS = ['Ethereum', 'Base', 'Arbitrum One', 'OP Mainnet', 'Robinhood Chain'] as const

/** Identifying marks always have a network name beside them. */
export function NetworkMark({ network }: { network: typeof FUNDING_NETWORKS[number] }) {
  return <span className="dm-network-mark" data-network={network} aria-hidden="true">
    {network === 'Ethereum' ? <svg viewBox="0 0 24 24"><path d="m12 2-6 10 6 3.5 6-3.5Zm-6 12 6 8 6-8-6 3.5Z" fill="currentColor" /></svg>
      : network === 'Base' ? <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="currentColor" /><path d="M3 12h10" stroke="var(--network-color)" strokeWidth="2" /></svg>
        : network === 'Arbitrum One' ? <svg viewBox="0 0 24 24"><path d="m12 2 9 5v10l-9 5-9-5V7Z" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m7 16 4-9h3l-4 9Zm7-5 3 5h-3l-1.5-2Z" fill="currentColor" /></svg>
          : network === 'OP Mainnet' ? <span>OP</span> : null}
  </span>
}

/** Explanatory scene only; no wallet scan or transfer quote is requested. */
export function HomeCapabilities() {
  const [mode, setMode] = useState<'across' | 'local'>('across')
  const [ref, running] = useInView<HTMLDivElement>(0.25)
  const surface = useSvgId('funding-surface')
  const tile = useSvgId('funding-tile')
  return <section id="funding" className="dm-home-funding dm-home-chapter" aria-labelledby="dm-funding-title">
    <div className="dm-funding-copy">
      <Display as="h2" id="dm-funding-title" className="dm-home-chapter-title">Start with<br /><em>what you have.</em></Display>
      <p>Use tokens in your wallet, even on another network. Domino finds a route into your chosen pair.</p>
      <LinkButton href="#/new" variant="ghost">Find your funds <IconChevronRight size={16} /></LinkButton>
      <details className="dm-funding-details"><summary>Networks and transfers</summary><p>Domino checks Ethereum, Base, Arbitrum One, OP Mainnet and Robinhood Chain. Available transfers depend on the token and destination. Review swaps, transfer costs and network fees before you approve in your wallet.</p></details>
    </div>
    <div ref={ref} className={'dm-funding-demonstration ' + (running ? 'is-running' : '')} data-funding-mode={mode}>
      <div className="dm-funding-switch" role="group" aria-label="Funding example">
        <button type="button" aria-pressed={mode === 'across'} onClick={() => setMode('across')}>From another network</button>
        <button type="button" aria-pressed={mode === 'local'} onClick={() => setMode('local')}>On this network</button>
      </div>
      <div className="dm-funding-networks" aria-label={mode === 'across' ? 'Funding networks' : 'Current network'}>
        {mode === 'across' ? FUNDING_NETWORKS.map(network => <span key={network}><NetworkMark network={network} />{network}</span>) : <span className="dm-funding-current"><i aria-hidden="true" />Robinhood Chain</span>}
      </div>
      <svg className="dm-funding-art" viewBox="0 0 640 285" role="img" aria-label={mode === 'across' ? 'Tokens from another network are transferred and swapped into the two tokens for your position.' : 'A token in your wallet is swapped into the two tokens for your position.'}>
        <defs>
          <linearGradient id={surface} x1="0" y1="0" x2="1" y2="1"><stop stopColor="var(--surface-3)" /><stop offset="1" stopColor="var(--surface-1)" /></linearGradient>
          <linearGradient id={tile} x1="0" y1="0" x2="1" y2="1"><stop stopColor="var(--fg)" /><stop offset="0.12" stopColor="var(--primary)" /><stop offset="1" stopColor="var(--primary-line)" /></linearGradient>
        </defs>
        <ellipse cx="326" cy="222" rx="235" ry="20" className="dm-funding-shadow" />
        <path d="M145 146H289M344 146H392Q413 146 426 131L456 101M392 146Q413 146 426 161L456 191" className="dm-funding-route" />
        <path d="M145 146H289" className="dm-funding-packet" />
        <path d="M344 146H392Q413 146 426 131L456 101M344 146H392Q413 146 426 161L456 191" className="dm-funding-split" />
        <g className="dm-funding-wallet">
          <rect x="45" y="101" width="119" height="86" rx="15" fill={'url(#' + surface + ')'} stroke="var(--border-strong)" />
          <path d="M57 101V88q0-10 10-10h76v23" fill="var(--surface-3)" stroke="var(--border-strong)" />
          <rect x="121" y="127" width="51" height="34" rx="9" fill="var(--surface-3)" stroke="var(--border-strong)" /><circle cx="134" cy="144" r="4" fill="var(--primary)" />
          <circle cx="81" cy="143" r="20" fill="var(--fg)" /><path d="m81 128-8 14 8 5 8-5Zm-8 17 8 12 8-12-8 5Z" fill="var(--bg)" />
        </g>
        <g transform="translate(280 85) rotate(8 35 61)"><g className="dm-funding-domino"><rect x="7" y="7" width="68" height="120" rx="13" fill="var(--primary-line)" opacity=".35" /><rect width="68" height="120" rx="13" fill={'url(#' + tile + ')'} /><path d="M4 60h60" stroke="var(--primary-fg)" opacity=".25" /><g fill="var(--primary-fg)"><circle cx="22" cy="21" r="5" /><circle cx="46" cy="41" r="5" /><circle cx="34" cy="90" r="5" /></g></g></g>
        <g className="dm-funding-pair">
          <rect x="430" y="52" width="165" height="171" rx="20" fill={'url(#' + surface + ')'} stroke="var(--border-strong)" />
          <circle cx="479" cy="110" r="29" fill="var(--primary)" /><text x="479" y="117" className="dm-funding-symbol">A</text>
          <circle cx="535" cy="110" r="29" fill="var(--funding-mint)" /><text x="535" y="117" className="dm-funding-symbol">B</text>
          <path d="M460 163h105" stroke="var(--border-strong)" strokeWidth="4" strokeLinecap="round" /><path d="M471 163h74" stroke="var(--primary)" strokeWidth="4" strokeLinecap="round" /><circle cx="507" cy="163" r="6" fill="var(--fg)" />
          <text x="512" y="195" className="dm-funding-small">Your chosen pair</text>
        </g>
        <text x="107" y="259" className="dm-funding-label">Your wallet</text><text x="318" y="259" className="dm-funding-label">{mode === 'across' ? 'Transfer + swap' : 'Swap'}</text><text x="512" y="259" className="dm-funding-label">Your position</text>
      </svg>
      <div className="dm-funding-mobile-stages" aria-hidden="true"><span>Your wallet</span><span>{mode === 'across' ? 'Transfer + swap' : 'Swap'}</span><span>Your position</span></div>
      <p className="dm-funding-caption">{mode === 'across' ? 'Bring supported tokens across networks.' : 'Use one supported token for both sides of your pair.'}<span>You approve each step.</span></p>
    </div>
  </section>
}
