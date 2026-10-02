/**
 * The second chain's receipts: the transactions this browser sent through the Elysium section, and what became of each
 * (2026-10-01, the chain2 workstream).
 *
 * Kept in this browser only, under a key that names the chain and the owner (lib/chainStorage.ts, audit item G10:
 * `domino-elysium-receipts-v1:<chainId>:<owner>`), at most MAX_KEPT of them, newest first. What is read back is untrusted
 * and checked field by field; anything else is dropped. A pending one is asked again by itself (`followReceipt`): his
 * actions service's receipt route where it answers, else the chain's own eth_getTransactionReceipt, never a button.
 */
import type { ChainConfig } from '../../config/chainKit'
import { chainKey, readScoped, writeScoped, type KeyValueStore } from '../../lib/chainStorage'
import { KEPT_MAX_AGE_MS } from '../../lib/browserCopies'
import type { Draft } from '../../../functions/_lib/uniswap-v3/contracts/uniswap-v3-actions-v1/types'
import type { ChainReader } from '../../../functions/_lib/uniswap-v3/reads'
import { ServiceError, type Identity, type V3Api } from './api'
import type { SentTransaction } from './flow'

export const RECEIPTS_KEY = 'domino-elysium-receipts-v1'
export const MAX_KEPT = 50

export type ReceiptOutcome = 'pending' | 'confirmed' | 'reverted' | 'replaced'

export interface ReceiptEntry {
  readonly hash: string
  readonly vault: string
  readonly owner: string
  readonly step: Draft['step']
  /** Milliseconds. */
  readonly sentAt: number
  readonly outcome: ReceiptOutcome
  readonly block: number | null
}

const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const STEPS: ReadonlySet<string> = new Set(['approve-reset', 'approve-token0', 'approve-token1', 'open', 'set-policy', 'pause', 'reduce', 'release', 'withdraw-fees', 'withdraw-capital'])
const OUTCOMES: ReadonlySet<string> = new Set(['pending', 'confirmed', 'reverted', 'replaced'])

function entryOf(value: unknown): ReceiptEntry | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.hash !== 'string' || !HASH.test(v.hash)) return null
  if (typeof v.vault !== 'string' || !ADDRESS.test(v.vault) || typeof v.owner !== 'string' || !ADDRESS.test(v.owner)) return null
  if (typeof v.step !== 'string' || !STEPS.has(v.step) || typeof v.outcome !== 'string' || !OUTCOMES.has(v.outcome)) return null
  if (typeof v.sentAt !== 'number' || !Number.isSafeInteger(v.sentAt) || v.sentAt <= 0) return null
  if (v.block !== null && (typeof v.block !== 'number' || !Number.isSafeInteger(v.block) || v.block <= 0)) return null
  return { hash: v.hash, vault: v.vault, owner: v.owner, step: v.step as Draft['step'], sentAt: v.sentAt, outcome: v.outcome as ReceiptOutcome, block: v.block as number | null }
}

const keyFor = (chain: ChainConfig, owner: string) => chainKey(RECEIPTS_KEY, chain.id, owner)

/**
 * How long a receipt is kept, from when it was sent: the receipts' age everywhere on the site (lib/browserCopies.ts,
 * 30 days; fix round 1). An older one is never shown, and lib/browserCopies.ts sweepCopies deletes it as the site opens;
 * forgetWallets deletes them all when a wallet is disconnected here.
 */
export const RECEIPTS_MAX_AGE_MS = KEPT_MAX_AGE_MS.receipts

/**
 * The owner's kept receipts on this chain, newest first; whatever does not check out is left out, and, given `now` (the
 * screen's), whatever is past RECEIPTS_MAX_AGE_MS or from the future.
 */
export function loadReceipts(store: KeyValueStore | null, chain: ChainConfig, owner: string, now?: number): ReceiptEntry[] {
  if (!ADDRESS.test(owner.toLowerCase())) return []
  const text = readScoped(store, keyFor(chain, owner))
  if (text === null || text.length > 64 * 1024) return []
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed.map(entryOf).filter((entry): entry is ReceiptEntry => entry !== null && entry.owner === owner.toLowerCase() && (now === undefined || (now - entry.sentAt <= RECEIPTS_MAX_AGE_MS && entry.sentAt - now <= 60_000))).slice(0, MAX_KEPT)
  } catch {
    return []
  }
}

