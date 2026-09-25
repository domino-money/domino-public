import type { CSSProperties } from 'react'
import { FEE_BPS } from './feeMeter'

/**
 * The service fee as a share of earned fees: one bar standing for everything
 * a position earns, and at its end the sliver the service keeps (2% or 4% of
 * its length). Decoration beside the fee's own words (the `dl` above it), so
 * it carries no text. The sliver grows once, on mount, after the card has
 * risen.
 */
export function FeeMeter({ mode }: { mode: 'compound' | 'domino' }) {
  const share = FEE_BPS[mode] / 100
  return (
    <div className="dm-fee-meter" data-mode={mode} aria-hidden="true" style={{ '--fee': share } as CSSProperties}>
      <span className="dm-fee-meter-earned" />
      <span className="dm-fee-meter-fee" />
    </div>
  )
}
