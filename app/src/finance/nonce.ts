import { keccak256, stringToHex } from 'viem'

interface StoragePort { readonly length: number; key(index: number): string | null; getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
interface LockPort { request<T>(name: string, callback: () => Promise<T>): Promise<T> }
const prefix = 'domino.offered-nonce.v1.'
const keyFor = (owner: string, nonce: bigint) => {
  if (!/^0x[0-9a-f]{40}$/.test(owner) || nonce < 0n || nonce >= 2n ** 64n) throw new Error('invalid_wallet_nonce')
  return prefix + keccak256(stringToHex(`4663|${owner}|${nonce}`)).slice(2)
}
/** A cross-tab, reload-safe quarantine for a nonce offered to a wallet. Only
 * hashes and random claim IDs are stored; no addresses, amounts, calldata,
 * bearer credentials or private API responses enter browser storage. */
export function createNonceJournal(storage: StoragePort, locks: LockPort, randomId: () => string) {
  return {
    offered: (owner: string, nonce: bigint) => storage.getItem(keyFor(owner, nonce)) !== null,
    claim: (owner: string, nonce: bigint) => locks.request(keyFor(owner, nonce), async () => {
      const key = keyFor(owner, nonce)
      if (storage.getItem(key) !== null) throw new Error('wallet_nonce_already_offered')
      let count = 0
      for (let i = 0; i < storage.length; i++) if (storage.key(i)?.startsWith(prefix)) count++
      if (count >= 1024) throw new Error('wallet_nonce_journal_full')
      const token = randomId()
      if (!/^[0-9a-f-]{36}$/.test(token)) throw new Error('wallet_nonce_coordination_unavailable')
      storage.setItem(key, token)
      if (storage.getItem(key) !== token) throw new Error('wallet_nonce_coordination_unavailable')
      return token
    }),
    releaseAfterRejection: (owner: string, nonce: bigint, token: string) => locks.request(keyFor(owner, nonce), async () => {
      const key = keyFor(owner, nonce)
      if (storage.getItem(key) === token) storage.removeItem(key)
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