function save(store: KeyValueStore | null, chain: ChainConfig, owner: string, entries: readonly ReceiptEntry[]): void {
  writeScoped(store, keyFor(chain, owner), JSON.stringify(entries.slice(0, MAX_KEPT)))
}

/**
 * How long the receipts list waits before it looks at its pending ones again, by how many looks found them still pending
 * (fix round 1, 2026-10-01): 6 s, 15 s, 30 s, then every 60 s, as the section's other reads back off. The list looked
 * every 6 s for as long as it was open, hidden or not, and could start a look before the last one ended.
 */
export const LOOK_AGAIN_MS: readonly number[] = [6_000, 15_000, 30_000, 60_000]
export const lookAgainAfter = (looks: number): number => LOOK_AGAIN_MS[Math.min(Math.max(0, Math.floor(looks)), LOOK_AGAIN_MS.length - 1)]

/** Keeps a transaction the wallet just returned, pending. */
export function keepSent(store: KeyValueStore | null, chain: ChainConfig, sent: SentTransaction): void {
  const owner = sent.owner.toLowerCase()
  const entry: ReceiptEntry = { hash: sent.hash.toLowerCase(), vault: sent.vault.toLowerCase(), owner, step: sent.step, sentAt: sent.sentAt, outcome: 'pending', block: null }
  save(store, chain, owner, [entry, ...loadReceipts(store, chain, owner).filter((kept) => kept.hash !== entry.hash)])
}

/** Records what became of a kept transaction. */
export function keepOutcome(store: KeyValueStore | null, chain: ChainConfig, owner: string, hash: string, outcome: ReceiptOutcome, block: number | null): void {
  const kept = loadReceipts(store, chain, owner)
  save(store, chain, owner.toLowerCase(), kept.map((entry) => (entry.hash === hash.toLowerCase() ? { ...entry, outcome, block } : entry)))
}

/**
 * One look at a pending transaction: his receipt route where it answers (it also checks the transaction is the one his
 * draft named), else the chain's receipt. Pending stays pending; nothing is ever sent.
 */
export async function lookReceipt(entry: ReceiptEntry, deps: { reader: ChainReader; api: V3Api | null; identity: Identity | null }, signal?: AbortSignal): Promise<{ outcome: ReceiptOutcome; block: number | null }> {
  if (deps.api && deps.identity) {
    try {
      const receipt = await deps.api.actions('receipt', { ...deps.identity, owner: entry.owner, vault: entry.vault, transactionHash: entry.hash }, deps.identity, signal)
      if (receipt.transactionHash !== entry.hash || receipt.owner !== entry.owner || receipt.vault !== entry.vault) return { outcome: 'pending', block: null }
      if (receipt.state === 'pending') return { outcome: 'pending', block: null }
      return { outcome: receipt.state, block: receipt.anchor?.number ?? null }
    } catch (error) {
      if (error instanceof ServiceError && error.kind === 'aborted') throw error
    }
  }
  const raw = (await deps.reader.call('eth_getTransactionReceipt', [entry.hash], signal)) as { status?: unknown; blockNumber?: unknown; transactionHash?: unknown } | null
  if (!raw) return { outcome: 'pending', block: null }
  if (typeof raw.transactionHash !== 'string' || raw.transactionHash.toLowerCase() !== entry.hash) return { outcome: 'pending', block: null }
  const block = typeof raw.blockNumber === 'string' && /^0x[0-9a-f]+$/i.test(raw.blockNumber) ? Number(BigInt(raw.blockNumber)) : null
  if (raw.status === '0x1') return { outcome: 'confirmed', block }
  if (raw.status === '0x0') return { outcome: 'reverted', block }
  return { outcome: 'pending', block: null }
}
