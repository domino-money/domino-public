/**
 * The site's pages, by the first segment of the hash route, and the second segments that name nothing.
 *
 * Its own module, with no imports and no build flag (2026-10-01, platform workstream, F1/F2): App.tsx routes with it,
 * and the build (vite.config.ts) writes the same table into the page, where the boot script
 * (functions/_lib/boot.ts) finds the route's code and asks for it while the app's own script downloads. Older links
 * keep working: `#/explore` and `#/pools` are Markets; `#/app` and `#/portfolio` are Positions; `#/settings` opens the
 * docs, which say what the Settings page said (the owner removed that page, 2026-09-27). The screens a build carries
 * only behind a flag (the consumer previews, the test labs) add their own rows in App.tsx.
 *
 * `#/elysium…` is the second chain's section (2026-10-01, the chain2 workstream, part B): one lazy chunk of its own
 * (src/chains/elysium/ui/ElysiumEntry.tsx), which decides by itself whether it is open where the page is served
 * (src/chains/elysium/flag.ts: off on domino.money until the chain's deployment is qualified, on in the preview).
 */
export const ROUTES = {
  '': 'overview',
  markets: 'markets',
  explore: 'markets',
  pools: 'markets',
  pool: 'pool',
  positions: 'positions',
  app: 'positions',
  portfolio: 'positions',
  new: 'new',
  automate: 'automate',
  settings: 'docs',
  docs: 'docs',
  sequence: 'sequence',
  setup: 'setup',
  elysium: 'elysium',
} as const

export type RoutedPage = (typeof ROUTES)[keyof typeof ROUTES]

/**
 * Markets' second segment is a token's address (`#/markets/<token>`, components/explore/routes.ts); anything else there
 * names nothing, and the page says so rather than showing Markets as if the link had worked (live notes, L19).
 */
export const MARKETS_TOKEN = /^0x[0-9a-fA-F]{40}$/
