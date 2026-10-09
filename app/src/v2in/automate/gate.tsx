import { useEffect, useState } from 'react'
import type { V2Service } from '../../v2/capabilities'
import { v2Gate, type V2Gate } from '../../v2/gate'
import { v2PageProbe } from '../transports'
import { createGateCache, GATE_RECHECK_MS } from './gateCache'

/**
 * The gate of a Domino V2 service on a chain (src/v2/gate.ts), for the integrated automation screens: `off` (the screen is
 * exactly V1's), `preview` (the option runs up to its review, then says `lockedCopy`: nothing is sent or signed) or `live`
 * (the same screens, for real, through the closed money clients). Rechecked on re-entry, focus, reconnect and each
 * visible minute. The underlying capability probe keeps its own one-minute TTL. Null until the first check completes.
 */
export const gateOf = createGateCache((service, chainId) => v2Gate(service, chainId, undefined, v2PageProbe))

export function useGate(service: V2Service, chainId: number): V2Gate | null {
  const key = `${service}|${chainId}`
  const [known, setKnown] = useState<{ key: string; gate: V2Gate } | null>(null)
  useEffect(() => {
    let live = true
    const check = () => {
      if (document.visibilityState === 'hidden') return
      void gateOf(service, chainId, true).then((gate) => {
        if (live) setKnown((previous) => previous?.key === key && previous.gate === gate ? previous : { key, gate })
      })
    }
    check()
    const timer = window.setInterval(check, GATE_RECHECK_MS)
    window.addEventListener('focus', check)
    window.addEventListener('online', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      live = false
      window.clearInterval(timer)
      window.removeEventListener('focus', check)
      window.removeEventListener('online', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [service, chainId, key])
  return known && known.key === key ? known.gate : null
}

/** Whether a gate lets its option be seen at all (preview or live). */
export const gateOpen = (gate: V2Gate | null): gate is Exclude<V2Gate, { mode: 'off' }> => gate !== null && gate.mode !== 'off'
