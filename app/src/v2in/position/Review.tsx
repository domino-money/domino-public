import type { ReactNode } from 'react'
import { IconChevronDown } from '../../components/icons'
import { SheetCard, SheetFact, SheetFacts, SheetMore } from '../../components/positions/ActionSheet'
import { Button, cx, FigureDash, Skeleton } from '../../components/ui'
import type { ZapReview, ZapWarning } from '../../finance/v2/zap'
import { CREATE } from '../../lib/create/copy'
import { v2Chain } from '../../v2/chains'
import { conversionSummary, ethAboutText, ethText, EXACT_FRACTION, feesToCome, feeTierText, networkFeeLine, planNetworkCost, priceText, rangeBothWays, shortAddress, smallerUpToPercent, spanText } from '../../v2/plan/present'
import type { S1PlanReply, S1PlanRequest } from '../../v2/plan/types'
import { ZERO_ADDRESS, type Address, type TokenAmount, type V2ChainId } from '../../v2/types'
import { HIGH_SLIPPAGE_COPY, POSITION_SLIPPAGE_WARN_ABOVE_BPS, UNCONVERTED_OFFER_ABOVE_PERCENT } from './constants'
import { COPY } from './copy'
import type { RunStep } from './run'
import { Amount, Note, Pair, Rows } from './ui'
import { amountText, decimalsOf, labelOf, shortAmountText, type TokenBook } from './tokens'

/**
 * The review of a position action's plan (spec F7 rev2 §2.6.1 "Revisão", §8.2): the network and the pool (its tokens
 * and tier; the Uniswap version only as a title and under Details, the lists' rule), the range both ways round, what goes
 * in or comes out (with its minimums, "At least"), the route leg by leg (expected and "At least", its pools' tiers), the
 * Domino fee with its token, amount and base (as planned: the receipt's FeeCharged is exact), what goes into the position
 * and how much smaller it may come out within the slippage (§2.9), what comes back, the network cost (L2 gas and the
 * plan's L1 data fee, per stack, §2.4), and how long the quote is good for. A converted exit says how much is converted
 * at least and how much may come back as is (§2.6.4), with a lower slippage or both tokens offered when that rest is
 * large. Copied from the S1 reference's ReviewView and PlanPreview, in this page's look.
 *
 * Changed on purpose 2026-10-03 (the owner, point 9: the dialogs were "literally ugly", a review of paragraphs): what moves
 * leads, as two joined cards of token rows (what you put in, or what comes out of the position, then what it becomes:
 * what goes into the position, or what comes back to your wallet); the fees, the minimums and the context follow as
 * quiet facts, the money first. The same figures, words and hooks.
 *
 * Changed on purpose 2026-10-06 (the owner's point 4: little text, as New position's Review): in view are only the two
 * cards (amounts at most 6 decimals, every digit in the row's title), ONE Domino fee line in §2.8's words, ONE network
 * fee line (the plan's cost, its L1 part a dash when unread, present.ts networkFeeLine), the new range of a change of
 * range, the converted exit's line with its offers, and the notes that keep you safe. The minimums, the route, the
 * leftovers of an add, the network fee's ceiling and L1 data fee, the deadline, the "up to X% smaller" line, the
 * position's range, pool and network, and "Paying with ETH needs a direct transaction." are under the one Details; the
 * developer facts (plan and route hashes, nonce, raw deadline, contract, raw liquidity, gas units, L1 fee in wei, block,
 * quote internals, the Uniswap version) only as its data-* attributes. `stale`: the last review, kept greyed while the
 * same choices are quoted again (./PositionDialog.tsx). As New position's Review: the network fee line counts the
 * approvals still to send (a part not read, or a fee not known yet, said in words), a slippage above 2% is said in view,
 * and the Domino fee and what you put in are rounded up (never shown lower than they are; what you put in is what the
 * wallet is asked to allow, and what the receipt says was paid in). Changed on purpose 2026-10-30 (QA round 2, N2: one
 * number format): every amount drawn at six significant digits, as New position's Review (./tokens.ts shortAmountText),
 * no longer six decimals; every digit still in its title.
 *
 * `review` is the zap client's: its legs, fee and warnings (the plan's own figures where it has none).
 */
