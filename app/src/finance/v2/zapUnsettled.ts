import { keccak256, stringToHex, type Address, type Hex } from 'viem'

/**
 * S1 actions handed to the wallet whose final outcome is not known yet, per owner and chain (Domino V2 rev2 review, F3).
 * Added on purpose (data) 2026-10-02. The zap client's other latches are keyed by ONE plan (its intentHash): a batch
 * timed out while still queued in the wallet, and a fresh review of the same action, would be two prompts and two
 * positions; an unconfirmed EIP-5792 batch moves no nonce, so the nonce latch does not see it either. This record is
 * owner-wide: written when an action (a step, or a batch) is handed to the wallet, kept until the chain settles it
 * (finance/v2/zap.ts settleHeld: its receipt, the wallet's final batch status, its PositionLiquidityChanged by
 * intentHash, its nonce taken, or its deadline passed), or the person says, while the chain shows nothing pending,
 * that they rejected it in the wallet (V1's "I rejected it in my wallet"). Until then no zap action is reviewed or sent
 * on that chain for that owner.
 *
 * The pattern of finance/v2/crosschain.ts UnsettledStore: public data only (no amount, no calldata, no key), a hashed
 * storage name, each entry checked closed on read-back, in this page's memory and in localStorage where the browser keeps
 * it, so a reload keeps the hold.
 */
export interface UnsettledAction {
  chainId: number
  /** The zap the action went to: its PositionLiquidityChanged carries the intentHash as the first indexed topic. */
  zap: Address
  intentHash: Hex
  /** The block the review read at (decimal): the action's logs are looked up from it. */
  fromBlock: string
  /** The intent's deadline, unix seconds (decimal): once a block is past it, the action can never run (PlanExpired). */
  deadline: string
  kind: 'step' | 'batch'
  /** The transaction hash the wallet returned for a step, or null. */
  hash: Hex | null
  /** The wallet's id for a batch (EIP-5792), or null. */
  batchId: string | null
  /** The nonce a step was offered with (decimal), or null for a batch. */
  nonce: string | null
  /** When it was handed to the wallet, unix seconds. */
  at: number
}

export interface UnsettledActions {
  /** The actions held for this owner on this chain. */
  list(chainId: number, owner: string): readonly UnsettledAction[]
  /** Adds the action, or replaces the one held with the same intentHash. */
  put(owner: string, action: UnsettledAction): void
  drop(chainId: number, owner: string, intentHash: Hex): void
}

