import type { CSSProperties, ReactNode } from 'react'
import { IconTile } from '../components/figures'
import { MarketsTable } from '../components/MarketsTable'
import { RangeSimulator } from '../components/RangeSimulator'
import { FeatureCards } from '../components/home/FeatureCards'
import { HeroArt } from '../components/home/HeroArt'
import { useInView } from '../components/home/Vignettes'
import { IconChartDown, IconChevronRight, IconCoins, IconKey, IconShield } from '../components/icons'
import { Display, LinkButton, PageShell, cx } from '../components/ui'
import { useRouteTitle } from '../lib/routeTitle'

/*
 * Home (DESIGN-V2 §7). The headline and the two ways in, what automation does
 * with fees, then the selected pools. Below them it explains: how a position
 * comes together, what a range does as the price moves, and what Domino does
 * not do. Home sends no read of its own; the table keeps the app's existing
 * markets provider. The original hero animation is presentation only.
 */

/**
 * A first-load entrance, `step` × 40 ms in (DESIGN-V2 §5.5, §7.3): rise and fade
 * in, then nothing stays applied (backwards fill only), so no block keeps a
 * transform that would trap a fixed dialog. After the first route change
 * (`dm-booted`) blocks no longer rise; the page cross-fades instead.
 */
const RISE = 'animate-rise'
const rise = (step: number) => ({ '--delay': `${step * 40}ms` }) as CSSProperties

const STEPS: ReadonlyArray<{ n: string; title: string; body: string }> = [
  {
    n: '01',
    title: 'Choose your tokens',
    body: 'Pick the two tokens you want to add.',
  },
  {
    n: '02',
    title: 'Set a price range',
    body: 'Choose the prices where your position can earn fees.',
  },
  {
    n: '03',
    title: 'Choose an amount',
    body: 'Decide how much you want to add.',
  },
  {
    n: '04',
    title: 'Review and confirm',
    body: 'Check the details, then confirm in your wallet.',
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
    body: 'Domino never holds your wallet keys. You approve how automation can act, and you can pause or revoke that permission.',
    icon: <IconKey size={18} />,
  },
  {
    title: 'Compounding uses earned fees',
    body: 'Auto-compound and Domino-compound reinvest earned fees, not the tokens you originally deposited.',
    icon: <IconShield size={18} />,
  },
]

/**
 * The headline plate: the words centred over a horizon of tiles. The drawing plays while at least 30% of the plate is in view.
 * Changed on purpose 2026-10-03 (the owner: Domino covers more than one network now): no "On Robinhood Chain" chip over
 * the headline; the words start the plate.
 */
function Hero() {
  const [plate, inView] = useInView<HTMLDivElement>(0.3)
  return (
    <div ref={plate} className="dm-plate dm-dots-hero dm-hero">
      <div className="dm-hero-body">
        <Display as="h1" className={cx('dm-display-hero dm-hero-title', RISE)} style={rise(0)}>
          Earn fees on your tokens, <span className="dm-hero-accent">on your own terms.</span>
        </Display>
        <p className={cx('dm-lede-hero dm-hero-lede', RISE)} style={rise(1)}>
          You pick the pool and the range, and nothing moves until your wallet signs.
        </p>
        <div className={cx('dm-hero-actions', RISE)} style={rise(2)}>
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
      <div className="dm-home-section-head dm-learn-head">
        <div>
          <p className="dm-learn-eyebrow">How it works</p>
          <Display as="h2" className="dm-display-section dm-learn-title">
            Your first position, in four steps.
          </Display>
        </div>
      </div>
      <ol className="dm-learn-steps">
        {STEPS.map((step, index) => (
          <li key={step.n} className={cx('dm-card dm-learn-step', RISE)} style={rise(index)}>
            <span aria-hidden="true" className="dm-learn-num">
              {step.n}
            </span>
            <h3 className="dm-subtitle dm-learn-step-title">{step.title}</h3>
            <p className="dm-learn-step-body">{step.body}</p>
          </li>
        ))}
      </ol>
      <a href="#/new" className="dm-vig-link dm-learn-start">Create your first position <IconChevronRight size={16} /></a>
    </section>
  )
}

function Limits() {
  return (
    <section id="limits" className="dm-home-section">
      <div className="dm-card dm-limits">
        <div className="dm-home-section-head">
          <div>
            <p className="dm-home-eyebrow">Know before you start</p>
            <Display as="h2" className="dm-display-card">What Domino does not do.</Display>
          </div>
        </div>
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
      <section className="dm-home-section dm-home-options" aria-labelledby="dm-features-title">
        <div className="dm-home-section-head">
          <div>
            <p className="dm-home-eyebrow">After you open a position</p>
            <Display as="h2" id="dm-features-title" className="dm-display-section">Your fees. A choice of next steps.</Display>
          </div>
        </div>
        <FeatureCards className="dm-home-features" delay={160} />
      </section>
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
