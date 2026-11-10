/**
 * The site's page addresses (added 2026-11-07, the owner: Domino in Google, integ-logs/seo/PROPOSAL.md approach B).
 *
 * Every page has an address of its own, domino.money/markets rather than domino.money/#/markets. An older name of a
 * page (the route table's other spellings, src/routeTable.ts, and the docs' older slugs, src/lib/docs/registry.ts
 * DOC_ALIASES) and a trailing slash name the same page: the edge answers them with a 301 to the page's own address
 * (functions/_lib/seo.ts), and the page itself rewrites a link from before to it in place (src/lib/route.ts).
 * Only a name alone is an alias: `/explore/<token>` or `/portfolio/<address>` is a page of its own, read as before.
 *
 * Pure and without imports: the entry every visitor downloads carries it, and so does the edge.
 * tests/seo.test.mjs holds the list equal to the route table's and the docs' older names.
 */
export const PAGE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  '/explore': '/markets',
  '/pools': '/markets',
  '/app': '/positions',
  '/portfolio': '/positions',
  '/settings': '/docs',
  '/docs/stop-loss': '/docs/auto-exit',
  '/docs/domino-compounder': '/docs/domino-compound',
})

/** A page's own address for `path`: no trailing slash but Home's, and an older name as the page's own. */
export function canonicalPath(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') || '/' : path
  return Object.hasOwn(PAGE_ALIASES, trimmed) ? PAGE_ALIASES[trimmed] : trimmed
}
