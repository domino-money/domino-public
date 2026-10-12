/** Completed reads can lack a qualified price; that is not an unfinished loading state. */
export function usdUnavailableReason(reason?: string | null): string {
  const reasons = reason?.split(',') ?? []
  if (reasons.includes('pool_depth_below_floor')) return 'The price source has not verified enough liquidity for a USD estimate.'
  if (reasons.includes('pool_depth_unmeasurable')) return 'The pricing pool’s liquidity could not be verified.'
  if (reasons.includes('decimals_unknown')) return 'Token precision could not be verified.'
  if (reasons.some(value => value === 'stale_position_or_chain' || value === 'awaiting_receipt_block')) return 'Waiting for a current position reading.'
  if (reasons.some(value => ['eth_usd_stale', 'price_read_failed', 'pricing_limit_reached', 'sequencer_down'].includes(value))) return 'The USD price source is temporarily unavailable.'
  return 'A reliable USD price isn’t available for every token held.'
}
