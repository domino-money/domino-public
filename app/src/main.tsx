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

/**
 * A link to another screen that the mouse reaches or the keyboard focuses (2026-10-30, QA round 2, Q2, the owner: route
 * chunks preloaded on hover and focus too, so most moves draw at once): its route's files are asked for right then, as
 * the page's boot script asks for the opened route's (functions/_lib/boot.ts: the same table, the same links, the same
 * crossorigin, so the app's own loader takes them and nothing is fetched twice). Only fetched and parsed, never run
 * before the person goes there, so a file that fails here changes nothing. Once per route; a file the page already names
 * (asked, loaded or prefetched while idle) is left alone. Not for a finger: a touch reaches a link at the start of every
 * scroll that begins on one, and a tap follows its link at once anyway. And, as the idle prefetch (lib/prefetchRoutes.ts),
 * none on a connection that saves data or a 2G one, where the screen's own reads come first.
 */
const warmed = new Set<string>()
function warmRoute(event: Event) {
  if (typeof PointerEvent !== 'undefined' && event instanceof PointerEvent && event.pointerType === 'touch') return
  const href = event.target instanceof Element ? event.target.closest('a[href^="#/"]')?.getAttribute('href') : null
  if (!href) return
  const { page, param } = parseHash(href)
  const key = page === 'positions' && /^[1-9]\d*$/.test(param) ? 'position' : page
  const connection = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  if (warmed.has(key) || connection?.saveData === true || /(^|-)2g$/.test(connection?.effectiveType ?? '')) return
  warmed.add(key)
  let files: unknown
  try {
    files = (JSON.parse(document.getElementById('dm-boot')?.textContent ?? '{}') as { chunks?: Record<string, unknown> }).chunks?.[key]
  } catch {
    return
  }
  if (Array.isArray(files)) for (const file of files) {
    if (typeof file !== 'string' || !/^\/assets\/[\w.-]+\.(js|css)$/.test(file) || document.querySelector(`[href="${file}"],[src="${file}"]`)) continue
    const preload = document.createElement('link')
    if (file.endsWith('.css')) {
      preload.rel = 'preload'
      preload.as = 'style'
    } else preload.rel = 'modulepreload'
    preload.crossOrigin = ''
    preload.setAttribute('href', file)
    document.head.appendChild(preload)
  }
}

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
  // And a screen's files at once when a link to it is about to be followed (warmRoute, above).
  document.addEventListener('pointerover', warmRoute, { passive: true })
  document.addEventListener('focusin', warmRoute)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
