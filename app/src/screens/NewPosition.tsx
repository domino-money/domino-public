import { CREATE } from '../lib/create/copy'
import { SlotBoundary, SlotFailed } from '../lib/read/screens/slots'
import { PageHeader, PageShell } from '../components/ui'
import { Journey } from '../components/create/Journey'

/**
 * New position: the four-step flow. `poolId`, when present, preselects the
 * pool once the chain verifies it. The flow is part of the page's own code
 * (no chunk of its own), inside a boundary so a failure in it leaves the
 * rest of the page working and says so.
 */
export function NewPosition({ poolId }: { poolId: string }) {
  if (!SlotBoundary || !SlotFailed) return <Journey poolId={poolId} />
  return (
    <SlotBoundary
      fallback={
        <PageShell width="flow">
          <PageHeader size="display" align="center" title={CREATE.page.title} />
          <div className="mt-8">
            <SlotFailed />
          </div>
        </PageShell>
      }
    >
      <Journey poolId={poolId} />
    </SlotBoundary>
  )
}
