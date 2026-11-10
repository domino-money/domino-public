/**
 * The words each page's head carries, as the build that draws the screens has them (added 2026-11-07, the owner: Domino
 * in Google, integ-logs/seo/PROPOSAL.md §3 and correction 1).
 *
 * vite.config.ts (`domino:page-heads`) loads this module with the build's own defines, writes Home's head and this table
 * into the page, and the sitemap beside it; the edge gives every other address its own head from the table
 * (functions/_lib/seo.ts). The docs pages are the registry's: "<page> · Docs · Domino", the tab's name (screens/Docs.tsx),
 * and the summary the page shows under its title, so a summary that names the networks follows the build that opens
 * one. A page added with `index: false` (a page to keep out of search, such as a future points page) gets its own words
 * and noindex, and stays out of the sitemap.
 *
 * Not part of the app: nothing under src/ imports it, so no visitor downloads the docs' registry for it.
 */
import { headTags, tableTag, type HeadTable, type HeadWords } from '../../../functions/_lib/seo'
import { PAGE_ALIASES } from '../../../functions/_lib/pagePaths'
import { DOC_PAGES, DOCS_HOME } from '../docs/registry'
import { ROUTES } from '../../routeTable'
import { HOME_PAGE, MAIN_PAGES, OTHER_PAGE, SHARE_IMAGE, SITE_ALTERNATE_NAME, SITE_NAME, SITE_ORIGIN, type PageWords } from './heads'

const words = ({ title, description, social }: Omit<PageWords, 'path'>, index = true): HeadWords => ({ title, description, ...(social ? { social } : {}), index })

/**
 * Every page with words of its own, in the sitemap's order: Home, the main screens (`main`, MAIN_PAGES; a test hands
 * its own), the docs and each of their pages. A page's own `index: false` is kept: listed for search only where it says
 * nothing.
 */
export function pageWords(main: readonly PageWords[] = MAIN_PAGES): readonly (PageWords & { index: boolean })[] {
  return [
    { ...HOME_PAGE, index: HOME_PAGE.index ?? true },
    ...main.map((page) => ({ ...page, index: page.index ?? true })),
    { path: '/docs', title: `${DOCS_HOME.title} · ${SITE_NAME}`, description: DOCS_HOME.summary, index: true },
    ...DOC_PAGES.map((page) => ({ path: `/docs/${page.slug}`, title: `${page.title} · Docs · ${SITE_NAME}`, description: page.summary, index: true })),
  ]
}

/** The table the page carries for the edge (`pages`: pageWords()'s; a test hands its own). */
export function headTable(pages: readonly (PageWords & { index: boolean })[] = pageWords()): HeadTable {
  const aliasSlugs = Object.keys(PAGE_ALIASES).filter((path) => path.startsWith('/docs/')).map((path) => path.slice('/docs/'.length))
  return {
    origin: SITE_ORIGIN,
    site: { name: SITE_NAME, alternateName: SITE_ALTERNATE_NAME },
    image: { ...SHARE_IMAGE },
    pages: Object.fromEntries(pages.map((page) => [page.path, words(page, page.index)])),
    other: words(OTHER_PAGE, false),
    routes: { ...ROUTES },
    docs: [...DOC_PAGES.map((page) => page.slug), ...aliasSlugs],
  }
}

/** The mark index.html carries where Home's head goes. */
export const HEAD_MARK = '<title>Domino</title>'

/** index.html with Home's head and the table in place of its mark; a page without the mark fails the build. */
export function withHead(html: string): string {
  if (!html.includes(HEAD_MARK)) throw new Error(`index.html has no ${HEAD_MARK} for the page's head.`)
  const table = headTable()
  return html.replace(HEAD_MARK, `${headTags(table, '/')}\n    ${tableTag(table)}`)
}

const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** sitemap.xml: every page listed for search, at its own address; a page kept out of search is not in it. */
export function sitemapXml(pages: readonly (PageWords & { index: boolean })[] = pageWords()): string {
  const urls = pages.filter((page) => page.index).map((page) => `  <url><loc>${xml(`${SITE_ORIGIN}${page.path}`)}</loc></url>`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`
}
