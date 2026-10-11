/** Public canonical evidence shared by the screens; it never sends or signs a transaction. */
import { confirmationReads, type ConfirmationRead } from './edge/confirmation'
import { notePositionConfirmation } from './positionEvidence'

export interface OperationScope {
  positionManager?: string
  tokenIds: readonly string[]
  vault?: string
  /** Historical activity changes finality only; it must not create a new balance/position barrier. */
  indexed?: true
}
export interface OperationReceipt {
  transactionHash?: string
  blockHash: string
  blockNumber: bigint
  state: 'included' | 'finalized'
  events?: readonly { address: string; eventName: string; args: Readonly<Record<string, unknown>> }[]
}
export interface ConfirmedOperation extends OperationScope {
  chainId: number
  wallet: string
  hash: string
  blockHash: string
  block: number
  phase: 'included' | 'finalized' | 'reorged'
  at: number
  events: readonly { address: string; eventName: string; args: Readonly<Record<string, unknown>> }[]
}
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const number = (v: unknown): number | null => {
  if (typeof v !== 'string' || !/^0x[0-9a-f]+$/i.test(v)) return null
  const n = Number(BigInt(v))
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}
const keyOf = (chainId: number, hash: string) => `${chainId}:${hash.toLowerCase()}`

export function createConfirmedOperations(read: ConfirmationRead, clock: {
  now: () => number
  set: (run: () => void, ms: number) => unknown
  clear: (timer: unknown) => void
  visible: () => boolean
}, publish: (operation: ConfirmedOperation) => void = () => undefined) {
  let snapshot: readonly ConfirmedOperation[] = Object.freeze([])
  const listeners = new Set<(operation: ConfirmedOperation) => void>()
  let timer: unknown = null
  let busy = false
  const nextReads = new Map<string, number>()
  const settlements = new Map<string, { run: () => Promise<boolean>; tries: number; next: number; until: number | null }>()
  const emit = (operation: ConfirmedOperation) => {
    const key = keyOf(operation.chainId, operation.hash)
    snapshot = Object.freeze([...snapshot.filter(old => keyOf(old.chainId, old.hash) !== key), Object.freeze(operation)].slice(-64))
    for (const old of nextReads.keys()) if (!snapshot.some(op => keyOf(op.chainId, op.hash) === old && op.phase === 'included')) nextReads.delete(old)
    for (const old of settlements.keys()) if (!snapshot.some(op => keyOf(op.chainId, op.hash) === old && op.phase !== 'reorged')) settlements.delete(old)
    publish(operation)
    for (const listener of listeners) listener(operation)
  }
  const schedule = (ms: number) => {
    if (timer !== null) clock.clear(timer)
    timer = clock.set(() => { timer = null; void tick() }, ms)
  }
  const pruneSettlements = () => {
    for (const [key, work] of settlements) {
      const operation = snapshot.find(op => keyOf(op.chainId, op.hash) === key)
      if (work.tries >= 10 || (work.until !== null && clock.now() >= work.until) || !operation || operation.phase === 'reorged' || (operation.phase === 'included' && clock.now() - operation.at >= 7 * 86400_000)) settlements.delete(key)
    }
  }
  async function tick() {
    if (busy) return
    pruneSettlements()
    const pending = snapshot.filter(op => op.phase === 'included' && op.chainId === 4663 && clock.now() - op.at < 7 * 86400_000)
    if (!clock.visible()) { if (pending.length || settlements.size) schedule(5000); return }
    const settling = [...settlements].filter(([key, work]) => work.next <= clock.now() && snapshot.some(op => keyOf(op.chainId, op.hash) === key && op.phase === 'finalized'))
    if (!pending.length && !settling.length) {
      if (settlements.size) schedule(2000)
      return
    }
    busy = true
    try {
      // One queue, four receipts per pass. All callers share the finalized-block read.
      for (const operation of pending.filter(op => (nextReads.get(keyOf(op.chainId, op.hash)) ?? 0) <= clock.now()).slice(0, 4)) {
        const key = keyOf(operation.chainId, operation.hash)
        const current = () => snapshot.find(op => keyOf(op.chainId, op.hash) === key) === operation
        const age = clock.now() - operation.at
        nextReads.set(key, clock.now() + (age < 45_000 ? 2000 : age < 600_000 ? 5000 : 30_000))
        try {
          const answer = await read.read(operation.hash)
          if (!current()) continue
          // Missing data can mean a lagging node. Only a contradictory canonical block proves a reorg.
          if (!object(answer.receipt) || !object(answer.block)) continue
          const receipt = answer.receipt
          const block = answer.block
          // A wallet batch may have a gas payer different from its owner. Its effect was already verified by
          // the closed financial client (or the bound activity item); finality belongs to this exact transaction.
          if (String(receipt.transactionHash).toLowerCase() !== operation.hash) continue
          if (number(receipt.blockNumber) !== operation.block || String(receipt.blockHash).toLowerCase() !== operation.blockHash) {
            // A new inclusion is not adopted without the financial client's effect checks.
            if (number(block.number) === number(receipt.blockNumber) && String(block.hash).toLowerCase() === String(receipt.blockHash).toLowerCase()) emit({ ...operation, phase: 'reorged' })
            continue
          }
          if (number(block.number) !== operation.block) continue
          if (String(block.hash).toLowerCase() !== operation.blockHash) { emit({ ...operation, phase: 'reorged' }); continue }
          if (receipt.status !== '0x1') continue
          const finalized = await read.finalized().catch(() => null)
          if (current() && object(finalized) && (number(finalized.number) ?? -1) >= operation.block) emit({ ...operation, phase: 'finalized' })
        } catch (error) {
          const delay = object(error) && typeof error.retryAfterMs === 'number' ? error.retryAfterMs : 5000
          nextReads.set(key, clock.now() + Math.max(2000, delay))
        }
      }
      for (const [key, work] of settling.slice(0, 2)) {
        if (settlements.get(key) !== work || !snapshot.some(op => keyOf(op.chainId, op.hash) === key && op.phase === 'finalized')) continue
        // Give the client's finality cleanup its retry window after final proof, including after tab sleep.
        work.until ??= clock.now() + 600_000
        if (work.tries >= 10 || clock.now() >= work.until) { settlements.delete(key); continue }
        work.tries++
        work.next = clock.now() + 5000
        try { if (await work.run() && settlements.get(key) === work) settlements.delete(key) } catch { /* Keep the client's journal until its own final proof succeeds. */ }
      }
    } finally {
      busy = false
      pruneSettlements()
      if (settlements.size || snapshot.some(op => op.phase === 'included' && op.chainId === 4663 && clock.now() - op.at < 7 * 86400_000)) schedule(2000)
    }
  }
  return {
    get: () => snapshot,
    subscribe(listener: (operation: ConfirmedOperation) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    /** Only a financial client's explicit canonical contradiction may invalidate its already checked inclusion. */
    reorg(input: { chainId: number; wallet: string; hash: string; blockHash: string }): boolean {
      const operation = snapshot.find(op => op.chainId === input.chainId && op.hash === input.hash.toLowerCase()
        && op.wallet === input.wallet.toLowerCase() && op.blockHash === input.blockHash.toLowerCase())
      if (!operation || operation.phase === 'reorged') return false
      emit({ ...operation, phase: 'reorged' })
      return true
    },
    record(input: OperationScope & { chainId: number; wallet: string; receipt: OperationReceipt; onFinalized?: () => Promise<boolean> }): ConfirmedOperation | null {
      const hash = input.receipt.transactionHash?.toLowerCase()
      const wallet = input.wallet.toLowerCase()
      const blockHash = input.receipt.blockHash.toLowerCase()
      const block = Number(input.receipt.blockNumber)
      if (!hash || !HASH.test(hash) || !ADDRESS.test(wallet) || !HASH.test(blockHash) || !Number.isSafeInteger(block) || block <= 0) return null
      const old = snapshot.find(op => keyOf(op.chainId, op.hash) === keyOf(input.chainId, hash))
      if (input.indexed && old) {
        // The validated index may complete the exact inclusion already checked by the financial client.
        // It cannot replace its owner/scope, adopt another block, revive a reorg or downgrade final proof.
        if (old.wallet !== wallet || old.blockHash !== blockHash || old.block !== block
          || old.phase !== 'included' || input.receipt.state !== 'finalized') return old
        const finalized: ConfirmedOperation = { ...old, phase: 'finalized' }
        emit(finalized)
        return finalized
      }
      const phase = old?.blockHash === blockHash && old.phase === 'finalized' ? 'finalized' : input.receipt.state
      const operation: ConfirmedOperation = { chainId: input.chainId, wallet, hash, blockHash, block, phase, at: old?.at ?? clock.now(), positionManager: input.positionManager?.toLowerCase(), tokenIds: Object.freeze([...input.tokenIds]), vault: input.vault?.toLowerCase(), events: input.receipt.events ?? [], ...(input.indexed ? { indexed: true } : {}) }
      if (input.chainId === 4663 && input.onFinalized) settlements.set(keyOf(input.chainId, hash), { run: input.onFinalized, tries: 0, next: 0, until: null })
      emit(operation)
      if (input.chainId === 4663 && (operation.phase === 'included' || input.onFinalized)) schedule(0)
      return operation
    },
    wake() { if (!busy) { nextReads.clear(); schedule(0) } },
    finality(chainId: number, hash: string, blockHash: string) {
      return snapshot.find(op => op.chainId === chainId && op.hash === hash.toLowerCase() && op.blockHash === blockHash.toLowerCase())?.phase ?? null
    },
  }
}

const operations = createConfirmedOperations(confirmationReads, {
  now: () => Date.now(), set: (run, ms) => setTimeout(run, ms), clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>), visible: () => typeof document === 'undefined' || !document.hidden,
}, operation => { if (!operation.indexed) notePositionConfirmation({ kind: 'confirmed', chainId: operation.chainId, wallet: operation.wallet, positionManager: operation.positionManager, tokenIds: operation.tokenIds, block: operation.phase === 'reorged' ? undefined : operation.block, blockHash: operation.blockHash }) })
export const recordConfirmedOperation = operations.record
export const reorgConfirmedOperation = operations.reorg
export const subscribeConfirmedOperations = operations.subscribe
export const confirmedOperationState = operations.get
export const receiptFinality = operations.finality
if (typeof window !== 'undefined') {
  const wake = () => { if (!document.hidden) operations.wake() }
  window.addEventListener('focus', wake)
  window.addEventListener('online', wake)
  document.addEventListener('visibilitychange', wake)
}
