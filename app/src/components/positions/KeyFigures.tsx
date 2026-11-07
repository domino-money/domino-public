import { useEffect } from 'react'
import { LiveFigure, UsdText } from '../figures'
import { Stat, StatStrip, cx } from '../ui'
import { useFeeHistory } from '../../lib/fees/useFeeHistory'
import { usePastReads } from '../../lib/fees/usePastReads'
import { useLoadMilestone } from '../../lib/useLoadMilestone'
import { visibleAmountQuality } from './valueReadiness'
import type { PositionState } from '../../lib/fees/types'
import { formatUsdFloor } from '../../lib/format/usd'
import type { LiveCard } from '../../lib/walletCards'
import { YourAprStat } from './YourAprStat'
import type { CardPrice } from './PositionRange'
import { Amounts, FigureDetail, KEY_FIGURES_COPY as COPY, PriceNow, RangeLine, ValueSplit } from './keyFigureParts'
import { cardUsd } from './visual/PortfolioSummary'
import { basisOf, positive, rawPair, unitsText, valueShares } from './visual/value'

/*
 * A position's key figures (the owner, 2026-09-27: "Domino is for people who know nothing of liquidity pools"): four
 * tiles on one grid, each a label, one figure and what explains it, the figures on one line across the tiles:
 * what the position is worth now, the fees ready to collect, Your APR (this position's own fees as a yearly rate,
 * lib/positionApr.ts) and the price now against the position's range. Every figure but Your APR is from the page's
 * one chain read, at its block (the strip's title); Your APR is from the fees history the Fees earned card draws.
 */

/** Whether a decimal string is above zero (the fees figure's ink). */
const aboveZero = (value: string) => /[1-9]/.test(value)

/** Your APR (./YourAprStat.tsx) over this position's ledger. Asks for the 24H start while the tile is shown (no read when the history has one, or for a saved copy); no fills. */
function YourApr({ tokenId, compact = false, closed = false }: { tokenId: string; compact?: boolean; closed?: boolean }) {
  const fees = useFeeHistory(tokenId)
  usePastReads(tokenId, '24h', false)
  return <YourAprStat fees={fees} compact={compact} closed={closed} />
}

/**
 * Added 2026-10-14 (the incident of 2026-10-13, package V1; the owner's decision D3): the page's two dollar figures as
 * the one valuation gives them (src/v2in/position/pageValuation.ts PageUsd, the same shape: this file imports no V2 module),
 * in a build with V2. A figure of null is none from there; the page's own rule below then stands for it.
 */
export interface KeyUsd {
  /** Decimal strings at 18 places. */
  principal: string | null
  fees: string | null
  principalBasis?: 'qualified-prices' | 'pool-price'
  feesBasis?: 'qualified-prices' | 'pool-price'
  /** What each figure is worked out from, for its title. */
  principalTitle: string | null
  feesTitle: string | null
  /** The time and the basis in words for Details, when a figure is an estimate or is not current. */
  detail: string | null
  /** "as of 13:05 UTC" when the figures are not current. */
  asOf: string | null
  saved: boolean
  /**
   * Added 2026-10-14 (package V1, review): this one figure is of what is read now beside a kept one (a measured zero
   * needs no price): it says its own time (null while it is current), never the kept one's.
   */
  now?: { figure: 'principal' | 'fees'; asOf: string | null }
  /** One short reason for a figure that is missing. */
  why: string | null
}

/**
 * `state`: the page's read as a valued state (a pair with USDG), null otherwise. `usd` (2026-10-14): the one valuation's
 * figures, which come first; without one, the page's own rule (a pair with USDG at the pool's price), and with neither
 * the two token amounts, as before.
 */
