import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { rangeGeometry } from '../../lib/chart/range'
import { CREATE } from '../../lib/create/copy'
import { feeWords } from '../../lib/format/fee'
import type { JourneyState } from '../../lib/create/journey'
import { figuresShownUntil, networkFiguresAt } from '../../lib/create/otherChains'
import { awayShort, plainFigure } from '../../lib/create/plain'
import { formatUsd } from '../../lib/format/usd'
import { readNow } from '../../lib/markets'
import { rem } from '../../lib/rootScale'
import { pricePair } from '../../lib/read/orientation'
import { useMarketOption } from '../../lib/read/screens/knownMarkets'
import type { PoolPrice } from '../../lib/read/screens/poolRange'
import { optionAprText, type PoolOption } from '../../lib/read/screens/poolsList'
import { FEE_MEANING } from '../explore/feeMeaning'
import { AmountText, LiveFigure, UsdText } from '../figures'
import { SymbolText } from '../read/screens/SymbolText'
import { TokenMark, TokenMarkPair } from '../TokenIcon'
import { Badge, Pill } from '../ui'
import { PreviewArt } from './PreviewArt'
import type { PairBalancesState } from './usePairBalances'
import type { VisualStep } from './StepList'
import { heldAmounts, rangeView, type RangeView } from './valuation'

type Usable = Extract<PoolPrice, { state: 'usable' }>

/**
 * The row's own figures: its TVL, and its APR as New position's list row writes it (poolsList.ts optionAprText: Markets'
 * figure where the page holds the pool's row, else the row's own estimate), or nothing. The one APR rule of every screen
 * (lib/format/apr.ts, audit E21).
 */
function poolFigures(pool: PoolOption): { tvl: string | null; apr: string | null } {
  const tvl = pool.liquidity.state === 'attributed' || pool.liquidity.state === 'attributed_stale' ? pool.liquidity.value : null
  return { tvl, apr: optionAprText(pool) }
}

/** Review's own words for what a one-token plan takes from the wallet (StageReview's swap line). */
const FROM_WALLET = 'You put in'

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
 * the pool's price, rounded as the range step writes it (lib/create/plain.ts). Everything moves by translate and clip
 * (M14), 250 ms, and stands still when motion is stilled. Positions are percentages of the picture's own width, so it
 * needs no measuring.
 */
