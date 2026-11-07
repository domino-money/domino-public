import type { ActivityResponse, FeePositionRef, PortfolioResponse, PositionFeesResponse } from 'api-contracts/read-v6/types'
import { V2_CHAINS } from '../../v2/chains'
import { v2Gate, v2OriginOpen } from '../../v2/gate'
import type { V2ChainId } from '../../v2/types'
import { readPositionFees } from '../../v2/read/v6'
import { routeServes } from '../../v2/routes'
import { positionFeesServedNow, v2PageProbe, v2ReadTransports } from '../transports'
import { chainPoolsOn } from '../journey/served'
import { OFF_NETWORK, createKeyedReader, createListsReads, offNetwork, offNetworkReply, readAgainAfter, type ListsReply, type ListsTransports } from './read'
import { createPortfolioCatchup, reconcilePortfolio, subscribePositionChanges } from './positionSync'
import { CREATED_POSITIONS } from './createdPositions'
import { createPriceRecovery } from './priceRecovery'
import { noteAnswerFinality } from '../../lib/confirmedOperations'

/**
 * The lists' one read-v6 source in the page (Domino V2 builds only: the lists' chunks are opened behind `__DOMINO_V2__`).
 * Origin admission and the read route's capabilities decide, independently of transaction gates. Shared transports read
 * the site's own route, about the wallet the list is for; no example rows. A test build's suite scripts the answers through
 * `window.__dominoV2Test.read6`, which the shared transports read.
 */

export type ListsMode = 'off' | 'live'
export type ListsGate = Readonly<Record<V2ChainId, ListsMode>>

const readsOpen = () => v2OriginOpen(typeof location === 'undefined' ? '' : location.origin)

/** Origin/build admission only. The read route checks its own capability on every request; write gates stay separate. */
export const listsGateNow = (): ListsGate => Object.freeze(Object.fromEntries(V2_CHAINS.map((chain) => [chain.chainId, readsOpen() ? 'live' : 'off'])) as Record<V2ChainId, ListsMode>)
export const listsGate = async (): Promise<ListsGate> => listsGateNow()

/** The transports of one open chain (read-v6 is one answer for the three chains). */
async function listsTransports(): Promise<ListsTransports> {
  return { live: readsOpen() ? v2ReadTransports() : null }
}

export const LISTS_SOURCE = createListsReads(listsTransports)

/**
 * Asked again a minute after a good answer, and sooner after a failure (./read.ts readAgainAfter). In a test build a good
 * answer is asked again only when the suite asked for it before the page loaded (`window.__dominoRefresh`, as V1's own
 * list does), so every suite counts its reads.
 */
const REFRESH = !(__DOMINO_TEST_HOOKS__ && typeof window !== 'undefined' && !(window as { __dominoRefresh?: boolean }).__dominoRefresh)
const again = <T>(reply: ListsReply<T>, failures: number) => (reply.kind === 'ok' && !REFRESH ? null : readAgainAfter(reply, failures))
const failed = <T>(reply: ListsReply<T>) => reply.kind !== 'ok'

/** Receipts asked per page of the person's own activity (read-v6's default; 1 to 50). */
export const ACTIVITY_PAGE = 20

/** (2026-10-15, pack 8): told of each good portfolio answer as it arrives (./activity.tsx: a wallet with automation on). */
const portfolioHeard = new Set<(body: PortfolioResponse) => void>()
export const onPortfolioAnswer = (listener: (body: PortfolioResponse) => void): (() => void) => { portfolioHeard.add(listener); return () => { portfolioHeard.delete(listener) } }

