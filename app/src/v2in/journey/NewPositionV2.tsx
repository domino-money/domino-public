import { useEffect, useState, type ReactNode } from 'react'
import { Journey } from '../../components/create/Journey'
import { PageHeader, PageShell } from '../../components/ui'
import { CREATE } from '../../lib/create/copy'
import { SlotBoundary, SlotFailed } from '../../lib/read/screens/slots'
import { v2OriginOpen } from '../../v2/gate'
import type { V2ChainId } from '../../v2/types'
import { JourneyNetworkContext, type JourneyNetwork } from './context'
import { robinhoodFinderOpen, routeFor, ROBINHOOD, type GateMode } from './model/routing'
import { journeyGates, type JourneyGates } from './source'
import { ZapJourney } from './ZapJourney'

/**
 * New position in a build that carries Domino V2 (the integrated journey, 2026-10-02): the one screen New position opens
 * when `__DOMINO_V2__` is on (screens/NewPosition.tsx, its lazy mount point; production and development too since
 * 2026-10-04). Changed on purpose (data) 2026-10-02 (the owner, night): NO network choice; New position is Robinhood
 * Chain's: today's journey (components/create/Journey.tsx) while its S1 gate is `off`, the zap path's journey
 * (./ZapJourney.tsx) once it is `preview` or `live` (Changed on purpose 2026-10-04, the owner: every function runs on
 * Domino V2; SETUP_STAYS_WHILE_PREVIEW is false), a pool's link (`poolId`, `linkToken`) handed to it as to today's.
 * While its listed pools keep today's steps, the zap path's pool finder is reached only from "Create a new pool
 * (advanced)" at the foot of today's pool step (./PoolAdvanced.tsx `findOther`), for a pool today's journey cannot open
 * (a v3 pool, a pool with no price yet), and "Back to the pool list" returns. Other networks' positions come to the app
 * through the lists (read-v6) and the deposit from another network, never through a picker here. While the gate is read:
 * where V2 opens (domino.money), the page's header alone, as while this chunk loads (screens/NewPosition.tsx), never
 * today's journey for a moment (Changed on purpose 2026-10-04); elsewhere, or if the gate cannot be read, today's journey.
 *
 * Default export: the lazily mounted part.
 */
export default function NewPositionV2({ flow, poolId, linkToken }: { flow: number; poolId: string; linkToken: string | null }) {
  const [gates, setGates] = useState<JourneyGates | null>(null)
  const [unread, setUnread] = useState(false)
  const chainId: V2ChainId = ROBINHOOD
  const [finder, setFinder] = useState(false)
  useEffect(() => {
    let alive = true
    void journeyGates().then(
      (read) => {
        if (alive) setGates(read)
      },
      () => {
        if (alive) setUnread(true)
      },
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
  const route = routeFor(chainId, mode)
  const gate = gates?.[chainId]
  const robinhoodFinder = route === 'setup' && robinhoodFinderOpen(mode)
  const zap = gate !== undefined && gate.mode !== 'off' && (route === 'zap' || (robinhoodFinder && finder)) ? gate : null
  const network: JourneyNetwork = {
    chainId,
    findOther: robinhoodFinder && !finder ? () => setFinder(true) : null,
    backToList: robinhoodFinder && finder ? () => setFinder(false) : null,
  }
  // A pool the finder read that today's journey opens (a v4 pool with a price): today's own link, #/new/<id>.
  const onListed = (id: string) => {
    setFinder(false)
    window.location.hash = `#/new/${id}`
  }
  const reading = gates === null && !unread && v2OriginOpen(window.location.origin)
  const body: ReactNode = zap ? (
    <ZapJourney key={`${flow}:${chainId}:${finder ? 'finder' : 'zap'}`} chainId={chainId} gate={zap} finderOnly={robinhoodFinder} onListed={onListed} poolId={poolId} linkToken={linkToken} />
  ) : reading ? (
    <PageShell width="flow" data-journey-reading="">
      <PageHeader size="display" title={CREATE.page.title} description={CREATE.page.description} />
    </PageShell>
  ) : (
    <Journey key={flow} poolId={poolId} linkToken={linkToken} />
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
