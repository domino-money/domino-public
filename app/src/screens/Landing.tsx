import type { CSSProperties, ReactNode } from 'react'
import { IconTile } from '../components/figures'
import { MarketsTable } from '../components/MarketsTable'
import { RangeSimulator } from '../components/RangeSimulator'
import { FeatureCards } from '../components/home/FeatureCards'
import { HeroArt } from '../components/home/HeroArt'
import { useInView } from '../components/home/Vignettes'
import { IconChartDown, IconCoins, IconKey, IconShield } from '../components/icons'
import { Chip, Display, LinkButton, LiveDot, PageShell, Pill, cx } from '../components/ui'
import { ROADMAP, ROADMAP_PILL, ROADMAP_PILL_TITLE } from '../lib/capabilities'
import type { MarketsState } from '../lib/read/marketsProvider'
import { useMarkets } from '../lib/read/useMarkets'
import { useRouteTitle } from '../lib/routeTitle'

/*
 * Home (DESIGN-V2 §7). The headline and the two ways in, what automation does
 * with fees, then the selected pools. Below them it explains: how a position
 * comes together, what a range does as the price moves, and what Domino does
 * not do. Home sends no read of its own: the hero chip and the table share the
 * app's one markets provider. Layout and looks are home.css's; the drawings
 * are art.css's.
 */

/**
 * A first-load entrance, `step` × 40 ms in (DESIGN-V2 §5.5, §7.3): rise and fade
 * in, then nothing stays applied (backwards fill only), so no block keeps a
 * transform that would trap a fixed dialog. After the first route change
 * (`dm-booted`) blocks no longer rise; the page cross-fades instead.
 */
const RISE = 'animate-rise'
const rise = (step: number) => ({ '--delay': `${step * 40}ms` }) as CSSProperties

const STEPS: ReadonlyArray<{ n: string; title: string; body: string; roadmap?: ReadonlyArray<string> }> = [
  {
    n: '01',
    // Changed on purpose 2026-10-01 (audit E25): one sentence, not two run together.
    title: 'Choose a pool and set your range',
    body: 'Search for your token and pick one of the pools that already exists for it. The Range step draws the price band this position earns fees in, and the pool you pick carries the fee.',
  },
  {
    n: '02',
    title: 'Review, then create',
    body: 'Review every choice and the wallet steps before anything is sent. Create position then asks your wallet to sign each step; when the position exists, keep it plain or automate it.',
  },
  {
    n: '03',
    title: 'Automation',
    body: 'Three choices: Plain position, Auto-compound or Domino-compound.',
    roadmap: ['Compound', 'Domino'],
  },
]

const LIMITS: ReadonlyArray<{ title: string; body: string; icon: ReactNode }> = [
  {
    title: 'It does not remove market risk',
    // Changed on purpose 2026-10-01 (audit E13): a range opened above or below the price on purpose holds one token from
    // the start, so naming the token left as the one that fell was not always true; this is.
    body: 'Prices move and your position moves with them. Outside its range a position holds only one of its two tokens, and earns no fees until the price comes back.',
    icon: <IconChartDown size={18} />,
  },
  {
    title: 'It does not promise a return',
    body: 'Fees are not profit. A position can collect fees for weeks and still be worth less than holding the assets.',
    icon: <IconCoins size={18} />,
  },
  {
    title: 'It does not take custody',
    body: 'Your wallet signs every deposit, permission and withdrawal. Automation acts only within the limits you signed, and you can pause or revoke it.',
    icon: <IconKey size={18} />,
  },
  {
    title: 'It does not touch your principal',
    body: 'Automation spends earned fees only, and the contract does not let it reduce a position’s liquidity.',
    icon: <IconShield size={18} />,
  },
]

/** The pill ROADMAP gives the first named capability that wears one, so Home says what Automate and the docs say. */
const roadmapPill = (names: ReadonlyArray<string>): { label: string; title?: string } | undefined => {
  const entry = ROADMAP.find((one) => names.includes(one.name) && ROADMAP_PILL[one.status] !== undefined)
  const label = entry && ROADMAP_PILL[entry.status]
  return entry && label ? { label, title: ROADMAP_PILL_TITLE[entry.status] } : undefined
}

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
      style={rise(0)}
    >
      On Robinhood Chain
    </Chip>
  )
}

/** The headline plate: the words centred over a horizon of tiles. The drawing plays while at least 30% of the plate is in view. */
function Hero() {
  const [plate, inView] = useInView<HTMLDivElement>(0.3)
  return (
    <div ref={plate} className="dm-plate dm-dots-hero dm-hero">
      <div className="dm-hero-body">
        <HeroChip />
        <Display as="h1" className={cx('dm-display-hero dm-hero-title', RISE)} style={rise(1)}>
          Earn fees on your tokens, <span className="dm-hero-accent">on your own terms.</span>
        </Display>
        <p className={cx('dm-lede-hero dm-hero-lede', RISE)} style={rise(2)}>
          You pick the pool and the range, and nothing moves until your wallet signs.
        </p>
        <div className={cx('dm-hero-actions', RISE)} style={rise(3)}>
          <LinkButton href="#/markets" size="xl">
            Explore markets
          </LinkButton>
          <LinkButton href="#/new" variant="outline" size="xl">
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
    <section id="learn" className="dm-home-section dm-learn">
      <div className="dm-learn-head">
        <p className="dm-learn-eyebrow">How it works</p>
        <Display as="h2" className="dm-display-section dm-learn-title">
          Pick a pool. Set a range. Decide what happens to the fees.
        </Display>
      </div>
      <ol className="dm-learn-steps">
        {STEPS.map((step, index) => {
          const pill = step.roadmap && roadmapPill(step.roadmap)
          return (
            <li key={step.n} className={cx('dm-card dm-learn-step', RISE)} style={rise(index)}>
              <span aria-hidden="true" className="dm-learn-num">
                {step.n}
              </span>
              <h3 className="dm-subtitle dm-learn-step-title">{step.title}</h3>
              {pill && (
                <Pill className="dm-learn-pill" title={pill.title}>
                  {pill.label}
                </Pill>
              )}
              <p className="dm-learn-step-body">{step.body}</p>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function Limits() {
  return (
    <section id="limits" className="dm-home-section">
      <div className="dm-card dm-limits">
        <Display as="h2" className="dm-display-card">
          What Domino does not do.
        </Display>
        <div className="dm-limits-grid">
          {LIMITS.map((limit) => (
            <div key={limit.title} className="dm-limit">
              <IconTile icon={limit.icon} />
              <div className="min-w-0">
                <h3 className="dm-subtitle">{limit.title}</h3>
                <p className="dm-limit-body">{limit.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export function Landing() {
  // Home's tab is the site's own name, given back on the way home from another screen (lib/routeTitle.ts, audit E11).
  useRouteTitle(null)
  return (
    <PageShell className="dm-home">
      <Hero />
      <FeatureCards className="dm-home-features" delay={160} />
      {/* The pools table holds an inline dialog, so it takes no entrance: nothing may leave a transform on its ancestors. */}
      <section id="pools" className="dm-home-pools">
        <MarketsTable variant="featured" />
      </section>
      <HowItWorks />
      <section id="ranges" className="dm-home-section">
        <RangeSimulator />
      </section>
      <Limits />
    </PageShell>
  )
}
