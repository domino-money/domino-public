/**
 * The Wallet card's tokens on Base and Arbitrum One, live (lib/walletNetworks.ts declares the shape; ./model.ts is the pure
 * part). Part of the lists' chunk (re-exported by ../lists/OwnedRows.tsx, which already carries the portfolio reader and
 * the chain reads this needs, so no new chunk and no second copy of them): components/portfolio/PortfolioTokens.tsx opens
 * it lazily behind the bare `__DOMINO_V2__` define and mounts WalletNetworksWatch beside its rows (it draws nothing), so a
 * build without V2 carries none of it and its card is Robinhood Chain's alone.
 *
 * Added 2026-11-06 (the owner's replica rule; R-07). One chain-balances read per wallet and token set, through the site's
 * own read route (src/v2in/transports.ts), asked only while the route's capabilities name it; a closed route asks nothing
 * and the card stays as it was. The tokens asked are ./model.ts walletBalanceTokens': the networks' own currencies and
 * the tokens of the wallet's positions there, from read-v6's portfolio, which Positions' list reads for the same wallet
 * (lists/source.ts OWN_PORTFOLIO, one read shared by both). The card waits for that portfolio a moment before it asks,
 * so a first visit asks once.
 *
 * As Robinhood Chain's card: read again every five minutes while the page is shown, and after an action this page saw
 * confirmed on one of those networks for this wallet, never taking an answer older than that action's block
 * (./model.ts behindBarrier). Only a whole answer (every network and balance asked was read) reaches the card; the last
 * whole one stays on it, also when the card is opened again in this page, until a newer whole one replaces it.
 *
 * Changed on purpose 2026-11-07 (Elysium's screens): where the build serves Elysium, its tokens are asked in a read of their
 * own (`elysiumLane`), as the funds offer asks Ethereum and OP Mainnet apart (funds/model.ts balanceChainsRequest): a
 * service that does not read Elysium yet, or not for now, leaves the card's Base and Arbitrum One rows exactly as they are,
 * and Elysium's join them once its own read is whole.
 */
import type { ChainBalancesResponse, PortfolioResponse } from 'api-contracts/read-v6/types'
import { useEffect } from 'react'
import { ELYSIUM_LIVE, ELYSIUM_V2_ID } from '../../lib/elysiumIdentity'
import { createWalletReadGuard, subscribePositionEvidence } from '../../lib/positionEvidence'
import type { WalletNetworksView, WatchWalletNetworks } from '../../lib/walletNetworks'
import { v2OriginOpen } from '../../v2/gate'
import { readChainBalances } from '../../v2/read/v6'
import { routeServes } from '../../v2/routes'
import { createKeyedReader, readAgainAfter, type ListsReply } from '../lists/read'
import { OWN_PORTFOLIO } from '../lists/source'
import { v2ReadTransports } from '../transports'
import { WALLET_NETWORK_CHAINS, balanceRequest, behindBarrier, networkHoldingsOf, walletBalanceTokens, type AskedToken } from './model'

declare const __DOMINO_TEST_HOOKS__: boolean | undefined

/** As Robinhood Chain's card reads its list again (PortfolioTokens.tsx REFRESH_MS). */
const REFRESH_MS = 300_000
/** How long the card waits for the wallet's portfolio before it asks with the networks' own currencies alone. */
const PORTFOLIO_WAIT_MS = 1_500
/** How long the first read may keep the card's figure waiting for it; after that the figure is Robinhood Chain's until it lands. */
const FIRST_WAIT_MS = 3_000

/**
 * In a test build a good answer is asked again only when the suite asked for it before the page loaded
 * (`window.__dominoRefresh`), as the lists' reads do (lists/source.ts), so every suite counts its reads.
 */
const REFRESH = !(typeof __DOMINO_TEST_HOOKS__ === 'boolean' && __DOMINO_TEST_HOOKS__ && typeof window !== 'undefined' && !(window as { __dominoRefresh?: boolean }).__dominoRefresh)

const readsOpen = () => v2OriginOpen(typeof location === 'undefined' ? '' : location.origin)
const READING: WalletNetworksView = Object.freeze({ state: 'reading' })
/** As lib/walletNetworks.ts NETWORKS_OFF, which this chunk does not import (types only). */
const NETWORKS_OFF: WalletNetworksView = Object.freeze({ state: 'off' })

