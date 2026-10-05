import type { ActivityResponse, PortfolioResponse } from 'api-contracts/read-v6/types'
import { V2_CHAINS } from '../../v2/chains'
import { v2Gate, type V2Gate } from '../../v2/gate'
import type { V2ChainId } from '../../v2/types'
import { v2PageProbe, v2Transports } from '../transports'
import { createKeyedReader, createListsReads, readAgainAfter, type ListsReply, type ListsTransports } from './read'

/**
 * The lists' one read-v6 source in the page (Domino V2 builds only: the lists' chunks are opened behind `__DOMINO_V2__`).
 * Each chain's gate (src/v2/gate.ts) decides; the integrated screens' shared transports (src/v2in/transports.ts) read the
 * site's own route, about the wallet the list is for, on every open chain (`preview` or `live`: Changed on purpose
 * (data) 2026-10-02, the owner: real data only, no example rows). A test build's suite scripts the answers through
 * `window.__dominoV2Test.read6`, which the shared transports read.
 */

export type ListsMode = 'off' | 'live'
export type ListsGate = Readonly<Record<V2ChainId, ListsMode>>

const SERVICES = ['s1', 'vault', 'autoExit'] as const
const OFF: V2Gate = Object.freeze({ mode: 'off' })

let gates: Promise<{ modes: ListsGate; live: V2Gate | null }> | null = null

/**
 * Each chain's mode for the lists: `live` when any V2 service is open there (`live` or `preview`: the route is read
 * either way, and what it answers is the person's own), else `off`; and one open gate, for the transports. Off
 * everywhere but the preview alias and the development server (and a test build that opens it): there the lists are
 * exactly V1's, and nothing of read-v6 is read.
 */
function chainGates() {
  gates ??= (async () => {
    const modes = {} as Record<V2ChainId, ListsMode>
    let live: V2Gate | null = null
    for (const chain of V2_CHAINS) {
      const found = await Promise.all(SERVICES.map((service) => v2Gate(service, chain.chainId, undefined, v2PageProbe).catch(() => OFF)))
      const open = found.find((gate) => gate.mode === 'live') ?? found.find((gate) => gate.mode === 'preview') ?? null
      modes[chain.chainId] = open ? 'live' : 'off'
      live ??= open
    }
    return { modes: Object.freeze(modes), live }
  })()
  return gates
}

export const listsGate = (): Promise<ListsGate> => chainGates().then((found) => found.modes)

/** The transports of one open chain (read-v6 is one answer for the three chains). */
async function listsTransports(): Promise<ListsTransports> {
  const { live } = await chainGates()
  return { live: live ? v2Transports(live) : null }
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
export const OWN_PORTFOLIO = createKeyedReader<ListsReply<PortfolioResponse>>((wallet) => LISTS_SOURCE.ownPortfolio(wallet), { next: again, failed })
/** The first page of the person's own receipts, by wallet (lowercase). */
export const OWN_ACTIVITY = createKeyedReader<ListsReply<ActivityResponse>>((wallet) => LISTS_SOURCE.ownActivity(wallet, { limit: ACTIVITY_PAGE }), { next: again, failed })
