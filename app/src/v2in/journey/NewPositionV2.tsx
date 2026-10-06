import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Journey } from '../../components/create/Journey'
import { PageHeader, PageShell } from '../../components/ui'
import { CREATE } from '../../lib/create/copy'
import { OtherChainsContext } from '../../lib/create/otherChains'
import { PoolPricesContext } from '../../lib/create/poolPrices'
import { whenVisibleAfter } from '../../lib/read/screens/quietRead'
import { SlotBoundary, SlotFailed } from '../../lib/read/screens/slots'
import { quietDelayMs } from '../../lib/read/screens/transient'
import type { V2ChainId } from '../../v2/types'
import { JourneyNetworkContext, type JourneyNetwork } from './context'
import { JOURNEY_STAYS_ON_ROBINHOOD, SETUP_STAYS_WHILE_PREVIEW } from './constants'
import { mergeGates } from './model/networks'
import { robinhoodFinderOpen, routeFor, ROBINHOOD, type GateMode } from './model/routing'
import { otherChainsFor } from './otherChains'
import { poolPricesFor } from './poolPrices'
// A gate read that may pass, as the read screens' one rule waits for one (lib/read/screens/transient.ts): the chain
// reads' own (./served.ts, the same object since 2026-10-06).
import { PASSING } from './served'
import { journeyGatesRead, type JourneyGates } from './source'
import { ZapJourney } from './ZapJourney'

/** On the page's focus the gates are read again at most this often, while reading again could change them. */
const FOCUS_EVERY_MS = 15_000

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
 * Changed on purpose 2026-10-06 (the owner's point 3: the search "sometimes only brings Robinhood Chain"): the gates were
 * read once, and one failed read of the plan route's word left Base and Arbitrum One out for the whole visit. A read that
 * failed, or whose word could not be had for the moment (./source.ts journeyGatesRead `again`), is read again a few
 * times on its own (the read screens' quiet waits) and on the page's focus; a network once live stays live, and a gate
 * that says the same keeps its object (./model/networks.ts mergeGates), so nothing on screen starts over.
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
    let reading = false
    // Whether reading again could change the gates: a failed read, or a word that could not be had for the moment.
    let wanted = false
    let attempt = 0
    let lastRead = 0
    let cancelWait: (() => void) | null = null
    const later = () => {
      const wait = quietDelayMs(PASSING, attempt)
      if (wait === null) return
      attempt += 1
      cancelWait = whenVisibleAfter(wait, read)
    }
    function read() {
      if (!alive || reading) return
      reading = true
      lastRead = Date.now()
      cancelWait?.()
      cancelWait = null
      void journeyGatesRead().then(
        ({ gates: next, again }) => {
          reading = false
          if (!alive) return
          setGates((held) => mergeGates(held, next))
          wanted = again
          if (again) later()
        },
        () => {
          reading = false
          if (!alive) return
          wanted = true
          later()
        },
      )
    }
    const onFocus = () => {
      if (wanted && document.visibilityState === 'visible' && Date.now() - lastRead >= FOCUS_EVERY_MS) read()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    read()
    return () => {
      alive = false
      cancelWait?.()
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
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
  // Added 2026-10-06 (the owner: "USD estimate unavailable" for Robinhood Chain pairs without USDG): their qualified prices,
  // read by Domino's service while Robinhood Chain's S1 gate is live; and (the owner: AI/PONS short and nothing offered)
  // what paying with one other token would be, under the pool's network's live S1 gate (./poolPrices.ts).
  const prices = useMemo(() => poolPricesFor(gates), [gates])
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
      <PoolPricesContext.Provider value={prices}>
        <Journey key={flow} poolId={poolId} linkToken={linkToken} />
      </PoolPricesContext.Provider>
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
