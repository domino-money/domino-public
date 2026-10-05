import { useEffect, useState } from 'react'
import type { V2Service } from '../../v2/capabilities'
import { v2Gate, type V2Gate } from '../../v2/gate'
import { v2PageProbe } from '../transports'

/**
 * The gate of a Domino V2 service on a chain (src/v2/gate.ts), for the integrated automation screens: `off` (the screen is
 * exactly V1's), `preview` (the option runs up to its review, then says `lockedCopy`: nothing is sent or signed) or `live`
 * (the same screens, for real, through the closed money clients). Asked once per page for each service and chain: what it
 * depends on (the build, the page's origin, the pinned manifests, the backend's word) does not change while the page is
 * open. Null until it is known, which is a moment: the preview's fixture set is a lazy chunk.
 */
const asked = new Map<string, Promise<V2Gate>>()
const OFF: V2Gate = Object.freeze({ mode: 'off' })

export function gateOf(service: V2Service, chainId: number): Promise<V2Gate> {
  const key = `${service}|${chainId}`
  let gate = asked.get(key)
  if (!gate) {
    // A gate that cannot be worked out (the fixture chunk failed to load) is off: the screen stays V1's.
    gate = v2Gate(service, chainId, undefined, v2PageProbe).catch(() => OFF)
    asked.set(key, gate)
  }
  return gate
}

export function useGate(service: V2Service, chainId: number): V2Gate | null {
  const key = `${service}|${chainId}`
  const [known, setKnown] = useState<{ key: string; gate: V2Gate } | null>(null)
  useEffect(() => {
    let live = true
    void gateOf(service, chainId).then((gate) => {
      if (live) setKnown({ key, gate })
    })
    return () => {
      live = false
    }
  }, [service, chainId, key])
  return known && known.key === key ? known.gate : null
}

/** Whether a gate lets its option be seen at all (preview or live). */
export const gateOpen = (gate: V2Gate | null): gate is Exclude<V2Gate, { mode: 'off' }> => gate !== null && gate.mode !== 'off'
