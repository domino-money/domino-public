import { keccak256, stringToHex, type Address } from 'viem'
import { V2_CHAIN_IDS } from '../../config/chainIdentity'
import type { V2ChainId } from '../../v2/types'
import type { SignatureJournal, SignedNonce } from './transact'

/**
 * The page's journal of signature nonces (spec F7 §2.5.2 "Escolha do nonce", §2.10, §4.4): a nonce is recorded BEFORE a
 * wallet is asked to sign with it, kept while the signature may still be used (a Permit2 permit, a relayed action, an
 * auto-exit order), and let go only when the chain's finalized block shows it used or cancelled, or when nothing was
 * signed (a refusal before or at the prompt). It is what the page offers to cancel after a reload.
 *
 * Only public data is stored, and no address of the person's (as V1's nonce journal, finance/nonce.ts): the chain, a
 * hash of the chain and the owner (`who`), the verifying contract, the nonce's space and the nonce. No signature, no
 * typed data, no amount. An entry is listed only to the owner whose hash it carries. One entry per key, across tabs (Web Locks), at most 512 entries, and a write is
 * read back before it counts (a full or refusing storage refuses the signature: `signature_journal_unavailable`).
 */

interface StoragePort {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
interface LockPort {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>
}

const PREFIX = 'domino.signed-nonce.v1.'
const MAX_ENTRIES = 512
const ADDRESS = /^0x[0-9a-f]{40}$/
const SPACES: readonly SignedNonce['space'][] = ['permit2', 'zap', 'autoExit']
/** Every V2 chain the build serves (config/chainIdentity.ts V2_CHAIN_IDS; Changed on purpose 2026-11-07: the three were written out). */
const CHAINS: readonly number[] = V2_CHAIN_IDS
const MAX_UINT256 = (1n << 256n) - 1n

const fail = (code: string): never => { throw new Error(code) }

function checked(entry: SignedNonce): SignedNonce {
  const owner = String(entry.owner).toLowerCase()
  const verifier = String(entry.verifier).toLowerCase()
  if (!CHAINS.includes(entry.chainId) || !ADDRESS.test(owner) || !ADDRESS.test(verifier) || !SPACES.includes(entry.space)
    || typeof entry.nonce !== 'bigint' || entry.nonce < 0n || entry.nonce > MAX_UINT256) return fail('invalid_signature_nonce')
  return { chainId: entry.chainId, owner: owner as Address, space: entry.space, verifier: verifier as Address, nonce: entry.nonce }
}
const keyOf = (entry: SignedNonce) => PREFIX + keccak256(stringToHex(`${entry.chainId}|${entry.owner}|${entry.space}|${entry.verifier}|${entry.nonce}`)).slice(2)
/** The owner as stored: a hash of the chain and the lowercase address, never the address. */
const whoOf = (chainId: number, owner: string) => keccak256(stringToHex(`${chainId}|${owner}`))
const valueOf = (entry: SignedNonce) => JSON.stringify({ chainId: entry.chainId, who: whoOf(entry.chainId, entry.owner), space: entry.space, verifier: entry.verifier, nonce: entry.nonce.toString(10) })

/**
 * An entry read back from storage for `owner` (lowercase), or null for anything that is not exactly one of theirs (it is
 * then left alone).
 */
function parsed(raw: string | null, owner: string): SignedNonce | null {
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Object.keys(value).sort().join() !== 'chainId,nonce,space,verifier,who') return null
    if (typeof value.nonce !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value.nonce)) return null
    if (typeof value.chainId !== 'number' || value.who !== whoOf(value.chainId, owner)) return null
    return checked({ chainId: value.chainId as V2ChainId, owner: owner as Address, space: value.space as SignedNonce['space'], verifier: value.verifier as Address, nonce: BigInt(value.nonce) })
  } catch {
    return null
  }
}

export function createSignatureJournal(storage: StoragePort, locks: LockPort): SignatureJournal {
  const count = () => {
    let held = 0
    for (let i = 0; i < storage.length; i++) if (storage.key(i)?.startsWith(PREFIX)) held++
    return held
  }
  return {
    held: (entry) => storage.getItem(keyOf(checked(entry))) !== null,
    // Async, so a malformed entry is a rejected promise, as every journal failure is.
    record: async (entry) => {
      const clean = checked(entry)
      const key = keyOf(clean)
      return locks.request(key, async () => {
        if (storage.getItem(key) !== null) return
        if (count() >= MAX_ENTRIES) fail('signature_journal_full')
        const value = valueOf(clean)
        try {
          storage.setItem(key, value)
        } catch {
          fail('signature_journal_unavailable')
        }
        if (storage.getItem(key) !== value) fail('signature_journal_unavailable')
      })
    },
    forget: async (entry) => {
      const key = keyOf(checked(entry))
      return locks.request(key, async () => { storage.removeItem(key) })
    },
    list: (chainId, owner) => {
      const who = String(owner).toLowerCase()
      const found: SignedNonce[] = []
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (!key?.startsWith(PREFIX)) continue
        const entry = parsed(storage.getItem(key), who)
        // An entry is listed only under the key its own fields make: nothing written elsewhere passes for one.
        if (entry && keyOf(entry) === key && entry.chainId === chainId) found.push(Object.freeze(entry))
      }
      return Object.freeze(found)
    },
  }
}

/** The page's own journal, in localStorage across tabs; refused where the browser has no Web Locks. */
export function browserSignatureJournal(): SignatureJournal {
  if (typeof window === 'undefined' || !navigator.locks) return fail('signature_journal_unavailable')
  return createSignatureJournal(window.localStorage, navigator.locks)
}
