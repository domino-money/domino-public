import { useState, type CSSProperties, type ReactNode } from 'react'
import { rangeGeometry } from '../../lib/chart/range'
import { CREATE } from '../../lib/create/copy'
import type { JourneyState } from '../../lib/create/journey'
import { slippageBpsFrom, slippageWritten } from '../../lib/create/slippage'
import { formatUsd } from '../../lib/format/usd'
import { COPY } from '../../lib/read/screens/copy'
import { fromPoolPrice, type PoolPrice } from '../../lib/read/screens/poolRange'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import { rowApr } from '../../lib/read/screens/rowApr'
import { AmountText, LiveFigure, UsdText } from '../figures'
import { SymbolText } from '../read/screens/SymbolText'
import { TokenMark, TokenMarkPair } from '../TokenIcon'
import { Badge } from '../ui'
import { PreviewArt } from './PreviewArt'
import type { PairBalancesState } from './usePairBalances'
import { Approx, type VisualStep } from './StepList'
import { heldAmounts, rangeView, type RangeView } from './valuation'

type Usable = Extract<PoolPrice, { state: 'usable' }>

/** The row's own figures: its provider TVL, and the APR estimate the row works out, or nothing. */
function poolFigures(pool: PoolOption): { tvl: string | null; apr: string | null } {
  const tvl = pool.liquidity.state === 'attributed' || pool.liquidity.state === 'attributed_stale' ? pool.liquidity.value : null
  const apr = rowApr({ integration: pool.integration, currentLpFeePips: pool.feePips, protocolFeeRaw: pool.protocolFeeRaw, liquidity: pool.liquidity, volume: pool.volume })
  return { tvl, apr: apr.kind === 'estimate' ? `${apr.text}% est.` : null }
}

/** The range step's own words for the pool's price (PoolRangeControls' interval label). */
const POOL_PRICE = 'Pool price'
/** Review's own words for what a one-token plan takes from the wallet (StageReview's swap line). */
const FROM_WALLET = 'From your wallet'

const at = (percent: number): CSSProperties => ({ translate: `${percent}% 0` })

/** A label under a point of the range, kept inside the picture: centred, or aligned to the side that has room. */
function side(x: number, other: number, which: 'lower' | 'upper'): 'start' | 'center' | 'end' {
  if (x < 9) return 'start'
  if (x > 91) return 'end'
  if (Math.abs(other - x) < 22) return which === 'lower' ? 'end' : 'start'
  return 'center'
}

/**
 * The range on the pool's price (the owner's "beautiful range visual"): a log price axis across the card, the band
 * from the lower to the upper price with its Tangerine edges and grips, a warm light under it, and the pool's price
 * as a dotted line down to a dot on the axis that pings when the price changes. Under each edge, how far it sits from
 * the pool's price (the range step's own figures). Everything moves by translate and clip (M14), 250 ms, and stands
 * still when motion is stilled. Positions are percentages of the picture's own width, so it needs no measuring.
 */
function RangeStage({ view, poolTick, lowerTick, upperTick, priceText }: { view: RangeView; poolTick: number; lowerTick: number; upperTick: number; priceText: string }) {
  const geo = rangeGeometry(view.lower, view.upper, view.current, 100)
  const middle = (geo.lower + geo.upper) / 2
  const lowerAt = view.lower > 0 ? geo.lower : null
  const upperAt = Number.isFinite(view.upper) ? geo.upper : null
  return (
    <div className="dm-flow-pv-range" data-in={view.inRange ? 'true' : 'false'}>
      <span className="dm-flow-pv-range-glow" style={at(middle - 50)} />
      <span className="dm-flow-pv-range-band" style={{ clipPath: `inset(0 ${100 - geo.upper}% 0 ${geo.lower}% round 10px 10px 0 0)` }} />
      <span className="dm-flow-pv-range-edge" data-end="lower" data-at={lowerAt === null ? 'edge' : undefined} style={at(geo.lower)}>
        <span className="dm-flow-pv-range-grip" />
      </span>
      <span className="dm-flow-pv-range-edge" data-end="upper" data-at={upperAt === null ? 'edge' : undefined} style={at(geo.upper)}>
        <span className="dm-flow-pv-range-grip" />
      </span>
      <span className="dm-flow-pv-range-axis" />
      {geo.current !== null && (
        <span className="dm-flow-pv-range-now" style={at(geo.current)}>
          <span className="dm-flow-pv-range-dot" />
          {/* Remounted with each new price: the ping answers the change, it does not loop. */}
          <span key={priceText} className="dm-flow-pv-range-ping" />
        </span>
      )}
      {lowerAt !== null && (
        <span className="dm-flow-pv-range-mark" style={at(lowerAt)}>
          <span data-side={side(lowerAt, geo.upper, 'lower')}>{fromPoolPrice(lowerTick, poolTick)}</span>
        </span>
      )}
      {upperAt !== null && (
        <span className="dm-flow-pv-range-mark" style={at(upperAt)}>
          <span data-side={side(upperAt, geo.lower, 'upper')}>{fromPoolPrice(upperTick, poolTick)}</span>
        </span>
      )}
    </div>
  )
}

