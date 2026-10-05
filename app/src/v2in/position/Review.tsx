import type { ReactNode } from 'react'
import { IconChevronDown } from '../../components/icons'
import { SheetCard, SheetFact, SheetFacts, SheetMore } from '../../components/positions/ActionSheet'
import { Button, FigureDash, KeyValue, KeyValueList } from '../../components/ui'
import type { ZapReview, ZapWarning } from '../../finance/v2/zap'
import { v2Chain } from '../../v2/chains'
import { conversionSummary, ethText, feeTierText, planNetworkCost, priceText, rangeBothWays, shortAddress, smallerUpToPercent, spanText } from '../../v2/plan/present'
import type { S1PlanReply, S1PlanRequest } from '../../v2/plan/types'
import { ZERO_ADDRESS, type Address, type TokenAmount, type V2ChainId } from '../../v2/types'
import { UNCONVERTED_OFFER_ABOVE_PERCENT } from './constants'
import { COPY } from './copy'
import type { RunStep } from './run'
import { Amount, Note, Pair, Rows } from './ui'
import { amountText, decimalsOf, labelOf, type TokenBook } from './tokens'

/**
 * The review of a position action's plan (spec F7 rev2 §2.6.1 "Revisão", §8.2): the network and the pool (its tokens
 * and tier; the Uniswap version only as a title and under Details, the lists' rule), the range both ways round, what goes
 * in or comes out (with its minimums, "At least"), the route leg by leg (expected and "At least", its pools' tiers), the
 * Domino fee with its token, amount and base (as planned: the receipt's FeeCharged is exact), what goes into the position
 * and how much smaller it may come out within the slippage (§2.9), what comes back, the network cost (L2 gas and the
 * plan's L1 data fee, per stack, §2.4), and how long the quote is good for. A converted exit says how much is converted
 * at least and how much may come back as is (§2.6.4), with a lower slippage or both tokens offered when that rest is
 * large. Technical detail only under "Details". Copied from the S1 reference's ReviewView and PlanPreview, in this page's
 * look.
 *
 * Changed on purpose 2026-10-03 (the owner, point 9: the dialogs were "literally ugly", a review of paragraphs): what moves
 * leads, as two joined cards of token rows (what you put in, or what comes out of the position, then what it becomes:
 * what goes into the position, or what comes back to your wallet); the fees, the minimums and the context follow as
 * quiet facts, the money first. The same figures, words and hooks.
 *
 * `review` is the zap client's: its legs, fee and warnings (the plan's own figures where it has none).
 */
