import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Header } from './components/Header'
import { Footer } from './components/Footer'
import { EmberLight } from './components/EmberLight'
import { deferred } from './components/Deferred'
import { ScreenBoundary, ScreenFailed } from './components/ScreenBoundary'
import { Landing } from './screens/Landing'
import { NotFound } from './screens/NotFound'
import { BuildBanner } from './components/read/BuildBanner'
import { scrollToSection } from './lib/sectionScroll'
import { appMarketsProvider } from './lib/read/buildMode'
import { MarketsContext } from './lib/read/useMarkets'
import { LocalDevelopmentBanner } from './components/read/LocalDevelopmentBanner'
import { recovering } from './lib/staleRelease'
import { MARKETS_TOKEN, pendingTitle, ROUTES, type RoutedPage } from './routeTable'
import { ELYSIUM_STATUS } from './config/chainIdentity'
import { sectionLinked } from './chains/elysium/mode'
import { parseMarketsNetworkHash, parseNewNetworkHash } from './components/explore/routes'

// The owner's wallet flows, in builds that carry the wallet session: creating
// or recovering a position, and setting up a sequence. The
// onboarding previews (#38) and the deposit consumer's fixture lab (#40/#44)
// are compiled in only by `vite build --mode consumer-test`. Everywhere else
// each constant is null: the bundler drops the import, no chunk is emitted,
// and the route is not found like any unknown route. A chunk that fails to load
// says so instead of showing a blank page, unless a release replaced it: then
// the tab reloads once into the new release (lib/staleRelease.ts, D1).
// V4 (System, 'the screen did not load'): the same words in the failed page's frame, the first sentence as the serif title
// (styles/v4-system.css .dm-fail, as ScreenFailed); its text and the alert it is are unchanged.
const couldNotLoad = () => ({
  default: () => (
    <main className="dm-page dm-page--narrow">
      <p role="alert" className="dm-fail">
        <span>
          This screen couldn’t load<span>.</span>
        </span>{' '}
        Reload to try again.
      </p>
    </main>
  ),
})
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
// (2026-10-14, incident X1): the same stand-in as a screen that throws as it draws (components/ScreenBoundary.tsx).
const screenFailed = () => ({ default: ScreenFailed })
const Explore = deferred<object>(recovering(() => import('./screens/Explore').then((module) => ({ default: module.Explore })), screenFailed))
const PoolDetail = deferred<{ poolId: string }>(recovering(() => import('./screens/PoolDetail').then((module) => ({ default: module.PoolDetail })), screenFailed))
// Added 2026-11-06 (the owner's replica rule): a Base or Arbitrum One pool's page, Robinhood Chain's pool page fed from the
// network's own reads, in the same chunk (screens/PoolDetail.tsx), and only in a build that carries V2.
const NetworkPoolDetail = __DOMINO_V2__ ? deferred<object>(recovering(() => import('./screens/PoolDetail').then((module) => ({ default: module.NetworkPoolDetail })), screenFailed)) : null
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

/**
 * What a screen shows until its chunk is in: the page frame, at its full height (shell.css .dm-page). Changed on purpose
 * 2026-10-30 (QA round 2, Q2, the owner: a discreet V4 skeleton while a route chunk loads): the frame was empty, so a
 * slow chunk left a dark gap between the header and the footer and testers thought their click had failed. It now holds
 * the V4 skeleton of a page's first blocks, the title's bar and a card's outline (styles/v4-system.css .dm-pend-*),
 * wordless and hidden from assistive technology while the page stays aria-busy. It fades in only after a quarter of a
 * second, so a chunk that is already in or close never flashes it. The tab takes the route's name at once, as the screen
 * will (a screen that knows more renames it as it draws, and announces the move then, lib/routeTitle.ts). `narrow` for a
 * screen drawn in the narrow column (the flagged screens), so the skeleton stands where that screen lands.
 */
function Pending({ title, narrow = false }: { title: string | null; narrow?: boolean }) {
  useEffect(() => {
    if (title === null) return
    const before = document.title
    document.title = title
    return () => {
      document.title = before
    }
  }, [title])
  return (
    <main className={narrow ? 'dm-page dm-page--narrow dm-page-pending' : 'dm-page dm-page-pending'} aria-busy="true">
      <span aria-hidden="true" className="dm-skel dm-pend-title" />
      <span aria-hidden="true" className="dm-pend-card" />
    </main>
  )
}

/**
 * Skip to content (2026-10-30, QA round 2, N85): the page's first Tab stop, out of sight until the keyboard reaches it
 * (shell.css .dm-skip). It moves focus to the screen's own main, past the header. A button rather than a `#main` link,
 * which would be a route of its own here (parseHash).
 */
function SkipLink() {
  return (
    <button
      type="button"
      className="dm-skip"
      onClick={() => {
        const main = document.querySelector<HTMLElement>('#root main')
        if (!main) return
        if (!main.hasAttribute('tabindex')) main.tabIndex = -1
        main.focus()
      }}
    >
      Skip to content
    </button>
  )
}

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
  if (second === 'network' && (page === 'markets' || page === 'new')) {
    const qualified = __DOMINO_V2__ && (page === 'markets' ? parseMarketsNetworkHash(hash) : parseNewNetworkHash(hash))
    return { page: qualified ? page : 'not-found', param: '', section }
  }
  // Added 2026-11-06: a Base or Arbitrum One pool, `#/pool/network/<chain>/<pool>/<token>`, in a build that carries V2;
  // `network` is the param the pool screen takes it by (Screen, below), and that screen reads the rest of the link itself,
  // as Robinhood Chain's pool page reads its id (a malformed one is "That isn’t a pool id" there too). Kept out of the
  // entry every visitor downloads. Every Robinhood Chain pool link reads as before.
  if (second === 'network' && page === 'pool') return { page: __DOMINO_V2__ ? page : 'not-found', param: 'network', section }
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
    // A section link to the very hash already open changes nothing the browser reports, so a second tap on the footer's
    // or the menu's "How it works" did nothing (2026-10-30, QA round 2, Q16): it scrolls there again, as the docs' own
    // contents list does (DocsToc, which handles its links itself first).
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const href = event.target instanceof Element ? event.target.closest('a[href]')?.getAttribute('href') : null
      if (!href || href !== window.location.hash) return
      const { section } = parseHash(href)
      if (!section) return
      event.preventDefault()
      scrollToSection(section)
    }
    window.addEventListener('hashchange', onChange)
    document.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('hashchange', onChange)
      document.removeEventListener('click', onClick)
    }
  }, [])
  return location
}