interface StoragePort {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const ZAP_UNSETTLED_PREFIX = 'domino.v2.zap-unsettled.v1.'
const FIELDS = ['chainId', 'zap', 'intentHash', 'fromBlock', 'deadline', 'kind', 'hash', 'batchId', 'nonce', 'at'] as const
/** At most this many held per owner and chain: a new one is refused before then, so more only come from a race. */
const MAX_HELD = 8
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/
const fail = (code: string): never => {
  throw new Error(code)
}

/** The storage name for an owner on a chain: hashed, so no address is written in a key. */
export function zapUnsettledKey(chainId: number, owner: string): string {
  const who = owner.toLowerCase()
  if (!Number.isSafeInteger(chainId) || chainId < 1 || !ADDRESS.test(who)) return fail('invalid_journal_key')
  return ZAP_UNSETTLED_PREFIX + keccak256(stringToHex(`zap-unsettled|${chainId}|${who}`)).slice(2)
}

/** A closed check of an entry read back: exactly the ten fields, each in its only shape. */
export function isUnsettledAction(value: unknown): value is UnsettledAction {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  const keys = Object.keys(entry)
  if (keys.length !== FIELDS.length || !FIELDS.every((key) => Object.hasOwn(entry, key))) return false
  return (
    typeof entry.chainId === 'number' && Number.isSafeInteger(entry.chainId) && entry.chainId >= 1 &&
    typeof entry.zap === 'string' && ADDRESS.test(entry.zap) &&
    typeof entry.intentHash === 'string' && HASH.test(entry.intentHash) &&
    typeof entry.fromBlock === 'string' && DECIMAL.test(entry.fromBlock) &&
    typeof entry.deadline === 'string' && DECIMAL.test(entry.deadline) &&
    (entry.kind === 'step' || entry.kind === 'batch') &&
    (entry.hash === null || (typeof entry.hash === 'string' && HASH.test(entry.hash))) &&
    (entry.batchId === null || (typeof entry.batchId === 'string' && entry.batchId.length > 0 && entry.batchId.length <= 512 && /^[\x21-\x7e]+$/.test(entry.batchId))) &&
    (entry.nonce === null || (typeof entry.nonce === 'string' && DECIMAL.test(entry.nonce))) &&
    typeof entry.at === 'number' && Number.isSafeInteger(entry.at) && entry.at >= 0
  )
}

/**
 * The held actions, in `storage` where it allows (so every tab of the page, and the page after a reload, sees what any of
 * them holds: storage is read first, every time) and in this page's memory. Where storage refuses a write, or cannot be
 * read, this page's memory still holds what it put: a refusing storage never loses a hold for this page.
 */
export function createUnsettledActions(storage: StoragePort | null): UnsettledActions {
  const memory = new Map<string, UnsettledAction[]>()
  /** Keys whose last write storage refused: this page's memory holds more than storage does. */
  const unsynced = new Set<string>()
  const stored = (key: string): UnsettledAction[] | null => {
    if (!storage) return null
    try {
      const raw = storage.getItem(key)
      const value = raw === null ? [] : (JSON.parse(raw) as unknown)
      return Array.isArray(value) ? value.filter(isUnsettledAction) : []
    } catch {
      return null
    }
  }
  const read = (key: string): UnsettledAction[] => {
    const shared = stored(key)
    const mine = memory.get(key) ?? []
    if (shared === null) return mine
    if (!unsynced.has(key)) return shared
    return [...mine, ...shared.filter((entry) => !mine.some((own) => own.intentHash === entry.intentHash))]
  }
  const write = (key: string, actions: UnsettledAction[]) => {
    memory.set(key, actions)
    if (!storage) return
    try {
      if (actions.length === 0) storage.removeItem(key)
      else storage.setItem(key, JSON.stringify(actions.map((a) => Object.fromEntries(FIELDS.map((field) => [field, a[field]])))))
      unsynced.delete(key)
    } catch {
      // Held in this page's memory; a reload will not find it.
      unsynced.add(key)
    }
  }
  return {
    list: (chainId, owner) => Object.freeze(read(zapUnsettledKey(chainId, owner)).filter((a) => a.chainId === chainId).map((a) => Object.freeze({ ...a }))),
    put(owner, action) {
      if (!isUnsettledAction(action)) fail('invalid_unsettled_action')
      const key = zapUnsettledKey(action.chainId, owner)
      write(key, [action, ...read(key).filter((a) => a.intentHash !== action.intentHash)].slice(0, MAX_HELD))
    },
    drop(chainId, owner, intentHash) {
      const key = zapUnsettledKey(chainId, owner)
      const all = read(key)
      const kept = all.filter((a) => a.intentHash !== intentHash.toLowerCase())
      if (kept.length !== all.length) write(key, kept)
    },
  }
}

let shared: UnsettledActions | null = null
/**
 * The page's one store of held S1 actions: in localStorage where the browser keeps it, in the page's memory otherwise
 * (one store for every client of the page). Outside a browser (node), a store of its own for each caller.
 */
export function browserUnsettledActions(): UnsettledActions {
  if (typeof window === 'undefined') return createUnsettledActions(null)
  if (shared) return shared
  let storage: StoragePort | null = null
  try {
    storage = window.localStorage ?? null
  } catch {
    storage = null
  }
  shared = createUnsettledActions(storage)
  return shared
}
