/**
 * The address bar, read and written here and nowhere else (added 2026-11-07, the owner: Domino in Google,
 * integ-logs/seo/PROPOSAL.md approach B).
 *
 * Every page has its own address now: domino.money/markets, domino.money/docs/risks#who, domino.money/#learn, where it
 * was domino.money/#/markets. Inside, nothing changed: each screen still reads its route in the hash router's own form,
 * `#/markets`, `#/docs/risks#who`, `#/#learn` (currentRoute: the path and the section, or a link from before as it is),
 * with the same parsers, and hears a move as it heard hashchange (onRoute, the `domino:route` event).
 *
 * - A link from before (`/#/markets`: a bookmark, a post, a wallet app's return link) opens the same screen, and the
 *   address becomes the page's own at once, in place: no reload, no extra Back entry, the history entry's state kept
 *   (installRoutes, at start and on every hashchange). An older name of a page becomes the page's own the same way
 *   (functions/_lib/pagePaths.ts).
 * - A link of the site (`<a href="/markets">`) moves without a reload: one listener on the window, after every screen's
 *   own handlers, so a link a screen already handled (a contents list's, a section already open) is left to it. A link
 *   with a modifier key, another target, a download or a file goes to the browser as before.
 * - Back and Forward tell a move only when the route changed: the steps of New position, entries of one address
 *   (components/create/Journey.tsx), are not page changes.
 * - A path the site has no page at (`/nope`, `/nope#/positions`) is not found, whatever its hash (launch sweep F12,
 *   2026-11-07, kept beside pages of their own): a link from before is read only on a page's path (pageAt).
 *
 * Nothing here reads more than the address, and nothing is stored. A referral link's `ref` leaves the query here too
 * (dropSearchParam, 2026-11-07, the Points page), once src/points/capture.ts has read it.
 */
import { canonicalPath } from '../../functions/_lib/pagePaths'

/** The event a move of the route raises on the window, as hashchange did. */
export const ROUTE_EVENT = 'domino:route'

/** A move: the route before and after, each as currentRoute gives it. */
export interface RouteChange {
  from: string
  to: string
}

type Where = Pick<Location, 'pathname' | 'hash'>

/**
 * Whether the site has a page at a path (App.tsx isPagePath, given by installRoutes; every path until then). Kept from
 * 2026-11-07 (launch sweep F12) with pages of their own: Pages answers every path that names no file with the site's
 * page, and a path the app has no page at is not found whatever its hash, so a link from before is read only on a page's
 * path (`/#/markets`, `/positions#/docs`), never on `/nope#/positions`.
 */
let pageAt: (path: string) => boolean = () => true

/**
 * The route of a location in the hash router's form: a link from before (`#/…`) as it is on a page's path, else `#` +
 * path + section. `/index.html`, the site's page by its file's name, is Home's `/`.
 */
export const routeOf = (where: Where): string => {
  const path = where.pathname === '/index.html' ? '/' : where.pathname
  return where.hash.startsWith('#/') && pageAt(path) ? where.hash : `#${path}${where.hash}`
}

/** The open route; empty outside a browser. */
export const currentRoute = (): string => (typeof window === 'undefined' ? '' : routeOf(window.location))

/** A link's path and section at the page's own address: `/markets#x` for `#/explore#x`, `/explore#x` or `/markets/#x`. */
function pageUrl(href: string): string {
  const raw = href.startsWith('#/') ? href.slice(1) : href
  const cut = raw.indexOf('#')
  return `${canonicalPath(cut === -1 ? raw : raw.slice(0, cut))}${cut === -1 ? '' : raw.slice(cut)}`
}

