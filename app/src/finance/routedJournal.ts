import { keccak256, stringToHex, type Hex } from 'viem'

/** Only an opaque account digest, claim and public transaction hash survive a reload.
 * No quote, address, amount, credential or calldata is persisted. Unknown outcomes
 * are quarantined across tabs; clearing a pending browser record is never recovery. */
interface StoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
interface LockPort { request<T>(key: string, run: () => Promise<T>): Promise<T> }
export interface RouteRecord { claim: string; hash: Hex | null; batchOperation: Hex | null }
const PREFIX = 'domino.routed-offer.v1.'
const keyOf = (owner: string) => {
  if (!/^0x[0-9a-f]{40}$/.test(owner)) throw new Error('route_coordination_unavailable')
  return PREFIX + keccak256(stringToHex(`4663|${owner}`)).slice(2)
}
export function createRouteJournal(storage: StoragePort, locks: LockPort, random: () => string) {
  function read(owner: string): RouteRecord | null {
    const value = storage.getItem(keyOf(owner))
    if (value === null) return null
    if (!/^[0-9a-f-]{36}\|((b:)?0x[0-9a-f]{64})?$/.test(value)) throw new Error('route_coordination_unavailable')
    const batch = value.slice(37).startsWith('b:')
    return { claim: value.slice(0, 36), hash: value.length > 37 && !batch ? value.slice(37) as Hex : null, batchOperation: batch ? value.slice(39) as Hex : null }
  }
  return {
    read,
    claim: (owner: string) => locks.request(keyOf(owner), async () => {
      if (read(owner)) throw new Error('route_already_offered')
      const claim = random()
      if (!/^[0-9a-f-]{36}$/.test(claim)) throw new Error('route_coordination_unavailable')
      storage.setItem(keyOf(owner), `${claim}|`)
      if (read(owner)?.claim !== claim) throw new Error('route_coordination_unavailable')
      return claim
    }),
    record: (owner: string, claim: string, hash: Hex) => locks.request(keyOf(owner), async () => {
      if (!/^0x[0-9a-f]{64}$/.test(hash) || read(owner)?.claim !== claim) throw new Error('route_coordination_unavailable')
      storage.setItem(keyOf(owner), `${claim}|${hash}`)
      if (read(owner)?.hash !== hash) throw new Error('route_coordination_unavailable')
    }),
    recordBatch: (owner: string, claim: string, operationId: Hex) => locks.request(keyOf(owner), async () => {
      if (!/^0x[0-9a-f]{64}$/.test(operationId) || read(owner)?.claim !== claim) throw new Error('route_coordination_unavailable')
      storage.setItem(keyOf(owner), `${claim}|b:${operationId}`)
      if (read(owner)?.batchOperation !== operationId) throw new Error('route_coordination_unavailable')
    }),
    // Only an explicit wallet rejection, canonical revert, or completed mint permits this.
    release: (owner: string, claim: string) => locks.request(keyOf(owner), async () => {
      if (read(owner)?.claim === claim) storage.removeItem(keyOf(owner))
    }),
  }
}
export function routeJournal() {
  if (typeof window === 'undefined' || !navigator.locks) throw new Error('route_coordination_unavailable')
  return createRouteJournal(window.localStorage, navigator.locks, () => crypto.randomUUID())
}
