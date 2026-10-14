import { reopenClose, settleClose, type IncludedClose, type PendingClose } from '../../finance/v2/closeJournal'
import type { DirectClient } from '../../finance/v2/direct'
import type { V2Receipt } from '../../finance/v2/transact'
import { receiptFinality, recordConfirmedOperation, subscribeConfirmedOperations } from '../../lib/confirmedOperations'
import type { Hex } from '../../v2/types'
import { RECEIPT_FOLLOW } from '../journey/receiptFollow'
import { forgetLocalClose, LOCAL_RECEIPTS, recordLocalClose } from './localReceipts'

/** The money client's own read of a close: the sender's for the hash it sent, the recovery's for any other. */
export type CloseProof = () => Promise<{ receipt: V2Receipt; replaced: boolean; final: boolean }>

/**
 * The money client's own read of a close: the sender's for the hash it sent (`direct`), the recovery's for any other.
 * Changed on purpose 2026-10-14 (review of C3 on main): the recovery's without its description (`false`), which the hold
 * never uses: that read of the positions took the client's one-operation lock in the background (finance/v2/direct.ts).
 * Moved on purpose 2026-10-14 (second review of C3 on main) out of ./BulkClosePositions.tsx (its `proofOf`), unchanged, so
 * a test runs it (tests/v2/close-hold.test.mjs, tests/v2/close-many.test.mjs over the real client): the `false` lived in
 * the page's .tsx, which no test ran, and dropping it passed every test.
 */
export const closeProof = (row: PendingClose, hash: Hex, originalHash: Hex | null, direct: Pick<DirectClient, 'receipt'> | null, recover: DirectClient['recoverCloseMany']): CloseProof =>
  async () => {
    if (direct) return { receipt: await direct.receipt(hash), replaced: false, final: false }
    const result = await recover({ ...row, hash, originalHash: originalHash ?? undefined, tokenIds: row.tokenIds.map(BigInt) }, false)
    return { receipt: result.receipt, replaced: result.replaced, final: result.replacementFinal }
  }

/**
 * Added 2026-10-14 (second review of C3 on main): how long the money client's own read must miss a close, read after
 * read, before it has left its block. Its "pending" is no transaction, no receipt, or no block of that number on the
 * node that answers, and a wallet's load-balanced node that is only behind answers any of the three.
 */
const LEFT_BLOCK_MS = 60_000

/**
 * Added 2026-10-14 (incident C3: screens finish at inclusion). A close in a block is done, and the next group may start;
 * its intent waits among the included closes (../../finance/v2/closeJournal.ts) until the money client's own read says
 * it is final, then it is settled, as before. Robinhood Chain: that read is registered with the confirmation queue, which
 * runs it after its one read bound to the block once the chain's finalized mark has passed it (lib/confirmedOperations.ts;
 * nothing is asked of the node before). Base and Arbitrum One: the shared receipt follow, through the wallet
 * (../journey/receiptFollow.ts). A block that leaves the chain sends the close back to be checked ("Check status"), and
 * its local receipt goes; a reverted or replaced one is settled as before.
 *
 * Moved on purpose 2026-10-14 (C3 review) out of ./BulkClosePositions.tsx, unchanged, so a test runs this code itself on
 * Robinhood Chain (tests/v2/close-hold.test.mjs, over the page's own confirmation queue): the browser suite runs Close
 * positions on Base only, and the unit test wrote its own settlement.
 *
 * Changed on purpose 2026-10-14 (review of C3 on main): a close is held again whenever its hold has ended without a
 * settlement. The run kept every close it held in a set only a settlement emptied, so a hold that ended otherwise was
 * never made again in that page: a follow dropped (the wallet on another account at a tick, its hour, its 80 reads,
 * eight newer follows), a settlement the queue dropped (ten failed tries), or a close found in another block after its
 * own left the chain. Its positions then answered "This was already sent to your wallet" and it kept one of the
 * wallet's eight places until a reload. Base and Arbitrum One: the shared follow already ignores a close it still
 * follows, so it is simply asked again. Robinhood Chain: a close is skipped only while the queue still waits for its
 * block's proof; held again otherwise (the queue keeps a final proof and runs the settlement anew; its subscription is
 * one per close).
 *
 * Corrected on purpose 2026-10-14 (second review of C3 on main): on Robinhood Chain "the queue still waits for its
 * block's proof" includes a queue read that gave up (its eleventh try, lib/confirmedOperations.ts `again`), which leaves
 * the close 'included' with no read due. It is skipped at a review too, and on purpose: holding it again would start the
 * queue's read of the site's node anew (eleven more tries) at every review on that network, where the page asked it
 * eleven times in all. Its settlement stays registered: read-v6's own item saying final (no read) still releases it by
 * the money client's own read, and a reload holds it once more. Pinned by tests/v2/close-hold.test.mjs.
 *
 * `now`: the clock of "left its block" on Base and Arbitrum One (the shared follow's own, by default).
 */
