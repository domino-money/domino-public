import { useEffect } from 'react'

/**
 * Each screen names its tab, and a screen reader hears where it arrived (audit E11, 2026-10-01). Every route was titled
 * "Domino" (only the docs named theirs), so tabs, history and bookmarks all read the same; and a hash route changes no
 * document, so a screen reader was told nothing when the page changed under it.
 *
 * The tab: "Markets · Domino", "ETH / USDG · Domino", "Position #4101 · Domino"; Home is "Domino". The name goes back
 * when the screen goes. The announcement: once the first screen is on show, every later move to another route says the
 * new tab's name in a polite live region kept outside the app's root, made once. A screen that renames itself on the
 * same route (a pool's pair arriving) renames the tab and says nothing.
 */

const SITE = 'Domino'

/** The route the last announcement was for (the hash up to a section), so a renamed screen is not announced again. */
let announcedRoute: string | null = null

const routeOf = (hash: string) => {
  const path = hash.replace(/^#/, '')
  const cut = path.indexOf('#', 1)
  return (cut === -1 ? path : path.slice(0, cut)) || '/'
}

/** The live region, made the first time something is said: visually hidden, polite, and never focusable. */
function region(): HTMLElement | null {
  if (typeof document === 'undefined' || !document.body) return null
  const found = document.querySelector<HTMLElement>('[data-route-announcer]')
  if (found) return found
  const node = document.createElement('div')
  node.setAttribute('data-route-announcer', '')
  node.setAttribute('aria-live', 'polite')
  node.setAttribute('aria-atomic', 'true')
  node.className = 'sr-only'
  document.body.appendChild(node)
  return node
}

/** Says `words` once: cleared first, so the same words said again are still heard. */
function announce(words: string) {
  const node = region()
  if (!node) return
  node.textContent = ''
  window.setTimeout(() => {
    node.textContent = words
  }, 50)
}

/** Names the tab `full` while the screen is on show, and announces a move to a new route. */
export function useTabTitle(full: string) {
  useEffect(() => {
    if (typeof document === 'undefined') return
    const before = document.title
    document.title = full
    const route = routeOf(window.location.hash)
    // The first screen of a visit is the page itself: the browser reads its title already.
    if (announcedRoute !== null && announcedRoute !== route) announce(full)
    announcedRoute = route
    return () => {
      // Changed on purpose 2026-10-30 (QA round 2, N25: a stale tab title after Back): the name goes back only while the
      // tab still shows this screen's; a screen that has already named the tab since keeps its own.
      if (document.title === full) document.title = before
    }
  }, [full])
}

/** A screen's tab: "<name> · Domino", or "Domino" for Home (no name). */
export function useRouteTitle(name: string | null) {
  useTabTitle(name ? `${name} · ${SITE}` : SITE)
}