/** The person's own portfolio, from the site's route, by wallet (lowercase). */
const catchup = createPortfolioCatchup()
const priceRecovery = createPriceRecovery({
  async warm(target, active) {
    if (!readsOpen() || !active()) return { kind: 'cancelled' }
    const gate = await v2Gate('vault', target.chainId, undefined, v2PageProbe)
    if (!active()) return { kind: 'cancelled' }
    if (gate.mode === 'off') return { kind: 'unavailable' }
    // No pairedToken: the backend surveys the token's own qualified sources and offers the answer to its shared Pricer.
    // This shared request may finish after navigation; active() prevents another read or any stale-wallet refresh.
    const reply = await chainPoolsOn(gate, target.chainId, target.address)
    // A busy lane's wait still applies if the person changed wallets while its request was in flight.
    if (reply.kind === 'failed') return reply.passing ? { kind: 'retry', afterMs: (reply.retryAfterS ?? 0) * 1000 } : { kind: 'unavailable' }
    if (!active()) return { kind: 'cancelled' }
    if (reply.kind !== 'ok' || reply.body.chainId !== target.chainId || reply.body.token.toLowerCase() !== target.address) return { kind: 'unavailable' }
    if (reply.body.freshness.status !== 'fresh') return { kind: 'retry' }
    const token = reply.body.tokens.find(token => token.address.toLowerCase() === target.address)
    if (token?.price) return { kind: 'qualified' }
    return token?.priceReason === 'price_read_failed' || token?.priceReason === 'pricing_limit_reached' ? { kind: 'retry' } : { kind: 'unavailable' }
  },
  refresh: wallet => OWN_PORTFOLIO.again(wallet),
})
export const OWN_PORTFOLIO = createKeyedReader<ListsReply<PortfolioResponse>>(async (wallet, active) => {
  // A reloaded page may know only the receipt's NFT identity. It speeds discovery, never supplies chain state.
  // (2026-10-15, pack 8): not for Robinhood Chain's hints, which main did not keep: its list has its own state reading.
  for (const created of CREATED_POSITIONS.get(wallet)) if (created.chainId !== 4663) catchup.note({ ...created, tokenIds: [created.tokenId] })
  const answer = await LISTS_SOURCE.ownPortfolio(wallet)
  // Added 2026-10-14 (incident C2): each chain's finalized block as this answer names it goes to the confirmation queue.
  // It is the queue's hint for when an operation this browser sent may be final; it asks the node nothing until then.
  // The activity history hands its answers on the same way (activity.tsx).
  if (answer.kind === 'ok') noteAnswerFinality(answer.body.chains)
  if (answer.kind === 'ok') CREATED_POSITIONS.reconcile(answer.body)
  if (answer.kind === 'ok') for (const listener of portfolioHeard) listener(answer.body)
  // Changed on purpose 2026-10-14 (package V1): no valuation is recorded here any more. The last complete valuation is
  // kept where a row or a page works one out (./valuation.ts), of the reading it shows, which may be newer than this answer's.
  if (answer.kind === 'ok' && active()) void priceRecovery.run(answer.body, active)
  return answer.kind === 'ok' ? { ...answer, body: reconcilePortfolio(answer.body) } : answer
}, { next: (reply, failures) => reply.kind === 'ok' && REFRESH ? catchup.delay(reply.body) ?? 30_000 : again(reply, failures), failed })
/** The first page of the person's own receipts, by wallet (lowercase). */
export const OWN_ACTIVITY = createKeyedReader<ListsReply<ActivityResponse>>((wallet) => LISTS_SOURCE.ownActivity(wallet, { limit: ACTIVITY_PAGE }), { next: again, failed })

/** One `position-fees` read's key: its chain and up to 8 positions, in the order asked. */
export const positionFeesKey = (chainId: number, positions: readonly FeePositionRef[]): string => `${chainId}|${positions.map((position) => `${position.dex}:${position.tokenId}`).join(',')}`
export const routeOpensPositionFees = positionFeesServedNow

/**
 * Added 2026-11-04 (read-v6 1.2.0-rc.1, docs/v2/V2_FEES.md): up to 8 positions' stored fee history, by `positionFeesKey`, a
 * minute apart like the follower's own pass. Asked only while the route's capabilities name it: until then nothing is sent.
 */
export const POSITION_FEES = createKeyedReader<ListsReply<PositionFeesResponse>>(async (key) => {
  if (!readsOpen()) return { kind: 'unavailable', reason: 'gate_off' }
  const [chainId, list] = key.split('|')
  const positions = list.split(',').map((item) => {
    const [dex, tokenId] = item.split(':')
    return { dex: Number(dex) as FeePositionRef['dex'], tokenId }
  })
  // Changed on purpose 2026-11-06 (Elysium readiness; rugged97's #459): never asked for a position of a version its chain
  // lacks (v3 on a chain with v4 alone), which the service refuses with invalid_request. Said as not available there
  // (./read.ts OFF_NETWORK), which the page draws as a chain with no history (nothing new on screen), never asked again.
  if (offNetwork(Number(chainId), positions)) return OFF_NETWORK
  const transports = v2ReadTransports()
  if (!routeServes(await transports.routeState('readV6'), 'position-fees')) return { kind: 'unavailable', reason: 'route_not_available' }
  return readPositionFees(transports.read, transports.readRuntime, Number(chainId), positions)
}, { next: (reply, failures) => (offNetworkReply(reply) ? null : again(reply, failures)), failed })

subscribePositionChanges((change) => {
  if (change.kind === 'state') OWN_PORTFOLIO.update((value) => value.kind === 'ok' ? { ...value, body: reconcilePortfolio(value.body) } : value)
  else { catchup.note(change); OWN_PORTFOLIO.again(change.wallet) }
}, true)