export function createCloseHold(owner: string, now: () => number = () => Date.now()) {
  /** Robinhood Chain: the closes this run registered with the queue (by transaction), with their subscription's end. */
  const held = new Map<string, () => void>()
  return (row: IncludedClose, read: CloseProof, available: () => 'ready' | 'paused' | 'gone') => {
    const key = `${row.chainId}:${row.hash}`
    const reorged = () => { forgetLocalClose(owner, row.chainId, row.positionManager, row.hash); void reopenClose(row).catch(() => false) }
    const settled = async ({ receipt, replaced, final }: { receipt: V2Receipt; replaced: boolean; final: boolean }): Promise<boolean> => {
      if (replaced ? !final : receipt.state !== 'finalized' && receipt.state !== 'reverted') return false
      const local = LOCAL_RECEIPTS.get(owner).find((one) => one.chainId === row.chainId && one.hash.toLowerCase() === row.hash)
      if (replaced || receipt.state === 'reverted') forgetLocalClose(owner, row.chainId, row.positionManager, row.hash)
      else if (local && 'blockHash' in receipt && receipt.blockHash === local.blockHash) recordLocalClose({ ...local, state: 'finalized' })
      await settleClose(row)
      held.delete(key)
      return true
    }
    if (row.chainId === 4663) {
      // The queue still waits for this block's proof (its one read, then this settlement): nothing more to register.
      if (held.has(key) && receiptFinality(4663, row.hash, row.blockHash) === 'included') return
      held.get(key)?.()
      held.delete(key)
      const operation = recordConfirmedOperation({ chainId: 4663, wallet: owner, positionManager: row.positionManager, tokenIds: row.tokenIds,
        receipt: { transactionHash: row.hash, blockHash: row.blockHash, blockNumber: BigInt(row.block), state: 'included' },
        onFinalized: async () => settled(await read()) })
      if (operation?.phase !== 'included') return
      const stop = subscribeConfirmedOperations((next) => {
        if (next.chainId !== 4663 || next.hash !== row.hash || next.blockHash !== row.blockHash) return
        // Its block left the chain: the close found again in another block is held there (review of C3 on main).
        if (next.phase === 'reorged') { held.delete(key); reorged() }
        if (next.phase !== 'included') stop()
      })
      held.set(key, stop)
      return
    }
    let last: Awaited<ReturnType<typeof read>> | null = null
    /** When the first of the reads in a row that found the close in no block came; null after one that found it. */
    let missingSince: number | null = null
    RECEIPT_FOLLOW.follow(`close:${row.chainId}:${owner}:${row.hash}`, {
      read: async () => (last = await read()).receipt,
      available,
      accept(next) {
        if (!last || last.receipt !== next) return false
        // Changed on purpose 2026-10-14 (review of C3 on main): a close the money client's own read no longer finds in a
        // block has left its block and was put in no other: it goes back to "Check status", as a block that left the
        // chain does, where its replacement's hash can be named. It was followed for its hour and left among the included
        // closes for good, its positions held from every direct exit.
        // Changed on purpose 2026-10-14 (second review of C3 on main): only a lasting absence, every read missing it for a
        // minute (LEFT_BLOCK_MS). Two misses in a row were enough, 5 s apart at the follow's first reads, so a wallet's
        // node only behind sent a close that is in its block back to "Check status", and the next group's "Close 2
        // positions" met "This was already sent to your wallet". The wallet is asked nothing more: the follow reads until
        // final either way.
        if (next.state === 'pending') {
          missingSince ??= now()
          if (now() - missingSince < LEFT_BLOCK_MS) return false
          reorged()
          return true
        }
        missingSince = null
        if (next.state === 'reorged' || (!last.replaced && 'blockHash' in next && next.blockHash !== row.blockHash)) { reorged(); return true }
        const answer = last
        if (answer.replaced ? !answer.final : next.state !== 'finalized' && next.state !== 'reverted') return false
        void settled(answer).catch(() => undefined)
        return true
      },
    })
  }
}
