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

/**
 * Changed on purpose 2026-10-14 (incident C2: the 429 on /api/chain/v1/confirmation of 2026-10-13). The queue asked the
 * node about every included Robinhood receipt by the clock (every 2 s, then 5 s, then 30 s, for seven days), and about
 * every receipt read-v6 merely listed: about 470 node POSTs per receipt per tab, restarted by each reload and each
 * `focus`. A block is final about 16 minutes after it (measured), so nearly all of those could only answer "not yet".
 * Now nothing is read by the clock:
 *   - what read-v6 lists and this browser did not send is never read from the node (its own `tx.finality` says it);
 *   - an operation this browser sent turns final by read-v6's own item of the same transaction, block and hash (no
 *     read), or by ONE read bound to its recorded block, made once the chain's finalized mark has passed that block.
 *     The mark rides in every portfolio and activity answer the page already holds (`noteChainFinality`): a hint that
 *     says when to read, never a proof. The proof is what it was: this transaction, in this block, the canonical block
 *     of that number, success, and the node's own finalized block at or past it; another block there is `reorged`;
 *   - a settlement (a financial client's own release at finality) runs after that proof with its own read and its own
 *     bounded window, as before. With the mark null or frozen, an operation that holds one asks the node's finalized
 *     block from forty minutes old, once a minute for everything waiting.
 *
 * `INDEX_TURN_MS`: read-v6's activity head is read again every 60 s, so an item it lists says "final" within that of the
 * mark; the queue's own read waits that long, and what the index lists then costs the node nothing.
 */
