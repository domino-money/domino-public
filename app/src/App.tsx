import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Header } from './components/Header'
import { Footer } from './components/Footer'
import { Ticker } from './components/Ticker'
import { deferred } from './components/Deferred'
import { Landing } from './screens/Landing'
import { NotFound } from './screens/NotFound'
import { BuildBanner } from './components/read/BuildBanner'
import { scrollToSection } from './lib/sectionScroll'
import { appMarketsProvider } from './lib/read/buildMode'
import { MarketsContext } from './lib/read/useMarkets'
import { LocalDevelopmentBanner } from './components/read/LocalDevelopmentBanner'
import { recovering } from './lib/staleRelease'
import { MARKETS_TOKEN, ROUTES, type RoutedPage } from './routeTable'
import { ELYSIUM_STATUS } from './config/chainIdentity'
import { sectionLinked } from './chains/elysium/mode'

// The owner's wallet flows, in builds that carry the wallet session: creating
// or recovering a position, and setting up a sequence. The
// onboarding previews (#38) and the deposit consumer's fixture lab (#40/#44)
// are compiled in only by `vite build --mode consumer-test`. Everywhere else
// each constant is null: the bundler drops the import, no chunk is emitted,
// and the route is not found like any unknown route. A chunk that fails to load
// says so instead of showing a blank page, unless a release replaced it: then
// the tab reloads once into the new release (lib/staleRelease.ts, D1).
const couldNotLoad = () => ({ default: () => <p role="alert">This screen couldn’t load. Reload to try again.</p> })
const Sequence = __DOMINO_WALLET_SESSION__ ? lazy(recovering(() => import('./screens/Sequence'), couldNotLoad)) : null
const Setup = __DOMINO_WALLET_SESSION__ ? lazy(recovering(() => import('./screens/Setup'), couldNotLoad)) : null
const LivePreview = __DOMINO_ONBOARDING_PREVIEW__ ? lazy(recovering(() => import('./screens/LivePreview'), couldNotLoad)) : null
const Deposits = __DOMINO_DEPOSIT_LAB__ ? lazy(recovering(() => import('./screens/Deposits'), couldNotLoad)) : null
// Test builds only: the owner's position actions mounted alone, for tests/position-actions.browser.test.mjs.
const PositionLab = __DOMINO_TEST_HOOKS__ ? lazy(recovering(() => import('./screens/PositionLab'), couldNotLoad)) : null

/**
 * Every screen but Home is a chunk of its own (2026-10-01, platform workstream, F1): the entry every visitor downloads
 * carried them all, 1.1 MB, and Home ran 44% of it. Home stays in the entry, as the page most visits open on. The page's
 * boot script asks for the opened route's chunk while the entry downloads (functions/_lib/boot.ts, from the table the
 * build writes), and each is drawn as soon as it is in (components/Deferred.tsx), on a page frame of the screen's full
 * height meanwhile, so the footer never shows mid-screen (E1).
 */
const screenFailed = () => ({
  default: () => (
    <main className="dm-page">
      <p role="alert" className="text-body text-fg-muted">
        This page couldn’t load. Reload to try again.
      </p>
    </main>
  ),
})
const Explore = deferred<object>(recovering(() => import('./screens/Explore').then((module) => ({ default: module.Explore })), screenFailed))
const PoolDetail = deferred<{ poolId: string }>(recovering(() => import('./screens/PoolDetail').then((module) => ({ default: module.PoolDetail })), screenFailed))
const Positions = deferred<{ param?: string }>(recovering(() => import('./screens/Positions').then((module) => ({ default: module.Positions })), screenFailed))
const NewPosition = deferred<{ poolId: string }>(recovering(() => import('./screens/NewPosition').then((module) => ({ default: module.NewPosition })), screenFailed))
const Automate = deferred<object>(recovering(() => import('./screens/Automate').then((module) => ({ default: module.Automate })), screenFailed))
const Docs = deferred<{ slug: string }>(recovering(() => import('./screens/Docs').then((module) => ({ default: module.Docs })), screenFailed))
// The second chain's section (2026-10-01, the chain2 workstream, part B): its own lazy chunk, opened from its route only,
// so the Robinhood screens carry none of it. Whether it is open where the page is served is its own call
// (chains/elysium/flag.ts: off on domino.money until the chain's deployment is qualified, on in the preview).
const Elysium = deferred<object>(recovering(() => import('./chains/elysium/ui/ElysiumEntry'), screenFailed))
/**
 * Whether the section's route exists where the page is served (2026-10-01, fix round 1): the menu's own rule
 * (components/HeaderMenu.tsx, chains/elysium/mode.ts sectionLinked). Where it is off (domino.money until the chain's
 * deployment is qualified, and any other origin but the preview alias and the local development server) `#/elysium…`
 * is an unknown route like any other: the page shows Not found, never asks for the section's chunk, and names no chain.
 */
const ELYSIUM_OPEN = typeof location !== 'undefined' && sectionLinked(location.origin, ELYSIUM_STATUS)
/** What a screen shows until its chunk is in: the page frame, at its full height (shell.css .dm-page). */
const PENDING = <main className="dm-page dm-page-pending" aria-busy="true" />

/**
 * Asks for the chunk of the screen the page opens on before React draws anything (main.tsx), so the first draw can be
 * the screen itself: its file is already on its way (the boot script asked for it), and only its import is left.
 */
