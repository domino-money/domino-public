/**
 * Pages of their own, for search engines and shared links (added 2026-11-07, the owner: Domino in Google,
 * integ-logs/seo/PROPOSAL.md approach B with its three corrections).
 *
 * The site is one page, index.html, which Pages answers for every address. Each address now answers with its own head:
 * its title, description, canonical address and the shared link's words and picture, so a search result and a link pasted
 * in a chat say which page it is. The words are written by the build that draws the screens, into the page itself
 * (src/lib/seo/table.ts, vite.config.ts `domino:page-heads`): a data block this module reads and takes out again, and
 * Home's head between two marks, which it replaces. A Function has no build define, so a table imported here would
 * describe the site before a network opened (correction 1); the page's own table never can.
 *
 *   /markets/ and an older name (/explore, /docs/stop-loss …)   → 301 to the page's own address (functions/_lib/pagePaths.ts)
 *   a page the table lists (Home, Markets, New position,       → 200, its own head
 *   Positions, Automate, the docs and each of their pages)
 *   a page the app opens but no search lists (a pool, a        → 200, the site's head with no canonical, and noindex
 *   position, Receipts, an address, a setup, a section)
 *   anything else, a docs page that does not exist too         → 404, the same page: the app says "This page doesn't exist"
 *
 * Search (SEARCH_INDEX, a Pages secret, exactly "on"; off by default, PROPOSAL.md §5 step 3): only on domino.money itself,
 * and there only for the pages the table lists for search, the favicon and the shared picture, the noindex the site has
 * always carried is lifted. Every other answer keeps it: the preview, every pages.dev address, any other host, the API,
 * the access page, the files, and a page left out of search ("noindex", its links still followed). Anything else, or a
 * page without its table, fails closed: "noindex, nofollow" as before.
 *
 * Pure but for Response: functions/_middleware.ts calls it once the gate has admitted a request, and tests/seo.test.mjs
 * drives it with the build's own page.
 */
import { canonicalPath } from './pagePaths'

/** The search switch (2026-11-07), a Pages secret like BETA_GATE, set for production only: exactly SEARCH_ON lifts noindex. */
export interface SearchEnv {
  SEARCH_INDEX?: string
}
export const SEARCH_ON = 'on'
/** The one host whose pages may be listed. */
export const SEARCH_HOST = 'domino.money'
/** The site's files that may be shown in a result beside its pages: the favicon and the shared picture. */
export const SEARCH_FILES: ReadonlySet<string> = new Set(['/favicon.svg', '/favicon.ico', '/og.png'])

/** The data block's id, and the marks around the head this module replaces. */
export const HEAD_TABLE_ID = 'dm-head'
export const HEAD_START = '<!--dm-head-->'
export const HEAD_END = '<!--/dm-head-->'
const TABLE_OPEN = `<script type="application/json" id="${HEAD_TABLE_ID}">`

/** One page's words. `index`: listed for search (and in the sitemap); a page marked false keeps noindex. */
export interface HeadWords {
  title: string
  description: string
  /** The title a shared link shows, where it is not `title`. */
  social?: string
  index: boolean
}

/** What the build writes into the page (src/lib/seo/table.ts). */
export interface HeadTable {
  /** The address the site is listed under, with no trailing slash. */
  origin: string
  site: { name: string; alternateName: string }
  image: { path: string; width: number; height: number; alt: string }
  /** Every page with words of its own, by its own address. */
  pages: Readonly<Record<string, HeadWords>>
  /** The words of every other page the app opens. */
  other: HeadWords
  /** The route table: first segment to page (src/routeTable.ts ROUTES). */
  routes: Readonly<Record<string, string>>
  /** Every docs slug the docs open, the older ones included. */
  docs: readonly string[]
}

const attribute = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const text = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** JSON inside a script element: no `<` can close it. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')

/**
 * A page's head, between its two marks: `path` is a page the table lists, or null for any other page (no canonical
 * address, noindex). Home alone carries the site's name as structured data, a data block no CSP runs.
 */
