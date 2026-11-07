/**
 * The Wallet card's tokens on Domino's other networks (Base and Arbitrum One), beside Robinhood Chain's own list.
 *
 * Added 2026-11-06 (the owner's replica rule: Base and Arbitrum One show what Robinhood Chain shows, only the network
 * changes; R-07 of the comparison of 4 Nov): the card lists those networks' tokens in dollars as it lists Robinhood
 * Chain's, in one list, the largest three first and the rest behind the same "Show all", and its one total counts them.
 * Each row then names its network, as Your positions does. V1 declares the shape here and imports nothing of V2, as
 * lib/create/otherChains.ts does for New position: a build that carries V2 hands the rows in from the lists' chunk
 * (src/v2in/walletNetworks/WalletNetworks.tsx, over read-v6's chain-balances, re-exported by src/v2in/lists/OwnedRows.tsx);
 * without one the view is `off` and the card is exactly Robinhood Chain's.
 *
 * The total follows Robinhood Chain's own rules (lib/walletHoldings.ts totalWithheld) and the owner's of 2 Oct: no sum
 * across networks without all of them. The other networks join it only from a read where every network asked answered
 * and every balance asked was read (src/v2in/walletNetworks/model.ts); until such a read lands, nothing of theirs is shown or
 * counted, and the figure holds its place while the first one is on its way. Pure; no React, no clock.
 */
import type { TokenDisplay } from './read/types'

/** One token held on another network, as the card shows it. */
export interface NetworkHolding {
  /** `<chainId>:<address>`: identity is the network and the address. */
  key: string
  chainId: number
  /** The network as the app names it ("Base", "Arbitrum One"). */
  network: string
  token: TokenDisplay
  /** The balance's raw integer: the card writes it in the token's units (`token.decimals`), as it writes its own. */
  raw: string
  /** Its USD value in 10^-18 dollars, or null when it has no price. */
  value: bigint | null
  /** How the value is priced, for its title; null with no value. */
  priceTitle: string | null
}

/**
 * What the other networks add to the card: `off` (no V2 in the build, its read route closed, or nothing whole read yet
 * once the first read's wait is over), `reading` (the first read is on its way), or `ready`: the held tokens of the last
 * whole read, largest value first, their priced sum, and how many have no price.
 */
export type WalletNetworksView =
  | { state: 'off' }
  | { state: 'reading' }
  | { state: 'ready'; holdings: readonly NetworkHolding[]; total: bigint; unpriced: number }

export const NETWORKS_OFF: WalletNetworksView = Object.freeze({ state: 'off' })

/** What a build with V2 hands in: watches one wallet's tokens on the other networks until the returned stop. */
export type WatchWalletNetworks = (wallet: string, listener: (view: WalletNetworksView) => void) => () => void

/** The held tokens the view adds to the card (none unless `ready`). */
export const networkHoldings = (view: WalletNetworksView): readonly NetworkHolding[] => (view.state === 'ready' ? view.holdings : [])

/** One row of the card: one of Robinhood Chain's own holdings, or a token on another network. */
export type CardRow<H> = { kind: 'robinhood'; holding: H } | { kind: 'network'; holding: NetworkHolding }

/**
 * The card's one list: Robinhood Chain's holdings in their own order (lib/walletHoldings.ts walletHoldings: by value,
 * an older price placing a token that has none now, then the unpriced ones) merged with the other networks' by value,
 * Robinhood Chain's first at an equal value; then Robinhood Chain's unpriced ones, then the other networks'. With no
 * other network's token it is Robinhood Chain's list as it was (pure).
 */
export function mergeCardRows<H extends { rank: bigint | null }>(robinhood: readonly H[], others: readonly NetworkHolding[]): CardRow<H>[] {
  const own: CardRow<H>[] = robinhood.map((holding) => ({ kind: 'robinhood', holding }))
  if (others.length === 0) return own
  const ranked = robinhood.filter((holding) => holding.rank !== null)
  const priced = others.filter((holding) => holding.value !== null)
  const out: CardRow<H>[] = []
  let a = 0
  let b = 0
  while (a < ranked.length || b < priced.length) {
    const left = ranked[a]
    const right = priced[b]
    if (right === undefined || (left !== undefined && (left.rank as bigint) >= (right.value as bigint))) {
      out.push({ kind: 'robinhood', holding: left })
      a += 1
    } else {
      out.push({ kind: 'network', holding: right })
      b += 1
    }
  }
  for (const holding of robinhood) if (holding.rank === null) out.push({ kind: 'robinhood', holding })
  for (const holding of others) if (holding.value === null) out.push({ kind: 'network', holding })
  return out
}

/** A cent, in 10^-18 dollars: no "$0.00" headline (lib/walletHoldings.ts totalWithheld). */
const CENT = 10n ** 16n

/** Robinhood Chain's figure as the card worked it out (components/portfolio/PortfolioTokens.tsx). */
export interface RobinhoodTotal {
  /** The figure it shows (this read's, or the last complete one while it reads again), or null. */
  total: bigint | null
  /** Its place is held by a resting bar. */
  holdPlace: boolean
  /** Why it shows none (totalWithheld's code), or null. */
  withheld: string | null
  /** Held tokens the figure leaves out (no price). */
  unpriced: number
}

/**
 * The card's one figure with the other networks counted (pure). No other network's token: Robinhood Chain's, as it was.
 * The other networks' first read on its way: the figure holds its place, where Robinhood Chain's would show or hold one.
 * Their tokens read whole: Robinhood Chain's figure plus theirs; theirs alone when Robinhood Chain holds nothing priced;
 * none while Robinhood Chain's own list withholds it for any other reason (no sum across networks without all of them).
 */
export function cardTotal(robinhood: RobinhoodTotal, view: WalletNetworksView): { total: bigint | null; holdPlace: boolean; unpriced: number } {
  if (view.state === 'reading') {
    const hold = robinhood.holdPlace || robinhood.total !== null || robinhood.withheld === 'nothing_valued'
    return { total: null, holdPlace: hold, unpriced: robinhood.unpriced }
  }
  if (view.state === 'off' || view.holdings.length === 0) return { total: robinhood.total, holdPlace: robinhood.holdPlace, unpriced: robinhood.unpriced }
  const unpriced = robinhood.unpriced + view.unpriced
  if (robinhood.total !== null) return { total: robinhood.total + view.total, holdPlace: false, unpriced }
  if (robinhood.holdPlace) return { total: null, holdPlace: true, unpriced }
  if (robinhood.withheld === 'nothing_valued') return { total: view.total >= CENT ? view.total : null, holdPlace: false, unpriced }
  return { total: null, holdPlace: false, unpriced }
}

/** "Robinhood Chain", "Robinhood Chain and Base", "Robinhood Chain, Base and Arbitrum One" (pure). */
export function networksText(names: readonly string[]): string {
  const unique = [...new Set(names)]
  return unique.length <= 1 ? (unique[0] ?? '') : `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`
}
