import { keccak256, stringToHex } from 'viem'

interface StoragePort { readonly length: number; key(index: number): string | null; getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
interface LockPort { request<T>(name: string, callback: () => Promise<T>): Promise<T> }
const prefix = 'domino.offered-nonce.v1.'
const batchPrefix = 'domino.offered-batch.v1.'
/** When a batch's latch was claimed, in unix seconds, beside it under a prefix of its own (expireBatch). */
const batchAtPrefix = 'domino.offered-batch-at.v1.'
const keyFor = (owner: string, nonce: bigint) => {
  if (!/^0x[0-9a-f]{40}$/.test(owner) || nonce < 0n || nonce >= 2n ** 64n) throw new Error('invalid_wallet_nonce')
  return prefix + keccak256(stringToHex(`4663|${owner}|${nonce}`)).slice(2)
}
const batchKeyFor = (owner: string, operationId: string) => {
  if (!/^0x[0-9a-f]{40}$/.test(owner) || !/^0x[0-9a-f]{64}$/.test(operationId)) throw new Error('invalid_wallet_batch')
  return batchPrefix + keccak256(stringToHex(`4663|${owner}|${operationId}`)).slice(2)
}
const batchAtKeyFor = (owner: string, operationId: string) => batchAtPrefix + batchKeyFor(owner, operationId).slice(batchPrefix.length)
/** A wallet's id for a batch (EIP-5792): printable ASCII, and never the separator the latch stores it after. */
const BATCH_ID = /^[\x21-\x7b\x7d\x7e]{1,512}$/
/** A cross-tab, reload-safe quarantine for a nonce offered to a wallet. Only
 * hashes and random claim IDs are stored; no addresses, amounts, calldata,
 * bearer credentials or private API responses enter browser storage.
 *
 * A batch (EIP-5792) has a latch of its own, keyed by the operation id it
 * opens: a wallet may run it through a bundler, spending no nonce of the
 * owner's. It keeps the wallet's batch id beside the claim, the one value
 * from a wallet stored here, so the batch's status can be asked again after a
 * reload. The contract already refuses a second batch for the same id; the
 * latch keeps a second prompt from opening. Beside it, the time it was claimed
 * (2026-09-28), so a latch whose batch can no longer execute is freed
 * (expireBatch) instead of holding every later press. */
export function createNonceJournal(storage: StoragePort, locks: LockPort, randomId: () => string) {
  const held = () => {
    let count = 0
    for (let i = 0; i < storage.length; i++) if (storage.key(i)?.startsWith(prefix) || storage.key(i)?.startsWith(batchPrefix)) count++
    return count
  }
  const place = (key: string) => {
    if (held() >= 1024) throw new Error('wallet_nonce_journal_full')
    const token = randomId()
    if (!/^[0-9a-f-]{36}$/.test(token)) throw new Error('wallet_nonce_coordination_unavailable')
    storage.setItem(key, token)
    if (storage.getItem(key) !== token) throw new Error('wallet_nonce_coordination_unavailable')
    return token
  }
  return {
    offered: (owner: string, nonce: bigint) => storage.getItem(keyFor(owner, nonce)) !== null,
    claim: (owner: string, nonce: bigint) => locks.request(keyFor(owner, nonce), async () => {
      const key = keyFor(owner, nonce)
      if (storage.getItem(key) !== null) throw new Error('wallet_nonce_already_offered')
      return place(key)
    }),
    releaseAfterRejection: (owner: string, nonce: bigint, token: string) => locks.request(keyFor(owner, nonce), async () => {
      const key = keyFor(owner, nonce)
      if (storage.getItem(key) === token) storage.removeItem(key)
    }),
    /** The batch offered for this operation: the wallet's id for it, '' until the wallet answered, null when none. */
    batchOffered: (owner: string, operationId: string): string | null => {
      const value = storage.getItem(batchKeyFor(owner, operationId))
      return value === null ? null : value.slice(37)
    },
    /** `at`: when, in unix seconds; kept beside the latch where storage allows, never failing the claim. */
    claimBatch: (owner: string, operationId: string, at?: number) => locks.request(batchKeyFor(owner, operationId), async () => {
      const key = batchKeyFor(owner, operationId)
      if (storage.getItem(key) !== null) throw new Error('wallet_batch_already_offered')
      const token = place(key)
      if (at !== undefined && Number.isFinite(at) && at > 0) {
        try { storage.setItem(batchAtKeyFor(owner, operationId), String(Math.floor(at))) } catch { /* expireBatch starts the clock instead */ }
      }
      return token
    }),
    /** Keeps the wallet's id for the batch this claim offered, so its status can be asked after a reload. */
    recordBatch: (owner: string, operationId: string, token: string, id: string) => locks.request(batchKeyFor(owner, operationId), async () => {
      if (!BATCH_ID.test(id)) throw new Error('invalid_wallet_batch')
      const key = batchKeyFor(owner, operationId)
      if (storage.getItem(key) === token) storage.setItem(key, `${token}|${id}`)
    }),
    /** Frees the latch once nothing of the batch can still execute or it is done, by its claim or by the wallet's id. */
    releaseBatch: (owner: string, operationId: string, claim: string) => locks.request(batchKeyFor(owner, operationId), async () => {
      const key = batchKeyFor(owner, operationId), value = storage.getItem(key)
      if (value !== null && claim !== '' && (value.slice(0, 36) === claim || value.slice(37) === claim)) {
        storage.removeItem(key)
        storage.removeItem(batchAtKeyFor(owner, operationId))
      }
    }),
    /**
     * Frees the latch claimed more than `maxAge` seconds before `now`: its batch can no longer execute (setup.ts
     * BATCH_LATCH_EXPIRY_S says why), whether or not the wallet ever answered. A latch with no time beside it (claimed
     * before times were kept, or where storage refused one) starts its clock now, and one claimed in the future (a clock
     * set back) starts it again: either frees later than needed, never sooner. True when it freed one.
     */
    expireBatch: (owner: string, operationId: string, now: number, maxAge: number) => locks.request(batchKeyFor(owner, operationId), async () => {
      const key = batchKeyFor(owner, operationId), atKey = batchAtKeyFor(owner, operationId)
      if (storage.getItem(key) === null) {
        storage.removeItem(atKey)
        return false
      }
      const at = Number(storage.getItem(atKey) ?? Number.NaN)
      if (!Number.isFinite(at) || at <= 0 || at > now) {
        try { storage.setItem(atKey, String(Math.floor(now))) } catch { /* the latch stays, as before times were kept */ }
        return false
      }
      if (now - at <= maxAge) return false
      storage.removeItem(key)
      storage.removeItem(atKey)
      return true
    }),
  }
}
function browserJournal() {
  if (typeof window === 'undefined' || !navigator.locks) throw new Error('wallet_nonce_coordination_unavailable')
  return createNonceJournal(window.localStorage, navigator.locks, () => crypto.randomUUID())
}
export const ownerNonceOffered = (owner: string, nonce: bigint) => browserJournal().offered(owner, nonce)
export const claimOwnerNonce = (owner: string, nonce: bigint) => browserJournal().claim(owner, nonce)
export const releaseOwnerNonceAfterRejection = (owner: string, nonce: bigint, token: string) => browserJournal().releaseAfterRejection(owner, nonce, token)
export const ownerBatchOffered = (owner: string, operationId: string) => browserJournal().batchOffered(owner, operationId)
export const claimOwnerBatch = (owner: string, operationId: string) => browserJournal().claimBatch(owner, operationId, Date.now() / 1000)
export const recordOwnerBatch = (owner: string, operationId: string, token: string, id: string) => browserJournal().recordBatch(owner, operationId, token, id)
export const releaseOwnerBatch = (owner: string, operationId: string, claim: string) => browserJournal().releaseBatch(owner, operationId, claim)
export const expireOwnerBatch = (owner: string, operationId: string, now: number, maxAge: number) => browserJournal().expireBatch(owner, operationId, now, maxAge)