export function Review({ chainId, book, reply, request, review = null, steps = [], feePerGas = null, at, onLowerSlippage, onReceiveBoth, children }: {
  chainId: V2ChainId
  book: TokenBook
  reply: S1PlanReply
  request: S1PlanRequest
  review?: ZapReview | null
  steps?: readonly RunStep[]
  feePerGas?: bigint | null
  /** Unix seconds the plan is read as of: the review's moment. */
  at: number
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
  const known = steps.filter((step) => step.feeWei !== null)
  const feeSum = known.reduce((sum, step) => sum + (step.feeWei ?? 0n), 0n)
  const l1Fee = facts.l1DataFee
  const cost = facts.gasUnits !== null && feePerGas !== null
    ? planNetworkCost({ gasUnits: facts.gasUnits, feePerGas, l1: l1Fee.status === 'ok' ? (l1Fee.source === 'op_gas_price_oracle' ? { source: l1Fee.source, wei: l1Fee.wei, upperBoundWei: l1Fee.upperBoundWei } : { source: l1Fee.source, wei: l1Fee.wei, l1GasUnits: l1Fee.l1GasUnits }) : null })
    : null
  const converted = zapPlan.action === 'exit' && zapPlan.plan.legs.length > 0 && removed
    ? conversionSummary({ pool, legs: zapPlan.plan.legs, expectedRemoved: removed, offerAbovePercent: UNCONVERTED_OFFER_ABOVE_PERCENT })
    : null
  const warnings = warningsOf(zapPlan.action, pool.dex, review)
  if (inputs.some((input) => input.token === ZERO_ADDRESS)) warnings.push({ key: 'eth_direct', text: COPY.review.ethDirect })
  if (review?.replacesApproval) warnings.push({ key: 'replaces_approval', text: COPY.review.replacesApproval })
  const fee = facts.fee
  const amount = (token: Address, raw: bigint, maxFraction?: number) => <Amount chainId={chainId} book={book} token={token} raw={raw} maxFraction={maxFraction} />
  const returned = facts.expected.returned.length === 0
    ? <span>{COPY.review.leftoversNone}</span>
    : <Rows chainId={chainId} book={book} items={facts.expected.returned} size={zapPlan.action === 'exit' ? 'lg' : 'sm'} />

  return (
    <div className="dm-pa-field" data-position-review={zapPlan.action}>
      {/* What moves: where it comes from, then what it becomes. */}
      <div className="dm-pa-pair">
        {inputs.length > 0 && (
          <SheetCard caption={COPY.review.youPut} data-position-review-inputs="">
            <Rows chainId={chainId} book={book} items={inputs} />
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
            {smaller !== null ? <p className="dm-pa-sub" data-position-smaller={smaller}>{COPY.review.smaller(smaller)}</p> : <FigureDash reason={COPY.page.notReported} />}
          </SheetCard>
        ) : (
          <SheetCard caption={COPY.review.leftovers} data-position-leftovers="">
            {returned}
          </SheetCard>
        )}
      </div>
      <SheetFacts className="dm-receipt">
        {removes && minRemoved && (
          <SheetFact label={COPY.review.atLeast} data-position-at-least="">
            <Pair chainId={chainId} book={book} tokens={pair} amounts={minRemoved} />
          </SheetFact>
        )}
        {legs.map((leg, i) => (
          <SheetFact key={i} label={legs.length > 1 ? `${COPY.review.route} ${i + 1}` : COPY.review.route} data-position-route-leg={String(i)}>
            <span>{amount(leg.tokenIn, leg.amountIn)} → {labelOf(book, leg.tokenOut)}</span>
            {leg.expectedOut !== null && <span className="dm-pa-sub">{COPY.review.expected} {amountText(book, leg.tokenOut, leg.expectedOut)}</span>}
            <span className="dm-pa-sub" data-position-leg-at-least="">{COPY.review.atLeast} {amountText(book, leg.tokenOut, leg.minAmountOut)}</span>
            <span className="dm-pa-sub" title={leg.pools.map((p) => `${COPY.page.version(p.dex)} · ${feeTierText(p.fee)}`).join(', ')}>
              {leg.pools.map((p) => `${COPY.page.uniswap} · ${feeTierText(p.fee)}`).join(', ')}
              {leg.asQuoted && ` (${COPY.review.asQuoted})`}
            </span>
          </SheetFact>
        ))}
        {/* No fee reads as the direct exits' row does: "Domino fee", then "No Domino fee". */}
        <SheetFact label={COPY.review.fee} data-position-fee={fee ? 'charged' : 'none'}>
          {fee ? (
            <>
              <span data-position-fee-amount="">{amount(fee.token, fee.amount, 18)}</span>
              <span className="dm-pa-sub" data-position-fee-base="">{COPY.review.feeBase(amountText(book, fee.token, fee.basis, 18))}</span>
              <span className="dm-pa-sub">{COPY.review.feeEstimate}</span>
            </>
          ) : (
            COPY.review.noFee
          )}
        </SheetFact>
        {adds && (
          <SheetFact label={COPY.review.leftovers} data-position-leftovers="">
            {returned}
          </SheetFact>
        )}
        <SheetFact label={COPY.review.networkFee} data-position-network-fee="">
          <span>{known.length > 0 ? COPY.review.networkFeeUpTo(ethText(feeSum)) : COPY.review.networkFeeLater}</span>
          {cost !== null && <span className="dm-pa-sub" data-position-network-quoted="">{COPY.review.networkFeeQuoted(ethText(cost.total))}</span>}
          {cost !== null && cost.ceiling !== null && <span className="dm-pa-sub">{COPY.review.networkFeeCeiling(ethText(cost.ceiling))}</span>}
          <span className="dm-pa-sub" data-position-l1-fee={l1Fee.status === 'ok' ? l1Fee.wei.toString() : 'unavailable'}>
            {COPY.review.l1Fee}: {l1Fee.status === 'ok' ? ethText(l1Fee.wei) : <FigureDash reason={COPY.review.l1Unavailable} />}
          </span>
        </SheetFact>
        <SheetFact label={COPY.review.deadline} data-position-deadline="">{COPY.review.deadlineValue(spanText(facts.expiresAt - Math.floor(at)))}</SheetFact>
        <SheetFact label={COPY.review.range} data-position-review-range="">
          <RangeWords low={range.forward.low} high={range.forward.high} base={l0} quote={l1} />
          <span className="dm-pa-sub">
            <RangeWords low={range.inverse.low} high={range.inverse.high} base={l1} quote={l0} />
          </span>
        </SheetFact>
        <SheetFact label={COPY.review.pool} data-position-review-pool="">
          <span title={`${COPY.page.version(pool.dex)} · ${pool.currency0} / ${pool.currency1}`}>
            {l0} / {l1} · {COPY.page.uniswap} · {feeTierText(pool.fee)}
          </span>
        </SheetFact>
        <SheetFact label={COPY.review.network}>{chain.name}</SheetFact>
      </SheetFacts>
      {converted && (
        <div className="dm-pa-field" data-position-converted={converted.offer ? 'offer' : 'ok'}>
          <Note>{COPY.review.converted(`${(request.slippageBps / 100).toString()}%`, amountText(book, converted.token, converted.converted), amountText(book, converted.token, converted.rest))}</Note>
          {converted.offer && (onLowerSlippage || onReceiveBoth) && (
            <div className="flex flex-wrap gap-2">
              {onLowerSlippage && <Button type="button" variant="outline" size="sm" onClick={onLowerSlippage} data-position-lower-slippage="">{COPY.review.lowerSlippage}</Button>}
              {onReceiveBoth && <Button type="button" variant="outline" size="sm" onClick={onReceiveBoth} data-position-receive-both="">{COPY.review.receiveBoth}</Button>}
            </div>
          )}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="dm-pa-notes">
          {warnings.map((warning) => (
            <Note key={warning.key} data-position-warning={warning.key}>{warning.text}</Note>
          ))}
        </div>
      )}
      {children}
      <SheetMore label={COPY.review.details} data-position-review-details="">
        <KeyValueList>
          <KeyValue label="Plan hash" mono>{review?.intentHash ?? reply.document.intentHash}</KeyValue>
          <KeyValue label="Route hash" mono>{intent.routesHash}</KeyValue>
          <KeyValue label="Signature nonce" mono>{intent.nonce.toString()}</KeyValue>
          <KeyValue label="Deadline" mono>{intent.deadline.toString()}</KeyValue>
          <KeyValue label="Domino contract" mono>{review?.zap ?? reply.document.zap}</KeyValue>
          <KeyValue label={COPY.page.uniswapVersion} mono>v{pool.dex}</KeyValue>
          <KeyValue label="Pool tokens" mono>{shortAddress(pool.currency0)} / {shortAddress(pool.currency1)}</KeyValue>
          <KeyValue label="Position" mono>{intent.tokenId.toString()}</KeyValue>
          <KeyValue label="Liquidity" mono>{facts.expected.liquidity.toString()} (minimum {intent.minLiquidity.toString()})</KeyValue>
          <KeyValue label="Gas (L2)" mono>{facts.gasUnits === null ? '—' : facts.gasUnits.toString()}</KeyValue>
          <KeyValue label="L1 data fee" mono>{l1Fee.status === 'ok' ? `${l1Fee.wei.toString()} wei (${l1Fee.source})` : `unavailable (${l1Fee.source})`}</KeyValue>
          {review && <KeyValue label="Read at block" mono>{review.block.toString()}</KeyValue>}
          <KeyValue label="Quote" mono>{facts.contractVersion}, block {facts.block.number.toString()}, simulation {facts.simulation.status}{facts.simulation.reason ? ` (${facts.simulation.reason})` : ''}, expires {facts.expiresAt}</KeyValue>
          <KeyValue label="Routing" mono>{facts.routing}</KeyValue>
          <KeyValue label="Slippage" mono>{request.slippageBps} bps</KeyValue>
        </KeyValueList>
      </SheetMore>
    </div>
  )
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
