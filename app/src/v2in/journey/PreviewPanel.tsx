import type { CSSProperties } from 'react'
import { PreviewArt } from '../../components/create/PreviewArt'
import type { VisualStep } from '../../components/create/StepList'
import { endPrice } from '../../components/create/valuation'
import { SymbolText } from '../../components/read/screens/SymbolText'
import { Badge, Pill } from '../../components/ui'
import { CREATE } from '../../lib/create/copy'
import { plainFigure } from '../../lib/create/plain'
import { rangePosition, shownPrice, shownRange } from '../../lib/read/screens/poolRange'
import { v2Chain } from '../../v2/chains'
import { feePercent } from './model/pools'
import { pricedPair, type JourneyPriceState } from './model/price'
import { inputsOf, type JourneyState } from './model/state'
import { TokenDisc, TokenDiscPair, TokenName } from './parts'
import { figureText, tokenBook } from './tokens'

/**
 * The picture beside the steps on a wide screen, in today's preview's look (components/create/PositionPreview.tsx): before
 * a pool, the picture of what a position is; with a pool, its pair, network and fee; with a price and a range, the price
 * and the range's two ends; with amounts, what goes in. It mirrors the steps for sighted people only (aria-hidden): every
 * fact is also said in the steps. No USD, APR or TVL (decision #22: no qualified source for V2 pools). Changed on purpose
 * 2026-10-30 (QA round 2, Q24): the pair as its price is written, base then quote (./model/price.ts pricedPair). And
 * (its review, N73): an end at the pool's usable tick limit reads 0 or ∞, as the Range step, Review and today's preview
 * write it (components/create/valuation.ts endPrice), never a line for a figure beyond display.
 */
export function PreviewPanel({ state, price, step, className, style }: { state: JourneyState; price: JourneyPriceState | null; step: VisualStep; className?: string; style?: CSSProperties }) {
  const pool = state.pool
  const usable = price && price.state === 'usable' ? price : null
  const range = state.range
  const shown = usable ? shownPrice(usable) : null
  const view = usable && range ? shownRange(range, usable.inverted === true) : null
  const inputs = pool ? inputsOf(state) : null
  const book = tokenBook(state.chainId, pool ? [...pool.tokens] : [])
  const words = (text: string | null) => plainFigure(text ?? CREATE.review.summary.beyondDisplay)
  const pair = pool ? pricedPair(state.chainId, pool.pool.currency0, pool.pool.currency1, pool.tokens) : null
  return (
    <aside aria-hidden="true" hidden={step === 'review'} className={className} style={style} data-preview={pool ? 'chosen' : 'empty'} data-step={step}>
      <div className="dm-flow-pv-fold" data-open={pool ? '' : undefined}>
        <div className="dm-flow-pv-fold-inner">
          {pool && pair && (
            <div className="dm-flow-pv-pool dm-arrive">
              <TokenDiscPair chainId={state.chainId} first={pair[0]} second={pair[1]} size={40} />
              <div className="dm-flow-pv-pool-words">
                <p className="dm-flow-pv-pair">
                  <TokenName token={pair[0]} /> / <TokenName token={pair[1]} />
                </p>
                <p className="text-caption text-fg-subtle">{v2Chain(state.chainId).name}</p>
              </div>
              <span className="dm-chip dm-flow-pv-fee">{feePercent(pool.pool.fee)}</span>
            </div>
          )}
        </div>
      </div>
      {usable && shown && view && range ? (
        <div className="dm-flow-pv-live dm-arrive" data-part="range">
          <div className="dm-flow-pv-price">
            <div className="dm-flow-pv-price-head">
              <span className="dm-flow-pv-label">{CREATE.amount.now}</span>
              {rangePosition(range, usable.tick) === 'inside' ? <Badge kind="in-range" /> : <Pill>{CREATE.amount.earnsInRange}</Pill>}
            </div>
            <p className="dm-flow-pv-price-line">
              <span className="dm-fig-lg">{plainFigure(usable.text)}</span>
              <span className="dm-flow-pv-unit">
                <SymbolText token={usable.quote} /> for 1 <SymbolText token={usable.base} />
              </span>
            </p>
          </div>
          <dl className="dm-flow-pv-bounds">
            <div>
              <dt>{CREATE.amount.lowest}</dt>
              <dd className="dm-fig-sm">{words(endPrice(view.lower, 'lower', shown))}</dd>
            </div>
            <div>
              <dt>{CREATE.amount.highest}</dt>
              <dd className="dm-fig-sm">{words(endPrice(view.upper, 'upper', shown))}</dd>
            </div>
          </dl>
        </div>
      ) : (
        <div className="dm-flow-pv-start dm-arrive">
          <div className="dm-flow-pv-stage">
            <PreviewArt />
          </div>
        </div>
      )}
      {pool && inputs && (
        <div className="dm-flow-pv-deposit dm-arrive" data-part="amount">
          {inputs.map((input) => (
            <div key={input.token} className="dm-flow-pv-row">
              <TokenDisc chainId={state.chainId} token={{ address: input.token }} size={28} />
              <span className="dm-flow-pv-amount dm-fig-xs">
                {figureText(book, input.token, input.amount)}{' '}
                <span className="dm-flow-pv-symbol">
                  <TokenName token={book.get(input.token) ?? { address: input.token, symbol: null }} />
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