export function Review({ chainId, book, reply, request, review = null, steps = [], feePerGas = null, at, stale = false, onLowerSlippage, onReceiveBoth, children }: {
  chainId: V2ChainId
  book: TokenBook
  reply: S1PlanReply
  request: S1PlanRequest
  review?: ZapReview | null
  steps?: readonly RunStep[]
  feePerGas?: bigint | null
  /** Unix seconds the plan is read as of: the review's moment. */
  at: number
  /** The last review, drawn greyed and busy while the same choices are quoted again. */
  stale?: boolean
  onLowerSlippage?: () => void
  onReceiveBoth?: () => void
  /** What the dialog adds before the closed Details: the warnings it owns, the tick, the wallet's steps. */
  children?: ReactNode
}) {
  const { plan: zapPlan, quote, facts } = reply
  const intent = zapPlan.plan.intent
  const pool = intent.pool
  const chain = v2Chain(chainId)
  const pair: readonly [Address, Address] = [pool.currency0, pool.currency1]
  const l0 = labelOf(book, pool.currency0)
  const l1 = labelOf(book, pool.currency1)
  const inputs: readonly TokenAmount[] = zapPlan.action === 'create' || zapPlan.action === 'increase' ? zapPlan.plan.inputs : []
  const removes = zapPlan.action === 'changeRange' || zapPlan.action === 'exit'
  const removed = quote.expectedRemoved ?? null
  const minRemoved = facts.minimums.removed
  const adds = zapPlan.action !== 'exit'
  const smaller = adds ? smallerUpToPercent(facts.expected.liquidity, facts.minimums.liquidity) : null
  const range = rangeBothWays(intent.tickLower, intent.tickUpper, decimalsOf(book, pool.currency0), decimalsOf(book, pool.currency1))
  const legs = zapPlan.plan.legs.map((leg, i) => ({
    tokenIn: leg.tokenIn,
    tokenOut: leg.tokenOut,
    amountIn: leg.amountIn,
    expectedOut: review?.legs[i]?.expectedOut ?? quote.legs[i]?.expectedOut ?? null,
    minAmountOut: leg.minAmountOut,
    pools: review?.legs[i]?.pools ?? quote.legs[i]?.pools ?? [],
    asQuoted: review?.legs[i]?.asQuoted ?? facts.legs[i]?.source === 'uniswap_trading_api',
  }))
  const l1Fee = facts.l1DataFee
  const cost = facts.gasUnits !== null && feePerGas !== null
    ? planNetworkCost({ gasUnits: facts.gasUnits, feePerGas, l1: l1Fee.status === 'ok' ? (l1Fee.source === 'op_gas_price_oracle' ? { source: l1Fee.source, wei: l1Fee.wei, upperBoundWei: l1Fee.upperBoundWei } : { source: l1Fee.source, wei: l1Fee.wei, l1GasUnits: l1Fee.l1GasUnits }) : null })
    : null
  // The plan's cost and the approvals still to send (each a transaction of its own), or a batch's own ceiling.
  const network = networkFeeLine({ cost, l1Available: l1Fee.status === 'ok', batchFee: steps.find((step) => step.kind === 'batch')?.feeWei ?? null, others: feesToCome(steps) })
  // Above 2%, said in view as New position's Review says it (the tolerance itself is under Details, set under Advanced).
  const slippageWarns = request.slippageBps > POSITION_SLIPPAGE_WARN_ABOVE_BPS
  const converted = zapPlan.action === 'exit' && zapPlan.plan.legs.length > 0 && removed
    ? conversionSummary({ pool, legs: zapPlan.plan.legs, expectedRemoved: removed, offerAbovePercent: UNCONVERTED_OFFER_ABOVE_PERCENT })
    : null
  const warnings = warningsOf(zapPlan.action, pool.dex, review)
  if (review?.replacesApproval) warnings.push({ key: 'replaces_approval', text: COPY.review.replacesApproval })
  const paysEth = inputs.some((input) => input.token === ZERO_ADDRESS)
  const fee = facts.fee
  const amount = (token: Address, raw: bigint) => <Amount chainId={chainId} book={book} token={token} raw={raw} />
  const returned = facts.expected.returned.length === 0
    ? <span>{COPY.review.leftoversNone}</span>
    : <Rows chainId={chainId} book={book} items={facts.expected.returned} size={zapPlan.action === 'exit' ? 'lg' : 'sm'} />
  const rangeFact = (
    <SheetFact label={COPY.review.range} data-position-review-range="">
      <RangeWords low={range.forward.low} high={range.forward.high} base={l0} quote={l1} />
      <span className="dm-pa-sub">
        <RangeWords low={range.inverse.low} high={range.inverse.high} base={l1} quote={l0} />
      </span>
    </SheetFact>
  )

  return (
    <div className={cx('dm-pa-field', stale && 'opacity-60 transition-opacity')} data-position-review={zapPlan.action} data-position-review-stale={stale ? '' : undefined} aria-busy={stale || undefined}>
      {/* What moves: where it comes from, then what it becomes. */}
      <div className="dm-pa-pair">
        {inputs.length > 0 && (
          // What goes in, as the wallet is asked to allow it (./Steps.tsx): the same figure, rounded up (2026-10-06).
          <SheetCard caption={COPY.review.youPut} data-position-review-inputs="">
            <Rows chainId={chainId} book={book} items={inputs} round="up" />
          </SheetCard>
        )}
        {removes && (
          <SheetCard caption={COPY.review.removed} data-position-review-removed="">
            {removed ? <Pair chainId={chainId} book={book} tokens={pair} amounts={removed} size="lg" /> : <p className="dm-pa-hero"><FigureDash reason={COPY.page.notReported} /></p>}
          </SheetCard>
        )}
        <span aria-hidden="true" className="dm-pa-link">
          <IconChevronDown size={16} />
        </span>
        {adds ? (
          <SheetCard caption={COPY.review.liquidity} data-position-min-liquidity="">
            <Pair chainId={chainId} book={book} tokens={pair} amounts={facts.expected.amounts} size="lg" />
          </SheetCard>
        ) : (
          <SheetCard caption={COPY.review.leftovers} data-position-leftovers="">
            {returned}
          </SheetCard>
        )}
      </div>
      <SheetFacts className="dm-receipt">
        {/* §2.8, one line: "Domino fee  3.25 USDG (0.65% of 500 USDG swapped)"; no fee reads as the direct exits' row does. */}
        <SheetFact label={COPY.review.fee} data-position-fee={fee ? 'charged' : 'none'}>
          {fee ? (
            <span>
              <span data-position-fee-amount="" title={amountText(book, fee.token, fee.amount, EXACT_FRACTION)}>{shortAmountText(book, fee.token, fee.amount, 'up')}</span> (
              <span data-position-fee-base="" title={COPY.review.feeBase(amountText(book, fee.token, fee.basis, EXACT_FRACTION))}>{COPY.review.feeBase(shortAmountText(book, fee.token, fee.basis))}</span>)
            </span>
          ) : (
            COPY.review.noFee
          )}
        </SheetFact>
        {/* §2.4, one line: the plan's cost and the approvals still to send (each read at the review, ./run.ts). Changed on
            purpose 2026-10-06 (the review of the owner's point 4, as New position's Review): a part that could not be read
            (the plan's L1 data fee, or an approval that waits for an earlier one) is one plain clause beside the figure,
            never "L1", a 0 or a bare dash in view; Details says which part. With no figure yet, the resting bubble while a
            step is checked, else the words (an armed root's steps are checked only once its box is ticked). */}
        <SheetFact
          label={COPY.review.networkFee}
          data-position-network-fee={network.kind}
          data-position-network-wei={network.kind === 'unknown' ? undefined : network.wei.toString()}
          data-position-network-others={network.kind === 'about' && network.othersMissing ? 'unprepared' : undefined}
          data-position-l1-fee={l1Fee.status === 'ok' ? l1Fee.wei.toString() : 'unavailable'}
        >
          <span className="tnum">
            {network.kind === 'about'
              ? COPY.review.networkAbout(ethAboutText(network.wei))
              : network.kind === 'upTo'
                ? COPY.review.networkFeeUpTo(ethText(network.wei))
                : !stale && steps.some((step) => step.status === 'preparing')
                  ? <Skeleton className="inline-block h-[1em] w-24 align-middle" />
                  : COPY.review.networkUnknown}
            {network.kind === 'about' && (network.l1Missing || network.othersMissing) && `, ${COPY.review.networkMore}`}
          </span>
        </SheetFact>
        {/* A change of range is about its new range: said in view. */}
        {zapPlan.action === 'changeRange' && rangeFact}
      </SheetFacts>
      {converted && (
        <div className="dm-pa-field" data-position-converted={converted.offer ? 'offer' : 'ok'}>
          <Note>{COPY.review.converted(`${(request.slippageBps / 100).toString()}%`, shortAmountText(book, converted.token, converted.converted), shortAmountText(book, converted.token, converted.rest))}</Note>
          {converted.offer && (onLowerSlippage || onReceiveBoth) && !stale && (
            <div className="flex flex-wrap gap-2">
              {onLowerSlippage && <Button type="button" variant="outline" size="sm" onClick={onLowerSlippage} data-position-lower-slippage="">{COPY.review.lowerSlippage}</Button>}
              {onReceiveBoth && <Button type="button" variant="outline" size="sm" onClick={onReceiveBoth} data-position-receive-both="">{COPY.review.receiveBoth}</Button>}
            </div>
          )}
        </div>
      )}
      {(slippageWarns || warnings.length > 0) && (
        <div className="dm-pa-notes">
          {slippageWarns && <Note data-position-slippage-warning="">{HIGH_SLIPPAGE_COPY}</Note>}
          {warnings.map((warning) => (
            <Note key={warning.key} data-position-warning={warning.key}>{warning.text}</Note>
          ))}
        </div>
      )}
      {children}
      {/* The developer facts stay on the element for tests and support, never as text (2026-10-06, the owner's point 4). */}
      <SheetMore
        label={COPY.review.details}
        data-position-review-details=""
        data-plan-hash={review?.intentHash ?? reply.document.intentHash}
        data-routes-hash={intent.routesHash}
        data-nonce={intent.nonce.toString()}
        data-deadline={intent.deadline.toString()}
        data-zap={review?.zap ?? reply.document.zap}
        data-liquidity={`${facts.expected.liquidity.toString()} ${intent.minLiquidity.toString()}`}
        data-gas-units={facts.gasUnits === null ? '' : facts.gasUnits.toString()}
        data-l1-wei={l1Fee.status === 'ok' ? `${l1Fee.wei.toString()} ${l1Fee.source}` : `unavailable ${l1Fee.source}`}
        data-read-block={review ? review.block.toString() : ''}
        data-dex={`v${pool.dex}`}
        data-quote={`${facts.contractVersion} ${facts.block.number.toString()} ${facts.simulation.status}${facts.simulation.reason ? ` ${facts.simulation.reason}` : ''} ${facts.expiresAt} ${facts.routing}`}
      >
        {(smaller !== null || paysEth) && (
          <div className="dm-pa-notes">
            {smaller !== null && <Note data-position-smaller={smaller}>{COPY.review.smaller(smaller)}</Note>}
            {paysEth && <Note data-position-warning="eth_direct">{COPY.review.ethDirect}</Note>}
          </div>
        )}
        <SheetFacts data-position-review-facts="">
          {removes && minRemoved && (
            <SheetFact label={COPY.review.atLeast} data-position-at-least="">
              <Pair chainId={chainId} book={book} tokens={pair} amounts={minRemoved} />
            </SheetFact>
          )}
          {legs.map((leg, i) => (
            <SheetFact key={i} label={legs.length > 1 ? `${COPY.review.route} ${i + 1}` : COPY.review.route} data-position-route-leg={String(i)}>
              <span>{amount(leg.tokenIn, leg.amountIn)} → {labelOf(book, leg.tokenOut)}</span>
              {leg.expectedOut !== null && <span className="dm-pa-sub" title={amountText(book, leg.tokenOut, leg.expectedOut, EXACT_FRACTION)}>{COPY.review.expected} {shortAmountText(book, leg.tokenOut, leg.expectedOut)}</span>}
              <span className="dm-pa-sub" data-position-leg-at-least="" title={amountText(book, leg.tokenOut, leg.minAmountOut, EXACT_FRACTION)}>{COPY.review.atLeast} {shortAmountText(book, leg.tokenOut, leg.minAmountOut)}</span>
              <span className="dm-pa-sub" title={leg.pools.map((p) => `${COPY.page.version(p.dex)} · ${feeTierText(p.fee)}`).join(', ')}>
                {leg.pools.map((p) => `${COPY.page.uniswap} · ${feeTierText(p.fee)}`).join(', ')}
                {leg.asQuoted && ` (${COPY.review.asQuoted})`}
              </span>
            </SheetFact>
          ))}
          {adds && (
            <SheetFact label={COPY.review.leftovers} data-position-leftovers="">
              {returned}
            </SheetFact>
          )}
          {/* Base's ceiling, under a label of its own (with the approvals the line in view counts, so never below it). */}
          {network.kind === 'about' && network.ceiling !== null && (
            <SheetFact label={COPY.review.networkCeiling} data-position-network-ceiling="">
              <span className="tnum">
                {ethText(network.ceiling)}
                {network.othersMissing && (
                  <>
                    {' + '}
                    {COPY.review.networkOthers} <FigureDash reason={COPY.review.networkUnknown} />
                  </>
                )}
              </span>
            </SheetFact>
          )}
          <SheetFact label={COPY.review.l1Fee} data-position-l1="">
            <span className="tnum">{l1Fee.status === 'ok' ? ethText(l1Fee.wei) : <FigureDash reason={COPY.review.l1Unavailable} />}</span>
          </SheetFact>
          <SheetFact label={COPY.review.deadline} data-position-deadline="">{COPY.review.deadlineValue(spanText(facts.expiresAt - Math.floor(at)))}</SheetFact>
          {zapPlan.action !== 'changeRange' && rangeFact}
          <SheetFact label={COPY.review.pool} data-position-review-pool="">
            <span title={`${COPY.page.version(pool.dex)} · ${pool.currency0} / ${pool.currency1}`}>
              {l0} / {l1} · {COPY.page.uniswap} · {feeTierText(pool.fee)}
            </span>
          </SheetFact>
          <SheetFact label={COPY.review.network}>{chain.name}</SheetFact>
          {/* Changed on purpose 2026-10-06 (the review of point 4): the tokens' contracts as New position's Details names
              them ("ETH (native)", never the zero address), each in full in its title; the version only as data-dex. */}
          <SheetFact label={CREATE.review.detailRows.contracts} data-position-review-tokens="">
            <span className="tnum">
              <span title={pool.currency0}>{contractText(pool.currency0)}</span> / <span title={pool.currency1}>{contractText(pool.currency1)}</span>
            </span>
          </SheetFact>
          {intent.tokenId > 0n && <SheetFact label={COPY.page.nftId}>{intent.tokenId.toString()}</SheetFact>}
          <SheetFact label={COPY.review.slippageLabel}>{`${request.slippageBps / 100}%`}</SheetFact>
        </SheetFacts>
      </SheetMore>
    </div>
  )
}

