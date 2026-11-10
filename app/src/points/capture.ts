/**
 * A referral link's `?ref=` taken on whatever page it opens (added 2026-11-07, the owner's Points page, Stage 1:
 * integ-logs/points/PROPOSAL.md §6 step 1 and decisions D1, D2; rugged97's spec, "Captura do ?ref=").
 *
 *   - Only the address's own query is read (`location.search`), never a part after `#`: a link from before
 *     (`/#/points?ref=…`) stores nothing.
 *   - A referrer is `0x` and 40 hex digits; stored in lower case. Anything else is ignored.
 *   - The FIRST one stored wins in this browser (D2): a later `?ref=` never replaces it, so one browser names one
 *     referrer however many links it opens. A link naming the connected wallet itself is ignored: the wallet is not known
 *     yet when the page opens (the wallet's own chunk tells it later), so the Points page forgets such a link as soon as
 *     it sees that wallet connected (screens/Points.tsx), and the next link is stored in its place.
 *   - A referral link's `ref` leaves the address bar at once, through the router's own writer (lib/route.ts
 *     dropSearchParam): the path, the other parameters and the section stay, in the same history entry. A `ref` that
 *     is not one address is not ours (a wallet app's return link, a shared link's own tracking): it stays as it came.
 *
 * In the entry every visitor downloads (main.tsx): a few hundred bytes, so the link works on any page, before the Points
 * screen's own chunk is ever asked for. Nothing here signs or sends anything: linking is the Points page's, on a click.
 */

/** The browser's key for the stored referrer (lower case address, nothing else). */
export const REF_KEY = 'domino.points.ref'

/** A referrer: `0x` and 40 hex digits. */
export const REF_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** The storage this needs: localStorage, or a test's stand-in. The Points page reads and clears it (./ref.ts). */
export interface RefStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Reads `search` (the address's query, `?…`) for a referrer and stores it when it is the first. Returns whether the
 * query is a referral link (one `ref`, an address), stored or not, so the caller takes it out of the address bar.
 */
export function captureRef(search: string, store: RefStore | null): boolean {
  let values: string[]
  try {
    values = new URLSearchParams(search).getAll('ref')
  } catch {
    return false
  }
  if (values.length !== 1 || !REF_ADDRESS.test(values[0])) return false
  try {
    // The first one stored wins; what is stored and is not an address counts as nothing.
    if (!REF_ADDRESS.test(store?.getItem(REF_KEY) ?? '')) store?.setItem(REF_KEY, values[0].toLowerCase())
  } catch {
    // Private browsing that refuses storage: the link still opens the page, and nothing is kept.
  }
  return true
}