export function KeyFigures({ card, state, price, cached = false, workspace = false, usd = null }: { card: LiveCard; state: PositionState | null; price: CardPrice; block: number; cached?: boolean; workspace?: boolean; usd?: KeyUsd | null }) {
  const ownPrincipal = cardUsd(card, state, 'principal')
  const ownFees = cardUsd(card, state, 'unsettledFees')
  // Each figure with what its title and its data attributes say of it: the one valuation's, else the page's own.
  // The time of each is its own (2026-10-14, review): the one figure of now beside a kept one says its own, or none.
  const datedOf = (figure: 'principal' | 'fees') => (usd?.now?.figure === figure ? usd.now.asOf : usd?.asOf ?? null)
  const savedOf = (figure: 'principal' | 'fees') => usd?.saved === true && usd.now?.figure !== figure
  const principal = usd?.principal != null ? { text: usd.principal, title: usd.principalTitle ?? undefined, basis: usd.principalBasis, dated: datedOf('principal'), saved: savedOf('principal'), one: true } : ownPrincipal ? { text: unitsText(ownPrincipal.units), title: `Pool price at block ${ownPrincipal.block}`, basis: undefined, dated: null, saved: false, one: false } : null
  const fees = usd?.fees != null ? { text: usd.fees, title: usd.feesTitle ?? undefined, basis: usd.feesBasis, dated: datedOf('fees'), saved: savedOf('fees'), one: true } : ownFees ? { text: unitsText(ownFees.units), title: undefined, basis: undefined, dated: null, saved: false, one: false } : null
  const principalText = principal ? formatUsdFloor(principal.text) : null
  const longPrincipal = !!principalText && principalText.length > 13
  const basis = state && principal ? basisOf(state) : null
  const raw = rawPair([card.principal[0].raw, card.principal[1].raw])
  const shares = basis && raw ? valueShares(basis, raw) : null
  const valueQuality = principal ? 'current' : visibleAmountQuality(card.principal)
  useLoadMilestone('position', 'value', valueQuality && cached ? 'cached' : valueQuality)
  // The page's moment (v4-position.css, html:not(.dm-booted)) plays when the position page's figures arrive, as a page
  // load does in the approved V4 site; once it is over, later reads never run it again (the owner's silent updates).
  useEffect(() => {
    if (!workspace) return
    const timer = window.setTimeout(() => document.documentElement.classList.add('dm-booted'), 1200)
    return () => window.clearTimeout(timer)
  }, [workspace])
  // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): no time under a figure that is not current ("as of
  // 13:05 UTC") and no reason under amounts with no dollar figure; data-usd-snapshot still marks a kept figure.
  // Changed on purpose 2026-10-31 (QA round 2 follow-ups, R23; N16: no block numbers in the main tooltips): the strip has
  // no title; hovering anywhere on it said "Read from chain at block N". `block` stays in the props for the callers.
  return (
    <StatStrip layout="tiles" className="dm-pos-stats" data-position-stats="" data-position-overview={workspace ? '' : undefined} data-valued={principal ? '' : undefined}>
      <Stat
        label={COPY.value}
        info={COPY.valueInfo}
        className="dm-pos-stat"
        data-cell="principal"
        data-long-value={longPrincipal ? '' : undefined}
        data-value-width={principalText && principalText.length > 11 ? 'wide' : principalText && principalText.length > 8 ? 'medium' : undefined}
        sub={
          principal ? (
            <>
              <FigureDetail active={workspace} label={COPY.tokenAmounts}>
                <ValueSplit shares={shares} />
                <Amounts card={card} which="principal" />
              </FigureDetail>
            </>
          ) : null
        }
      >
        {principal ? (
          <span className="dm-arrive" title={principal.title} data-usd={principal.one ? 'principal' : undefined} data-usd-basis={principal.basis} data-usd-snapshot={principal.saved ? '' : undefined} data-usd-dated={principal.dated ? '' : undefined}>
            <LiveFigure value={principalText!} mode={longPrincipal ? 'whole' : 'digits'} dimCents className={cx('dm-fig-lg', longPrincipal && 'dm-position-long-figure')}>
              {longPrincipal && principalText!.split(/(?<=,)/).map((part, index) => <span className="dm-position-amount-group" key={index}>{part}</span>)}
            </LiveFigure>
          </span>
        ) : (
          <Amounts card={card} which="principal" />
        )}
      </Stat>
      <Stat
        label={COPY.fees}
        info={COPY.feesInfo}
        className="dm-pos-stat"
        data-cell="fees"
        sub={fees ? (
          <>
            <FigureDetail active={workspace} label={COPY.tokenAmounts}><Amounts card={card} which="unsettledFees" /></FigureDetail>
          </>
        ) : null}
      >
        {fees ? (
          fees.one ? (
            <span title={fees.title} data-usd="fees" data-usd-basis={fees.basis} data-usd-snapshot={fees.saved ? '' : undefined} data-usd-dated={fees.dated ? '' : undefined}>
              <UsdText value={fees.text} floor className={cx('dm-fig-lg dm-arrive', aboveZero(fees.text) && 'dm-fees-in')} />
            </span>
          ) : (
            <UsdText value={fees.text} block={ownFees!.block} floor className={cx('dm-fig-lg dm-arrive', positive(ownFees!.units) && 'dm-fees-in')} />
          )
        ) : <Amounts card={card} which="unsettledFees" />}
      </Stat>
      <YourApr tokenId={card.tokenId} compact={workspace} closed={!card.hasLiquidity} />
      <Stat
        // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): never "Last known price".
        label={COPY.price}
        info={COPY.priceInfo}
        className={cx('dm-pos-stat', workspace && 'dm-lit')}
        data-cell="price"
        sub={<RangeLine price={price} card={card} cached={cached} />}
      >
        <span data-stat="price">
          <PriceNow price={price} card={card} />
        </span>
      </Stat>
    </StatStrip>
  )
}
