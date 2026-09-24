import type { AmountView, Batch } from '../../lib/read/screens/positions'
import { utcTime } from '../../lib/read/screens/figures'
import type { LiveCard } from '../../lib/ownedPositions'
import { TokenLabel } from '../read/TokenLabel'
import { Pill } from '../ui'
import { Figure } from './Figure'

/**
 * An amount in its token's units to six significant digits, every digit in
 * its title; a dash, with the raw amount in its title, when the token's
 * decimals were not read. The symbol is the token's own text, never markup.
 */
export function Amount({ amount }: { amount: AmountView }) {
  const symbol = (
    <span className="dm-acct-amount-symbol">
      <TokenLabel token={amount.token} />
    </span>
  )
  if (amount.kind === 'raw') {
    return (
      <span className="dm-acct-amount" data-amount="raw" title={`Raw amount ${amount.raw}: the token’s decimals were not read`}>
        <span className="text-fg-subtle">—</span> {symbol}
      </span>
    )
  }
  return (
    <span className="dm-acct-amount" data-amount={amount.kind} title={amount.kind === 'units' ? (amount.exact ?? undefined) : undefined}>
      <Figure text={amount.text} /> {symbol}
    </span>
  )
}

/** A position's state at the read's block, as the pill a person scans for: Closed once it holds no liquidity. */
export function PositionStatus({ card }: { card: LiveCard }) {
  if (!card.hasLiquidity) {
    return (
      <Pill dot data-position-status="closed">
        Closed
      </Pill>
    )
  }
  return card.inRange ? (
    <Pill dot tone="in" data-position-status="in-range">
      In range
    </Pill>
  ) : (
    <Pill dot tone="out" data-position-status="out-of-range">
      Out of range
    </Pill>
  )
}

/** The pair as a person reads it: the two tokens' own symbols, currency0 first. */
export function PairName({ card }: { card: LiveCard }) {
  const [base, quote] = card.currencies
  return (
    <>
      <TokenLabel token={base} /> / <TokenLabel token={quote} />
    </>
  )
}

/** The block, time and freshness of the read a position's figures are from: a title, never a line on the page. */
export function snapshotTitle(batch: Batch) {
  const age = `${batch.freshness.ageSeconds} s old when read`
  return `Block ${batch.block.number} · ${utcTime(batch.block.timestamp)} · ${batch.freshness.status === 'stale' ? `stale, ${age}` : `fresh, ${age}`}`
}
