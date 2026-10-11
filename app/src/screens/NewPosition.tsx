// The screens' own styles (styles/screens.css, F8): loaded with the first screen that needs them, never on Home's first paint.
import '../styles/screens.css'
import { lazy, Suspense, useEffect, useState } from 'react'
import { CREATE } from '../lib/create/copy'
import { useRouteTitle } from '../lib/routeTitle'
import { useCreated, useFlowMade } from '../lib/create/createProgress'
import { SlotBoundary, SlotFailed } from '../lib/read/screens/slots'
import { PageHeader, PageShell } from '../components/ui'
import { Journey } from '../components/create/Journey'
import { parseNewHash, parseNewNetworkHash, type NetworkTokenLocation } from '../components/explore/routes'
import { useHash } from '../components/explore/useHash'
import { recovering } from '../lib/staleRelease'

/**
 * Changed on purpose (data) 2026-10-02 (Domino V2 integration, the journey): in a build that carries V2 (`__DOMINO_V2__`;
 * production and development too since 2026-10-04, the owner: the site runs on Domino V2; false only in the test builds
 * without V2, where this folds away and New position is V1's Journey), New position is drawn by the integrated
 * journey's wrapper (src/v2in/journey): Domino V2's journey wherever the V2 gate opens (Robinhood Chain on domino.money,
 * src/v2in/journey/constants.ts SETUP_STAYS_WHILE_PREVIEW), today's Journey where it stays off. Opened lazily, named
 * once; a wrapper that cannot load leaves today's Journey (lib/staleRelease.ts recovering).
 */
type V2JourneyProps = { flow: number; poolId: string; linkToken: string | null; networkToken: NetworkTokenLocation | null }
const V2NewPosition = __DOMINO_V2__ ? lazy(recovering(() => import('../v2in/journey/NewPositionV2'), () => ({ default: ({ flow, poolId, linkToken, networkToken }: V2JourneyProps) => networkToken
  ? <PageShell width="flow"><PageHeader size="display" title={CREATE.page.title} /><p role="status">This network could not be loaded. <a href="#/new">Search again</a></p></PageShell>
  : <Journey key={flow} poolId={poolId} linkToken={linkToken} /> }))) : null

/**
 * Which flow New position shows: a new one each time a link to New position is followed after a position was created
 * here (review of 2026-09-24). Once a position exists the flow rests on its success (Review offers what comes next,
 * CreatedNext.tsx, and no step reopens), so the footer's, the menu's or a pool's New position has to start again at
 * the first step: on a route change (#/new/<pool> to #/new, both the same page) and on a link to the very hash already
 * open, which changes nothing the browser reports. While no position has been created, following such a link keeps
 * the flow as it is, as before.
 *
 * Changed on purpose 2026-10-06 (the final check's F1/F6, a second look): a position Domino V2 made on this flow counts
 * too, on every network (lib/create/createProgress.ts useFlowMade): on Base and Arbitrum One, whose positions are never
 * `created` (that marker is Robinhood Chain's lists'), the flow rested on its success and New position's link did nothing.
 */
function useFlowKey(): number {
  const listed = useCreated() !== null
  const madeV2 = useFlowMade()
  const created = listed || madeV2
  const [flow, setFlow] = useState(0)
  useEffect(() => {
    if (!created) return
    const again = () => setFlow((count) => count + 1)
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!(link instanceof HTMLAnchorElement) || link.getAttribute('href') !== window.location.hash) return
      again()
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', again)
    document.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('hashchange', again)
      document.removeEventListener('click', onClick)
    }
  }, [created])
  return flow
}

/**
 * New position: the four-step flow. `poolId`, when present, preselects the
 * pool once the chain verifies it, with the token the link names after it
 * (`#/new/<id>/<token>`, parseNewHash) when there is one. The flow is part of
 * the page's own code (no chunk of its own), inside a boundary so a failure in
 * it leaves the rest of the page working and says so.
 */
export function NewPosition({ poolId }: { poolId: string }) {
  // The tab's name (lib/routeTitle.ts, audit E11).
  useRouteTitle(CREATE.page.title)
  const flow = useFlowKey()
  const hash = useHash()
  const networkToken = parseNewNetworkHash(hash)
  const linkToken = parseNewHash(hash).token
  if (__DOMINO_V2__ && V2NewPosition) {
    return (
      <Suspense fallback={<PageShell width="flow"><PageHeader size="display" title={CREATE.page.title} description={CREATE.page.description} /></PageShell>}>
        <V2NewPosition flow={flow} poolId={networkToken ? '' : poolId} linkToken={linkToken} networkToken={networkToken} />
      </Suspense>
    )
  }
  if (!SlotBoundary || !SlotFailed) return <Journey key={flow} poolId={poolId} linkToken={linkToken} />
  return (
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
      <Journey key={flow} poolId={poolId} linkToken={linkToken} />
    </SlotBoundary>
  )
}
