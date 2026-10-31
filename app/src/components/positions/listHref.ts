import { positionsHref } from '../explore/routes'
import { portfolioHash } from '../../lib/read/screens/positions'

/**
 * Where a position page's "Positions" link goes back to (QA round 2, N62): the list as it was left. Opened from another
 * address's list (`#/portfolio/<address>`, the Wallet card's View address), it returns to that address, not to an empty
 * Public address field on `#/positions`. The list says what it shows (Positions.tsx PositionsList); a page opened by a
 * link or after a reload goes to `#/positions`, as before. Leaving Positions for any other screen forgets the address.
 *
 * Memory of this visit only: nothing is kept in the browser, and nothing is read for it.
 *
 * Changed on purpose 2026-10-30 (QA round 2, CI): the address is also taken from the route the moment the hash changes.
 * The list learns its address a render later (PortfolioBody's onLinked), so a position opened right after the list
 * appeared could miss it, and the list's later null (it shows no address once a position is open) erased it. A position
 * page now keeps the list it was opened from, whatever the list reports after it.
 */
let viewed: string | null = null
let listening = false

const PORTFOLIO_ADDRESS = /^#\/portfolio\/(0x[0-9a-fA-F]{40})(?:[/?#]|$)/
const POSITION_PAGE = /^#\/positions\/[^/?#]+/
const POSITIONS_OR_PORTFOLIO = /^#\/(positions|portfolio)(\/|$)/

const follow = () => {
  const hash = window.location.hash
  const shown = PORTFOLIO_ADDRESS.exec(hash)
  if (shown) viewed = shown[1].toLowerCase()
  else if (!POSITIONS_OR_PORTFOLIO.test(hash)) viewed = null
}

/** Told by the list: the address it shows read-only (lowercase), or null for the connected wallet's own list. */
export function rememberPositionsList(address: string | null): void {
  if (!listening && typeof window !== 'undefined') {
    listening = true
    window.addEventListener('hashchange', follow)
  }
  // A position page keeps the list it was opened from: the list's own null after it opened one changes nothing.
  if (address === null && typeof window !== 'undefined' && POSITION_PAGE.test(window.location.hash)) return
  viewed = address
}

/** The address the list showed read-only when it was left, or null (the connected wallet's list, or no list this visit). */
export const viewedPositionsAddress = (): string | null => viewed

/** The list to go back to: that address's `#/portfolio/<address>`, or `#/positions`. */
export const positionsListHref = (): string => (viewed ? portfolioHash(viewed) : positionsHref)