/**
 * The picture's legend, in words the product already uses (the range badge, the range heading, the fees card's
 * title): what the Tangerine line, the grey line, the band and the rising pips stand for. Shapes, not figures.
 */
const LEGEND: ReadonlyArray<{ key: 'in' | 'out' | 'band' | 'fees'; words: string }> = [
  { key: 'in', words: 'In range' },
  { key: 'out', words: 'Out of range' },
  { key: 'band', words: CREATE.amount.rangeHeading },
  { key: 'fees', words: 'Fees earned' },
]

function ArtLegend() {
  return (
    <ul className="dm-flow-pv-legend">
      {LEGEND.map((item) => (
        <li key={item.key}>
          <span className="dm-flow-pv-swatch" data-swatch={item.key} />
          {item.words}
        </li>
      ))}
    </ul>
  )
}

/**
 * The live picture of the position being made, beside the steps on a wide
 * screen and under them on a narrow one (the owner, 2026-09-24: "it has to
 * appear in a much more incredible way"). It mirrors the steps for sighted
 * people only (aria-hidden): every fact here is also said in the steps.
 * Nothing here reads: it draws the Journey's own state, and a pool row the
 * pointer or focus is on in step 1 (`preview`).
 *
 * Before a pool it is a picture of what a position is (PreviewArt) over its
 * legend. With a pool, its pair, fee, TVL and APR head the card;
 * with the pool's price and a range, the price large and the range drawn on
 * it, moving with the range step; the amounts and their USD value join at the
 * amount step, the total under them, and the tolerance once that step is
 * done. Every figure is one the steps already show; none is made up.
 */
