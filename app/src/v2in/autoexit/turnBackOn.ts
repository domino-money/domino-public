import { triggerReached, type AutoExitClient } from '../../finance/v2/autoExit'
import type { Dex, Hex } from '../../v2/types'
import type { ExitTriggers } from './card'

/**
 * Turning a paused Auto-exit back on, by its module (after Leave automation) or by its position's approval (after a change
 * made outside it), puts the order the owner signed back in force as it is. Added 2026-10-06 (the integration review,
 * money #4): the module has no latch, so an end of the range the price crossed while it was paused closes the position on
 * Domino's next pass, at the price of the moment, with the 0.2% fee. The pool's own price is read first, as Auto-exit's
 * dialog reads it (./MandateDialog.tsx, finance/v2/autoExit.ts readPoolPrice), and an end it has reached is said before
 * the wallet opens, with a tick to go on anyway and "Turn off instead": turned off, then on again, Auto-exit arms only the
 * ends still ahead. Reads only.
 */

/** What the check reads through: the automation session's auto-exit client (../automate/session.tsx). */
export interface EdgeReader {
  autoExit: Pick<AutoExitClient, 'readPoolPrice' | 'status'>
}

/** The code a press stops with when the price reached an end since the dialog opened: said by the warning, never as an error. */
export const EDGE_PASSED = 'exit_edge_passed'

/**
 * Whether the pool's price has reached an end the order arms: at or below its lower one, at or above its upper one (the
 * module's own rule, finance/v2/autoExit.ts triggerReached). `triggers`: the order's ends as listed, or as registered on
 * this page; null when unread, and then its own record on chain says them (an order no longer active passes nothing).
 * The caller runs it in the session's queue.
 */
export async function edgePassed(reader: EdgeReader, order: { id: Hex; triggers: ExitTriggers | null }, dex: Dex, tokenId: bigint): Promise<boolean> {
  let ends = order.triggers ? { triggerBelowSqrtPriceX96: order.triggers.below, triggerAboveSqrtPriceX96: order.triggers.above } : null
  if (!ends) {
    const status = await reader.autoExit.status(order.id)
    if (status.status !== 'active' || !status.record) return false
    ends = { triggerBelowSqrtPriceX96: status.record.triggerBelowSqrtPriceX96, triggerAboveSqrtPriceX96: status.record.triggerAboveSqrtPriceX96 }
  }
  const { sqrtPriceX96 } = await reader.autoExit.readPoolPrice(dex, tokenId)
  return triggerReached(ends, sqrtPriceX96)
}

/** The warning, said before the wallet opens. */
export const PAST_EDGE_TEXT = "The price is already past the end of your range. Turning Auto-exit back on closes this position at today's price, with the 0.2% fee."
/** The tick that lets the person go on anyway. */
export const PAST_EDGE_ACK = 'Turn it back on anyway'
/** The other way: Auto-exit turned off, then on again from its card, at the ends still ahead. */
export const TURN_OFF_INSTEAD = 'Turn off instead'