/**
 * A lazily loaded screen behind its build flag; null when the build does not carry it, so the route is not found.
 * Changed on purpose 2026-10-30 (QA round 2, Q2): while it loads it shows the same skeleton as every other screen's chunk
 * (Pending), where it said "Loading your sequence…" beside a lit domino, so a route change looks the same wherever it goes;
 * in the narrow column these screens draw in, as that line was.
 */
function Flagged({ screen: Lazy, title }: { screen: React.LazyExoticComponent<() => React.ReactNode> | null; title: string | null }) {
  if (!Lazy) return <NotFound />
  return (
    <Suspense fallback={<Pending title={title} narrow />}>
      <Lazy />
    </Suspense>
  )
}

function Screen({ page, param }: { page: Page; param: string }) {
  // The tab's name until the screen is in (routeTable.ts pendingTitle, final review shell-2: the screens' own names).
  const title = pendingTitle(page, param, window.location.hash, __DOMINO_V2__)
  const pending = <Pending title={title} />
  switch (page) {
    case 'overview':
      return <Landing />
    case 'markets':
      return <Explore fallback={pending} />
    case 'pool':
      return param === 'network' && NetworkPoolDetail ? <NetworkPoolDetail fallback={pending} /> : <PoolDetail poolId={param} fallback={pending} />
    case 'positions':
      return <Positions param={param} fallback={pending} />
    case 'new':
      return <NewPosition poolId={param} fallback={pending} />
    case 'automate':
      return <Automate fallback={pending} />
    case 'docs':
      return <Docs slug={param} fallback={pending} />
    case 'sequence':
      return <Flagged screen={Sequence} title={title} />
    case 'setup':
      return <Flagged screen={Setup} title={title} />
    case 'elysium':
      return <Elysium fallback={pending} />
    default:
      // Only the build that carries a consumer screen names it; elsewhere the whole branch folds away.
      if (__DOMINO_ONBOARDING_PREVIEW__ && page === 'live-preview') return <Flagged screen={LivePreview} title={title} />
      if (__DOMINO_DEPOSIT_LAB__ && page === 'deposits') return <Flagged screen={Deposits} title={title} />
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
  // One provider for the whole app, so navigating between pool views shares one load.
  const [markets] = useState(appMarketsProvider)

  // Every screen plays its own load moment on every visit, as each page of the approved prototype does on its own load
  // (V4, states/System.html 'Changing pages'): a route change takes dm-booted off <html> for 1.5 s, so the screen that
  // mounts replays its html:not(.dm-booted) moment (tokens.css, each area's v4 file), then puts it back, so content that
  // mounts later, a tab switch or data arriving never animate. A section link (#/docs/x#y) keeps the route, so nothing
  // replays. dm-started stays from the first route change: the header and the ember never replay (tokens.css). Before
  // the paint (a layout effect), so the new screen's first frame is its moment's first frame. A part that stays mounted
  // across the change (the docs sidebar) replays too, as on the prototype's full page load: when the first load's moment
  // is still on, it goes off for one style pass first (a forced style read), so its animation starts again.
  const routeKey = `${page}/${param}`
  const shownRoute = useRef(routeKey)
  useLayoutEffect(() => {
    if (shownRoute.current === routeKey) return
    shownRoute.current = routeKey
    const root = document.documentElement
    root.classList.add('dm-started')
    if (!root.classList.contains('dm-booted')) {
      root.classList.add('dm-booted')
      void root.offsetWidth
    }
    root.classList.remove('dm-booted')
    const settle = window.setTimeout(() => root.classList.add('dm-booted'), 1500)
    return () => window.clearTimeout(settle)
  }, [routeKey])
  // The first load's moment ends the same way, 1.5 s in, so a part that mounts later on a page opened directly (the
  // verified pool replacing its resting one, a card after a dialog closes) does not replay it. A route change before
  // then owns the class (above).
  useEffect(() => {
    const first = shownRoute.current
    const settle = window.setTimeout(() => { if (shownRoute.current === first) document.documentElement.classList.add('dm-booted') }, 1500)
    return () => window.clearTimeout(settle)
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
      <EmberLight />
      <SkipLink />
      {__DOMINO_LOCAL_LIVE__ ? <LocalDevelopmentBanner /> : !__DOMINO_DEPLOYABLE__ && <BuildBanner mode={__DOMINO_READ_MODE__} />}
      <Header page={page} />
      {/* 2026-10-14 (incident X1): a screen that throws as it draws no longer blanks the page; the header and the footer stay. */}
      <ScreenBoundary route={routeKey}>
        <Screen page={page} param={param} />
      </ScreenBoundary>
      {/* Changed on purpose 2026-10-03 (the owner): the footer's Pause motion control is gone; reduced motion still stills the page. */}
      <Footer />
    </div>
    </MarketsContext.Provider>
  )
}
