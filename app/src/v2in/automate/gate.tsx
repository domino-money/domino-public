import { useEffect, useState } from 'react'
import { ELYSIUM_LIVE, ELYSIUM_V2_ID } from '../../lib/elysiumIdentity'
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

/** Added 2026-11-09 (the core-flows fix, item a): how soon a gate that is not live is asked again, before the visible minute. */
export const HEAL_MS = [3_000, 10_000, 30_000] as const

/**
 * Added 2026-11-09 (the core-flows fix, item a): the gate of a position page's own actions. They asked it once per page (a
 * 10-second probe), so a passing failure of that probe left the page on `preview` (every action locked) or `off` until a
 * reload. Here a gate that is not live is asked again by itself, sooner at first (HEAL_MS), then each visible minute and
 * at the page's wake as useGate does; a live gate is rechecked each visible minute. Identical answers keep their
 * reference (./gateCache.ts), so an open review is never restarted by a recheck. Null until the first answer.
 */
export function useHealingGate(service: V2Service, chainId: number): V2Gate | null {
  const key = `${service}|${chainId}`
  const [known, setKnown] = useState<{ key: string; gate: V2Gate } | null>(null)
  useEffect(() => {
    let live = true
    let attempt = 0
    let timer: number | undefined
    const later = (ms: number) => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => check(), ms)
    }
    const check = (refresh = true) => {
      if (document.visibilityState === 'hidden') return later(GATE_RECHECK_MS)
      void gateOf(service, chainId, refresh).then((gate) => {
        if (!live) return
        setKnown((previous) => previous?.key === key && previous.gate === gate ? previous : { key, gate })
        if (gate.mode === 'live') attempt = 0
        later(gate.mode === 'live' || attempt >= HEAL_MS.length ? GATE_RECHECK_MS : HEAL_MS[attempt++])
      })
    }
    check()
    const stopWake = pageWake.onWake(() => check(false))
    return () => {
      live = false
      window.clearTimeout(timer)
      stopWake()
    }
  }, [service, chainId, key])
  return known && known.key === key ? known.gate : null
}

/**
 * Elysium's gate of a service (added 2026-11-07, Elysium as a fourth V2 chain): useGate for chain 99901 where the build
 * serves Elysium (lib/elysiumIdentity.ts ELYSIUM_LIVE); where it does not, null, with no hook, no check and no timer. A
 * build-time fact, so every render of a build calls the same hooks.
 */
export const useElysiumGate: (service: V2Service) => V2Gate | null = ELYSIUM_LIVE ? (service) => useGate(service, ELYSIUM_V2_ID) : () => null

/** Whether a gate lets its option be seen at all (preview or live). */
export const gateOpen = (gate: V2Gate | null): gate is Exclude<V2Gate, { mode: 'off' }> => gate !== null && gate.mode !== 'off'
