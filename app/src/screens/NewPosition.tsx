import { useEffect, useState } from 'react'
import { CREATE } from '../lib/create/copy'
import { useCreated } from '../lib/create/createProgress'
import { SlotBoundary, SlotFailed } from '../lib/read/screens/slots'
import { PageHeader, PageShell } from '../components/ui'
import { Journey } from '../components/create/Journey'
import { parseNewHash } from '../components/explore/routes'
import { useHash } from '../components/explore/useHash'

/**
 * Which flow New position shows: a new one each time a link to New position is followed after a position was created
 * here (review of 2026-09-24). Once a position exists the flow rests on its success (Review offers what comes next,
 * CreatedNext.tsx, and no step reopens), so the footer's, the menu's or a pool's New position has to start again at
 * the first step: on a route change (#/new/<pool> to #/new, both the same page) and on a link to the very hash already
 * open, which changes nothing the browser reports. While no position has been created, following such a link keeps
 * the flow as it is, as before.
 */
function useFlowKey(): number {
  const created = useCreated() !== null
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
  const flow = useFlowKey()
  const linkToken = parseNewHash(useHash()).token
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