/** A token's contract as New position's Details writes it: "ETH (native)" for the native currency, else its short address. */
function contractText(token: Address): string {
  return token === ZERO_ADDRESS ? `ETH (${CREATE.review.detailRows.native})` : shortAddress(token)
}

function RangeWords({ low, high, base, quote }: { low: number | null; high: number | null; base: string; quote: string }): ReactNode {
  const a = priceText(low)
  const b = priceText(high)
  if (a === null || b === null) return <span><FigureDash reason="Decimals unknown" /></span>
  return (
    <span>
      1 {base} = {a} to {b} {quote}
    </span>
  )
}

/** The review's warnings (the zap client's closed keys; the action's own without a client review). The WETH note is a v3 pool's alone. */
function warningsOf(action: ZapReview['action'], dex: 3 | 4, review: ZapReview | null): { key: string; text: string }[] {
  const keys: ZapWarning[] = review ? review.warnings.filter((key) => key !== 'exit_conversion_dust' && (key !== 'v3_weth_leftovers' || dex === 3)) : [...(dex === 4 && action === 'increase' ? ['v4_increase_sends_fees' as const] : []), ...(action === 'changeRange' ? ['change_range_new_nft' as const] : [])]
  return keys.map((key) => ({ key, text: warningText(key as Exclude<ZapWarning, 'exit_conversion_dust'>) }))
}

function warningText(key: Exclude<ZapWarning, 'exit_conversion_dust'>): string {
  switch (key) {
    case 'v3_weth_leftovers': return COPY.review.wethWarning
    case 'v4_increase_sends_fees': return COPY.review.feesSent
    case 'change_range_new_nft': return COPY.review.newNft
    case 'nft_approval_stays': return COPY.review.approvalStays
  }
}