/** A link of this site's pages: a path (never `//host` or `/\host`) outside the API and the access page, or a link from before. */
const PAGE_HREF = /^(?:#\/|\/(?![/\\]|api(?:[/?#]|$)|uniswap-v3(?:[/?#]|$)|__beta(?:[/?#]|$)))/
/** A path whose last segment names a file: a picture, a script, the sitemap. */
const FILE_PATH = /\.[A-Za-z0-9]{1,8}$/

/**
 * Whether a browser reads `url` (a path) as an address of this site. `//host…` and `/\host…` (a link from before typed
 * `#//host`, `#/\host`; a tab or a line break between the two, which the browser drops) name another host, which history
 * refuses with an error: such an address is never written or followed here, and the page stays where it is, showing
 * what it showed before (review 2026-11-07).
 */
const ownPath = (url: string): boolean => /^\/(?![/\\])/.test(url.replace(/[\t\n\r]/g, ''))

/** The route a link of the site's pages opens, in currentRoute's form, or null for any other link. */
export function routeOfHref(href: string): string | null {
  const url = PAGE_HREF.test(href) ? pageUrl(href) : null
  return url !== null && ownPath(url) && !FILE_PATH.test(url.split('#')[0]) ? `#${url}` : null
}

/** Writes the address: false where it is not this site's or the browser refused it, and nothing changed. */
function write(url: string, replace: boolean, state: unknown): boolean {
  if (!ownPath(url)) return false
  try {
    if (replace) window.history.replaceState(state, '', url)
    else window.history.pushState(state, '', url)
    return true
  } catch {
    return false
  }
}

/** The route the last move was told for. */
let shown = ''

function tell(quiet: boolean): void {
  const now = currentRoute()
  if (now === shown) return
  const change: RouteChange = { from: shown, to: now }
  shown = now
  if (!quiet) window.dispatchEvent(new CustomEvent<RouteChange>(ROUTE_EVENT, { detail: change }))
}

/** The page's own address in place of a link from before or an older name: the same entry, its state kept. */
function settle(): void {
  const { pathname, search, hash } = window.location
  const own = pageUrl(routeOf({ pathname, hash }).slice(1))
  const cut = own.indexOf('#')
  const url = cut === -1 ? `${own}${search}` : `${own.slice(0, cut)}${search}${own.slice(cut)}`
  if (url !== `${pathname}${search}${hash}`) write(url, true, window.history.state)
}

/**
 * Goes to `to` (a path with its section, or a link from before): a new history entry, or the open one replaced
 * (`replace`, as location.replace did). The open address again changes nothing, as a link to the open hash did. `quiet`:
 * the address changes and no move is told (a screen that follows its own state, components/portfolio/PortfolioBody.tsx);
 * Back to the entry before is told as any other move. False where the address could not be written (not this site's,
 * or refused): nothing moved, and a link is left to the browser.
 */
export function navigate(to: string, { replace = false, quiet = false }: { replace?: boolean; quiet?: boolean } = {}): boolean {
  const url = pageUrl(to)
  if (url === `${window.location.pathname}${window.location.hash}`) return true
  if (!write(url, replace, null)) return false
  tell(quiet)
  return true
}

/**
 * Takes one parameter out of the address's query, in place (added 2026-11-07, the Points page: a referral link's `ref`,
 * src/points/capture.ts): the same history entry and its state, the path, the other parameters and the section kept, and
 * no move told (the route is the path and the section, which do not change). False where nothing was written.
 */
export function dropSearchParam(name: string): boolean {
  const { pathname, search, hash } = window.location
  const params = new URLSearchParams(search)
  if (!params.has(name)) return false
  params.delete(name)
  const rest = params.toString()
  return write(`${pathname}${rest ? `?${rest}` : ''}${hash}`, true, window.history.state)
}

/** Hears every move of the route; the returned function stops it. `once`: the next move only. */
export function onRoute(listener: (change: RouteChange) => void, once = false): () => void {
  const heard = (event: Event) => listener((event as CustomEvent<RouteChange>).detail)
  window.addEventListener(ROUTE_EVENT, heard, { once })
  return () => window.removeEventListener(ROUTE_EVENT, heard)
}

/** For useSyncExternalStore: currentRoute is read again on every move. */
export const subscribeRoute = (changed: () => void): (() => void) => onRoute(() => changed())

/** A plain click on a link of the site's pages that nothing handled yet: moved here, without a reload. */
function follow(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null
  if (!(link instanceof HTMLAnchorElement) || (link.target !== '' && link.target !== '_self') || link.hasAttribute('download')) return
  const href = link.getAttribute('href') ?? ''
  if (routeOfHref(href) !== null && navigate(href)) event.preventDefault()
}

/**
 * Once, before the app reads its route (main.tsx): the page's own address now, then every move. `isPage`: whether the
 * site has a page at a path (App.tsx isPagePath). On a path it has none at, the first link from before followed there
 * (a hash change, `#/…`) moves to the site's own path, where its screen is (launch sweep F12, kept).
 */
export function installRoutes(isPage: (path: string) => boolean = () => true): void {
  pageAt = isPage
  settle()
  shown = currentRoute()
  const moved = () => {
    settle()
    tell(false)
  }
  const hashMoved = () => {
    const { pathname, search, hash } = window.location
    if (hash.startsWith('#/') && !pageAt(pathname === '/index.html' ? '/' : pathname)) window.history.replaceState(window.history.state, '', `/${search}${hash}`)
    moved()
  }
  window.addEventListener('popstate', moved)
  window.addEventListener('hashchange', hashMoved)
  window.addEventListener('click', follow)
}