export function PositionPreview({
  state,
  preview,
  price,
  balances,
  slippageDone,
  step,
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
  /** The open step: the part of the card it fills is marked. */
  step: VisualStep
  className?: string
  style?: CSSProperties
}) {
  const pool = state.pool ?? preview
  const chosen = state.pool
  // The head folds away over the pool it showed: the last pool pointed at stays drawn while the fold closes (and
  // until its transition ends), or the head would vanish at once and the whole card jump up with it. Kept as render
  // state (React's "a value from the previous render"), set when another pool arrives, cleared when the fold is shut.
  const [kept, setKept] = useState<PoolOption | null>(pool)
  if (pool && pool.key !== kept?.key) setKept(pool)
  const head = pool ?? kept
  const figures = head ? poolFigures(head) : null
  const view = chosen && price && state.range ? rangeView(state.range, price, chosen) : null
  const held = chosen ? heldAmounts(state, balances) : null
  const slippage = slippageDone ? slippageBpsFrom(state.slippageBps) : null
  const valued = held !== null && held.sides.every((side) => side.usd !== null) ? held.total : null
  const words = (text: string | null): ReactNode => <Approx text={text ?? CREATE.review.summary.beyondDisplay} />
  const phase = chosen ? 'chosen' : pool ? 'pointed' : 'empty'

  return (
    <aside aria-hidden="true" className={className} style={style} data-preview={phase} data-step={step}>
      {/* The pool: pair, fee, and its TVL and APR, for a chosen pool or a row pointed at. It opens and folds (M13). */}
      <div
        className="dm-flow-pv-fold"
        data-open={pool ? '' : undefined}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && !pool) setKept(null)
        }}
      >
        <div className="dm-flow-pv-fold-inner">
          {head && (
            <div key={head.key} className="dm-flow-pv-pool dm-arrive">
              <TokenMarkPair base={head.currencies[0]} quote={head.currencies[1]} size={40} />
              <div className="dm-flow-pv-pool-words">
                <p className="dm-flow-pv-pair">
                  <SymbolText token={head.currencies[0]} /> / <SymbolText token={head.currencies[1]} />
                </p>
                {figures && (figures.tvl || figures.apr) && (
                  <dl className="dm-flow-pv-stats">
                    {figures.tvl && (
                      <div>
                        <dt>TVL</dt>
                        <dd>
                          <LiveFigure value={figures.tvl} direction="none" />
                        </dd>
                      </div>
                    )}
                    {figures.apr && (
                      <div>
                        <dt>APR</dt>
                        <dd className="dm-flow-pv-apr">
                          <LiveFigure value={figures.apr} direction="none" />
                        </dd>
                      </div>
                    )}
                  </dl>
                )}
              </div>
              <span className="dm-chip dm-flow-pv-fee">{head.fee}</span>
            </div>
          )}
        </div>
      </div>

      {view && price && state.range ? (
        <div key="range" className="dm-flow-pv-live dm-arrive" data-part="range">
          <div className="dm-flow-pv-price">
            <div className="dm-flow-pv-price-head">
              <span className="dm-flow-pv-label">{POOL_PRICE}</span>
              <Badge kind={view.inRange ? 'in-range' : 'out-of-range'} />
            </div>
            <p className="dm-flow-pv-price-line">
              <span className="dm-fig-lg">
                <LiveFigure value={price.text} direction="auto">
                  <Approx text={price.text} />
                </LiveFigure>
              </span>
              <span className="dm-flow-pv-unit">
                <SymbolText token={price.quote} /> per <SymbolText token={price.base} />
              </span>
            </p>
          </div>
          <RangeStage view={view} poolTick={price.tick} lowerTick={state.range.lower} upperTick={state.range.upper} priceText={price.text} />
          <dl className="dm-flow-pv-bounds">
            <div>
              <dt>{COPY.range.minPrice}</dt>
              <dd className="dm-fig-sm">
                <LiveFigure value={view.lowerText ?? ''} direction="none">
                  {words(view.lowerText)}
                </LiveFigure>
              </dd>
            </div>
            <div>
              <dt>{COPY.range.maxPrice}</dt>
              <dd className="dm-fig-sm">
                <LiveFigure value={view.upperText ?? ''} direction="none">
                  {words(view.upperText)}
                </LiveFigure>
              </dd>
            </div>
          </dl>
        </div>
      ) : (
        <div key="start" className="dm-flow-pv-start dm-arrive">
          <div className="dm-flow-pv-stage">
            <PreviewArt />
          </div>
          <ArtLegend />
        </div>
      )}

      {/* The deposit joins once there are amounts to draw: no token beside an empty place on the first two steps. */}
      {chosen && held && (
        <div className="dm-flow-pv-deposit dm-arrive" data-part="amount">
          {held.wallet && (
            // A one-token plan: what leaves the wallet (the amount typed in the step), over what the position holds
            // once part of it is swapped, so the two figures beside each other are never left unexplained.
            <div className="dm-flow-pv-from">
              <span>{FROM_WALLET}</span>
              <span className="dm-fig-xs">
                <AmountText text={held.wallet.text} /> <SymbolText token={chosen.currencies[held.wallet.side]} />
              </span>
            </div>
          )}
          {chosen.currencies.map((currency, index) => {
            const part = held.sides[index]
            return (
              <div key={currency.address} className="dm-flow-pv-row">
                <TokenMark token={currency} size={28} />
                <span className="dm-flow-pv-amount dm-fig-xs">
                  {held.estimate && <span className="dm-approx">≈</span>}
                  <LiveFigure value={part.text} direction="none">
                    <AmountText text={part.text} />
                  </LiveFigure>{' '}
                  <span className="dm-flow-pv-symbol">
                    <SymbolText token={currency} />
                  </span>
                </span>
                {part.usd && (
                  <span className="dm-flow-pv-usd">
                    <LiveFigure value={formatUsd(part.usd)} direction="none">
                      <UsdText value={part.usd} approx={held.estimate} />
                    </LiveFigure>
                  </span>
                )}
              </div>
            )
          })}
          {valued && (
            // The receipt's figure: it ticks, and a change tints it up or down for a moment (M7).
            <div className="dm-flow-pv-total">
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
        <div className="dm-flow-pv-slip dm-arrive" data-part="review">
          <span>{CREATE.amount.slippageLabel}</span>
          <span className="dm-fig-xs">{slippageWritten(slippage)}</span>
        </div>
      )}
    </aside>
  )
}