export function headTags(table: HeadTable, path: string | null): string {
  const listed = path !== null && Object.hasOwn(table.pages, path)
  const words = listed ? table.pages[path] : table.other
  const url = listed ? `${table.origin}${path}` : null
  const lines = [
    `<title>${text(words.title)}</title>`,
    `<meta name="description" content="${attribute(words.description)}" />`,
    ...(words.index ? [] : ['<meta name="robots" content="noindex" />']),
    ...(url ? [`<link rel="canonical" href="${attribute(url)}" />`] : []),
    `<meta property="og:site_name" content="${attribute(table.site.name)}" />`,
    '<meta property="og:type" content="website" />',
    ...(url ? [`<meta property="og:url" content="${attribute(url)}" />`] : []),
    `<meta property="og:title" content="${attribute(words.social ?? words.title)}" />`,
    `<meta property="og:description" content="${attribute(words.description)}" />`,
    `<meta property="og:image" content="${attribute(`${table.origin}${table.image.path}`)}" />`,
    `<meta property="og:image:width" content="${table.image.width}" />`,
    `<meta property="og:image:height" content="${table.image.height}" />`,
    `<meta property="og:image:alt" content="${attribute(table.image.alt)}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    ...(path === '/' && listed
      ? [`<script type="application/ld+json">${scriptJson({ '@context': 'https://schema.org', '@type': 'WebSite', name: table.site.name, alternateName: table.site.alternateName, url: `${table.origin}/` })}</script>`]
      : []),
  ]
  return `${HEAD_START}\n    ${lines.join('\n    ')}\n    ${HEAD_END}`
}

/** The data block the build writes beside the head. */
export const tableTag = (table: HeadTable): string => `${TABLE_OPEN}${scriptJson(table)}</script>`

/** The table a page carries, and where its block starts and ends; null when it carries none or an unreadable one. */
function readTable(html: string): { table: HeadTable; start: number; end: number } | null {
  const start = html.indexOf(TABLE_OPEN)
  const end = start === -1 ? -1 : html.indexOf('</script>', start)
  if (end === -1) return null
  try {
    const table = JSON.parse(html.slice(start + TABLE_OPEN.length, end)) as HeadTable
    if (typeof table?.origin !== 'string' || typeof table.pages !== 'object' || typeof table.routes !== 'object' || !Array.isArray(table.docs) || typeof table.other?.title !== 'string') return null
    return { table, start, end: end + '</script>'.length }
  } catch {
    return null
  }
}

/** A path of the site's pages: one that names no file, outside the API and the access page. */
const pagePath = (path: string): boolean => !/^\/(?:api|uniswap-v3|__beta)(?:\/|$)/i.test(path) && !/\.[A-Za-z0-9]{1,8}$/.test(path)

/** A request the site's pages answer: a GET or HEAD of a page's path. */
export function pageRequest(request: Request, url: URL): boolean {
  return (request.method === 'GET' || request.method === 'HEAD') && pagePath(url.pathname)
}

/**
 * What the static files are asked for a page request: a HEAD as a GET, the same request otherwise (undefined: as sent).
 * Cloudflare answers a HEAD with headers alone, which carry no table to read the page's words and kind from. The GET
 * carries no cookie: the static files read none, and so a signed-in visitor's HEAD and an open site's ask the same.
 */
export function pageFromFiles(request: Request): Request | undefined {
  if (request.method !== 'HEAD') return undefined
  const headers = new Headers(request.headers)
  headers.delete('Cookie')
  return new Request(request, { method: 'GET', headers })
}

/** Where a page's address moves for good: the page's own, the query kept; null when it is the page's own already. */
export function pageRedirect(url: URL): string | null {
  const own = canonicalPath(url.pathname)
  return own === url.pathname ? null : `${url.origin}${own}${url.search}`
}

/**
 * The route a gated page was asked at, for the access page to carry through the password (`#/markets`; PROPOSAL.md §2,
 * from approach A): the hash form the gate already carries (functions/_lib/gate.ts nextHash checks its shape, and the app
 * turns `/#/markets` into `/markets`). Home carries none, as before, and neither does a path with an empty segment
 * (`//host/`), which no page has (pageKind) and which would read as another host's address after the password.
 */
export function askedRoute(url: URL): string {
  const own = canonicalPath(url.pathname)
  return own === '/' || own.includes('//') || !pagePath(own) ? '' : `#${own}`
}

/** listed: the table's own words; other: a page the app opens with no words of its own; missing: a 404. */
export type PageKind = 'listed' | 'other' | 'missing'

/** What the app shows at `path`, as App.tsx parseHash reads its first two segments, with the table's docs and routes. */
export function pageKind(table: HeadTable, path: string): PageKind {
  if (Object.hasOwn(table.pages, path)) return 'listed'
  if (path.includes('//')) return 'missing'
  const [, first = '', second = ''] = path.split('/')
  const page = Object.hasOwn(table.routes, first) ? table.routes[first] : null
  if (page === null) return 'missing'
  // Markets takes a token's address or a network's token there (App.tsx parseHash); the docs one of their slugs.
  if (page === 'markets' && second !== '' && second !== 'network' && !/^0x[0-9a-fA-F]{40}$/.test(second)) return 'missing'
  if (page === 'docs' && second !== '' && !table.docs.includes(second)) return 'missing'
  return 'other'
}

/** A page's answer once shaped: the page's kind and words, or null where the page carried no table. */
export interface ShapedPage {
  response: Response
  kind: PageKind | null
  index: boolean
}

/**
 * The static answer for a page (`served`: index.html, as Pages answers any address) with the page's own head, without
 * the table, and 404 where the app has nothing there. Anything but a 200 page with its table is passed on as it came.
 * `head`: a HEAD request, whose answer has no body. The middleware asks the static files for its page as a GET
 * (pageFromFiles), so a HEAD answers with its GET's status and robots, without the body (review 2026-11-07); where the
 * files still answered with none, there is no table to read and it is passed on as it came (a 200, noindex kept).
 */
export async function shapePage(served: Response, url: URL, head: boolean): Promise<ShapedPage> {
  const unshaped = (response: Response): ShapedPage => ({ response, kind: null, index: false })
  if (served.status !== 200 || !(served.headers.get('Content-Type') ?? '').includes('text/html')) return unshaped(head ? new Response(null, served) : served)
  const html = await served.text()
  const found = readTable(html)
  const start = html.indexOf(HEAD_START)
  const end = html.indexOf(HEAD_END)
  if (found === null || start === -1 || end < start) return unshaped(new Response(head ? null : html, served))
  const kind = pageKind(found.table, url.pathname)
  const listed = kind === 'listed'
  const withoutTable = `${html.slice(0, found.start).replace(/[ \t]*$/, '')}${html.slice(found.end).replace(/^\r?\n/, '')}`
  const at = withoutTable.indexOf(HEAD_START)
  const page = `${withoutTable.slice(0, at)}${headTags(found.table, listed ? url.pathname : null)}${withoutTable.slice(withoutTable.indexOf(HEAD_END) + HEAD_END.length)}`
  const headers = new Headers(served.headers)
  headers.delete('Content-Length')
  headers.delete('Content-Encoding')
  return {
    response: new Response(head ? null : page, { status: kind === 'missing' ? 404 : 200, headers }),
    kind,
    index: listed && found.table.pages[url.pathname].index,
  }
}

/** The sitemap the build writes (src/lib/seo/table.ts sitemapXml). */
export const SITEMAP_PATH = '/sitemap.xml'

/**
 * The X-Robots-Tag of an answer the site writes (functions/_middleware.ts): "noindex, nofollow", the site's own since it
 * began, everywhere but on domino.money with search on. There, a page the table lists for search and the files a
 * result shows (SEARCH_FILES) carry none, and every other page "noindex" (its links still followed); so does the
 * sitemap, a file never shown in a result whose addresses are all to be followed (review 2026-11-07). `page`: a page's
 * answer as shapePage shaped it; null for anything else.
 */
export function searchRobots(response: Response, url: URL, env: SearchEnv, page: ShapedPage | null): Response {
  if (env.SEARCH_INDEX !== SEARCH_ON || url.hostname !== SEARCH_HOST) return response
  const ok = response.status === 200 || response.status === 304
  if (page !== null && page.kind !== null) {
    if (ok && page.index) response.headers.delete('X-Robots-Tag')
    else response.headers.set('X-Robots-Tag', 'noindex')
  } else if (SEARCH_FILES.has(url.pathname) && ok) response.headers.delete('X-Robots-Tag')
  else if (url.pathname === SITEMAP_PATH && ok) response.headers.set('X-Robots-Tag', 'noindex')
  return response
}
