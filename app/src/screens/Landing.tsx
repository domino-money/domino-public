import { DominoSequence } from '../components/DominoSequence'
import { HeroWidget } from '../components/HeroWidget'
import { MarketsTable } from '../components/MarketsTable'
import { ProductCards } from '../components/ProductCards'
import { RangeSimulator } from '../components/RangeSimulator'
import { HeroBackdrop } from '../components/HeroBackdrop'
import { TokenIcon } from '../components/TokenIcon'
import { Card, Display, Eyebrow, Pill } from '../components/ui'

const STEPS = [
  {
    n: '01',
    title: 'Choose a token and a range',
    body: 'Start from what your wallet already holds. Domino shows the actual amount of each asset the position needs at today’s price, not a 50/50 guess.',
  },
  {
    n: '02',
    title: 'Review every signature',
    body: 'Each approval and transaction is shown before you sign it: what it does, what it costs and where it goes. Nobody promises you a single signature.',
  },
  {
    n: '03',
    title: 'Let the upkeep run',
    body: 'Earned fees are added back when the numbers justify it. When they are not, Domino waits and tells you why. Every run leaves a receipt you can read.',
  },
]

const LIMITS = [
  { title: 'It does not remove market risk', body: 'Prices move and your position moves with them. Below your range you hold the volatile token; above it, the stablecoin.' },
  { title: 'It does not promise a return', body: 'Fees are separate from profit. A position can collect fees for weeks and still be worth less than if you had simply held the assets.' },
  { title: 'It does not take custody', body: 'Your wallet owns the position and signs every change. Pausing the automation does not withdraw liquidity, and you can leave without us.' },
  { title: 'It does not touch your principal', body: 'Automation only ever works with the fees a position has earned. Your deposit, your unused fee balance and any price appreciation are never touched.' },
]

