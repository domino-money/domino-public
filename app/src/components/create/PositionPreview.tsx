import type { CSSProperties, ReactNode } from 'react'
import { CREATE } from '../../lib/create/copy'
import type { JourneyState } from '../../lib/create/journey'
import { slippageBpsFrom, slippageWritten } from '../../lib/create/slippage'
import { formatUsd } from '../../lib/format/usd'
import type { PoolPrice } from '../../lib/read/screens/poolRange'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import { rowApr } from '../../lib/read/screens/rowApr'
import { RangePreview } from '../charts/RangePreview'
import { AmountText, LiveFigure, UsdText } from '../figures'
import { SymbolText } from '../read/screens/SymbolText'
import { TokenMark, TokenMarkPair } from '../TokenIcon'
import { Badge } from '../ui'
import type { PairBalancesState } from './usePairBalances'
import { Approx } from './StepList'
import { heldAmounts, rangeView } from './valuation'

type Usable = Extract<PoolPrice, { state: 'usable' }>

/** A dashed place for something a later choice fills: never a loading bubble, and never a figure. */
const Slot = ({ width, round = false }: { width: number; round?: boolean }) => (
  <span className={round ? 'dm-flow-preview-slot dm-flow-preview-slot--mark' : 'dm-flow-preview-slot'} style={round ? undefined : ({ width } as CSSProperties)} />
)

/** The row's own figures: its provider TVL, and the APR estimate the row works out, or nothing. */
function poolFigures(pool: PoolOption): { tvl: string | null; apr: string | null } {
  const tvl = pool.liquidity.state === 'attributed' || pool.liquidity.state === 'attributed_stale' ? pool.liquidity.value : null
  const apr = rowApr({ integration: pool.integration, currentLpFeePips: pool.feePips, protocolFeeRaw: pool.protocolFeeRaw, liquidity: pool.liquidity, volume: pool.volume })
  return { tvl, apr: apr.kind === 'estimate' ? `${apr.text}% est.` : null }
}

/**
 * The live picture of the position being made, beside the steps on a wide
 * screen (DESIGN-V2 §10.1): the pair and its figures, the range on the pool's
 * price, what each token amounts to, and the tolerance. It mirrors the steps
 * for sighted people only (aria-hidden): every fact here is also said in the
 * steps. Nothing here reads: it draws the Journey's own state, and a pool row
 * the pointer or focus is on in step 1 (`preview`). Before a pool, dashed
 * slots show where each part will go; they are places, not loading.
 */