const SCREENS: Partial<Record<Page, { preload: () => void }>> = { markets: Explore, pool: PoolDetail, positions: Positions, new: NewPosition, automate: Automate, docs: Docs, elysium: Elysium }
export function preloadScreen(page: Page): void {
  SCREENS[page]?.preload()
}

/**
 * The pages, by the first segment of the hash route (src/routeTable.ts). The
 * docs are `#/docs`, a page of them `#/docs/<slug>`. The two consumer screens
 * have a route only in the build that carries them: everywhere else their route
 * names never reach the bundle (the deployable build is scanned for them). A
 * route that names no page, here or in this build, is `not-found` (2026-10-01,
 * live notes L19: it showed Home as if the link had worked).
 */
export type Page = RoutedPage | 'not-found' | 'live-preview' | 'deposits' | 'position-lab' | 'sequence-lab'

const PAGES: Readonly<Record<string, Page>> = {
  ...ROUTES,
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
 * takes it decides what it is and never treats it as trusted. Markets takes
 * only a token's address there; anything else is not found.
 */
export function parseHash(hash: string): HashLocation {
  const raw = hash.replace(/^#/, '')
  const cut = raw.indexOf('#')
  const route = (cut === -1 ? raw : raw.slice(0, cut)) || '/'
  const section = cut === -1 ? '' : raw.slice(cut + 1)
  const [, first = '', second = ''] = route.split('/')
  const page: Page = Object.hasOwn(PAGES, first) ? PAGES[first] : 'not-found'
  if (page === 'elysium' && !ELYSIUM_OPEN) return { page: 'not-found', param: second, section }
  return { page: page === 'markets' && second !== '' && !MARKETS_TOKEN.test(second) ? 'not-found' : page, param: second, section }
}

const subscribeHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

function useHashLocation() {
  // Changed on purpose 2026-10-04 (PR #335's CI, finance-create): read through useSyncExternalStore, which reads the hash
  // again once it listens. As state set from a listener added after the first render, a hash that changed in between (a
  // link followed while the page was still starting) was missed, and the old screen stayed.
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash, () => '')
  const location = useMemo(() => parseHash(hash), [hash])
  useEffect(() => {
    const onChange = () => {
      const next = parseHash(window.location.hash)
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

/** A lazily loaded screen behind its build flag; null when the build does not carry it, so the route is not found. */
function Flagged({ screen: Lazy, loading }: { screen: React.LazyExoticComponent<() => React.ReactNode> | null; loading: string }) {
  if (!Lazy) return <NotFound />
  return (
    <Suspense fallback={<main className="dm-page dm-page--narrow"><p role="status" className="text-body text-fg-muted">{loading}</p></main>}>
      <Lazy />
    </Suspense>
  )
}

function Screen({ page, param }: { page: Page; param: string }) {
  switch (page) {
    case 'overview':
      return <Landing />
    case 'markets':
      return <Explore fallback={PENDING} />
    case 'pool':
      return <PoolDetail poolId={param} fallback={PENDING} />
    case 'positions':
      return <Positions param={param} fallback={PENDING} />
    case 'new':
      return <NewPosition poolId={param} fallback={PENDING} />
    case 'automate':
      return <Automate fallback={PENDING} />
    case 'docs':
      return <Docs slug={param} fallback={PENDING} />
    case 'sequence':
      return <Flagged screen={Sequence} loading="Loading your sequence…" />
    case 'setup':
      return <Flagged screen={Setup} loading="Loading position setup…" />
    case 'elysium':
      return <Elysium fallback={PENDING} />
    default:
      // Only the build that carries a consumer screen names it; elsewhere the whole branch folds away.
      if (__DOMINO_ONBOARDING_PREVIEW__ && page === 'live-preview') return <Flagged screen={LivePreview} loading="Loading the preview…" />
      if (__DOMINO_DEPOSIT_LAB__ && page === 'deposits') return <Flagged screen={Deposits} loading="Loading deposits…" />
      if (__DOMINO_TEST_HOOKS__ && page === 'position-lab' && PositionLab) return <Suspense fallback={null}><PositionLab spec={param} /></Suspense>
      if (__DOMINO_TEST_HOOKS__ && page === 'sequence-lab' && Sequence) return <Suspense fallback={null}><Sequence lab={param} /></Suspense>
      return <NotFound />
  }
}

/** The flagged screens, by page. A null one is not found, so it lights and frames as an unknown route. */
const FLAGGED: Partial<Record<Page, unknown>> = {
  sequence: Sequence,
  setup: Setup,
  ...(__DOMINO_ONBOARDING_PREVIEW__ ? { 'live-preview': LivePreview } : {}),
  ...(__DOMINO_DEPOSIT_LAB__ ? { deposits: Deposits } : {}),
  ...(__DOMINO_TEST_HOOKS__ ? { 'position-lab': PositionLab, 'sequence-lab': Sequence } : {}),
}

export default function App() {
  const { page: route, param } = useHashLocation()
  const page: Page = Object.hasOwn(FLAGGED, route) && !FLAGGED[route] ? 'not-found' : route
  // One provider for the whole app, so the ticker and the table share one load.
  const [markets] = useState(appMarketsProvider)

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
      {/* Changed on purpose 2026-10-03 (the owner): the footer's Pause motion control is gone; reduced motion still stills the page. */}
      <Footer />
    </div>
    </MarketsContext.Provider>
  )
}