/** The tokens each read's key stands for (a key is the wallet and the tokens' networks and addresses). */
const ASKED = new Map<string, readonly AskedToken[]>()
const keyOf = (wallet: string, asked: readonly AskedToken[]) => `${wallet}|${asked.map((token) => `${token.chainId}:${token.address}`).join(',')}`
const walletOf = (key: string) => key.slice(0, key.indexOf('|'))

/** Per wallet: the newest block on each network at which this page saw one of its actions confirmed. */
const BARRIERS = new Map<string, Map<number, number>>()
/** Per wallet: the last whole read the card showed, kept for this page. */
const KEPT = new Map<string, WalletNetworksView>()

const BALANCES = createKeyedReader<ListsReply<ChainBalancesResponse>>(async (key) => {
  if (!readsOpen()) return { kind: 'unavailable', reason: 'gate_off' }
  const asked = ASKED.get(key)
  if (!asked) return { kind: 'unavailable', reason: 'not_asked' }
  const transports = v2ReadTransports()
  if (!routeServes(await transports.routeState('readV6'), 'chain-balances')) return { kind: 'unavailable', reason: 'route_not_available' }
  const wallet = walletOf(key)
  const reply = await readChainBalances(transports.read, transports.readRuntime, wallet, balanceRequest(asked))
  if (reply.kind !== 'ok') return reply
  if (String(reply.body.wallet).toLowerCase() !== wallet) return { kind: 'unavailable', reason: 'other_wallet' }
  if (behindBarrier(reply.body, BARRIERS.get(wallet) ?? new Map())) return { kind: 'unavailable', reason: 'behind_confirmation' }
  return reply
}, {
  next: (reply, failures) => {
    if (reply.kind === 'ok') return REFRESH ? REFRESH_MS : null
    // A closed route or a closed gate is not asked again soon: the probe would say the same.
    if (reply.kind === 'unavailable' && reply.reason !== 'behind_confirmation') return REFRESH_MS
    return readAgainAfter(reply, failures)
  },
  failed: (reply) => reply.kind !== 'ok',
})

/**
 * The view one read gives the card, or null when it is not whole (the card then keeps what it had). `elysium` (added
 * 2026-11-07): the key of Elysium's own read, whose rows join only when that read is whole too. Changed on purpose
 * 2026-11-07 (review finding P10): Elysium's rows come from its last good read (the reader's `get`), as the card keeps
 * Base's and Arbitrum One's through a failed re-read, so one refused or failed re-read of its own never drops them.
 */
function viewOf(key: string, elysium: string | null = null): WalletNetworksView | null {
  const reply = BALANCES.getLatest(key)
  const asked = ASKED.get(key)
  if (reply?.kind !== 'ok' || !asked) return null
  let read = networkHoldingsOf(reply.body, asked)
  if (!read.whole) return null
  // Only where the build serves Elysium (a build-time fact, so a build where it is off carries none of this).
  if (ELYSIUM_LIVE && elysium !== null) {
    const extra = BALANCES.get(elysium)
    const more = ASKED.get(elysium)
    if (extra?.kind === 'ok' && more) {
      const both = networkHoldingsOf({ ...reply.body, chains: [...reply.body.chains, ...extra.body.chains.filter((chain) => (chain.chainId as number) === ELYSIUM_V2_ID)] }, [...asked, ...more])
      if (both.whole) read = both
    }
  }
  return { state: 'ready', holdings: read.holdings, total: read.total, unpriced: read.unpriced }
}

/** Elysium's tokens apart from the others' (added 2026-11-07): none apart where the build does not serve Elysium. */
const elysiumLane = (asked: readonly AskedToken[]): { rest: readonly AskedToken[]; elysium: readonly AskedToken[] } =>
  ELYSIUM_LIVE ? { rest: asked.filter((token) => token.chainId !== ELYSIUM_V2_ID), elysium: asked.filter((token) => token.chainId === ELYSIUM_V2_ID) } : { rest: asked, elysium: [] }

/**
 * Watches one wallet's tokens on Base and Arbitrum One for the card, until the returned stop. `off` when the build's gate
 * is closed, the read route does not serve chain-balances, or nothing whole has been read once the first wait is over;
 * `reading` while the first read is on its way (FIRST_WAIT_MS at most); `ready` with the last whole read.
 */
