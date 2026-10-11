import type { ActivityResponse, PortfolioResponse } from 'api-contracts/read-v6/types'
import { V2_CHAINS } from '../../v2/chains'
import { v2Gate, v2OriginOpen } from '../../v2/gate'
import type { V2ChainId } from '../../v2/types'
import { v2PageProbe, v2ReadTransports } from '../transports'
import { chainPoolsOn } from '../journey/served'
import { createKeyedReader, createListsReads, readAgainAfter, type ListsReply, type ListsTransports } from './read'
import { createPortfolioCatchup, reconcilePortfolio, subscribePositionChanges } from './positionSync'
import { CREATED_POSITIONS } from './createdPositions'
import { POSITION_VALUATIONS } from './valuation'
import { createPriceRecovery } from './priceRecovery'

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
export const listsGate = async (): Promise<ListsGate> => Object.freeze(Object.fromEntries(V2_CHAINS.map((chain) => [chain.chainId, readsOpen() ? 'live' : 'off'])) as Record<V2ChainId, ListsMode>)

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

/** The person's own portfolio, from the site's route, by wallet (lowercase). */
const catchup = createPortfolioCatchup()
const priceRecovery = createPriceRecovery({
  async warm(target, active) {
    if (!readsOpen() || !active()) return false
    const gate = await v2Gate('vault', target.chainId, undefined, v2PageProbe)
    if (gate.mode === 'off' || !active()) return false
    // No pairedToken: the backend surveys the token's own qualified sources and offers the answer to its shared Pricer.
    // This shared request may finish after navigation; active() prevents another read or any stale-wallet refresh.
    const reply = await chainPoolsOn(gate, target.chainId, target.address)
    return active() && reply.kind === 'ok' && reply.body.freshness.status === 'fresh'
      && reply.body.chainId === target.chainId && reply.body.token.toLowerCase() === target.address
      && reply.body.tokens.some(token => token.address.toLowerCase() === target.address && token.price !== null)
  },
  refresh: wallet => OWN_PORTFOLIO.again(wallet),
})
export const OWN_PORTFOLIO = createKeyedReader<ListsReply<PortfolioResponse>>(async (wallet, active) => {
  // A reloaded page may know only the receipt's NFT identity. It speeds discovery, never supplies chain state.
  for (const created of CREATED_POSITIONS.get(wallet)) catchup.note({ ...created, tokenIds: [created.tokenId] })
  const answer = await LISTS_SOURCE.ownPortfolio(wallet)
  if (answer.kind === 'ok') CREATED_POSITIONS.reconcile(answer.body)
  if (answer.kind === 'ok') POSITION_VALUATIONS.record(answer.body)
  if (answer.kind === 'ok' && active()) void priceRecovery.run(answer.body, active)
  return answer.kind === 'ok' ? { ...answer, body: reconcilePortfolio(answer.body) } : answer
}, { next: (reply, failures) => reply.kind === 'ok' && REFRESH ? catchup.delay(reply.body) ?? 30_000 : again(reply, failures), failed })
/** The first page of the person's own receipts, by wallet (lowercase). */
export const OWN_ACTIVITY = createKeyedReader<ListsReply<ActivityResponse>>((wallet) => LISTS_SOURCE.ownActivity(wallet, { limit: ACTIVITY_PAGE }), { next: again, failed })

subscribePositionChanges((change) => {
  if (change.kind === 'state') OWN_PORTFOLIO.update((value) => value.kind === 'ok' ? { ...value, body: reconcilePortfolio(value.body) } : value)
  else { catchup.note(change); OWN_PORTFOLIO.again(change.wallet) }
}, true)
