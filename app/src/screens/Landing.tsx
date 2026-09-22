import type { CSSProperties } from 'react'
import { MarketsTable } from '../components/MarketsTable'
import { RangeSimulator } from '../components/RangeSimulator'
import { FeatureCards } from '../components/home/FeatureCards'
import { HeroArt } from '../components/home/HeroArt'
import { useInView } from '../components/home/Vignettes'
import { Chip, Display, LinkButton, LiveDot, PageShell, Pill, cx } from '../components/ui'
import { ROADMAP, ROADMAP_PILL } from '../lib/capabilities'
import type { MarketsState } from '../lib/read/marketsProvider'
import { useMarkets } from '../lib/read/useMarkets'

/*
 * Home. The headline and the two ways in, what automation does with fees,
 * then the selected pools. Below them it explains: how a position comes
 * together, what a range does as the price moves, and what Domino does not
 * do. Home sends no read of its own: the hero chip and the table share the
 * app's one markets provider.
 */

/**
 * A one-time entrance: rise and fade in, then nothing stays applied (backwards
 * fill only), so no block keeps a transform that would trap a fixed dialog.
 */
const RISE = 'animate-[dm-rise_var(--dur-enter)_var(--ease-enter)_backwards]'
const delay = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` })

const STEPS: ReadonlyArray<{ n: string; title: string; body: string; roadmap?: ReadonlyArray<string> }> = [
  {
    n: '01',
    title: 'Decide which tokens you want to pool, set your range',
    body: 'Search for your token and pick one of the pools that already exists for it. The Range step draws the price band this position earns fees in, and the pool you pick carries the fee.',
  },
  {
    n: '02',
    title: 'Review, then sign in Setup',
    body: 'Review every choice, the fees and the wallet steps before anything is sent. The deposit itself is signed in Setup, one reviewed wallet step at a time.',
  },
  {
    n: '03',
    title: 'Automation',
    body: 'Three choices: Self-managing, Auto-compound or Domino-compound.',
    roadmap: ['Compound', 'Domino'],
  },
]

const LIMITS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'It does not remove market risk',
    body: 'Prices move and your position moves with them. Outside its range a position holds only one of its two tokens: the one that lost value against the other.',
  },
  {
    title: 'It does not promise a return',
    body: 'Fees are not profit. A position can collect fees for weeks and still be worth less than holding the assets.',
  },
  {
    title: 'It does not take custody',
    body: 'Your wallet signs every deposit, permission and withdrawal. Automation acts only within the limits you signed, and you can pause or revoke it.',
  },
  {
    title: 'It does not touch your principal',
    body: 'Automation spends earned fees only, and the contract does not let it reduce a position’s liquidity.',
  },
]

/** The pill ROADMAP gives the first named capability that wears one, so Home says what Settings and the docs say. */
const roadmapPill = (names: ReadonlyArray<string>): string | undefined => ROADMAP.filter((entry) => names.includes(entry.name)).map((entry) => ROADMAP_PILL[entry.status]).find((label) => label !== undefined)

/**
 * The newest block a live pool row was read at, or null. Only a ready answer
 * from the live read path counts: no loading state, no retained or fixture
 * rows, and no row without its own verification block.
 */
function liveBlock(state: MarketsState): number | null {
  if (state.phase !== 'ready' || state.result.source !== 'live') return null
  let block: number | null = null
  for (const market of state.result.markets) {
    const at = market.provenance?.block
    if (at !== undefined && (block === null || at > block)) block = at
  }
  return block
}

/** The chain the pools live on. Its dot lights, and the chip names the block, only once a live pool row has arrived. */
function HeroChip() {
  const { state } = useMarkets()
  const block = liveBlock(state)
  return (
    <Chip
      variant="plate"
      icon={<LiveDot lit={block !== null} />}
      title={block === null ? undefined : `Pool data read from Robinhood Chain at block ${block}`}
      className={RISE}
      style={delay(0)}
    >
      On Robinhood Chain
    </Chip>
  )
}

/** The headline plate. Its drawing plays while at least 30% of the plate is in view. */
function Hero() {
  const [plate, inView] = useInView<HTMLDivElement>(0.3)
  return (
    <div ref={plate} className="dm-plate dm-dots-hero dm-hero">
      <div className="dm-hero-body">
        <HeroChip />
        <Display as="h1" className={cx('dm-display-hero mt-5 text-balance', RISE)} style={delay(0)}>
          Earn fees on your tokens, <span className="dm-hero-accent">on your own terms.</span>
        </Display>
        <p className={cx('mt-4 max-w-[60ch] text-body text-fg-muted', RISE)} style={delay(60)}>
          You pick the pool and the range, and nothing moves until your wallet signs.
        </p>
        <div className={cx('mt-6 flex w-full items-center justify-center gap-2', RISE)} style={delay(120)}>
          <LinkButton href="#/markets" className="max-md:h-11 max-md:flex-1 max-md:px-[18px]">
            Explore markets
          </LinkButton>
          <LinkButton href="#/new" variant="outline" className="max-md:h-11 max-md:flex-1 max-md:px-[18px]">
            New position
          </LinkButton>
        </div>
      </div>
      <div className="dm-hero-band">
        <HeroArt running={inView} />
      </div>
    </div>
  )
}

function HowItWorks() {
  return (
    <section id="learn" className="mt-12 grid gap-x-10 gap-y-6 md:mt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <div className="min-w-0 lg:pt-5">
        <p className="text-body font-medium text-fg-subtle">How it works</p>
        <Display as="h2" className="dm-display-title mt-3 max-w-[30ch] text-balance text-fg">
          Pick a pool. Set a range. Decide what happens to the fees.
        </Display>
      </div>
      <ol className="dm-card m-0 min-w-0 list-none p-2">
        {STEPS.map((step, index) => (
          <li key={step.n} className={cx('grid grid-cols-[28px_minmax(0,1fr)] gap-4 px-4 py-5 sm:px-5', index > 0 && 'border-t border-line')}>
            <span aria-hidden="true" className="tnum grid size-7 place-items-center rounded-[var(--radius-sm)] bg-surface-3 text-caption font-medium text-fg-subtle">
              {step.n}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <h3 className="text-lead font-medium text-fg">{step.title}</h3>
                {step.roadmap && roadmapPill(step.roadmap) && <Pill>{roadmapPill(step.roadmap)}</Pill>}
              </div>
              <p className="mt-1 max-w-[62ch] text-body text-fg-muted">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function Limits() {
  return (
    <section id="limits" className="mt-12 md:mt-16">
      <div className="dm-card p-5 sm:p-6">
        <Display as="h2" className="dm-display-card">
          What Domino does not do.
        </Display>
        <div className="mt-5 grid gap-x-10 md:grid-cols-2">
          {LIMITS.map((limit) => (
            <div key={limit.title} className="min-w-0 border-t border-line py-5 last:pb-0 md:[&:nth-last-child(2)]:pb-0">
              <h3 className="text-body font-medium text-fg">{limit.title}</h3>
              <p className="mt-1 text-body text-fg-muted">{limit.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export function Landing() {
  return (
    <PageShell>
      <Hero />
      <FeatureCards className="mt-6" delay={60} />
      {/* The pools card holds an inline dialog, so it takes no entrance: nothing may leave a transform on its ancestors. */}
      <section id="pools" className="mt-10">
        <MarketsTable variant="featured" />
      </section>
      <HowItWorks />
      <section id="ranges" className="mt-12 md:mt-16">
        <RangeSimulator />
      </section>
      <Limits />
    </PageShell>
  )
}
