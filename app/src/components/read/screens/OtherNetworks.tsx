import { lazy, Suspense, type ReactNode } from 'react'
import type { OtherChains } from '../../../lib/create/otherChains'
import { recovering } from '../../../lib/staleRelease'

type Children = (others: OtherChains | null, checking: boolean) => ReactNode

/**
 * Base and Arbitrum One's public reads for a V1 screen (added 2026-11-06, the replica rule: a pool's page on those
 * networks), as Markets opens them (screens/Explore.tsx): V2's discovery (src/v2in/journey/MarketsNetworks.tsx), loaded
 * only in a build that carries V2 and only when such a page opens, which never connects or switches a wallet. Without V2,
 * or when its chunk could not load, `children` is handed no networks at all.
 */
const MarketsNetworks = __DOMINO_V2__ ? lazy(recovering(() => import('../../../v2in/journey/MarketsNetworks'), () => ({ default: ({ children }: { children: Children }) => children(null, false) }))) : null

export function OtherNetworks({ children, fallback }: { children: Children; fallback: ReactNode }) {
  if (!MarketsNetworks) return <>{children(null, false)}</>
  return (
    <Suspense fallback={fallback}>
      <MarketsNetworks>{children}</MarketsNetworks>
    </Suspense>
  )
}
