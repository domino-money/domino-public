import { useEffect, useState } from 'react'
import type { V2Service } from '../../v2/capabilities'
import { v2Gate, type V2Gate } from '../../v2/gate'
import { v2PageProbe } from '../transports'
import { createGateCache, GATE_RECHECK_MS } from './gateCache'
import { pageWake } from '../../lib/wake'

/**
 * The gate of a Domino V2 service on a chain (src/v2/gate.ts), for the integrated automation screens: `off` (the screen is
 * exactly V1's), `preview` (the option runs up to its review, then says `lockedCopy`: nothing is sent or signed) or `live`
 * (the same screens, for real, through the closed money clients). Rechecked on re-entry and each visible minute, and at
 * the page's wake (lib/wake.ts) only once the last check is a minute old. The underlying capability probe keeps its own
 * one-minute TTL. Null until the first check completes.
 *
 * Changed on purpose 2026-10-14 (incident 2026-10-13, design 2.5, package Q1): every focus, online and visibility change
 * rechecked every gate on the page at once; a wallet's popup closing fired it.
 */
export const gateOf = createGateCache((service, chainId) => v2Gate(service, chainId, undefined, v2PageProbe))

export function useGate(service: V2Service, chainId: number): V2Gate | null {
  const key = `${service}|${chainId}`
  const [known, setKnown] = useState<{ key: string; gate: V2Gate } | null>(null)
  useEffect(() => {
    let live = true
    // `refresh`: asked again whatever its age (re-entry and the visible minute); else the kept gate while it is younger than
    // GATE_RECHECK_MS, its own period (gateCache.ts), so a wake asks only for a gate older than that.
    const check = (refresh = true) => {
      if (document.visibilityState === 'hidden') return
      void gateOf(service, chainId, refresh).then((gate) => {
        if (live) setKnown((previous) => previous?.key === key && previous.gate === gate ? previous : { key, gate })
      })
    }
    check()
    const timer = window.setInterval(() => check(), GATE_RECHECK_MS)
    const stopWake = pageWake.onWake(() => check(false))
    return () => {
      live = false
      window.clearInterval(timer)
      stopWake()
    }
  }, [service, chainId, key])
  return known && known.key === key ? known.gate : null
}

/** Whether a gate lets its option be seen at all (preview or live). */
export const gateOpen = (gate: V2Gate | null): gate is Exclude<V2Gate, { mode: 'off' }> => gate !== null && gate.mode !== 'off'