function RangeStage({ view, poolTick, lowerTick, upperTick, priceText }: { view: RangeView; poolTick: number; lowerTick: number; upperTick: number; priceText: string }) {
  const geo = rangeGeometry(view.lower, view.upper, view.current, 100)
  const middle = (geo.lower + geo.upper) / 2
  const lowerAt = view.lower > 0 ? geo.lower : null
  const upperAt = Number.isFinite(view.upper) ? geo.upper : null
  // The band's ends and the point it stretches about (today's price, else its middle), as numbers of the window's width:
  // the CSS draws the band from them (--lo, --hi), so a pointed-at Wider or Custom can stretch it (styles/v4-newposition.css).
  const ends = { '--pv-lo': geo.lower, '--pv-hi': geo.upper, '--pv-mid': geo.current ?? middle } as CSSProperties
  return (
    <div className="dm-flow-pv-range" data-in={view.inRange ? 'true' : 'false'} style={ends}>
      <span className="dm-flow-pv-range-glow" style={at(middle - 50)} />
      <span className="dm-flow-pv-range-band" style={{ clipPath: `inset(0 calc(100% - var(--hi)) 0 var(--lo) round ${rem(10)} ${rem(10)} 0 0)` }} />
      <span className="dm-flow-pv-range-edge" data-end="lower" data-at={lowerAt === null ? 'edge' : undefined} style={{ translate: 'var(--lo) 0' }}>
        <span className="dm-flow-pv-range-grip" />
      </span>
      <span className="dm-flow-pv-range-edge" data-end="upper" data-at={upperAt === null ? 'edge' : undefined} style={{ translate: 'var(--hi) 0' }}>
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
        <span className="dm-flow-pv-range-mark dm-flow-pv-range-mark--lo" style={at(lowerAt)}>
          <span data-side={side(lowerAt, geo.upper, 'lower')}>{awayShort(lowerTick, poolTick)}</span>
        </span>
      )}
      {upperAt !== null && (
        <span className="dm-flow-pv-range-mark dm-flow-pv-range-mark--hi" style={at(upperAt)}>
          <span data-side={side(upperAt, geo.lower, 'upper')}>{awayShort(upperTick, poolTick)}</span>
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
 * amount step, the total under them. Every figure is one the steps already
 * show; none is made up. Changed on purpose (round 6, 2026-09-27, the owner:
 * plain words, fewer numbers): prices read "2,499.91 USDG for 1 ETH" with no
 * "≈", an estimate's total says "About", and the slippage tolerance, which
 * sits under the amount step's Advanced now, is no longer drawn here.
 */
export function PositionPreview({
  state,
  preview,
  price,
  balances,
  step,
  network = null,
  className,
  style,
}: {
  state: JourneyState
  /** A pool row pointed at or focused in step 1, while nothing is chosen. */
  preview: PoolOption | null
  /** The chosen pool's price, when it can be used. */
  price: Usable | null
  balances: PairBalancesState
  /** The open step: the part of the card it fills is marked. */
  step: VisualStep
  /**
   * QA round 2, Q23/N37 (the owner: the network on every pool): a pool's network by its chain id, where the chosen pool's
   * panel names it (other networks offered, lib/create/otherChains.ts); null for one it does not name.
   */
  network?: ((chainId: number) => string | null) | null
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
  // Changed on purpose 2026-10-06 (rugged97's delta of 6 Oct §4): a pool of Base or Arbitrum One shows DEX Screener's
  // figures for ten minutes after they were read, never after (lib/create/otherChains.ts networkFiguresAt), on a clock
  // read when the card mounts and again just after the figure shown may no longer be. Robinhood Chain's are as they were.
  const [clock, setClock] = useState(readNow)
  const shown = head ? networkFiguresAt(head, Math.floor(clock.wall / 1000)) : null
  const until = shown ? figuresShownUntil([shown]) : null
  useEffect(() => {
    if (until === null) return
    const wake = setTimeout(() => setClock(readNow()), Math.max(0, (until + 1) * 1000 - Date.now()))
    return () => clearTimeout(wake)
  }, [until, clock])
  // QA round 2, N8 (pass 3): the figures Markets shows for this pool, whichever way it came in (a link carries the pools
  // route's TVL and no Markets APR), so the card and its list row write the same TVL and APR. Only the Markets rows the
  // page already holds; nothing is asked. Base and Arbitrum One pools have no Markets row and keep their own.
  const marked = useMarketOption(shown)
  const figures = marked ? poolFigures(marked) : null
  const view = chosen && price && state.range ? rangeView(state.range, price, chosen) : null
  const held = chosen ? heldAmounts(state, balances) : null
  const valued = held !== null && held.sides.every((side) => side.usd !== null) ? held.total : null
  const words = (text: string | null): ReactNode => plainFigure(text ?? CREATE.review.summary.beyondDisplay)
  const phase = chosen ? 'chosen' : pool ? 'pointed' : 'empty'
  // QA round 2, Q24: the pair named as Markets and the pool page name it (the order its price is written), marks matched.
  const pair = head ? pricePair(head.currencies[0], head.currencies[1]) : null
  const chain = head ? head.currencies[0].chainId : null
  const networkText = chain !== null && network ? network(chain) : null
  // The fee as every chip writes it (lib/format/fee.ts, QA round 2 N34: never a bare percentage), and what it is on hover (Q28).
  const fee = head ? feeWords(head.fee) : ''

  return (
    <aside aria-hidden="true" hidden={step === 'review'} className={className} style={style} data-preview={phase} data-step={step}>
      <div className="dm-flow-preview-head">
        {/* QA round 2, N21 (the owner's yes): a pool only pointed at, nothing chosen yet, is a preview, not your position. */}
        <span className="dm-flow-preview-kicker">{phase === 'pointed' ? CREATE.page.previewPointed : CREATE.page.preview}</span>
      </div>
      {/* The pool: pair, fee, and its TVL and APR, for a chosen pool or a row pointed at. It opens and folds (M13). */}
      <div
        className="dm-flow-pv-fold"
        data-open={pool ? '' : undefined}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && !pool) setKept(null)
        }}
      >
        <div className="dm-flow-pv-fold-inner">
          {head && pair && (
            <div key={head.key} className="dm-flow-pv-pool dm-arrive">
              <TokenMarkPair base={pair.base} quote={pair.quote} size={40} />
              <div className="dm-flow-pv-pool-words">
                <p className="dm-flow-pv-pair">
                  <SymbolText token={pair.base} /> / <SymbolText token={pair.quote} />
                </p>
                {/* QA round 2, Q23/N37: with its network, the pool's tags sit under the pair, network then fee, as the chosen
                    pool's panel and the pool rows show them (joined tags, new.html .tag). */}
                {networkText !== null && (
                  <span className="dm-flow-pv-chips" data-pool-chips="">
                    <span className="dm-chip" data-chain-chip={chain ?? undefined}>{networkText}</span>
                    <span className="dm-chip" data-fee="" title={FEE_MEANING}>{fee}</span>
                  </span>
                )}
                {figures && (figures.tvl || figures.apr) && (
                  <dl className="dm-flow-pv-stats">
                    {figures.tvl && (
                      <div>
                        <dt>In this pool</dt>
                        <dd>
                          <LiveFigure value={figures.tvl} direction="none" />
                        </dd>
                      </div>
                    )}
                    {figures.apr && (
                      <div>
                        {/* Changed on purpose 2026-10-30 (QA round 2, N52, the owner's option b): the label says it is the
                            pool's yearly fee rate now, not what this deposit earns. The number and its formula are unchanged (D9). */}
                        <dt>Pool fee rate, yearly</dt>
                        <dd className="dm-flow-pv-apr">
                          <LiveFigure value={figures.apr} direction="none" />
                        </dd>
                      </div>
                    )}
                  </dl>
                )}
              </div>
              {networkText === null && (
                <span className="dm-chip dm-flow-pv-fee" title={FEE_MEANING}>
                  {fee}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {view && price && state.range ? (
        <div key="range" className="dm-flow-pv-live dm-arrive" data-part="range">
          <div className="dm-flow-pv-price">
            <div className="dm-flow-pv-price-head">
              <span className="dm-flow-pv-label">{step === 'amount' ? CREATE.amount.now : CREATE.amount.rangeHeading}</span>
              {/* Changed on purpose 2026-09-28 (one-sided): a range beside today's price is a choice, not an alarm, so it is
                  said calmly (no red "Out of range"): the position earns once the price enters it. */}
              {view.inRange ? (
                <Badge kind="in-range" />
              ) : (
                <Pill data-preview-waits="">{CREATE.amount.earnsInRange}</Pill>
              )}
            </div>
            <p className="dm-flow-pv-price-line">
              <span className="dm-fig-lg">
                <LiveFigure value={price.text} direction="auto">
                  {plainFigure(price.text)}
                </LiveFigure>
              </span>
              {/* Changed on purpose (round 6, 2026-09-27): "USDG for 1 ETH", not "USDG per ETH". */}
              <span className="dm-flow-pv-unit">
                <SymbolText token={price.quote} /> for 1 <SymbolText token={price.base} />
              </span>
            </p>
          </div>
          <RangeStage view={view} poolTick={view.ticks.pool} lowerTick={view.ticks.lower} upperTick={view.ticks.upper} priceText={price.text} />
          <dl className="dm-flow-pv-bounds">
            <div>
              <dt>{CREATE.amount.lowest}</dt>
              <dd className="dm-fig-sm">
                <LiveFigure value={view.lowerText ?? ''} direction="none">
                  {words(view.lowerText)}
                </LiveFigure>
              </dd>
            </div>
            <div>
              <dt>{CREATE.amount.highest}</dt>
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
          <p className="dm-flow-preview-example">{CREATE.page.previewExample}</p>
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
            // One token alone: its row only, never "0" of the other.
            if (held.only !== null && index !== held.only) return null
            return (
              <div key={currency.address} className="dm-flow-pv-row">
                <TokenMark token={currency} size={28} />
                <span className="dm-flow-pv-amount dm-fig-xs">
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
                      <UsdText value={part.usd} floor />
                    </LiveFigure>
                  </span>
                )}
              </div>
            )
          })}
          {valued && (
            // The receipt's figure: it ticks, and a change tints it up or down for a moment (M7).
            <div className="dm-flow-pv-total">
              <span className="dm-flow-pv-label">{CREATE.page.previewTotal}</span>
              <span className="dm-fig-lg dm-arrive">
                {held.estimate && <span className="dm-flow-pv-about">{CREATE.review.about} </span>}
                <LiveFigure value={formatUsd(valued)} direction="auto">
                  <UsdText value={valued} floor />
                </LiveFigure>
              </span>
            </div>
          )}
        </div>
      )}

      {/* Where the ember rests while no pointer moves (new.html: 70px in from the card's left, 40px over its top). */}
      <span className="dm-np-ember-at" data-ember-rest="" aria-hidden="true" />
    </aside>
  )
}
