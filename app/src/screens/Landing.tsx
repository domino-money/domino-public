import type { CSSProperties, ReactNode } from 'react'
import { IconTile } from '../components/figures'
import { MarketsTable } from '../components/MarketsTable'
import { RangeSimulator } from '../components/RangeSimulator'
import { FUNDING_NETWORKS, HomeCapabilities, NetworkMark } from '../components/home/HomeCapabilities'
import { FeatureCards } from '../components/home/FeatureCards'
import { HeroArt } from '../components/home/HeroArt'
import { useInView } from '../components/home/Vignettes'
import { IconChartDown, IconChevronRight, IconCoins, IconKey, IconShield } from '../components/icons'
import { Display, LinkButton, PageShell, cx } from '../components/ui'
import { useRouteTitle } from '../lib/routeTitle'

/*
 * Home introduces wallet funding, pools and their range in the order a new visitor needs them.
 * The shared table still owns every figure and read; the teaching scene never projects earnings.
 */

/**
 * A first-load entrance, `step` × 40 ms in (DESIGN-V2 §5.5, §7.3): rise and fade
 * in, then nothing stays applied (backwards fill only), so no block keeps a
 * transform that would trap a fixed dialog. After the first route change
 * (`dm-booted`) blocks no longer rise; the page cross-fades instead.
 */
const RISE = 'animate-rise'
const rise = (step: number) => ({ '--delay': `${step * 40}ms` }) as CSSProperties

const LIMITS: ReadonlyArray<{ title: string; body: string; icon: ReactNode }> = [
  {
    title: 'Outside your range, trading fees stop',
    // Changed on purpose 2026-10-01 (audit E13): a range opened above or below the price on purpose holds one token from
    // the start, so naming the token left as the one that fell was not always true; this is.
    body: 'Outside your range, the position holds one token and stops earning trading fees until the price returns.',
    icon: <IconChartDown size={18} />,
  },
  {
    title: 'Your position can lose value',
    body: 'Your position can lose value, even while earning fees, and be worth less than holding the tokens.',
    icon: <IconCoins size={18} />,
  },
  {
    title: 'Your wallet, your permissions',
    body: 'Domino never holds your keys. You approve what automation can do and can pause or revoke its permission.',
    icon: <IconKey size={18} />,
  },
  {
    title: 'Compounding uses earned fees',
    body: 'Auto-compound and Domino-compound use earned fees. Your original deposit stays in its position.',
    icon: <IconShield size={18} />,
  },
]

/**
 * A short headline beside a position taking shape.
 * The drawing plays while at least 30% of the hero is in view.
 */
function Hero() {
  const [plate, inView] = useInView<HTMLDivElement>(0.3)
  return (
    <div ref={plate} className="dm-hero dm-v3-hero">
      <div className="dm-hero-body">
        <Display as="h1" className={cx('dm-display-hero dm-hero-title', RISE)} style={rise(0)}>
          <span className="dm-hero-opening">Earn fees.</span><span className="dm-hero-accent">Keep control.</span>
        </Display>
        <div className={cx('dm-hero-actions', RISE)} style={rise(1)}>
          <LinkButton href="#/markets" size="xl">
            Explore markets
          </LinkButton>
          <LinkButton href="#/new" variant="ghost" size="xl">
            New position <IconChevronRight size={16} />
          </LinkButton>
        </div>
        <div className="dm-hero-funding" aria-label="Networks to bring funds from">
          <span>Bring funds from</span>
          <ul>{FUNDING_NETWORKS.map(network => <li key={network}><NetworkMark network={network} /><span>{network}</span></li>)}</ul>
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
    <section id="learn" className="dm-home-chapter dm-home-automations" aria-labelledby="dm-automation-title">
      <div className="dm-home-chapter-heading">
        <div><Display as="h2" id="dm-automation-title" className="dm-home-chapter-title">Choose what<br /><em>happens next.</em></Display><p>Three ways to manage your position, on your terms.</p></div>
        <LinkButton href="#/automate" variant="ghost">Explore automation <IconChevronRight size={16} /></LinkButton>
      </div>
      <FeatureCards />
      <details id="ranges" className="dm-home-range-guide">
        <summary><span>What is a price range?</span><span aria-hidden="true">+</span></summary>
        <RangeSimulator title="Your price range" />
      </details>
    </section>
  )
}

function Limits() {
  return (
    <section id="limits" className="dm-limits dm-home-chapter dm-home-control" aria-labelledby="dm-home-risks-title">
      <div><Display as="h2" id="dm-home-risks-title" className="dm-home-chapter-title">Stay informed.<br /><em>Stay in control.</em></Display><p className="dm-home-control-intro">Your wallet stays yours. Know how your position works before you start.</p></div>
      <div className="dm-limits-grid">
        {LIMITS.map((limit) => (
          <details key={limit.title} className="dm-limit">
            <summary>
              <IconTile icon={limit.icon} />
              <h3 className="dm-subtitle">{limit.title}</h3>
              <IconChevronRight size={15} />
            </summary>
            <p className="dm-limit-body">{limit.body}</p>
          </details>
        ))}
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
      <HomeCapabilities />
      {/* Keep the shared provider and dialog ancestry intact: presentation adds no market reads. */}
      <section id="pools" className="dm-home-pools">
        <MarketsTable variant="home" />
      </section>
      <HowItWorks />
      <Limits />
    </PageShell>
  )
}
