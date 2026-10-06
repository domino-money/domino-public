import type { WalletPosition } from '../../lib/walletPositions'
import type { TokenMeta } from '../automate/tokens'

/** The position page's existing read, never an independent request or a made-up price. */
export interface ExitPriceSnapshot {
  sqrtPriceX96: string | null
  block: number | null
  saved: boolean
}

/** Price belongs to the position read, not to whether an order can currently be offered. */
export function positionExitPrice(position: Pick<WalletPosition, 'sqrtPriceX96'> | null, context: Pick<ExitPriceSnapshot, 'block' | 'saved'> | null | undefined): ExitPriceSnapshot | null {
  if (!position?.sqrtPriceX96) return null
  return { sqrtPriceX96: position.sqrtPriceX96, block: context?.block ?? null, saved: context?.saved ?? true }
}

/** Fill missing metadata only from the same token address. Zero decimals is a real value. */
export function exitTokenMeta(page: TokenMeta | null, index: TokenMeta | null): TokenMeta | null {
  if (!page) return index
  if (!index || page.address.toLowerCase() !== index.address.toLowerCase()) return page
  return { ...page, symbol: page.symbol ?? index.symbol, decimals: page.decimals ?? index.decimals }
}

/** The page's sqrt price as a number, saved or not; null when there is none or it is not one. */
export function snapshotSqrtPrice(snapshot: ExitPriceSnapshot | null | undefined): bigint | null {
  if (!snapshot || !snapshot.sqrtPriceX96 || !/^[1-9]\d{0,48}$/.test(snapshot.sqrtPriceX96)) return null
  return BigInt(snapshot.sqrtPriceX96)
}

/**
 * The page's own current read of the pool's sqrt price, never a saved copy (Changed on purpose 2026-10-06, the owner's
 * point 5: an old price may say an edge is still ahead when the price has crossed it since). Changed on purpose
 * 2026-10-06 (the review of point 5): only what the dialog SHOWS before the pool's own price arrives; the edges a review
 * arms are always chosen against the pool's price read on chain right before (finance/v2/autoExit.ts readPoolPrice),
 * and the client refuses an edge that price has reached. Null otherwise.
 */
export function freshSqrtPrice(snapshot: ExitPriceSnapshot | null | undefined): bigint | null {
  return snapshot && !snapshot.saved ? snapshotSqrtPrice(snapshot) : null
}
