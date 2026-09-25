import { LiveFigure, StackedBar, UsdText } from '../../figures'
import { cx } from '../../ui'
import type { PositionState } from '../../../lib/fees/types'
import { formatUsd } from '../../../lib/format/usd'
import type { LiveCard } from '../../../lib/walletCards'
import { cardUsd } from './PortfolioSummary'
import { basisOf, positive, rawPair, unitsText, valueShares } from './value'

/**
 * The value band's USD (DESIGN-V2 §12.1), for a position whose pair has USDG
 * and whose `/state` answered: Principal in rolling digits over a 4px split of
 * the two tokens' value, drawn above the amounts by CSS while it follows them
 * in the DOM. Nothing without a valued state: no USD, no split.
 */
export function PrincipalUsd({ card, state }: { card: LiveCard; state: PositionState | null }) {
  const value = cardUsd(card, state, 'principal')
  const basis = state && value ? basisOf(state) : null
  const amounts = rawPair([card.principal[0].raw, card.principal[1].raw])
  if (!value || !basis || !amounts) return null
  const shares = valueShares(basis, amounts)
  return (
    <span className="dm-pos-usd dm-arrive" title={`Pool price at block ${value.block}`}>
      <LiveFigure value={formatUsd(unitsText(value.units))} mode="digits" dimCents className="dm-fig-hero" />
      {/* Neutral inks: on this page Tangerine means the fees series (Collected), so the tokens' split never borrows it. A
          position all in one token has nothing to split: no bar (one solid segment would say nothing the amounts do not). */}
      {shares && shares[0] > 0 && shares[1] > 0 && (
        <StackedBar className="dm-pos-split" height={4} parts={[{ share: shares[0], tone: 'neutral' }, { share: shares[1], tone: 'muted' }]} />
      )}
    </span>
  )
}

/** Unclaimed fees in USD at the same price, in the in-colour while there are any. */
export function UnclaimedUsd({ card, state }: { card: LiveCard; state: PositionState | null }) {
  const value = cardUsd(card, state, 'unsettledFees')
  if (!value) return null
  return (
    <span className="dm-pos-usd dm-arrive">
      <UsdText value={unitsText(value.units)} block={value.block} className={cx('dm-fig-lg', positive(value.units) && 'dm-fees-in')} />
    </span>
  )
}
