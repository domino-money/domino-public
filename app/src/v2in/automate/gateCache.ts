import type { V2Service } from '../../v2/capabilities'
import type { V2Gate } from '../../v2/gate'

export const GATE_RECHECK_MS = 60_000

/** Share only an in-flight check and a bounded answer, never a failed page-lifetime Promise. */
export function createGateCache(ask: (service: V2Service, chainId: number) => Promise<V2Gate>, now = Date.now) {
  const entries = new Map<string, { value?: V2Gate; until: number; pending?: Promise<V2Gate> }>()
  return (service: V2Service, chainId: number, refresh = false): Promise<V2Gate> => {
    const key = `${service}|${chainId}`
    const entry = entries.get(key) ?? { until: 0 }
    entries.set(key, entry)
    if (entry.pending) return entry.pending
    if (!refresh && entry.value && now() < entry.until) return Promise.resolve(entry.value)
    entry.pending = Promise.resolve().then(() => ask(service, chainId)).catch((): V2Gate => ({ mode: 'off' })).then((next) => {
      // Identical manifests keep their reference: focus must not restart a prepared review or a wallet run.
      if (!entry.value || JSON.stringify(entry.value) !== JSON.stringify(next)) entry.value = next
      entry.until = now() + GATE_RECHECK_MS
      entry.pending = undefined
      return entry.value
    })
    return entry.pending
  }
}