const watchWalletNetworks: WatchWalletNetworks = (address, listener) => {
  const wallet = address.toLowerCase()
  if (!readsOpen() || WALLET_NETWORK_CHAINS.length === 0) {
    listener(NETWORKS_OFF)
    return () => undefined
  }
  let stopped = false
  let served: boolean | null = null
  let waited = false
  let key: string | null = null
  let stopBalances: (() => void) | null = null
  let elysiumKey: string | null = null
  let stopElysium: (() => void) | null = null
  let shown: WalletNetworksView | null = null
  const emit = () => {
    if (stopped) return
    const fresh = key !== null ? viewOf(key, elysiumKey) : null
    if (fresh) KEPT.set(wallet, fresh)
    const kept = KEPT.get(wallet) ?? null
    // `reading` only once the route is known to serve: until then, and with it closed, the card is Robinhood Chain's.
    const view = kept ?? (served === true && !waited ? READING : NETWORKS_OFF)
    if (view === shown) return
    shown = view
    listener(view)
  }
  const portfolio = (): PortfolioResponse | null => {
    const reply = OWN_PORTFOLIO.get(wallet)
    return reply?.kind === 'ok' ? reply.body : null
  }
  const ask = () => {
    if (stopped || served !== true) return
    const { rest: asked, elysium } = elysiumLane(walletBalanceTokens(portfolio()))
    const next = keyOf(wallet, asked)
    // Changed on purpose 2026-11-07 (review finding E): Elysium's lane behind the build's own fact, so a build where it is off
    // carries none of it.
    const nextElysium = ELYSIUM_LIVE && elysium.length > 0 ? keyOf(wallet, elysium) : null
    if (next === key && (!ELYSIUM_LIVE || nextElysium === elysiumKey)) return
    if (next !== key) {
      ASKED.set(next, asked)
      stopBalances?.()
      key = next
      stopBalances = BALANCES.subscribe(next, emit)
    }
    if (ELYSIUM_LIVE && nextElysium !== elysiumKey) {
      stopElysium?.()
      stopElysium = null
      elysiumKey = nextElysium
      if (nextElysium !== null) {
        ASKED.set(nextElysium, elysium)
        stopElysium = BALANCES.subscribe(nextElysium, emit)
      }
    }
    emit()
  }
  // The wallet's portfolio names its positions' tokens; Positions' list reads the same answer.
  let portfolioHeard = OWN_PORTFOLIO.get(wallet) !== null
  const stopPortfolio = OWN_PORTFOLIO.subscribe(wallet, () => {
    portfolioHeard = true
    ask()
  })
  const portfolioWait = setTimeout(() => {
    portfolioHeard = true
    ask()
  }, PORTFOLIO_WAIT_MS)
  const firstWait = setTimeout(() => {
    waited = true
    emit()
  }, FIRST_WAIT_MS)
  // Confirmed actions on those networks for this wallet: a barrier, then a new read (the retained ones replayed at
  // subscribe only set the barrier: the first read is still to come).
  const guards = new Map(WALLET_NETWORK_CHAINS.map((chainId) => [chainId, createWalletReadGuard(wallet, chainId)] as const))
  let replaying = true
  const stopEvidence = subscribePositionEvidence((event) => {
    if (event.kind !== 'confirmed') return
    const guard = guards.get(event.value.chainId as (typeof WALLET_NETWORK_CHAINS)[number])
    if (!guard || !guard.confirm(event.value)) return
    const barrier = BARRIERS.get(wallet) ?? new Map<number, number>()
    barrier.set(event.value.chainId, Math.max(barrier.get(event.value.chainId) ?? 0, Number(event.value.block)))
    BARRIERS.set(wallet, barrier)
    if (!replaying && key !== null) BALANCES.again(key)
    if (ELYSIUM_LIVE && !replaying && elysiumKey !== null) BALANCES.again(elysiumKey)
  })
  replaying = false
  void v2ReadTransports().routeState('readV6').then((state) => {
    if (stopped) return
    served = routeServes(state, 'chain-balances')
    if (served && portfolioHeard) ask()
    emit()
  }, () => {
    served = false
    emit()
  })
  emit()
  return () => {
    stopped = true
    clearTimeout(portfolioWait)
    clearTimeout(firstWait)
    stopPortfolio()
    stopEvidence()
    stopBalances?.()
    if (ELYSIUM_LIVE) stopElysium?.()
  }
}

/** What the card mounts: watches `address` and tells the card each view; draws nothing. */
export function WalletNetworksWatch({ address, onView }: { address: string; onView: (view: WalletNetworksView) => void }) {
  useEffect(() => watchWalletNetworks(address, onView), [address, onView])
  return null
}
