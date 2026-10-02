import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import App, { parseHash, preloadScreen } from './App'
import { parseExploreHash } from './components/explore/routes'
import { startMarkets } from './lib/read/buildMode'
import { startLoadTimings } from './lib/loadTiming'
import { recoverWhenSafe } from './lib/staleRelease'
import { sweepCopies } from './lib/browserCopies'
import { prefetchRoutes } from './lib/prefetchRoutes'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')

// The read lab (src/lab/main.tsx) marks its document: this module is reached
// from there through a chunk the read screens share with the app, and must
// not mount the app over the lab's own root.
if (!('dominoLab' in document.documentElement.dataset)) {
  startLoadTimings(window)
  // A file of this page that failed to load anywhere (Vite tells every lazily loaded chunk's failure here, then hands
  // the error on to the code that asked for it): if a release replaced it, the tab reloads once into the new release,
  // never under an open money flow (lib/staleRelease.ts, D1, 2026-10-01).
  window.addEventListener('vite:preloadError', recoverWhenSafe)
  // What this browser keeps about wallets and is past its age is deleted as the site opens, after its first paint
  // (lib/browserCopies.ts, I6, 2026-10-01): a copy is never shown past its age, and now it does not stay on disk either.
  setTimeout(() => sweepCopies(), 3_000)
  // Home and Markets ask for their pools now, not once the page has rendered (speed wave, item 9, 2026-09-28). A
  // token's own view on Markets (#/markets/<address>) shows no list, and asks for none.
  const { page } = parseHash(window.location.hash)
  if (page === 'overview' || (page === 'markets' && !parseExploreHash(window.location.hash).token)) startMarkets()
  // The opened screen's chunk, asked for before the first draw (2026-10-01, F1).
  preloadScreen(page)
  // And the other main screens' files once the page has loaded and gone quiet, at the lowest priority, so a first move to
  // one of them draws at once, as when they were in the entry (lib/prefetchRoutes.ts).
  window.addEventListener('load', () => setTimeout(() => prefetchRoutes(), 4_000), { once: true })
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
