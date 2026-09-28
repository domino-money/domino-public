import { lazy, Suspense, useEffect, useState } from 'react'
import { Header } from './components/Header'
import { Footer } from './components/Footer'
import { Ticker } from './components/Ticker'
import { Landing } from './screens/Landing'
import { Explore } from './screens/Explore'
import { PoolDetail } from './screens/PoolDetail'
import { Positions } from './screens/Positions'
import { Automate } from './screens/Automate'
import { NewPosition } from './screens/NewPosition'
import { Docs } from './screens/Docs'
import { Button } from './components/ui'
import { IconPause, IconPlay } from './components/icons'
import { BuildBanner } from './components/read/BuildBanner'
import { scrollToSection } from './lib/sectionScroll'
import { appMarketsProvider } from './lib/read/buildMode'
import { MarketsContext } from './lib/read/useMarkets'
import { LocalDevelopmentBanner } from './components/read/LocalDevelopmentBanner'

// The owner's wallet flows, in builds that carry the wallet session: creating
// or recovering a position, and setting up a sequence. The
// onboarding previews (#38) and the deposit consumer's fixture lab (#40/#44)
// are compiled in only by `vite build --mode consumer-test`. Everywhere else
// each constant is null: the bundler drops the import, no chunk is emitted,
// and the route falls through to Home like any unknown route. A chunk that
// fails to load says so instead of showing a blank page.
const couldNotLoad = () => ({ default: () => <p role="alert">This screen couldn’t load. Reload to try again.</p> })
const Sequence = __DOMINO_WALLET_SESSION__ ? lazy(() => import('./screens/Sequence').catch(couldNotLoad)) : null
const Setup = __DOMINO_WALLET_SESSION__ ? lazy(() => import('./screens/Setup').catch(couldNotLoad)) : null
const LivePreview = __DOMINO_ONBOARDING_PREVIEW__ ? lazy(() => import('./screens/LivePreview').catch(couldNotLoad)) : null
const Deposits = __DOMINO_DEPOSIT_LAB__ ? lazy(() => import('./screens/Deposits').catch(couldNotLoad)) : null
// Test builds only: the owner's position actions mounted alone, for tests/position-actions.browser.test.mjs.
const PositionLab = __DOMINO_TEST_HOOKS__ ? lazy(() => import('./screens/PositionLab').catch(couldNotLoad)) : null

/**
 * The pages, by the first segment of the hash route. Older links keep
 * working: `#/explore` and `#/pools` are Markets; `#/app` and `#/portfolio`
 * are Positions; `#/settings` opens the docs, which say what the Settings page
 * said (the owner removed that page, 2026-09-27). The docs are `#/docs`, a
 * page of them `#/docs/<slug>`. The two consumer screens have a route only in
 * the build that carries them: everywhere else their route names never reach
 * the bundle (the deployable build is scanned for them), and the route falls
 * through to Home like any unknown route.
 */
export type Page = 'overview' | 'markets' | 'pool' | 'positions' | 'new' | 'automate' | 'docs' | 'sequence' | 'setup' | 'live-preview' | 'deposits' | 'position-lab' | 'sequence-lab'

const PAGES: Readonly<Record<string, Page>> = {
  '': 'overview',
  markets: 'markets',
  explore: 'markets',
  pools: 'markets',
  pool: 'pool',
  positions: 'positions',
  app: 'positions',
  portfolio: 'positions',
  new: 'new',
  automate: 'automate',
  settings: 'docs',
  docs: 'docs',
  sequence: 'sequence',
  setup: 'setup',
  ...(__DOMINO_ONBOARDING_PREVIEW__ ? ({ 'live-preview': 'live-preview' } as const) : {}),
  ...(__DOMINO_DEPOSIT_LAB__ ? ({ deposits: 'deposits' } as const) : {}),
  ...(__DOMINO_TEST_HOOKS__ ? ({ 'position-lab': 'position-lab' } as const) : {}),
  // 2026-09-24: the automation page with the wallet's positions injected (tests/finance.browser.test.mjs), test builds only.
  ...(__DOMINO_TEST_HOOKS__ ? ({ 'sequence-lab': 'sequence-lab' } as const) : {}),
}

export interface HashLocation {
  page: Page
  /** The second segment: a pool id under `#/pool/<id>`, a pool id under `#/new/<id>`, an NFT id (or a list of them) under `#/positions/<id>`, a page's slug under `#/docs/<slug>`. Empty otherwise. */
  param: string
  /** The in-page section after a second `#`, e.g. `pools` in `#/#pools`. */
  section: string
}

/**
 * Hash routing with a section part: `#/#pools` is route `/`, section
 * `pools`. Both are tracked, so a link that only changes the section still
 * produces a state change and still scrolls, and a route change does not
 * discard the section it was asked to open. A route may carry one parameter
 * segment, `#/pool/<id>`, which is passed through untouched: the screen that
 * takes it decides what it is and never treats it as trusted.
 */
