import { useEffect, useRef, type ReactNode } from 'react'
import { IconTile } from '../components/figures'
import { MarketsTable } from '../components/MarketsTable'
import { RangeSimulator } from '../components/RangeSimulator'
import { FUNDING_ROW, HomeCapabilities, NetworkMark, POSITION_ROW } from '../components/home/HomeCapabilities'
import { FeatureCards } from '../components/home/FeatureCards'
import { HeroArt } from '../components/home/HeroArt'
import { useHomeLight } from '../components/home/HomeLight'
import { HomeMarquee } from '../components/home/HomeMarquee'
import { HomeTraveller } from '../components/home/HomeTraveller'
import { homeStory, locOf, useHomeStory, useHomeStoryState } from '../components/home/homeStory'
import { ChapterTitle, Stop } from '../components/home/HomeType'
import { GlyphKey, GlyphLoop, GlyphRange, GlyphValue } from '../components/home/LimitGlyphs'
import { useInView } from '../components/home/Vignettes'
import { IconChevronRight } from '../components/icons'
import { Display, LinkButton, PageShell, cx } from '../components/ui'
import { ELYSIUM_LIVE } from '../lib/elysiumIdentity'
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
        {/* Changed on purpose 2026-10-30 (QA round 2, Q7, the owner's exact line): what Domino is and which fees it earns,
            under the headline, outside the head so the light's copy never covers it. */}
        <p className="dm-hero-lede dm-k-up1">Put two tokens in a pool and earn its trading fees.</p>
        <div className="dm-hero-actions dm-k-up1">
          <LinkButton href="#/markets" size="xl">
            Explore markets
          </LinkButton>
          <LinkButton href="#/new" variant="ghost" size="xl">
            {PLUS}New position
          </LinkButton>
        </div>
        {/* Changed on purpose 2026-10-30 (QA round 2, N20): the chips looked like buttons and did nothing; each now leads to
            Home's own section on bringing funds (same look), and the group's name is announced. */}
        <div className="dm-hero-funding dm-k-up2" role="group" aria-label="Networks to bring funds from">
          <span>Bring funds from</span>
          <ul>{FUNDING_ROW.map(network => <li key={network}><a href="#/#funding"><NetworkMark network={network} variant="v4" /><span>{network}</span></a></li>)}</ul>
        </div>
        {/* Added 2026-11-07 (the owner's order of 6 Nov: Elysium's mark on Home): where positions open, with Elysium last, in
            the funding row's own chips; each leads to New position. Only where the build serves Elysium (POSITION_ROW).
            Changed on purpose 2026-11-07 (review finding E/P9): behind the build's own fact too, so a build where Elysium is
            off carries none of the row (its length alone does not fold). */}
        {ELYSIUM_LIVE && POSITION_ROW.length > 0 && <div className="dm-hero-funding dm-hero-networks dm-k-up2" role="group" aria-label="Networks to open positions on">
          <span>Open positions on</span>
          <ul>{POSITION_ROW.map(network => <li key={network}><a href="#/new"><NetworkMark network={network} variant="v4" /><span>{network}</span></a></li>)}</ul>
        </div>}
      </div>
      <div className="dm-hero-band">
        <HeroArt running={inView} />
      </div>
    </div>
  )
}

function HowItWorks() {
  // The lesson folding or opening moves the travelling tile (it waits in the functions while the lesson is folded).
  const lesson = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const node = lesson.current
    if (!node) return
    const toggled = () => homeStory.setRangeOpen(node.open)
    node.addEventListener('toggle', toggled)
    return () => node.removeEventListener('toggle', toggled)
  }, [])
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
      <details ref={lesson} id="ranges" className="dm-home-range-guide" open>
        <summary className="dm-sx-t dm-rsum">
          <span className="dm-sx-l">What is a</span>{' '}<span className="dm-sx-l dm-sx-l2">price range<Stop>?</Stop><span className="dm-pl-lg" aria-hidden="true" /></span>
          <span className="dm-sx-t dm-sx-sh dm-rsum" aria-hidden="true" data-home-sheen="">
            <span className="dm-sx-l">What is a</span>{' '}<span className="dm-sx-l dm-sx-l2">price range<Stop>?</Stop></span>
          </span>
        </summary>
        {/* The lesson's pad (V4 .rg-pad): the space above and below the card folds away with it. */}
        <div className="dm-rg-pad">
          <div className="dm-home-range-card dm-lit">
            <RangeSimulator title="Your price range" />
          </div>
        </div>
      </details>
    </section>
  )
}

function Limits() {
  const story = useHomeStoryState()
  const list = useRef<HTMLDivElement>(null)
  // V4 (the approved prototype's calm scene): the travelling tile comes to the left column when a topic opens, and stands
  // as the last topic opened says (dark, sinking, facing you, pips lit). A look only: the topics stay native details.
  useEffect(() => {
    const node = list.current
    if (!node) return
    const toggled = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLDetailsElement) || !target.classList.contains('dm-limit')) return
      const topics = Array.from(node.querySelectorAll<HTMLDetailsElement>('details.dm-limit'))
      let last = target.open ? topics.indexOf(target) : -1
      if (!target.open) for (let index = topics.length - 1; index >= 0; index--) if (topics[index].open) { last = index; break }
      homeStory.setCalm(last)
    }
    node.addEventListener('toggle', toggled, true)
    return () => node.removeEventListener('toggle', toggled, true)
  }, [])
  const here = story.ready && locOf(story.act, story.rangeOpen) === 'calm'
  return (
    <section id="limits" className="dm-limits dm-home-chapter dm-home-control" aria-labelledby="dm-home-risks-title">
      <ChapterTitle id="dm-home-risks-title" first={<>Stay informed<Stop /></>} second={<>Stay in control<Stop /></>} />
      {/* The calm grid (V4 .cm-grid): the intro and the tile's scene beside the topics, at least 420 design px tall. */}
      <div className="dm-cm-grid">
        <div className="dm-cm-side">
          <p className="dm-home-control-intro">Your wallet stays yours. Know how your position works before you start.</p>
          <div className="dm-cm-scene" aria-hidden="true">
            <span className="dm-cm-floor" />
            <span className={cx('dm-foot dm-cm-foot', !here && 'is-away')} />
          </div>
        </div>
        <div ref={list} className="dm-limits-grid">
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
      </div>
    </section>
  )
}

export function Landing() {
  // Home's tab is the site's own name, given back on the way home from another screen (lib/routeTitle.ts, audit E11).
  useRouteTitle(null)
  useHomeLight()
  useHomeStory()
  return (
    <PageShell className="dm-home">
      <Hero />
      <HomeMarquee />
      {/* V4 (the approved prototype): Top pools sits right under the strip, in the first screen, before the story.
          Keep the shared provider and dialog ancestry intact: presentation adds no market reads. The frame only carries
          the card's lit rim and the first load's rise (a backwards fill ending on none: no transform, filter or z-index
          stays on it, since the figures dialog renders inside it). */}
      <section id="pools" className="dm-home-pools">
        <div className="dm-home-pools-frame dm-lit dm-k-card">
          <MarketsTable variant="home" />
        </div>
      </section>
      <HomeCapabilities />
      <HowItWorks />
      <Limits />
      {/* V4 decoration, children of main and siblings of every section (never an ancestor of #pools): the dotted texture
          the light reveals below the fold, and the one tile that travels through the story. */}
      <span className="dm-home-zdots" aria-hidden="true" data-home-zdots="" />
      <HomeTraveller />
    </PageShell>
  )
}
