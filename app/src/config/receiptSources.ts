/**
 * Added 2026-10-15 (pack 8, incident package C5: no chain literal on the receipt path). Here and not in src/v2 (where the
 * design put it): the confirmation queue (lib/confirmedOperations.ts) is a V1 module, and no V1 module imports a V2 one
 * statically (tests/session.source-guard.test.mjs); like ./chainIdentity.ts, whose ids it takes, it holds data only.
 * One row per chain says who reads
 * whether a transaction this page sent is in a block, in which order, and who makes the one read at finality. Every
 * money client, every wait and the confirmation queue (lib/confirmedOperations.ts) ask this table; none of them names a
 * chain. Until this table the receipt path tested `chainId === 4663` (or `!== 4663`) in a dozen places, and Base and
 * Arbitrum One followed their own receipts through the wallet until final, about 50 reads in the twenty minutes a block
 * takes to be final there (v2in/journey/receiptFollow.ts: every 5 s, then 15 s, then 30 s, up to 80 reads an hour).
 *
 *   - `edge`: the site's own node, through the confirmation route at our edge (functions/_lib/confirmation.ts,
 *     lib/edge/confirmation.ts). Only Robinhood Chain has one; the person's wallet is its second source, read-only,
 *     after two missed reads of the same hash (the owner's decision D2, finance/v2/transact.ts WALLET_SECOND_SOURCE).
 *   - `wallet`: the person's own wallet, read-only, through the money client that sent the transaction.
 *
 * Finality, on every chain: the chain's finalized mark as read-v6 already names it (`finalizedThrough`, no request) says
 * when the one read may be made; an item read-v6 lists as final needs no read at all. Without a mark, the operation's age
 * (`finalAfterMs`) says it. The read itself is the edge's (the queue's own, then the money client's settlement) or the
 * money client's own read through the wallet, which keeps its checks of a block that left the chain or of a transaction
 * found in another block.
 *
 * A chain's readers change here and nowhere else. `inclusion: ['wallet']` on Robinhood Chain would take the edge out of
 * its receipts (the strict reading of decision D1); the order "wallet first, edge second" would need a second source on
 * the wallet path, which does not exist today.
 */
import { ARBITRUM_ID, BASE_ID, ROBINHOOD_ID } from './chainIdentity'

export type ReceiptReader = 'edge' | 'wallet'

export interface ReceiptSources {
  /** Who is asked whether a sent transaction is in a block, first source first. */
  readonly inclusion: readonly ReceiptReader[]
  /** Who makes the one read at finality, bound to the recorded block. */
  readonly finality: ReceiptReader
  /**
   * With no finalized mark from read-v6, how old an operation must be before that read is made: about twice the chain's
   * finality on Robinhood Chain (16 minutes measured 2026-10-13; the queue's frozen-mark fallback, unchanged), and on
   * Base and Arbitrum One a little over their usual time to finality (the L1 batch and its two finalized epochs).
   */
  readonly finalAfterMs: number
  /** Who simulates a batch before it is offered: the site's qualified simulator on its own node, or the wallet's eth_simulateV1. */
  readonly simulation: ReceiptReader
}

const MINUTE = 60_000

const SOURCES: ReadonlyMap<number, ReceiptSources> = new Map<number, ReceiptSources>([
  [ROBINHOOD_ID, Object.freeze({ inclusion: Object.freeze(['edge', 'wallet'] as const), finality: 'edge', finalAfterMs: 40 * MINUTE, simulation: 'edge' })],
  [BASE_ID, Object.freeze({ inclusion: Object.freeze(['wallet'] as const), finality: 'wallet', finalAfterMs: 20 * MINUTE, simulation: 'wallet' })],
  [ARBITRUM_ID, Object.freeze({ inclusion: Object.freeze(['wallet'] as const), finality: 'wallet', finalAfterMs: 20 * MINUTE, simulation: 'wallet' })],
])

/** A chain the table does not know is read through the wallet alone: the site's edge never reads a chain it does not serve. */
const UNKNOWN: ReceiptSources = Object.freeze({ inclusion: Object.freeze(['wallet'] as const), finality: 'wallet', finalAfterMs: 20 * MINUTE, simulation: 'wallet' })

export function receiptSources(chainId: number): ReceiptSources {
  return SOURCES.get(chainId) ?? UNKNOWN
}

/** Whether the site's edge is the first reader of this chain's receipts (the wallet then only its second source). */
export const edgeReadsReceipts = (chainId: number): boolean => receiptSources(chainId).inclusion[0] === 'edge'

/** Whether the money client's own read through the wallet is this chain's read at finality. */
export const walletReadsFinality = (chainId: number): boolean => receiptSources(chainId).finality === 'wallet'

/** Whether a batch is simulated by the site's qualified simulator on its own node. */
export const edgeSimulates = (chainId: number): boolean => receiptSources(chainId).simulation === 'edge'
