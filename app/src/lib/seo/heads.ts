/**
 * What a search engine and a shared link show for the site's main pages (added 2026-11-07, the owner: Domino in Google,
 * the words he approved in integ-logs/seo/PROPOSAL.md §3).
 *
 * Each title is the name the page's own tab already has (routeTable.ts pendingTitle, each screen's useRouteTitle), so a
 * search result and the tab say the same thing; tests/seo.test.mjs holds them equal. Home's is new: "Domino · Earn fees.
 * Keep control." (decision 1), its tab too (screens/Landing.tsx). A link shared in a chat shows `social` as its title
 * where it differs: Home's leaves out "Domino", which the site's name already shows beside it.
 *
 * The docs pages take their own title and the summary their page shows under it (lib/seo/table.ts, from the docs'
 * registry), so a summary that changes with a network changes here in the same build.
 *
 * Pure data, no imports: Home's tab name is read from here by the entry every visitor downloads.
 */

/** The address the site is listed under. */
export const SITE_ORIGIN = 'https://domino.money'
export const SITE_NAME = 'Domino'
/** The site's other name, in Home's structured data only. */
export const SITE_ALTERNATE_NAME = 'domino.money'

/** Home's tab and search title. */
export const HOME_TITLE = 'Domino · Earn fees. Keep control.'

export interface PageWords {
  /** The page's own address, as functions/_lib/pagePaths.ts canonicalPath writes it. */
  path: string
  title: string
  description: string
  /** The title a shared link shows, where it is not `title`. */
  social?: string
  /**
   * False: a page kept out of search (a future points page): its own words, noindex, and not in the sitemap. Left out, the
   * page is listed for search.
   */
  index?: boolean
}

export const HOME_PAGE: PageWords = {
  path: '/',
  title: HOME_TITLE,
  description: 'Put two tokens in a Uniswap pool and earn its trading fees. Your wallet stays yours.',
  social: 'Earn fees. Keep control.',
}

/** The main screens, in the order the sitemap lists them; the docs index and its pages follow from the registry. */
export const MAIN_PAGES: readonly PageWords[] = [
  { path: '/markets', title: 'Markets · Domino', description: 'Top pools of the last 24 hours, with their volume and estimated APR.' },
  { path: '/new', title: 'New position · Domino', description: 'Choose a pool, a price range and an amount. Nothing leaves your wallet until you confirm.' },
  { path: '/positions', title: 'Positions · Domino', description: 'Your positions on every network, what they earned, and what your automation did.' },
  { path: '/automate', title: 'Automate · Domino', description: 'Auto-compound, Domino-compound or Auto-exit: choose what happens next.' },
  // Added 2026-11-07 (the owner's Points page, Season 1, integ-logs/points/PROPOSAL.md §1): its own words, and kept out of
  // search: noindex, and not in the sitemap.
  { path: '/points', title: 'Points · Domino', description: 'Your Domino points for Season 1 and your referral link.', index: false },
]

/**
 * A page with no words of its own (a pool's, a position's, one not found): the tab's name until the screen names it, and
 * a shared link's title the same (PROPOSAL.md §3: the other pages' shared title is the tab's).
 */
export const OTHER_PAGE: Omit<PageWords, 'path'> = {
  title: SITE_NAME,
  description: HOME_PAGE.description,
}

/** The picture a shared link shows, the same for every page: public/og.png, as the owner approved it. */
export const SHARE_IMAGE = {
  path: '/og.png',
  width: 1200,
  height: 630,
  alt: 'Earn fees. Keep control. Put two tokens in a pool and earn its trading fees. domino.money',
} as const