export function Landing() {
  return (
    <main>
      {/* Hero: the headline and the product, nothing in between. Full width and
          pulled up under the clear header, so the backdrop fills the page from
          the top down to the pools. The 40px is the ticker above the header. */}
      <section className="relative -mt-[var(--header-h)] flex min-h-[calc(100vh-40px)] flex-col justify-center overflow-hidden px-5 pb-24 pt-[calc(var(--header-h)+80px)] sm:pb-32 sm:pt-[calc(var(--header-h)+112px)]">
        <HeroBackdrop />
        <div className="relative text-center">
          <Display as="h1" className="dm-rise mx-auto max-w-[14ch] text-[46px] leading-[1.04] sm:text-[66px]">
            Liquidity you can <span style={{ color: 'var(--primary)' }}>actually see.</span>
          </Display>
        </div>
        <div className="dm-rise relative mt-9" style={{ '--delay': '0.1s' } as React.CSSProperties}>
          <HeroWidget />
        </div>
        <p className="dm-rise relative mx-auto mt-6 max-w-[46ch] text-center text-[13px] leading-relaxed text-fg-muted" style={{ '--delay': '0.18s' } as React.CSSProperties}>
          Open a liquidity position on Robinhood Chain and watch exactly what it holds. Your wallet signs everything and stays the owner.
        </p>
      </section>

      <div className="mx-auto max-w-[1220px] px-5">
        {/* Pools come first, the way an exchange leads with its markets */}
        <section id="pools" className="mt-6 scroll-mt-24">
          <MarketsTable />
        </section>

        {/* Then the product */}
        <section className="mt-28">
          <div className="mb-8 text-center">
            <Display className="mx-auto max-w-[18ch] text-[40px]">Made for every way to hold liquidity.</Display>
            <p className="mx-auto mt-3 max-w-[54ch] text-[15px] text-fg-muted">Positions, reinvestment, the Domino sequence and receipts you can actually read. All in one place.</p>
          </div>
          <ProductCards />
        </section>

        <section className="mt-24">
          <RangeSimulator />
        </section>

        <section className="mt-24">
          <Card level={2} className="p-8 lg:p-10">
            <div className="grid gap-8 lg:grid-cols-[0.85fr_1.15fr]">
              <div>
                <Pill tone="accent">Advanced</Pill>
                <Display className="mt-4 text-[32px]">One position sets up the next.</Display>
                <p className="mt-4 text-[14px] leading-relaxed text-fg-muted">
                  Normally a position reinvests its fees into itself. As the price climbs into the top of its range, Domino points those fees at the next position instead, so each one stands up the one above it.
                </p>
                <p className="mt-3 text-[14px] leading-relaxed text-fg-muted">
                  The successor is funded from earned fees only. Your deposit is never moved and nothing is pulled from your wallet. Every successor is another position in the same pool, not a new pool.
                </p>
                <p className="mt-4 text-[12px] leading-relaxed text-fg-subtle">Invite only, after its own security review. Holding several positions at once can increase your exposure if the price reverses.</p>
              </div>
              <DominoSequence />
            </div>
          </Card>
        </section>

        <section id="learn" className="mt-24 scroll-mt-24">
          <Eyebrow>How it works</Eyebrow>
          <Display className="mt-3 max-w-[20ch] text-[34px]">Three decisions, then it runs itself.</Display>
          <div className="mt-8 grid gap-5 md:grid-cols-3">
            {STEPS.map((step) => (
              <Card key={step.n} className="p-6">
                <span className="font-mono text-[12px] tracking-[0.5px]" style={{ color: 'var(--primary)' }}>{step.n}</span>
                <h3 className="mt-3 text-[16px] font-medium">{step.title}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-fg-muted">{step.body}</p>
              </Card>
            ))}
          </div>
        </section>

        <section className="mt-24">
          <Eyebrow>Before you start</Eyebrow>
          <Display className="mt-3 max-w-[22ch] text-[34px]">What Domino does not do.</Display>
          <p className="mt-3 max-w-[58ch] text-[14px] text-fg-muted">Most of this lives in the small print elsewhere. Here it is the first thing you read.</p>
          <div className="mt-8 grid gap-5 sm:grid-cols-2">
            {LIMITS.map((limit) => (
              <Card key={limit.title} className="p-6">
                <h3 className="text-[15px] font-medium">{limit.title}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-fg-muted">{limit.body}</p>
              </Card>
            ))}
          </div>
        </section>

        <section className="mt-20">
          <a
            href="https://uniswap.org"
            target="_blank"
            rel="noreferrer"
            className="group relative flex flex-col items-start gap-6 overflow-hidden rounded-[28px] p-7 transition-transform duration-300 hover:-translate-y-1 sm:flex-row sm:items-center sm:justify-between sm:p-8"
            style={{ background: 'color-mix(in srgb, #FF007A 12%, transparent)' }}
          >
            <div className="pointer-events-none absolute -left-16 -top-16 h-64 w-64 rounded-full opacity-50 blur-3xl transition-opacity duration-500 group-hover:opacity-80" style={{ background: '#FF007A' }} aria-hidden="true" />
            <div className="pointer-events-none absolute -bottom-20 right-10 h-56 w-56 rounded-full opacity-30 blur-3xl" style={{ background: '#FC72FF' }} aria-hidden="true" />
            <div className="relative flex items-center gap-5">
              <div className="dm-float rounded-full" style={{ '--dur': '9s', '--dx': '4px', '--dy': '-8px', boxShadow: '0 24px 60px -16px rgba(255,0,122,0.55)' } as React.CSSProperties}>
                <TokenIcon symbol="UNI" size={64} />
              </div>
              <div>
                <span className="font-mono text-[11px] uppercase tracking-[0.6px]" style={{ color: '#FF6FBE' }}>Protocol</span>
                <h3 className="mt-1 font-display text-[26px] leading-tight">Built on Uniswap v4</h3>
                <p className="mt-1.5 max-w-[52ch] text-[14px] leading-relaxed text-fg-muted">Every Domino position is a standard v4 position on Robinhood Chain. Domino looks after its upkeep and nothing else.</p>
              </div>
            </div>
            <span className="relative inline-flex items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-pill)] px-4 py-2 text-[13px] font-medium text-white transition group-hover:gap-2.5" style={{ background: '#FF007A' }}>
              Learn about v4 <span aria-hidden="true">→</span>
            </span>
          </a>
        </section>
      </div>
    </main>
  )
}
