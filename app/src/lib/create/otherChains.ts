import { createContext, useContext } from 'react'
import { NATIVE_CURRENCY, addressKey } from '../read/screens/identity'
import type { PoolOption } from '../read/screens/poolsList'
import type { TokenCandidate } from '../read/screens/tokens'
import type { TokenChainId, TokenDisplay } from '../read/types'
import type { CurrencyBalance } from './budgets'

/**
 * New position on the other networks Domino V2 serves (the owner, 2026-10-05: "the search on the screen, across the three
 * networks; the results get the network's tag", and creating there through the V2 contracts, spec F7 rev4 §1.2): Base and
 * Arbitrum One beside Robinhood Chain, in today's journey's own steps (components/create/Journey.tsx). V1 declares the
 * shape here and imports nothing of V2; a build that carries V2 hands an implementation in around today's journey
 * (src/v2in/journey/NewPositionV2.tsx, for the networks whose S1 gate is live). Without one (a build without V2, a page
 * outside that wrapper, no other network live) nothing of this exists and every step is exactly today's.
 *
 * Those networks have no read service yet (spec §6.2, "pools per chain" is still missing from read-v6), and no public RPC
 * may be asked (§6.1, the owner's rule): their tokens are offered from the network's profile (ETH, WETH, USDC) and a pasted
 * address, and a token's pools, a pool's price and the wallet's balances are read through the wallet's own provider on
 * that network, so the wallet is asked once to switch networks when such a token is chosen. Identity is chain plus
 * address (§1.3): Base's ETH is never Robinhood Chain's ETH.
 */

/** The other networks: Base and Arbitrum One. */
export type OtherChainId = Exclude<TokenChainId, 4663>

/** A token of another network as the search offers it: its network's tag beside its name. */
export interface NetworkToken {
  chainId: OtherChainId
  /** The network's name, the tag ("Base", "Arbitrum One"). */
  network: string
  token: TokenDisplay
  /** A pasted address: its symbol and decimals are read through the wallet once it is chosen (`resolve`). */
  unread: boolean
}

/** What reading a token's pools on its network came to; `reason` is a sentence for the screen. */
export type NetworkPools = { kind: 'ok'; options: PoolOption[] } | { kind: 'failed'; code: string; reason: string }

export type NetworkResolved = { ok: true; token: TokenDisplay } | { ok: false; code: string; reason: string }

export interface OtherChains {
  /** Robinhood Chain's own tag, for today's rows once other networks are listed beside them. */
  home: string
  /** A network's name by id, for its tag; null for one this page does not offer. */
  name: (chainId: number) => string | null
  /** The other networks' tokens a query names. Synchronous; reads nothing. */
  tokens: (query: string) => readonly NetworkToken[]
  /** A chosen row's token with its symbol and decimals: read through the wallet when it was a pasted address. */
  resolve: (row: NetworkToken, signal: AbortSignal) => Promise<NetworkResolved>
  /** The pools of a token on its network a position can open in, read through the wallet on that network. */
  pools: (token: TokenDisplay, signal: AbortSignal) => Promise<NetworkPools>
  /** A pool read again (its price), when the one on screen has aged; null when it could not be. */
  reread: (option: PoolOption, signal: AbortSignal) => Promise<PoolOption | null>
  /** The wallet's balances of a pool's two currencies, in pool order, on the pool's network; null when unread. */
  balances: (option: PoolOption, owner: string, signal: AbortSignal) => Promise<readonly [CurrencyBalance, CurrencyBalance] | null>
}

export const OtherChainsContext = createContext<OtherChains | null>(null)

/** The other networks this page offers, or null where there are none (every V1 path). */
export const useOtherChains = (): OtherChains | null => useContext(OtherChainsContext)

/** Whether a token or a pool's currency is on another network than Robinhood Chain. */
export const onOtherChain = (token: Pick<TokenDisplay, 'chainId'> | null | undefined): boolean => !!token && token.chainId !== 4663

/** Whether a pool is on another network than Robinhood Chain. */
export const poolOnOtherChain = (pool: Pick<PoolOption, 'currencies'> | null | undefined): boolean => !!pool && onOtherChain(pool.currencies[0])

/** Another network's token as the journey holds a chosen token: chosen, selectable, its decimals as read. */
export function networkCandidate(token: TokenDisplay): TokenCandidate {
  const key = addressKey(token.address)
  return {
    key,
    wire: key,
    token,
    kind: key === NATIVE_CURRENCY ? 'native' : 'erc20_candidate',
    why: null,
    reasonCode: null,
    decimalsUnavailable: token.decimals === null,
    source: 'pasted',
    wallet: null,
    balance: null,
    page: null,
    old: false,
    block: null,
  }
}