const INDEX_TURN_MS = 75_000
/** A read that proved nothing is tried again after 5, 10, 20, 40, then 60 s (the route's own wait when longer), ten times at most. */
const RETRY_MS = 5_000
const RETRY_MAX_MS = 60_000
const RETRIES = 10
/** The fallback's age (about twice Robinhood Chain's finality), its pace, and its end: a day after inclusion. */
const FALLBACK_AGE_MS = 40 * 60_000
const FALLBACK_EVERY_MS = 60_000
const FALLBACK_END_MS = 86400_000

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
  /** An own included operation's one read: when it may run (null: the mark has not reached its block), its failed tries, and whether it gave up. */
  const reads = new Map<string, { due: number | null; tries: number; over: boolean }>()
  const settlements = new Map<string, { run: () => Promise<boolean>; tries: number; next: number; until: number | null }>()
  /** The highest finalized block heard per chain. */
  const marks = new Map<number, number>()
  /** When the fallback last asked the node's finalized block. */
  let asked = Number.NEGATIVE_INFINITY
  const emit = (operation: ConfirmedOperation) => {
    const key = keyOf(operation.chainId, operation.hash)
    snapshot = Object.freeze([...snapshot.filter(old => keyOf(old.chainId, old.hash) !== key), Object.freeze(operation)].slice(-64))
    for (const old of reads.keys()) if (!snapshot.some(op => keyOf(op.chainId, op.hash) === old && op.phase === 'included')) reads.delete(old)
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
      // The seven days drop a callback whose operation never turned final here; they schedule nothing.
      if (work.tries >= 10 || (work.until !== null && clock.now() >= work.until) || !operation || operation.phase === 'reorged' || (operation.phase === 'included' && clock.now() - operation.at >= 7 * 86400_000)) settlements.delete(key)
    }
  }
  /** Whether the fallback speaks for this operation: its block not reached by any mark, a settlement to release, under a day old. */
  const waiting = (operation: ConfirmedOperation, key: string) => {
    const entry = reads.get(key)
    return !!entry && entry.due === null && !entry.over && settlements.has(key) && clock.now() - operation.at < FALLBACK_END_MS
  }
  /** When the next pass has something to do; null when nothing does, and then no timer runs. */
  const nextAt = (): number | null => {
    let at = Number.POSITIVE_INFINITY
    for (const operation of snapshot) {
      const key = keyOf(operation.chainId, operation.hash)
      const entry = reads.get(key)
      if (entry && entry.due !== null) at = Math.min(at, entry.due)
      else if (waiting(operation, key)) at = Math.min(at, Math.max(operation.at + FALLBACK_AGE_MS, asked + FALLBACK_EVERY_MS))
      const work = settlements.get(key)
      if (work && operation.phase === 'finalized') at = Math.min(at, work.next)
    }
    return at === Number.POSITIVE_INFINITY ? null : at
  }
  const plan = () => {
    const at = nextAt()
    if (at !== null) schedule(Math.max(0, at - clock.now()))
    else if (timer !== null) { clock.clear(timer); timer = null }
  }
  /** The mark is at or past this operation's block: its one read falls due after `wait`. */
  const arm = (operation: ConfirmedOperation, wait: number) => {
    const entry = reads.get(keyOf(operation.chainId, operation.hash))
    if (entry && entry.due === null && !entry.over && (marks.get(operation.chainId) ?? 0) >= operation.block) entry.due = clock.now() + wait
  }
  const note = (chainId: number, block: number, wait: number): boolean => {
    if (!Number.isSafeInteger(chainId) || !Number.isSafeInteger(block) || block <= (marks.get(chainId) ?? 0) || (!marks.has(chainId) && marks.size >= 8)) return false
    marks.set(chainId, block)
    for (const operation of snapshot) if (operation.chainId === chainId) arm(operation, wait)
    return true
  }
  /** A try that proved nothing: the next one is further away each time, never nearer than 5 s, and the eleventh is the last. */
  const again = (entry: { due: number | null; tries: number; over: boolean }, named = 0) => {
    if (++entry.tries > RETRIES) { entry.due = null; entry.over = true; return }
    entry.due = clock.now() + Math.max(Math.min(RETRY_MS * 2 ** (entry.tries - 1), RETRY_MAX_MS), named)
  }
  async function tick() {
    if (busy) return
    pruneSettlements()
    if (!clock.visible()) { if (nextAt() !== null) schedule(5000); return }
    busy = true
    try {
      // A settlement runs on the pass after its operation's proof, never in the pass that proved it.
      const settling = [...settlements].filter(([key, work]) => work.next <= clock.now() && snapshot.some(op => keyOf(op.chainId, op.hash) === key && op.phase === 'finalized'))
      // One finalized-block read per pass, shared by the fallback and by every receipt read in it.
      let final: Promise<number | null> | null = null
      const finalized = () => final ??= read.finalized().then(value => object(value) ? number(value.number) : null, () => null)
      const stale = snapshot.filter(op => waiting(op, keyOf(op.chainId, op.hash)) && clock.now() - op.at >= FALLBACK_AGE_MS)
      if (stale.length && clock.now() - asked >= FALLBACK_EVERY_MS) {
        asked = clock.now()
        // The node's own finalized block is the best mark there is: what it has passed is read in this same pass.
        const block = await finalized()
        if (block !== null) note(stale[0].chainId, block, 0)
      }
      // One queue, four receipts per pass.
      const due = snapshot.filter(op => { const entry = reads.get(keyOf(op.chainId, op.hash)); return op.phase === 'included' && !!entry && entry.due !== null && entry.due <= clock.now() })
      for (const operation of due.slice(0, 4)) {
        const key = keyOf(operation.chainId, operation.hash)
        const entry = reads.get(key)
        // A newer word from the financial client replaces both the operation and its read.
        const current = () => snapshot.find(op => keyOf(op.chainId, op.hash) === key) === operation && reads.get(key) === entry
        // The index, or the client, may have spoken while an earlier read of this pass was in flight: then nothing is asked.
        if (!entry || entry.due === null || !current()) continue
        try {
          const answer = await read.read(operation.hash)
          if (!current()) continue
          // Missing data can mean a lagging node. Only a contradictory canonical block proves a reorg.
          if (!object(answer.receipt) || !object(answer.block)) { again(entry); continue }
          const receipt = answer.receipt
          const block = answer.block
          // A wallet batch may have a gas payer different from its owner. Its effect was already verified by
          // the closed financial client (or the bound activity item); finality belongs to this exact transaction.
          if (String(receipt.transactionHash).toLowerCase() !== operation.hash) { again(entry); continue }
          if (number(receipt.blockNumber) !== operation.block || String(receipt.blockHash).toLowerCase() !== operation.blockHash) {
            // A new inclusion is not adopted without the financial client's effect checks.
            if (number(block.number) === number(receipt.blockNumber) && String(block.hash).toLowerCase() === String(receipt.blockHash).toLowerCase()) emit({ ...operation, phase: 'reorged' })
            else again(entry)
            continue
          }
          if (number(block.number) !== operation.block) { again(entry); continue }
          if (String(block.hash).toLowerCase() !== operation.blockHash) { emit({ ...operation, phase: 'reorged' }); continue }
          if (receipt.status !== '0x1') { again(entry); continue }
          const through = await finalized()
          if (!current()) continue
          if (through !== null && through >= operation.block) emit({ ...operation, phase: 'finalized' })
          else again(entry)
        } catch (error) {
          // No wait named (`retryAfterMs: 0`, or none) is no hint: the step's own wait stands.
          if (current()) again(entry, object(error) && typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : 0)
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
      plan()
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
      plan()
      return true
    },
    record(input: OperationScope & { chainId: number; wallet: string; receipt: OperationReceipt; onFinalized?: () => Promise<boolean> }): ConfirmedOperation | null {
      const hash = input.receipt.transactionHash?.toLowerCase()
      const wallet = input.wallet.toLowerCase()
      const blockHash = input.receipt.blockHash.toLowerCase()
      const block = Number(input.receipt.blockNumber)
      if (!hash || !HASH.test(hash) || !ADDRESS.test(wallet) || !HASH.test(blockHash) || !Number.isSafeInteger(block) || block <= 0) return null
      const key = keyOf(input.chainId, hash)
      const old = snapshot.find(op => keyOf(op.chainId, op.hash) === key)
      if (input.indexed && old) {
        // The validated index may complete the exact inclusion already checked by the financial client.
        // It cannot replace its owner/scope, adopt another block, revive a reorg or downgrade final proof.
        if (old.wallet !== wallet || old.blockHash !== blockHash || old.block !== block
          || old.phase !== 'included' || input.receipt.state !== 'finalized') return old
        const finalized: ConfirmedOperation = { ...old, phase: 'finalized' }
        emit(finalized)
        // Its settlement, when it holds one, is due now; no timer was running for an operation that only waited.
        plan()
        return finalized
      }
      const phase = old?.blockHash === blockHash && old.phase === 'finalized' ? 'finalized' : input.receipt.state
      const operation: ConfirmedOperation = { chainId: input.chainId, wallet, hash, blockHash, block, phase, at: old?.at ?? clock.now(), positionManager: input.positionManager?.toLowerCase(), tokenIds: Object.freeze([...input.tokenIds]), vault: input.vault?.toLowerCase(), events: input.receipt.events ?? [], ...(input.indexed ? { indexed: true } : {}) }
      if (input.chainId === 4663 && input.onFinalized) settlements.set(key, { run: input.onFinalized, tries: 0, next: 0, until: null })
      // The financial client's word starts this inclusion's one read anew. What the index merely listed has none.
      if (input.chainId === 4663 && phase === 'included' && !input.indexed) reads.set(key, { due: null, tries: 0, over: false })
      else reads.delete(key)
      emit(operation)
      arm(operation, INDEX_TURN_MS)
      plan()
      return operation
    },
    /**
     * The chain's finalized block as an answer the page already holds names it (read-v6's `finalizedThrough`). A hint: it
     * decides when an own operation's one read is made and finalizes nothing by itself.
     */
    noteChainFinality(chainId: number, block: number): void { if (note(chainId, block, INDEX_TURN_MS)) plan() },
    /** A pass now, for what is due now. It clears no wait: a `focus` (a wallet popup closing) reads nothing sooner. */
    wake() { if (!busy) schedule(0) },
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
export const noteChainFinality = operations.noteChainFinality
/** Each chain's finalized mark from a read-v6 answer (portfolio or activity) the page already holds: no request is made for it. */
export function noteAnswerFinality(chains: readonly { chainId: number; finalizedThrough: { number: number } | null }[]): void {
  for (const chain of chains) if (chain.finalizedThrough) noteChainFinality(chain.chainId, chain.finalizedThrough.number)
}
if (typeof window !== 'undefined') {
  const wake = () => { if (!document.hidden) operations.wake() }
  window.addEventListener('focus', wake)
  window.addEventListener('online', wake)
  document.addEventListener('visibilitychange', wake)
}