export function parseHash(hash: string): HashLocation {
  const raw = hash.replace(/^#/, '')
  const cut = raw.indexOf('#')
  const route = (cut === -1 ? raw : raw.slice(0, cut)) || '/'
  const section = cut === -1 ? '' : raw.slice(cut + 1)
  const [, first = '', second = ''] = route.split('/')
  return { page: Object.hasOwn(PAGES, first) ? PAGES[first] : 'overview', param: second, section }
}

function useHashLocation() {
  const [location, setLocation] = useState(() => parseHash(window.location.hash))
  useEffect(() => {
    const onChange = () => {
      const next = parseHash(window.location.hash)
      setLocation(next)
      // Scrolled from the listener rather than from an effect: the new screen
      // has to be committed first, and an effect keyed on the route would be
      // torn down by the re-render that commits it. A timeout rather than a
      // frame callback, because a hidden or backgrounded tab never paints and
      // would silently skip the scroll entirely.
      setTimeout(() => scrollToSection(next.section), 0)
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return location
}

/** A lazily loaded screen behind its build flag; null when the build does not carry it, so the route falls through to Home. */
function Flagged({ screen: Lazy, loading }: { screen: React.LazyExoticComponent<() => React.ReactNode> | null; loading: string }) {
  if (!Lazy) return <Landing />
  return (
    <Suspense fallback={<main className="dm-page dm-page--narrow"><p role="status" className="text-body text-fg-muted">{loading}</p></main>}>
      <Lazy />
    </Suspense>
  )
}

function Screen({ page, param }: { page: Page; param: string }) {
  switch (page) {
    case 'markets':
      return <Explore />
    case 'pool':
      return <PoolDetail poolId={param} />
    case 'positions':
      return <Positions param={param} />
    case 'new':
      return <NewPosition poolId={param} />
    case 'automate':
      return <Automate />
    case 'docs':
      return <Docs slug={param} />
    case 'sequence':
      return <Flagged screen={Sequence} loading="Loading your sequence…" />
    case 'setup':
      return <Flagged screen={Setup} loading="Loading position setup…" />
    default:
      // Only the build that carries a consumer screen names it; elsewhere the whole branch folds away.
      if (__DOMINO_ONBOARDING_PREVIEW__ && page === 'live-preview') return <Flagged screen={LivePreview} loading="Loading the preview…" />
      if (__DOMINO_DEPOSIT_LAB__ && page === 'deposits') return <Flagged screen={Deposits} loading="Loading deposits…" />
      if (__DOMINO_TEST_HOOKS__ && page === 'position-lab' && PositionLab) return <Suspense fallback={null}><PositionLab spec={param} /></Suspense>
      if (__DOMINO_TEST_HOOKS__ && page === 'sequence-lab' && Sequence) return <Suspense fallback={null}><Sequence lab={param} /></Suspense>
      return <Landing />
  }
}

/** The flagged screens, by page. A null one falls through to Home, so it lights and frames as Home. */
const FLAGGED: Partial<Record<Page, unknown>> = {
  sequence: Sequence,
  setup: Setup,
  ...(__DOMINO_ONBOARDING_PREVIEW__ ? { 'live-preview': LivePreview } : {}),
  ...(__DOMINO_DEPOSIT_LAB__ ? { deposits: Deposits } : {}),
  ...(__DOMINO_TEST_HOOKS__ ? { 'position-lab': PositionLab, 'sequence-lab': Sequence } : {}),
}

export default function App() {
  const { page: route, param } = useHashLocation()
  const page: Page = Object.hasOwn(FLAGGED, route) && !FLAGGED[route] ? 'overview' : route
  // Pause motion: kept in memory for this visit only, never stored.
  const [still, setStill] = useState(false)
  // One provider for the whole app, so the ticker and the table share one load.
  const [markets] = useState(appMarketsProvider)

  useEffect(() => {
    document.documentElement.classList.toggle('dm-still', still)
  }, [still])

  // First load rises, navigation crossfades (DESIGN-V2 §5.5): at the first route change <html> gets dm-booted, which
  // switches the page blocks' rise off (tokens.css); from then on only the 180ms page fade marks a navigation.
  useEffect(() => {
    const boot = () => {
      document.documentElement.classList.add('dm-booted')
      window.removeEventListener('hashchange', boot)
    }
    window.addEventListener('hashchange', boot)
    return () => window.removeEventListener('hashchange', boot)
  }, [])

  // A page opened directly on a section link starts at the top otherwise. Read
  // from the hash rather than from state so this depends on nothing and runs
  // once; later changes are handled by the hash listener.
  useEffect(() => {
    const initial = parseHash(window.location.hash).section
    if (initial) setTimeout(() => scrollToSection(initial), 0)
  }, [])

  return (
    <MarketsContext.Provider value={markets}>
    <div className="min-h-screen">
      {__DOMINO_LOCAL_LIVE__ ? <LocalDevelopmentBanner /> : !__DOMINO_DEPLOYABLE__ && <BuildBanner mode={__DOMINO_READ_MODE__} />}
      {page === 'overview' && <Ticker />}
      <Header page={page} />
      <Screen page={page} param={param} />
      {/* The footer's motion control sits in its own flow at every width, never floating over the page, so it can never cover text. */}
      <Footer
        motion={
          <Button variant="outline" size="sm" onClick={() => setStill(!still)}>
            {still ? <IconPlay /> : <IconPause />}
            {still ? 'Resume motion' : 'Pause motion'}
          </Button>
        }
      />
    </div>
    </MarketsContext.Provider>
  )
}
