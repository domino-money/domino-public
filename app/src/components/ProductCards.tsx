import { cx } from './ui'

/**
 * Four product cards in the manner of an exchange's landing page: a deep
 * colour per card, an eyebrow with a small mark, the title in the card's own
 * colour, a short line and a big graphic that runs off the right edge. Built
 * from shapes, not screenshots, and wordless: no pair, token or amount is
 * drawn. None of these features is part of the alpha, and each card says so.
 */

type Theme = { bg: string; ink: string; soft: string; pillBg: string }

const THEMES: Record<'orange' | 'green' | 'blue' | 'plum', Theme> = {
  orange: { bg: '#3a2214', ink: '#ff9d62', soft: '#e8b394', pillBg: 'rgba(0,0,0,0.35)' },
  green: { bg: '#10301f', ink: '#5ee0a0', soft: '#a9d9bf', pillBg: 'rgba(0,0,0,0.35)' },
  blue: { bg: '#161f3f', ink: '#8fa0ff', soft: '#b8c1f0', pillBg: 'rgba(0,0,0,0.35)' },
  plum: { bg: '#2e1630', ink: '#f28ad9', soft: '#dfb3d8', pillBg: 'rgba(0,0,0,0.35)' },
}

const lift = '0 30px 60px -24px rgba(0,0,0,0.7)'

/* Three position cards climbing off the right edge: two plain marks and a range bar each. */
function PositionsArt({ t }: { t: Theme }) {
  const cards = [
    { x: 8, y: 58, w: 118, rot: -8, from: 18, span: 44 },
    { x: 44, y: 26, w: 136, rot: 6, from: 30, span: 36 },
    { x: 80, y: 60, w: 152, rot: -4, from: 12, span: 58 },
  ]
  return (
    <div className="absolute inset-y-0 right-0 w-[52%]">
      {cards.map((c, i) => (
        <div
          key={i}
          className="dm-float absolute"
          style={{ left: `${c.x}%`, top: `${c.y}%`, transform: `translate(-50%, -50%) rotate(${c.rot}deg)`, '--dur': `${11 + i * 3}s`, '--delay': `${-i * 2}s`, '--dx': '0px', '--dy': '-8px' } as React.CSSProperties}
        >
          <div className="rounded-[16px] border p-3" style={{ width: c.w, background: t.bg, borderColor: 'rgba(255,255,255,0.12)', boxShadow: lift }}>
            <div className="flex">
              <span className="h-6 w-6 rounded-full" style={{ background: t.soft, opacity: 0.55 }} />
              <span className="-ml-2 h-6 w-6 rounded-full border-2" style={{ background: t.ink, borderColor: t.bg }} />
            </div>
            <div className="mt-3 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.12)' }}>
              <div className="h-full rounded-full" style={{ marginLeft: `${c.from}%`, width: `${c.span}%`, background: t.ink }} />
            </div>
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

/* Floating slips, the lines of a receipt spread out in space, drawn as lines rather than words or amounts. */
function ReceiptArt({ t }: { t: Theme }) {
  const slips = [
    { w: 132, x: 30, y: 22, rot: -6 },
    { w: 104, x: 68, y: 46, rot: 5 },
    { w: 150, x: 38, y: 72, rot: -3, hot: true },
  ]
  return (
    <div className="absolute inset-y-0 right-0 w-[56%]">
      {slips.map((c, i) => (
        <div key={i} className="dm-float absolute" style={{ left: `${c.x}%`, top: `${c.y}%`, transform: `translate(-50%, -50%) rotate(${c.rot}deg)`, '--dur': `${10 + i * 2}s`, '--delay': `${-i * 1.8}s`, '--dx': '4px', '--dy': '-8px' } as React.CSSProperties}>
          <span className="block rounded-[12px] border px-4 py-3" style={{ width: c.w, background: c.hot ? t.ink : t.bg, borderColor: 'rgba(255,255,255,0.12)', boxShadow: c.hot ? `${lift}, 0 0 40px ${t.ink}66` : lift }}>
            <span className="block h-1.5 w-2/3 rounded-full" style={{ background: c.hot ? '#1d1020' : t.soft, opacity: 0.6 }} />
            <span className="mt-1.5 block h-1.5 w-1/3 rounded-full" style={{ background: c.hot ? '#1d1020' : t.soft, opacity: 0.35 }} />
          </span>
        </div>
      ))}
    </div>
  )
}

function Mark({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex h-4 w-4 items-center justify-center">{children}</span>
}

const CARDS: Array<{ key: keyof typeof THEMES; eyebrow: string; mark: React.ReactNode; title: string; body: string; cta?: string; href?: string; art: (t: Theme) => React.ReactNode }> = [
  {
    key: 'orange',
    eyebrow: 'Positions',
    mark: <Mark><svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><rect x="2" y="3" width="12" height="10" rx="2" /></svg></Mark>,
    title: 'Every position on one card.',
    body: 'What you hold, where your range sits, and whether it is collecting fees right now.',
    cta: 'Your positions',
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
    mark: <Mark><svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><rect x="4" y="1" width="8" height="14" rx="2" /><circle cx="8" cy="4.6" r="1.2" fill="#161f3f" /><circle cx="8" cy="11.4" r="1.2" fill="#161f3f" /></svg></Mark>,
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
    art: (t) => <ReceiptArt t={t} />,
  },
]

export function ProductCards() {
  return (
    <div className="grid gap-5 md:grid-cols-2">
      {CARDS.map((c) => {
        const t = THEMES[c.key]
        const content = (
          <>
            {c.art(t)}
            <div className="relative max-w-[52%]">
              <span className="flex items-center gap-2 text-[13px] font-medium" style={{ color: t.ink }}>
                {c.mark} {c.eyebrow}
              </span>
              <h3 className="mt-4 text-[30px] font-medium leading-[1.1] tracking-[-0.3px]" style={{ color: t.ink }}>{c.title}</h3>
              <p className="mt-3 text-[15px] leading-relaxed" style={{ color: t.soft }}>{c.body}</p>
            </div>
            <div className="relative mt-8 flex flex-wrap items-center gap-3">
              {c.cta && (
                <span className="inline-flex w-fit items-center gap-2 rounded-[var(--radius-pill)] px-4 py-2.5 text-[13px] font-medium transition group-hover:gap-3" style={{ background: t.pillBg, color: t.ink }}>
                  {c.cta} <span aria-hidden="true">→</span>
                </span>
              )}
              <span className="rounded-[var(--radius-pill)] border px-3 py-1.5 text-[12px]" style={{ borderColor: 'rgba(255,255,255,0.18)', color: t.soft }}>
                Not available in the alpha
              </span>
            </div>
          </>
        )
        const shape = 'group relative flex min-h-[320px] flex-col justify-between overflow-hidden rounded-[28px] p-8'
        return c.href ? (
          <a key={c.key} href={c.href} className={cx(shape, 'transition-transform duration-300 hover:-translate-y-1')} style={{ background: t.bg }}>
            {content}
          </a>
        ) : (
          <div key={c.key} className={shape} style={{ background: t.bg }}>
            {content}
          </div>
        )
      })}
    </div>
  )
}
