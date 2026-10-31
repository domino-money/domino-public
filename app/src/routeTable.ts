/**
 * The site's pages, by the first segment of the hash route, and the second segments that name nothing; and the tab's name
 * a route takes while its screen loads (pendingTitle, below).
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

/** The tab a route's screen names itself (each screen's useRouteTitle), as far as the route alone says it. */
const PENDING_NAMES: Partial<Record<string, string>> = { markets: 'Markets', pool: 'Pool', positions: 'Positions', new: 'New position', automate: 'Automate', docs: 'Docs', setup: 'Setup' }
const SETUP_MODE = /^(?:compound|domino)$/

/**
 * The tab's name while a route's screen is still on its way (App.tsx Pending): the name that screen gives itself, so the
 * tab and the history entry change on its arrival only where it knows more (a pool's pair, a docs page's title). `page`
 * and `param` as App's parseHash gives them, `hash` the whole location hash, `v2` the build's __DOMINO_V2__ (handed in, so
 * this module keeps no build flag).
 *
 * Changed on purpose 2026-10-30 (QA round 2, final review shell-2): moved here from App.tsx, in the names the screens now
 * give themselves. The docs are "Docs · Domino" (screens/Docs.tsx, N25; it said "Domino docs"). Set up automation's frame
 * takes the mode chosen on Automate, in either link order (screens/SequenceShell.tsx Frame, lib/create/sequenceDefaults.ts
 * sequenceIntent): "Set up Auto-compound · Domino" and "Set up Domino-compound · Domino"; it said "Set up automation" there.
 */
export function pendingTitle(page: string, param: string, hash: string, v2: boolean): string | null {
  const segments = hash.replace(/^#/, '').split('#')[0].split('/')
  if (page === 'sequence') {
    const mode = SETUP_MODE.test(param) ? param : /^[1-9]\d{0,77}$/.test(param) && SETUP_MODE.test(segments[3] ?? '') ? segments[3] : ''
    return `Set up ${!v2 ? 'automation' : param === 'protection' ? 'Auto-exit' : mode === 'compound' ? 'Auto-compound' : mode === 'domino' ? 'Domino-compound' : 'automation'} · Domino`
  }
  // A token's or a network's pools are Explore's "Token pools"; a position is "Position #<id>", the list's Receipts its own.
  const name =
    page === 'markets' && segments[2]
      ? 'Token pools'
      : page === 'positions' && param === 'receipts'
        ? 'Receipts'
        : page === 'positions' && /^[1-9]\d*$/.test(param)
          ? `Position #${param}`
          : Object.hasOwn(PENDING_NAMES, page)
            ? PENDING_NAMES[page]
            : undefined
  return name ? `${name} · Domino` : null
}
