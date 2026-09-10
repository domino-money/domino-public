import { TokenIcon, TokenPair } from './TokenIcon'

/**
 * Four product cards in the manner of an exchange's landing page: a deep
 * colour per card, an eyebrow with a small mark, the title in the card's own
 * colour, a short line, a pill link with an arrow, and a big graphic that
 * runs off the right edge. Built from shapes, not screenshots.
 */

type Theme = { bg: string; ink: string; soft: string; pillBg: string }

const THEMES: Record<'orange' | 'green' | 'blue' | 'plum', Theme> = {
  orange: { bg: '#3a2214', ink: '#ff9d62', soft: '#e8b394', pillBg: 'rgba(0,0,0,0.35)' },
  green: { bg: '#10301f', ink: '#5ee0a0', soft: '#a9d9bf', pillBg: 'rgba(0,0,0,0.35)' },
  blue: { bg: '#161f3f', ink: '#8fa0ff', soft: '#b8c1f0', pillBg: 'rgba(0,0,0,0.35)' },
  plum: { bg: '#2e1630', ink: '#f28ad9', soft: '#dfb3d8', pillBg: 'rgba(0,0,0,0.35)' },
}

const lift = '0 30px 60px -24px rgba(0,0,0,0.7)'

/* Three pair badges climbing off the right edge, like coins stacked on a desk. */
function PositionsArt({ t }: { t: Theme }) {
  const pairs = [
    { base: 'MEME', quote: 'USDG', x: 6, y: 58, s: 66, rot: -8 },
    { base: 'WETH', quote: 'USDG', x: 42, y: 26, s: 78, rot: 6 },
    { base: 'ETH', quote: 'USDG', x: 78, y: 60, s: 92, rot: -4 },
  ]
  return (
    <div className="absolute inset-y-0 right-0 w-[52%]">
      {pairs.map((p, i) => (
        <div key={i} className="dm-float absolute" style={{ left: `${p.x}%`, top: `${p.y}%`, transform: `translate(-50%, -50%) rotate(${p.rot}deg)`, '--dur': `${11 + i * 3}s`, '--delay': `${-i * 2}s`, '--dx': '0px', '--dy': '-8px' } as React.CSSProperties}>
          <div className="flex items-center gap-2 rounded-full border px-2.5 py-2" style={{ background: t.bg, borderColor: 'rgba(255,255,255,0.12)', boxShadow: lift }}>
            <TokenPair base={p.base} quote={p.quote} size={Math.round(p.s * 0.5)} ring={t.bg} />
            <span className="pr-1 font-mono text-[12px]" style={{ color: t.soft }}>{p.base}/{p.quote}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

/* Rounded bars, each longer than the last: fee lots being added back, run after run. */
function ReinvestArt({ t }: { t: Theme }) {
  const bars = [34, 52, 44, 70, 60, 88]
  return (
    <div className="absolute -right-6 top-1/2 flex w-[52%] -translate-y-1/2 flex-col gap-3">
      {bars.map((w, i) => (
        <div key={i} className="dm-float h-7 rounded-full" style={{ width: `${w}%`, marginLeft: `${100 - w}%`, background: `linear-gradient(90deg, ${t.ink}22, ${t.ink}${i === bars.length - 1 ? 'ff' : '66'})`, boxShadow: i === bars.length - 1 ? `0 0 40px ${t.ink}66` : undefined, '--dur': `${9 + i}s`, '--delay': `${-i * 1.3}s`, '--dx': '6px', '--dy': '0px' } as React.CSSProperties} />
      ))}
    </div>
  )
}

/* Three big tiles climbing diagonally, the top one lit. */
function DominoArt({ t }: { t: Theme }) {
  const tiles = [
    { x: 8, y: 66, s: 96, lit: false, rot: -10 },
    { x: 46, y: 44, s: 110, lit: false, rot: -4 },
    { x: 86, y: 22, s: 124, lit: true, rot: 8 },
  ]
  return (
    <div className="absolute inset-y-0 right-0 w-[55%]">
      {tiles.map((tile, i) => (
        <div key={i} className="dm-float absolute" style={{ left: `${tile.x}%`, top: `${tile.y}%`, transform: `translate(-50%, -50%) rotate(${tile.rot}deg)`, '--dur': `${12 + i * 2}s`, '--delay': `${-i * 2.4}s`, '--dx': '0px', '--dy': '-10px' } as React.CSSProperties}>
          <div className="relative rounded-[22px]" style={{ width: tile.s * 0.62, height: tile.s, background: tile.lit ? `linear-gradient(160deg, ${t.ink}, #5866d6)` : 'linear-gradient(160deg, rgba(255,255,255,0.14), rgba(255,255,255,0.05))', boxShadow: tile.lit ? `${lift}, 0 0 60px ${t.ink}55` : lift, border: '1px solid rgba(255,255,255,0.12)' }}>
            <span className="absolute left-1/2 top-[18%] h-3 w-3 -translate-x-1/2 rounded-full" style={{ background: tile.lit ? '#fff' : t.soft, opacity: tile.lit ? 0.95 : 0.5 }} />
            <span className="absolute inset-x-3 top-1/2 h-px" style={{ background: tile.lit ? '#fff' : t.soft, opacity: 0.4 }} />
            <span className="absolute bottom-[18%] left-1/2 h-3 w-3 -translate-x-1/2 rounded-full" style={{ background: tile.lit ? '#fff' : t.soft, opacity: tile.lit ? 0.95 : 0.5 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

/* Floating chips, the lines of a receipt spread out in space. */
function ReceiptArt({ t }: { t: Theme }) {
  const chips = [
    { text: 'Card 02 · receipt', x: 30, y: 22, rot: -6 },
    { text: 'Nothing waiting', x: 68, y: 46, rot: 5 },
    { text: '+$41.16 reinvested', x: 38, y: 72, rot: -3, hot: true },
  ]
  return (
    <div className="absolute inset-y-0 right-0 w-[56%]">
      {chips.map((c, i) => (
        <div key={i} className="dm-float absolute" style={{ left: `${c.x}%`, top: `${c.y}%`, transform: `translate(-50%, -50%) rotate(${c.rot}deg)`, '--dur': `${10 + i * 2}s`, '--delay': `${-i * 1.8}s`, '--dx': '4px', '--dy': '-8px' } as React.CSSProperties}>
          <span className="tnum block whitespace-nowrap rounded-[12px] border px-4 py-2.5 font-mono text-[13px]" style={{ background: c.hot ? t.ink : t.bg, color: c.hot ? '#1d1020' : t.soft, borderColor: 'rgba(255,255,255,0.12)', boxShadow: c.hot ? `${lift}, 0 0 40px ${t.ink}66` : lift }}>
            {c.text}
          </span>
        </div>
      ))}
    </div>
  )
}

function Mark({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex h-4 w-4 items-center justify-center">{children}</span>
}

const CARDS: Array<{ key: keyof typeof THEMES; eyebrow: string; mark: React.ReactNode; title: string; body: string; cta: string; href: string; art: (t: Theme) => React.ReactNode; tall?: boolean }> = [
  {
    key: 'orange',
    eyebrow: 'Positions',
    mark: <Mark><svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><rect x="2" y="3" width="12" height="10" rx="2" /></svg></Mark>,
    title: 'Every position on one card.',
    body: 'What you hold, where your range sits, and whether it is collecting fees right now.',
    cta: 'Open the workspace',
    href: '#/app',
    art: (t) => <PositionsArt t={t} />,
  },
  {
    key: 'green',
    eyebrow: 'Reinvestment',
    mark: <Mark><svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M2 12h3V6H2zM6.5 12h3V3h-3zM11 12h3V8h-3z" /></svg></Mark>,
    title: 'Fees go back to work.',
    body: 'When it pays to, earned fees are added back to your position. When it does not, Domino waits and says why.',
    cta: 'See how it decides',
    href: '#/#learn',
    art: (t) => <ReinvestArt t={t} />,
  },
  {
    key: 'blue',
    eyebrow: 'Domino',
    mark: <Mark><TokenIcon symbol="MEME" size={14} /></Mark>,
    title: 'One position opens the next.',
    body: 'Near the top of its range, a position uses its fees to open the next one higher up. Your deposit never moves.',
    cta: 'Watch the sequence',
    href: '#/#learn',
    art: (t) => <DominoArt t={t} />,
  },
  {
    key: 'plum',
    eyebrow: 'Receipts',
    mark: <Mark><svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4 2h8v12l-2-1.2L8 14l-2-1.2L4 14zM6 5h4v1H6zm0 2.5h4v1H6z" /></svg></Mark>,
    title: 'Every action, itemised.',
    body: 'What was collected, what went back in and what is still waiting. On every run, down to fractions of a cent.',
    cta: 'Read a receipt',
    href: '#/app#activity',
    art: (t) => <ReceiptArt t={t} />,
  },
]

export function ProductCards() {
  return (
    <div className="grid gap-5 md:grid-cols-2">
      {CARDS.map((c) => {
        const t = THEMES[c.key]
        return (
          <a key={c.key} href={c.href} className="group relative flex min-h-[320px] flex-col justify-between overflow-hidden rounded-[28px] p-8 transition-transform duration-300 hover:-translate-y-1" style={{ background: t.bg }}>
            {c.art(t)}
            <div className="relative max-w-[52%]">
              <span className="flex items-center gap-2 text-[13px] font-medium" style={{ color: t.ink }}>
                {c.mark} {c.eyebrow}
              </span>
              <h3 className="mt-4 text-[30px] font-medium leading-[1.1] tracking-[-0.3px]" style={{ color: t.ink }}>{c.title}</h3>
              <p className="mt-3 text-[15px] leading-relaxed" style={{ color: t.soft }}>{c.body}</p>
            </div>
            <span className="relative mt-8 inline-flex w-fit items-center gap-2 rounded-[var(--radius-pill)] px-4 py-2.5 text-[13px] font-medium transition group-hover:gap-3" style={{ background: t.pillBg, color: t.ink }}>
              {c.cta} <span aria-hidden="true">→</span>
            </span>
          </a>
        )
      })}
    </div>
  )
}
