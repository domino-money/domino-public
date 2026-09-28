import { LiveFigure, UsdText } from '../../figures'
import { cx } from '../../ui'
import type { PositionState } from '../../../lib/fees/types'
import { formatUsd } from '../../../lib/format/usd'
import type { LiveCard } from '../../../lib/walletCards'
import { basisOf, positive, unitsText, usdgSide, valueOfRaw } from './value'

/** A value in USD and the block of the price it was taken at. */
export interface UsdValue {
  units: bigint
  block: number
}

/**
 * A card's principal or unclaimed fees in USD, at the `/state` answer's pool
 * price (§6.2): only for a pair with USDG and a state of the same pool. Null
 * otherwise: no USD is shown rather than a guessed one.
 */
export function cardUsd(card: LiveCard, state: PositionState | null | undefined, which: 'principal' | 'unsettledFees'): UsdValue | null {
  if (!state || state.poolId !== card.poolId || usdgSide(state.currencies) === null) return null
  const basis = basisOf(state)
  if (!basis) return null
  const units = valueOfRaw(basis, [card[which][0].raw, card[which][1].raw])
  return units === null ? null : { units, block: basis.block }
}

/** One open row of the list: its card, and the state of the same read its USD is valued at (null: no price read). */
export interface PortfolioRow {
  card: LiveCard
  state: PositionState | null
}

export interface Portfolio {
  /** Principal and unclaimed fees of every open position in USD; null unless every one is valued. */
  totals: { principal: bigint; unclaimed: bigint; block: number } | null
}

/**
 * The Positions list's USD (§11.1), from the wallet's own chain read: every
 * row's amounts and its pool's price are from one block, so a pair with USDG
 * is valued at once, with nothing else asked. The totals when every open
 * position is valued. (2026-09-25: no fees aggregate any more; the list
 * replays no history.)
 */
export function portfolioOf(open: readonly PortfolioRow[]): Portfolio {
  const everyUsdg = open.length > 0 && open.every((row) => usdgSide(row.card.currencies) !== null)
  let principal = 0n
  let unclaimed = 0n
  let block = 0
  let valued = everyUsdg
  for (const row of everyUsdg ? open : []) {
    const p = cardUsd(row.card, row.state, 'principal')
    const u = cardUsd(row.card, row.state, 'unsettledFees')
    if (!p || !u) {
      valued = false
      break
    }
    principal += p.units
    unclaimed += u.units
    block = Math.max(block, p.block)
  }
  return { totals: valued ? { principal, unclaimed, block } : null }
}

/**
 * The portfolio band over Your positions' rows (§11.1-4): their total value,
 * rolling digits, over the fees ready to collect (2026-09-27: plain words, once
 * Principal and Unclaimed fees). Shown only when every open position is valued.
 */
export function PortfolioSummary({ principal, unclaimed, block }: { principal: bigint; unclaimed: bigint; block: number }) {
  const title = `Pool price at block ${block}`
  return (
    <div className="dm-portfolio dm-arrive">
      <div className="dm-portfolio-fig">
        <span className="dm-portfolio-label">Total value</span>
        <span title={title}>
          <LiveFigure value={formatUsd(unitsText(principal))} mode="digits" dimCents className="dm-fig-hero" />
        </span>
      </div>
      <div className="dm-portfolio-fig">
        <span className="dm-portfolio-label">Fees ready to collect</span>
        <UsdText value={unitsText(unclaimed)} block={block} className={cx('dm-fig-lg', positive(unclaimed) && 'dm-fees-in')} />
      </div>
    </div>
  )
}
