import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Journey } from '../../components/create/Journey'
import { PageHeader, PageShell } from '../../components/ui'
import { CREATE } from '../../lib/create/copy'
import { OtherChainsContext } from '../../lib/create/otherChains'
import { SlotBoundary, SlotFailed } from '../../lib/read/screens/slots'
import type { V2ChainId } from '../../v2/types'
import { JourneyNetworkContext, type JourneyNetwork } from './context'
import { JOURNEY_STAYS_ON_ROBINHOOD, SETUP_STAYS_WHILE_PREVIEW } from './constants'
import { robinhoodFinderOpen, routeFor, ROBINHOOD, type GateMode } from './model/routing'
import { otherChainsFor } from './otherChains'
import { journeyGates, type JourneyGates } from './source'
import { ZapJourney } from './ZapJourney'

/**
 * New position in a build that carries Domino V2 (the integrated journey, 2026-10-02): the one screen New position opens
 * when `__DOMINO_V2__` is on (screens/NewPosition.tsx, its lazy mount point; production and development too since
 * 2026-10-04). Changed on purpose (data) 2026-10-02 (the owner, night): NO network choice; New position is Robinhood
 * Chain's, exactly today's journey (components/create/Journey.tsx). Changed on purpose 2026-10-05 (the owner: his screens,
 * as he built them): whatever its S1 gate says (JOURNEY_STAYS_ON_ROBINHOOD); the zap path's journey (./ZapJourney.tsx)
 * only in a test build that asks for it (`window.__dominoV2Test.journey.zapOnRobinhood`). The zap path's pool finder
 * is reached only from "Create a new pool (advanced)" at the foot of today's pool step (./PoolAdvanced.tsx `findOther`),
 * for a pool today's journey cannot open (a v3 pool, a pool with no price yet), and "Back to the pool list" returns.
 * Other networks' positions come to the app through the lists (read-v6) and the deposit from another network, never
 * through a picker here. While the gate is read, today's journey.
 * Changed on purpose 2026-10-05 (the owner: "the search on the screen, across the three networks; the results get the
 * network's tag", and creating there through Domino V2): today's journey also offers Base and Arbitrum One, each while its
 * S1 gate is live (./otherChains.ts, handed in through lib/create/otherChains.ts): their tokens in today's search with
 * their network's tag, their pools in today's list, today's range and amount steps, and Review and Create position on
 * that network's contracts (./JourneyCreateV2.tsx). Still no network picker: the search is the way in.
 *
 * Default export: the lazily mounted part.
 */
// TEST builds only (the define folds every other build's branch away): the browser suites' look at the zap path's screens on
// Robinhood Chain, which the owner's journey keeps out of every deployable build.
declare const __DOMINO_TEST_HOOKS__: boolean | undefined
const TEST_HOOKS: boolean = typeof __DOMINO_TEST_HOOKS__ === 'boolean' && __DOMINO_TEST_HOOKS__
const zapOnRobinhood = (): boolean =>
  TEST_HOOKS && typeof window !== 'undefined' &&
  (window as unknown as { __dominoV2Test?: { journey?: { zapOnRobinhood?: unknown } } }).__dominoV2Test?.journey?.zapOnRobinhood === true

export default function NewPositionV2({ flow, poolId, linkToken }: { flow: number; poolId: string; linkToken: string | null }) {
  const [gates, setGates] = useState<JourneyGates | null>(null)
  const chainId: V2ChainId = ROBINHOOD
  const [finder, setFinder] = useState(false)
  useEffect(() => {
    let alive = true
    void journeyGates().then(
      (read) => {
        if (alive) setGates(read)
      },
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [])
  // A new flow (screens/NewPosition.tsx useFlowKey: New position followed again after a position was made) starts on today's journey.
  const [seenFlow, setSeenFlow] = useState(flow)
  if (seenFlow !== flow) {
    setSeenFlow(flow)
    setFinder(false)
  }
  const mode: GateMode = gates ? gates[chainId].mode : 'off'
  const zapHook = zapOnRobinhood()
  const route = routeFor(chainId, mode, SETUP_STAYS_WHILE_PREVIEW && !zapHook, JOURNEY_STAYS_ON_ROBINHOOD && !zapHook)
  const gate = gates?.[chainId]
  const others = useMemo(() => otherChainsFor(gates), [gates])
  const robinhoodFinder = route === 'setup' && robinhoodFinderOpen(mode)
  const zap = gate !== undefined && gate.mode !== 'off' && (route === 'zap' || (robinhoodFinder && finder)) ? gate : null
  const network: JourneyNetwork = {
    chainId,
    findOther: robinhoodFinder && !finder ? () => setFinder(true) : null,
    backToList: robinhoodFinder && finder ? () => setFinder(false) : null,
    s1: gate,
    gates: gates ?? undefined,
  }
  // A pool the finder read that today's journey opens (a v4 pool with a price): today's own link, #/new/<id>.
  const onListed = (id: string) => {
    setFinder(false)
    window.location.hash = `#/new/${id}`
  }
  const body: ReactNode = zap ? (
    <ZapJourney key={`${flow}:${chainId}:${finder ? 'finder' : 'zap'}`} chainId={chainId} gate={zap} finderOnly={robinhoodFinder} onListed={onListed} poolId={poolId} linkToken={linkToken} />
  ) : (
    <OtherChainsContext.Provider value={others}>
      <Journey key={flow} poolId={poolId} linkToken={linkToken} />
    </OtherChainsContext.Provider>
  )
  return (
    <JourneyNetworkContext.Provider value={network}>
      {SlotBoundary && SlotFailed ? (
        <SlotBoundary
          fallback={
            <PageShell width="flow">
              <PageHeader size="display" title={CREATE.page.title} />
              <div className="mt-8">
                <SlotFailed />
              </div>
            </PageShell>
          }
        >
          {body}
        </SlotBoundary>
      ) : (
        body
      )}
    </JourneyNetworkContext.Provider>
  )
}
