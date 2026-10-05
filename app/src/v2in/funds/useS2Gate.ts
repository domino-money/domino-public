import { useEffect, useState } from 'react'
import { s2Gate, type V2Gate } from '../../v2/gate'
import type { V2ChainId } from '../../v2/types'
import { fundsRoutes } from './live'

/**
 * The gate's answer for S2 on `chainId` (src/v2/gate.ts s2Gate: the crosschain route's own word, asked of the page's
 * probe), once it is known; null before, or for no chain. A gate that cannot be worked out is off: the step stays V1's.
 */
export function useS2Gate(chainId: V2ChainId | null): V2Gate | null {
  const [answer, setAnswer] = useState<{ chainId: V2ChainId; gate: V2Gate } | null>(null)
  useEffect(() => {
    if (chainId === null) return
    let alive = true
    void s2Gate(chainId, fundsRoutes).then(
      (gate) => {
        if (alive) setAnswer({ chainId, gate })
      },
      () => {
        if (alive) setAnswer({ chainId, gate: { mode: 'off' } })
      },
    )
    return () => {
      alive = false
    }
  }, [chainId])
  return answer !== null && answer.chainId === chainId ? answer.gate : null
}