export function PositionPreview({
  state,
  preview,
  price,
  balances,
  slippageDone,
  className,
  style,
}: {
  state: JourneyState
  /** A pool row pointed at or focused in step 1, while nothing is chosen. */
  preview: PoolOption | null
  /** The chosen pool's price, when it can be used. */
  price: Usable | null
  balances: PairBalancesState
  /** The amount step is done: its tolerance joins the preview. */
  slippageDone: boolean
  className?: string
  style?: CSSProperties
}) {
  const pool = state.pool ?? preview
  const chosen = state.pool
  const figures = pool ? poolFigures(pool) : null
  const view = chosen && price && state.range ? rangeView(state.range, price, chosen) : null
  const held = chosen ? heldAmounts(state, balances) : null
  const slippage = slippageDone ? slippageBpsFrom(state.slippageBps) : null
  const valued = held !== null && held.sides.every((side) => side.usd !== null) ? held.total : null
  const words = (text: string | null): ReactNode => <Approx text={text ?? CREATE.review.summary.beyondDisplay} />

  return (
    <aside aria-hidden="true" className={className} style={style} data-preview={chosen ? 'chosen' : pool ? 'pointed' : 'empty'}>
      <div className="dm-flow-preview-pair">
        {pool ? (
          <div key={pool.key} className="dm-flow-preview-id dm-arrive">
            <TokenMarkPair base={pool.currencies[0]} quote={pool.currencies[1]} size={36} />
            <p className="dm-subtitle dm-flow-preview-name">
              <SymbolText token={pool.currencies[0]} /> / <SymbolText token={pool.currencies[1]} />
            </p>
            <span className="dm-chip dm-flow-preview-fee">{pool.fee}</span>
          </div>
        ) : (
          <div className="dm-flow-preview-id">
            <span className="dm-flow-preview-slot-pair">
              <Slot width={36} round />
              <Slot width={36} round />
            </span>
            <span className="dm-flow-preview-slot-lines">
              <Slot width={96} />
              <Slot width={48} />
            </span>
          </div>
        )}
        {figures && (figures.tvl || figures.apr) ? (
          <dl className="dm-flow-preview-stats">
            {figures.tvl && (
              <div>
                <dt>TVL</dt>
                <dd className="dm-fig-xs">
                  <LiveFigure value={figures.tvl} direction="none" />
                </dd>
              </div>
            )}
            {figures.apr && (
              <div>
                <dt>APR</dt>
                <dd className="dm-fig-xs dm-flow-preview-apr">
                  <LiveFigure value={figures.apr} direction="none" />
                </dd>
              </div>
            )}
          </dl>
        ) : (
          !pool && (
            <div className="dm-flow-preview-stats">
              <Slot width={64} />
              <Slot width={64} />
            </div>
          )
        )}
      </div>

      <div className="dm-flow-preview-range">
        {view && price ? (
          <>
            <div className="dm-flow-preview-head">
              <span className="dm-flow-preview-label">{CREATE.amount.rangeHeading}</span>
              <Badge kind={view.inRange ? 'in-range' : 'out-of-range'} />
            </div>
            <RangePreview
              lower={view.lower}
              upper={view.upper}
              current={view.current}
              inRange={view.inRange}
              height={120}
              labels={{ lower: words(view.lowerText), upper: words(view.upperText), current: <Approx text={price.text} /> }}
              className="dm-arrive"
            />
          </>
        ) : (
          <div className="dm-flow-preview-axis">
            <RangePreview lower={1} upper={1} current={null} inRange={null} height={56} axisOnly />
            <span className="dm-flow-preview-slot dm-flow-preview-slot--band" />
          </div>
        )}
      </div>

      {/* The deposit joins once there are amounts to draw: no token beside an empty place on the first two steps. */}
      {chosen && held && (
        <div className="dm-flow-preview-deposit dm-arrive">
          {chosen.currencies.map((currency, index) => {
            const side = held.sides[index]
            return (
              <div key={currency.address} className="dm-flow-preview-row">
                <TokenMark token={currency} size={24} />
                <span className="dm-flow-preview-amount dm-fig-xs">
                  {held.estimate && <span className="dm-approx">≈</span>}
                  <LiveFigure value={side.text} direction="none">
                    <AmountText text={side.text} />
                  </LiveFigure>{' '}
                  <SymbolText token={currency} />
                </span>
                {side.usd && (
                  <span className="dm-flow-preview-usd">
                    <LiveFigure value={formatUsd(side.usd)} direction="none">
                      <UsdText value={side.usd} approx={held.estimate} />
                    </LiveFigure>
                  </span>
                )}
              </div>
            )
          })}
          {valued && (
            // The receipt's figure: it ticks, and a change tints it up or down for a moment (M7).
            <div className="dm-flow-preview-total">
              <TokenMarkPair base={chosen.currencies[0]} quote={chosen.currencies[1]} size={24} />
              <span className="dm-fig-lg dm-arrive">
                <LiveFigure value={formatUsd(valued)} direction="auto">
                  <UsdText value={valued} approx={held.estimate} />
                </LiveFigure>
              </span>
            </div>
          )}
        </div>
      )}

      {slippage !== null && (
        <div className="dm-flow-preview-slip">
          <span>{CREATE.amount.slippageLabel}</span>
          <span className="dm-fig-xs dm-arrive">{slippageWritten(slippage)}</span>
        </div>
      )}
    </aside>
  )
}
