import type { Hex } from 'viem'
import { sequenceReceiptReadRetryable, type createSequenceClient } from './sequence.js'

type Client = Pick<ReturnType<typeof createSequenceClient>, 'receipt'>
type Receipt = Awaited<ReturnType<Client['receipt']>>['state']
export const RECEIPT_WAIT_MS = 240_000
export const RECEIPT_EVERY_MS = 3_000
const SETTLED: readonly Receipt[] = ['confirming', 'finalized', 'reverted', 'reorged', 'over_budget', 'over_budget_finalized', 'replaced']
const realTime = { now: () => performance.now(), wait: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }

/** Poll the same already-sent hash. Only normalized receipt transport failures
 * recover; identity, malformed responses and execution failures stay closed.
 * This interface has no send or signing operation.
 *
 * `replaced` (2026-10-01, audit C14): the wallet replaced the step ("Speed up"
 * or "Cancel"; ./sequence.ts receipt), said as soon as it is known instead of
 * after the whole wait. The caller reads the vault again to know whether the
 * step happened; nothing is sent again. */
export async function settleStep(client: Client, hash: Hex, here: () => boolean, time = realTime): Promise<'landed' | 'left' | 'replaced'> {
  let state: Receipt = 'pending'
  let unread: unknown
  const until = time.now() + RECEIPT_WAIT_MS
  while (time.now() < until && !SETTLED.includes(state)) {
    if (!here()) return 'left'
    await time.wait(Math.min(RECEIPT_EVERY_MS, until - time.now()))
    if (!here()) return 'left'
    if (time.now() >= until) break
    try { state = (await client.receipt(hash)).state; unread = undefined }
    catch (error) {
      if (!here()) return 'left'
      if (!sequenceReceiptReadRetryable(error)) throw error
      unread = error
    }
    if (!here()) return 'left'
  }
  // An unavailable receipt does not prove the transaction is still pending.
  if (!SETTLED.includes(state)) throw unread ?? new Error('sequence_receipt_waiting')
  if (state === 'reverted') throw new Error('sequence_step_reverted')
  if (state === 'reorged') throw new Error('sequence_step_reorged')
  if (state === 'replaced') return 'replaced'
  return 'landed'
}
