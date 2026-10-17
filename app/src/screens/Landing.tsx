import type { ReactNode } from 'react'
import { IconTile } from '../components/figures'
import { MarketsTable } from '../components/MarketsTable'
import { RangeSimulator } from '../components/RangeSimulator'
import { FUNDING_NETWORKS, HomeCapabilities, NetworkMark } from '../components/home/HomeCapabilities'
import { FeatureCards } from '../components/home/FeatureCards'
import { HeroArt } from '../components/home/HeroArt'
import { useHomeLight } from '../components/home/HomeLight'
import { HomeMarquee } from '../components/home/HomeMarquee'
import { ChapterTitle, Stop } from '../components/home/HomeType'
import { GlyphKey, GlyphLoop, GlyphRange, GlyphValue } from '../components/home/LimitGlyphs'
import { useInView } from '../components/home/Vignettes'
import { IconChevronRight } from '../components/icons'
import { Display, LinkButton, PageShell } from '../components/ui'
import { useRouteTitle } from '../lib/routeTitle'

/*
 * Home introduces wallet funding, pools and their range in the order a new visitor needs them.
 * The shared table still owns every figure and read; the teaching scene never projects earnings.
 *
 * V4 (2026-10-16, the owner approved the prototype): the first load is one moment (the foundation's dm-k-* classes,
 * first load only, backwards fills ending on none), so no block keeps a transform or a filter that would trap the
 * Pool figures dialog, which renders inside #pools.
 */

const LIMITS: ReadonlyArray<{ title: string; body: string; icon: ReactNode }> = [
  {
    title: 'Outside your range, trading fees stop',
    // Changed on purpose 2026-10-01 (audit E13): a range opened above or below the price on purpose holds one token from
    // the start, so naming the token left as the one that fell was not always true; this is.
    body: 'Outside your range, the position holds one token and stops earning trading fees until the price returns.',
    icon: <GlyphRange />,
  },
  {
    title: 'Your position can lose value',
    body: 'Your position can lose value, even while earning fees, and be worth less than holding the tokens.',
    icon: <GlyphValue />,
  },
  {
    title: 'Your wallet, your permissions',
    body: 'Domino never holds your keys. You approve what automation can do and can pause or revoke its permission.',
    icon: <GlyphKey />,
  },
  {
    title: 'Compounding uses earned fees',
    body: 'Auto-compound and Domino-compound use earned fees. Your original deposit stays in its position.',
    icon: <GlyphLoop />,
  },
]

/** The plus of a ghost action, drawn (V4 §5.1 .pl): it turns a quarter on hover. */
const PLUS = (
  <span className="dm-pl" aria-hidden="true">
    <svg viewBox="0 0 12 12" fill="none"><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
  </span>
)

/** The headline's two lines, each rising through its own mask on the first load; `still` is the light's copy. */
function HeroLines({ still = false }: { still?: boolean }) {
  return (
    <>
      <span className="dm-ln"><span className={still ? 'dm-ln-in' : 'dm-ln-in dm-k-l1'}>Earn fees<Stop className={still ? undefined : 'dm-k-s1'} /></span></span>
      {' '}
      <span className="dm-ln dm-ln-2"><span className={still ? 'dm-ln-in' : 'dm-ln-in dm-k-l2'}>Keep control<Stop className={still ? undefined : 'dm-k-s2'} /></span></span>
    </>
  )
}

/**
 * A short headline beside the tile standing in the light.
 * The tile drifts while at least 30% of the hero is in view.
 */
function Hero() {
  const [plate, inView] = useInView<HTMLDivElement>(0.3)
  return (
    <div ref={plate} className="dm-hero dm-v3-hero">
      <div className="dm-hero-body">
        <div className="dm-hero-head">
          <Display as="h1" className="dm-display-hero dm-hero-title">
            <HeroLines />
          </Display>
          {/* The light's warm copy of the headline: beside the heading, never inside it, so its text stays its own. */}
          <span className="dm-hero-title dm-hero-sheen dm-k-sheen" aria-hidden="true" data-home-sheen="hero"><HeroLines still /></span>
        </div>
        <div className="dm-hero-actions dm-k-up1">
          <LinkButton href="#/markets" size="xl">
            Explore markets
          </LinkButton>
          <LinkButton href="#/new" variant="ghost" size="xl">
            {PLUS}New position
          </LinkButton>
        </div>
        <div className="dm-hero-funding dm-k-up2" aria-label="Networks to bring funds from">
          <span>Bring funds from</span>
          <ul>{FUNDING_NETWORKS.map(network => <li key={network}><NetworkMark network={network} variant="v4" /><span>{network}</span></li>)}</ul>
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
        <ChapterTitle id="dm-automation-title" first="Choose what" second={<>happens next<Stop /></>} />
        <div className="dm-home-chapter-aside">
          <p>Three ways to manage your position, on your terms.</p>
          <LinkButton href="#/automate" variant="ghost" className="dm-home-more">Explore automation <IconChevronRight size={16} /></LinkButton>
        </div>
      </div>
      <FeatureCards />
      {/* V4 (the owner, D-H3): the lesson starts open; its title is the summary that folds it. */}
      <details id="ranges" className="dm-home-range-guide" open>
        <summary className="dm-sx-t dm-rsum">
          <span className="dm-sx-l">What is a</span>{' '}<span className="dm-sx-l dm-sx-l2">price range<Stop>?</Stop><span className="dm-pl-lg" aria-hidden="true" /></span>
          <span className="dm-sx-t dm-sx-sh dm-rsum" aria-hidden="true" data-home-sheen="">
            <span className="dm-sx-l">What is a</span>{' '}<span className="dm-sx-l dm-sx-l2">price range<Stop>?</Stop></span>
          </span>
        </summary>
        <div className="dm-home-range-card dm-lit">
          <RangeSimulator title="Your price range" />
        </div>
      </details>
    </section>
  )
}

function Limits() {
  return (
    <section id="limits" className="dm-limits dm-home-chapter dm-home-control" aria-labelledby="dm-home-risks-title">
      <ChapterTitle id="dm-home-risks-title" first={<>Stay informed<Stop /></>} second={<>Stay in control<Stop /></>} />
      <div className="dm-cm-side"><p className="dm-home-control-intro">Your wallet stays yours. Know how your position works before you start.</p></div>
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
  useHomeLight()
  return (
    <PageShell className="dm-home">
      <Hero />
      <HomeMarquee />
      <HomeCapabilities />
      {/* Keep the shared provider and dialog ancestry intact: presentation adds no market reads. The frame only carries
          the card's lit rim (no transform, filter or z-index: the figures dialog renders inside it). */}
      <section id="pools" className="dm-home-pools">
        <div className="dm-home-pools-frame dm-lit">
          <MarketsTable variant="home" />
        </div>
      </section>
      <HowItWorks />
      <Limits />
    </PageShell>
  )
}
