import { lazy, Suspense, useEffect, useState } from 'react'
import { Header } from './components/Header'
import { Footer } from './components/Footer'
import { Ticker } from './components/Ticker'
import { Landing } from './screens/Landing'
import { Dashboard } from './screens/Dashboard'
import { Settings } from './screens/Settings'
import { Pools } from './screens/Pools'
import { Button, Card } from './components/ui'
import { BuildBanner } from './components/read/BuildBanner'
import { useAppearance } from './lib/appearance'
import { appMarketsProvider } from './lib/read/buildMode'
import { MarketsContext } from './lib/read/useMarkets'
import { LocalDevelopmentBanner } from './components/read/LocalDevelopmentBanner'

// The onboarding previews (#38) and the deposit consumer's fixture lab
// (#40/#44) are compiled in only by `vite build --mode consumer-test`.
// Everywhere else both constants are null: the bundler drops the imports, no
// chunk is emitted, and both routes fall through to Landing like any unknown
// route. A chunk that fails to load says so instead of showing a blank page.
const Sequence = __DOMINO_WALLET_SESSION__ ? lazy(() => import('./screens/Sequence')) : null
const Setup = __DOMINO_WALLET_SESSION__ ? lazy(() => import('./screens/Setup')) : null
const LivePreview = __DOMINO_ONBOARDING_PREVIEW__ ? lazy(() => import('./screens/LivePreview').catch(() => ({ default: () => <p role="alert">This screen couldn’t load. Reload to try again.</p> }))) : null
const Deposits = __DOMINO_DEPOSIT_LAB__ ? lazy(() => import('./screens/Deposits').catch(() => ({ default: () => <p role="alert">This screen couldn’t load. Reload to try again.</p> }))) : null

/**
 * Hash routing with a section part: `#/#pools` is route `/`, section
 * `pools`. Both are tracked, so a link that only changes the section still
 * produces a state change and still scrolls, and a route change does not
 * discard the section it was asked to open.
 */
function parseHash(hash: string) {
  const raw = hash.replace(/^#/, '')
  const cut = raw.indexOf('#')
  const route = (cut === -1 ? raw : raw.slice(0, cut)) || '/'
  const section = cut === -1 ? '' : raw.slice(cut + 1)
  return { route, section }
}

/**
 * Puts the requested section under the header, or returns to the top when the
 * hash carries none.
 *
 * Positioned directly rather than with a smooth behaviour: smooth scrolling is
 * silently ignored by some embedded browsers, which would leave an in-page link
 * doing nothing at all.
 */
function applyScroll(section: string) {
  const target = section ? document.getElementById(section) : null
  if (!target) {
    window.scrollTo(0, 0)
    return
  }
  const header = document.querySelector('header')?.getBoundingClientRect().height ?? 0
  window.scrollTo(0, Math.max(0, target.getBoundingClientRect().top + window.scrollY - header - 16))
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
      setTimeout(() => applyScroll(next.section), 0)
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return location
}

export default function App() {
  const { route } = useHashLocation()
  const { dark, setDark } = useAppearance()
  // One provider for the whole app, so the ticker and the table share one load.
  const [markets] = useState(appMarketsProvider)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  // A page opened directly on a section link starts at the top otherwise. Read
  // from the hash rather than from state so this depends on nothing and runs
  // once; later changes are handled by the hash listener.
  useEffect(() => {
    const initial = parseHash(window.location.hash).section
    if (initial) setTimeout(() => applyScroll(initial), 0)
  }, [])

  return (
    <MarketsContext.Provider value={markets}>
    <div className="min-h-screen">
      {__DOMINO_LOCAL_LIVE__ ? <LocalDevelopmentBanner /> : !__DOMINO_DEPLOYABLE__ && <BuildBanner mode={__DOMINO_READ_MODE__} />}
      {route === '/' && <Ticker />}
      <Header route={route} />
      {route === '/app' ? (
        __DOMINO_ONBOARDING_PREVIEW__ || __DOMINO_DEPOSIT_LAB__ ? (
          <>
            {/* The previews (#38) and the deposit fixture lab (#40/#44), in the
                consumer-test build only; everywhere else this branch folds away
                and /app renders exactly as before. */}
            <div className="mx-auto max-w-[1100px] px-5">
              <Card level={2} className="mt-10 flex flex-wrap items-center justify-between gap-4 p-4 md:px-5">
                <div>
                  <h2 className="text-[14px] font-medium">Live preview (invited testers)</h2>
                  <p className="mt-0.5 text-[12px] text-fg-muted">Onboarding previews for a signed-in wallet, and the deposit consumer’s fixture lab. This test build only.</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => (window.location.hash = '#/live-preview')}>
                    Live preview
                  </Button>
                  <Button variant="outline" onClick={() => (window.location.hash = '#/deposits')}>
                    Deposit fixture lab
                  </Button>
                </div>
              </Card>
            </div>
            <Dashboard />
          </>
        ) : (
          <Dashboard />
        )
      ) : route === '/sequence' && Sequence ? (
        <Suspense fallback={<p role="status">Loading sequences…</p>}><Sequence /></Suspense>
      ) : route === '/setup' && Setup ? (
        <Suspense fallback={<p role="status">Loading setup…</p>}><Setup /></Suspense>
      ) : route === '/pools' ? (
        <Pools />
      ) : route === '/settings' ? (
        <Settings />
      ) : __DOMINO_ONBOARDING_PREVIEW__ && LivePreview && route === '/live-preview' ? (
        <Suspense fallback={<p role="status">Loading…</p>}>
          <LivePreview />
        </Suspense>
      ) : __DOMINO_DEPOSIT_LAB__ && Deposits && route === '/deposits' ? (
        <Suspense fallback={<p role="status">Loading…</p>}>
          <Deposits />
        </Suspense>
      ) : (
        <Landing />
      )}
      {/* The appearance toggle sits in the footer's own flow at every width, never floating over the page, so it can never cover text. */}
      <Footer
        appearance={
          <Button variant="outline" onClick={() => setDark(!dark)} aria-label={dark ? 'Switch to light appearance' : 'Switch to dark appearance'}>
            {dark ? 'Light' : 'Dark'}
          </Button>
        }
      />
    </div>
    </MarketsContext.Provider>
  )
}
