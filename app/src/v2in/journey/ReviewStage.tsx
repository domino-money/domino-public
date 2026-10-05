import type { ReactNode } from 'react'
import { PlainArt } from '../../components/automate/ModeArt'
import { IconChevronRight } from '../../components/icons'
import { Button, FigureDash } from '../../components/ui'
import { CREATE } from '../../lib/create/copy'
import { rangePosition } from '../../lib/read/screens/poolRange'
import type { ReceiptLine } from '../../finance/v2/receipt'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import { ethText, planNetworkCost, priceText, rangeBothWays, smallerUpToPercent, spanText } from '../../v2/plan/present'
import { ZERO_ADDRESS, type Address } from '../../v2/types'
import { v2PositionHref } from '../route'
import { JOURNEY_HIGH_SLIPPAGE_COPY, JOURNEY_SLIPPAGE_WARNING_ABOVE_BPS, NEW_POOL_CONFIRM_COPY, NEW_POOL_TITLE } from './constants'
import { JOURNEY } from './copy'
import { dexName, feePercent } from './model/pools'
import type { JourneyPriceState } from './model/price'
import type { JourneyState } from './model/state'
import { ErrorLine, Note, PoolChips, Tick, TokenDiscPair, TokenName } from './parts'
import { stepDetail, stepTitle, type RunStep, type RunView } from './run'
import { amountText, decimalsOf, labelOf, tokenBook, type TokenBook } from './tokens'

type Gate = Extract<V2Gate, { mode: 'preview' | 'live' }>

/** What each step says under its title once Create position runs (today's Review's own captions, plus "Included" and "Finalized"). */
const LIVE: Record<RunStep['status'], string> = {
  waiting: JOURNEY.live.next,
  preparing: JOURNEY.live.preparing,
  ready: '',
  wallet: JOURNEY.live.wallet,
  sent: JOURNEY.live.sent,
  unknown: JOURNEY.live.failed,
  included: JOURNEY.live.included,
  finalized: JOURNEY.live.finalized,
}

/** A step's marker state in today's list of wallet steps (styles/flow.css .dm-flow-wsteps). */
function markerOf(step: RunStep): 'done' | 'current' | undefined {
  if (step.status === 'included' || step.status === 'finalized') return 'done'
  if (step.status === 'wallet' || step.status === 'sent' || step.status === 'preparing') return 'current'
  return undefined
}

/** The figures a review draws, from a `live` review (the zap client's); null before one (and always under `preview`). */
function figuresOf(view: RunView) {
  if (!view.reviewed) return null
  const { review, reply, request } = view.reviewed
  return { reply, request, legs: review.legs, warnings: review.warnings as readonly string[], createsPool: review.createsPool, replacesApproval: review.replacesApproval !== null, quoteLeft: reply.facts.expiresAt - Math.floor(view.reviewed.at) }
}

/**
 * Step 4, Review, on Domino's new contracts, in today's Review's look (components/create/StageReview.tsx): the position at
 * the top, then what the plan does in plain words, then the wallet's steps, then the technical facts under a closed
 * Details. Everything spec F7 rev2 §2.6.1 "Revisão" and §8.2 "S1, criar" ask for: the pool by its tokens, its network and
 * tier (the DEX as ./parts.tsx PoolChips says it: never its version as text); the range both ways round; what goes in; the
 * route leg by leg with what it should and must deliver and its pools' tiers; the Domino fee in today's words with its
 * token, amount and base ("0.65% of {amount} {token} swapped"; the receipt is exact); the liquidity expected and how much
 * smaller it may come out within the slippage (§2.9); what comes back; the network cost with the L2 gas and the plan's L1
 * data fee per stack (§2.4); how long the quote is good for and what is signed for.
 *
 * Under a `preview` gate no plan is asked (real data only: nothing stands in): the review shows what was chosen (`asked`),
 * and the wallet's steps are not drawn: the gate's sentence stands in their place, once, under Create position too.
 */
export function ReviewStage({ state, gate, view, price, confirmed, onConfirmed, onRejected, onNewPool, onPoolRace }: {
  state: JourneyState
  gate: Gate
  view: RunView
  price: JourneyPriceState | null
  confirmed: boolean
  onConfirmed: (next: boolean) => void
  onRejected: () => void
  onNewPool: () => void
  onPoolRace: () => void
}) {
  const pool = state.pool
  if (!pool) return null
  const chain = v2Chain(state.chainId)
  const figures = figuresOf(view)
  const facts = figures?.reply.facts ?? null
  const book: TokenBook = tokenBook(state.chainId, [...pool.tokens])
  const amount = (token: Address, raw: bigint, maxFraction = 6) => amountText(book, token, raw, maxFraction)
  const [l0, l1] = [labelOf(book, pool.pool.currency0), labelOf(book, pool.pool.currency1)]
  const range = state.range
  const both = range ? rangeBothWays(range.lower, range.upper, decimalsOf(book, pool.pool.currency0), decimalsOf(book, pool.pool.currency1)) : null
  const usable = price && price.state === 'usable' ? price : null
  const inside = usable && range ? rangePosition(range, usable.tick) === 'inside' : null
  const slippage = Number(state.slippage)
  const smaller = facts ? smallerUpToPercent(facts.expected.liquidity, facts.minimums.liquidity) : null
  const inputs = figures?.request.inputs ?? view.asked?.inputs ?? []
  const paysEth = inputs.some((input) => input.token === ZERO_ADDRESS)
  const warnings: { key: string; text: string }[] = []
  if (figures) {
    for (const key of figures.warnings) {
      // Said for a v3 pool only (the zap client raises it for one): "On this pool…", never a version on screen.
      if (key === 'v3_weth_leftovers' && pool.pool.dex === 3) warnings.push({ key, text: JOURNEY.review.wethWarning })
      if (key === 'nft_approval_stays') warnings.push({ key, text: JOURNEY.review.approvalStays })
    }
    if (paysEth) warnings.push({ key: 'eth_direct', text: JOURNEY.review.ethDirect })
    if (figures.replacesApproval) warnings.push({ key: 'replaces_approval', text: JOURNEY.review.replacesApproval })
    if (figures.createsPool) warnings.push({ key: 'new_pool_gas', text: JOURNEY.newPool.gas })
  }
  const known = view.steps.filter((step) => step.feeWei !== null)
  const feeSum = known.reduce((sum, step) => sum + (step.feeWei ?? 0n), 0n)
  const l1Fee = facts?.l1DataFee ?? null
  const cost = facts && facts.gasUnits !== null && view.feePerGas !== null && l1Fee
    ? planNetworkCost({ gasUnits: facts.gasUnits, feePerGas: view.feePerGas, l1: l1Fee.status === 'ok' ? (l1Fee.source === 'op_gas_price_oracle' ? { source: l1Fee.source, wei: l1Fee.wei, upperBoundWei: l1Fee.upperBoundWei } : { source: l1Fee.source, wei: l1Fee.wei, l1GasUnits: l1Fee.l1GasUnits }) : null })
    : null
  const fee = facts?.fee ?? null
  const recovery = view.error?.recovery
  const permit2 = chain.permit2 as Address

  return (
    <div className="dm-flow-stack" data-stage="review" data-zap-review={gate.mode} data-zap-review-stage={view.stage}>
      {view.stage === 'quoting' && (
        <p role="status" className="dm-flow-position" data-tone="neutral" data-zap-quoting="">
          <span>{view.requoting ? JOURNEY.review.requoting : JOURNEY.review.quoting}</span>
        </p>
      )}
      <section aria-labelledby="zap-choices-heading" className="dm-flow-section">
        <h3 id="zap-choices-heading" className="dm-flow-subtitle">
          {CREATE.review.choices}
        </h3>
        <div className="dm-flow-headline" data-review-headline="">
          <p className="dm-flow-headline-pair">
            <TokenDiscPair chainId={state.chainId} first={pool.tokens[0]} second={pool.tokens[1]} size={24} ring="var(--flow-well, var(--surface-1))" />
            <span className="min-w-0" data-review-pool="">
              <TokenName token={pool.tokens[0]} /> / <TokenName token={pool.tokens[1]} />
            </span>
          </p>
          <PoolChips chainId={state.chainId} dex={pool.pool.dex} fee={pool.pool.fee} />
          <p className="dm-flow-headline-amounts tnum" data-review-amounts="">
            {facts ? `${amount(pool.pool.currency0, facts.expected.amounts[0])} + ${amount(pool.pool.currency1, facts.expected.amounts[1])}` : CREATE.page.notChosen}
          </p>
          {inputs.length > 0 && (
            <p className="dm-flow-headline-line tnum" data-review-inputs="">
              {JOURNEY.review.youPut} {inputs.map((input) => amount(input.token, input.amount)).join(' + ')}.
            </p>
          )}
          <p className="dm-flow-headline-line tnum" data-review-range="">
            {CREATE.amount.rangeHeading}:{' '}
            {both && priceText(both.forward.low) && priceText(both.forward.high)
              ? `1 ${l0} = ${priceText(both.forward.low)} to ${priceText(both.forward.high)} ${l1} · 1 ${l1} = ${priceText(both.inverse.low) ?? '—'} to ${priceText(both.inverse.high) ?? '—'} ${l0}`
              : range ? CREATE.review.summary.rangeTicks(range.lower, range.upper) : CREATE.page.notChosen}
          </p>
        </div>
        {slippage > JOURNEY_SLIPPAGE_WARNING_ABOVE_BPS && <Note data-review-slippage-warning="">{JOURNEY_HIGH_SLIPPAGE_COPY}</Note>}
        {inside === false && <Note data-review-position="">{CREATE.review.outOfRange}</Note>}
        {warnings.map((warning) => (
          <Note key={warning.key} data-review-warning={warning.key}>
            {warning.text}
          </Note>
        ))}
        {/* A failure before any step (the quote) is said here; once there are steps, under Create position. */}
        <ErrorLine error={view.steps.length === 0 ? view.error : null} onRejected={onRejected} busy={view.busy} />
        {recovery === 'offer-new-pool' && (
          <Button type="button" variant="outline" size="md" className="w-full" onClick={onNewPool} data-review-offer-new-pool="">
            {NEW_POOL_TITLE}
          </Button>
        )}
        {recovery === 'pool-race' && (
          <Button type="button" variant="outline" size="md" className="w-full" onClick={onPoolRace} data-review-pool-race="">
            {JOURNEY.review.reviewAgain}
          </Button>
        )}
      </section>

      {facts && figures && (
        <section aria-labelledby="zap-plan-heading" className="dm-flow-section" data-review-plan="">
          <h3 id="zap-plan-heading" className="sr-only">
            {CREATE.review.details}
          </h3>
          <dl className="dm-flow-facts">
            {facts.initialPrice && (
              <Fact label={JOURNEY.newPool.price} data="review-start">
                {`1 ${l0} = ${facts.initialPrice.price0In1} ${l1} · 1 ${l1} = ${facts.initialPrice.price1In0} ${l0}`}
              </Fact>
            )}
            {figures.legs.map((leg, i) => (
              <Fact key={i} label={figures.legs.length > 1 ? `${JOURNEY.review.route} ${i + 1}` : JOURNEY.review.route} data={`route-leg-${i}`}>
                <span className="block">{amount(leg.tokenIn, leg.amountIn)} → {labelOf(book, leg.tokenOut)}</span>
                <span className="block text-fg-muted">{JOURNEY.review.expected} {amount(leg.tokenOut, leg.expectedOut)}</span>
                <span className="block" data-review-at-least="">{JOURNEY.review.atLeast} {amount(leg.tokenOut, leg.minAmountOut)}</span>
                <span className="block text-fg-subtle">
                  {/* Each pool of the leg by its tier; the DEX says "Uniswap", its version in the title only (./parts.tsx PoolChips' rule). */}
                  {leg.pools.map((p, j) => (
                    <span key={j} title={dexName(p.dex)} data-route-pool-dex={p.dex}>{`${j > 0 ? ', ' : ''}Uniswap · ${feePercent(p.fee)}`}</span>
                  ))}
                  {leg.asQuoted ? ` (${JOURNEY.review.asQuoted})` : ''}
                </span>
              </Fact>
            ))}
            <Fact label={fee ? JOURNEY.review.fee : JOURNEY.review.noFee} data="review-fee" attrs={{ 'data-review-fee-state': fee ? 'charged' : 'none' }}>
              {fee ? (
                <>
                  <span className="block" data-review-fee-amount="">{amount(fee.token, fee.amount, 18)}</span>
                  <span className="block">
                    <span className="dm-chip" data-review-fee-base="">{JOURNEY.review.feeBase(amount(fee.token, fee.basis, 18))}</span>
                  </span>
                  <span className="block text-fg-subtle">{JOURNEY.review.feeEstimate}</span>
                </>
              ) : (
                '—'
              )}
            </Fact>
            <Fact label={JOURNEY.review.goesIn} data="review-liquidity">
              <span className="block">{`${amount(pool.pool.currency0, facts.expected.amounts[0])} + ${amount(pool.pool.currency1, facts.expected.amounts[1])}`}</span>
            </Fact>
            <Fact label={JOURNEY.review.leftovers} data="review-leftovers">
              {facts.expected.returned.length === 0 ? JOURNEY.review.leftoversNone : facts.expected.returned.map((item) => <span key={item.token} className="block">{amount(item.token, item.amount)}</span>)}
            </Fact>
            <Fact label={JOURNEY.review.networkFee} data="review-network-fee">
              <span className="block">{known.length > 0 ? JOURNEY.review.networkFeeUpTo(ethText(feeSum)) : JOURNEY.review.networkFeeLater}</span>
              {cost !== null && <span className="block text-fg-muted" data-review-network-quoted="">{JOURNEY.review.networkFeeQuoted(ethText(cost.total))}</span>}
              {cost !== null && cost.ceiling !== null && <span className="block text-fg-subtle">{JOURNEY.review.networkFeeCeiling(ethText(cost.ceiling))}</span>}
              <span className="block text-fg-subtle" data-review-l1-fee={l1Fee && l1Fee.status === 'ok' ? l1Fee.wei.toString() : 'unavailable'}>
                {JOURNEY.review.l1Fee}: {l1Fee && l1Fee.status === 'ok' ? ethText(l1Fee.wei) : <FigureDash reason={JOURNEY.review.l1Unavailable} />}
              </span>
            </Fact>
            <Fact label={JOURNEY.review.deadline} data="review-deadline">
              <span className="block">{JOURNEY.review.deadlineValue(spanText(figures.quoteLeft))}</span>
              <span className="block text-fg-subtle">{JOURNEY.review.signedFor(spanText(Number(facts.deadline) - facts.requestedAt))}</span>
            </Fact>
          </dl>
        </section>
      )}

      {facts && (
        smaller !== null ? (
          <Note data-review-smaller={smaller}>{JOURNEY.review.smaller(smaller)}</Note>
        ) : (
          <Note data-review-smaller="unreported">
            {JOURNEY.review.goesIn}: <FigureDash reason="Not reported" />
          </Note>
        )
      )}

      {facts && figures?.createsPool && (
        <Tick checked={confirmed} onChange={onConfirmed} data-new-pool-confirm="">
          {NEW_POOL_CONFIRM_COPY}
        </Tick>
      )}

      <section aria-labelledby="zap-steps-heading" className="dm-flow-section">
        <h3 id="zap-steps-heading" className="dm-flow-subtitle">
          {CREATE.review.steps}
        </h3>
        {gate.mode === 'preview' ? (
          <p role="status" className="dm-flow-position" data-tone="neutral" data-v2-locked="" data-wallet-steps="locked">
            <span>{gate.lockedCopy}</span>
          </p>
        ) : view.steps.length === 0 ? (
          <p className="dm-flow-position" data-tone="neutral" data-wallet-steps="pending">
            <span>{view.stage === 'quoting' ? JOURNEY.review.quoting : CREATE.page.notChosen}</span>
          </p>
        ) : (
          <ol className="dm-flow-wsteps" data-wallet-steps={view.reviewed?.path ?? ''} data-live={view.busy ? '' : undefined} aria-live="polite">
            {view.steps.map((step, index) => {
              const caption = view.busy || step.status !== 'waiting' ? LIVE[step.status] || stepDetail(step) : stepDetail(step)
              const marker = markerOf(step)
              return (
                <li key={`${step.kind}-${index}`} data-wallet-step={step.kind} data-step-status={step.status} data-step-state={marker === 'done' ? 'done' : step.status === 'wallet' ? 'wallet' : step.status === 'sent' ? 'chain' : step.status === 'preparing' ? 'reading' : undefined}>
                  <span aria-hidden="true" className="dm-step-marker" data-state={marker}>
                    {marker === 'done' ? '✓' : index + 1}
                  </span>
                  <span className="dm-flow-wstep-body">
                    <span className="dm-flow-wstep-title">
                      <span>{stepTitle(step, (token, raw) => amount(token, raw), (token) => labelOf(book, token), permit2)}</span>
                    </span>
                    <span className="dm-flow-wstep-note">
                      {caption}
                      {step.feeWei !== null && step.status !== 'included' && step.status !== 'finalized' && (
                        <span data-step-fee="">{caption ? ' · ' : ''}{JOURNEY.review.networkFee}: {JOURNEY.review.networkFeeUpTo(ethText(step.feeWei))}</span>
                      )}
                    </span>
                  </span>
                </li>
              )
            })}
          </ol>
        )}
      </section>

      {figures && facts && (
        <details className="dm-details dm-flow-advanced" data-review-details="">
          <summary>
            <span>{CREATE.review.details}</span>
          </summary>
          <dl className="dm-flow-facts">
            <Fact label={JOURNEY.review.network} data="details-network">{chain.name}</Fact>
            <Fact label={CREATE.amount.slippageLabel} data="details-slippage">{`${figures.request.slippageBps / 100}%`}</Fact>
            {range && <Fact label={CREATE.review.detailRows.ticks} data="details-ticks">{`${range.lower} to ${range.upper}`}</Fact>}
            <Fact label={CREATE.review.detailRows.contracts} data="details-tokens">
              <span className="block">{pool.pool.currency0 === ZERO_ADDRESS ? `ETH (${CREATE.review.detailRows.native})` : pool.pool.currency0}</span>
              <span className="block">{pool.pool.currency1}</span>
            </Fact>
            <Fact label={CREATE.review.detailRows.pool} data="details-pool">{pool.id}</Fact>
            {view.reviewed && <Fact label="Plan hash" data="details-intent">{view.reviewed.review.intentHash}</Fact>}
            <Fact label="Route hash" data="details-routes">{figures.reply.plan.plan.intent.routesHash}</Fact>
            <Fact label="Signature nonce" data="details-nonce">{figures.reply.plan.plan.intent.nonce.toString()}</Fact>
            <Fact label="Deadline" data="details-deadline">{figures.reply.plan.plan.intent.deadline.toString()}</Fact>
            <Fact label="Domino contract" data="details-zap">{view.reviewed ? view.reviewed.review.zap : '—'}</Fact>
            {facts.initialPrice && <Fact label="Starting sqrt price" data="details-start-sqrt">{facts.initialPrice.sqrtPriceX96.toString()}</Fact>}
            {facts.initialPrice && <Fact label={JOURNEY.newPool.tick} data="details-start-tick">{String(facts.initialPrice.tick)}</Fact>}
            {view.reviewed && <Fact label="Consent" data="details-consent">{`${view.reviewed.path} (${view.reviewed.consent.reason}; account ${view.reviewed.consent.account}; batches ${view.reviewed.consent.atomic})`}</Fact>}
            <Fact label="Liquidity" data="details-liquidity">{`${facts.expected.liquidity.toString()} (minimum ${facts.minimums.liquidity.toString()})`}</Fact>
            <Fact label="Gas (L2)" data="details-gas">{facts.gasUnits === null ? '—' : facts.gasUnits.toString()}</Fact>
            <Fact label={JOURNEY.review.l1Fee} data="details-l1">{l1Fee && l1Fee.status === 'ok' ? `${l1Fee.wei.toString()} wei (${l1Fee.source})` : `unavailable (${l1Fee?.source ?? '—'})`}</Fact>
            <Fact label="Quote" data="details-quote">{`${facts.contractVersion}, block ${facts.block.number.toString()}, simulation ${facts.simulation.status}, routing ${facts.routing}`}</Fact>
          </dl>
        </details>
      )}
    </div>
  )
}

function Fact({ label, data, children, attrs }: { label: ReactNode; data: string; children: ReactNode; attrs?: Record<`data-${string}`, string> }) {
  return (
    <div data-fact={data} {...attrs}>
      <dt>{label}</dt>
      <dd className="tnum">{children}</dd>
    </div>
  )
}

/** Why Create position cannot be pressed yet, or what pressing it does (the line under it, today's #create-reason). */
function reasonOf(gate: Gate, view: RunView, blockedForPrice: boolean, connected: boolean): string {
  if (gate.mode === 'preview') return gate.lockedCopy
  if (!connected) return JOURNEY.final.reasonNoWallet
  if (view.stage === 'quoting') return JOURNEY.final.reasonQuote
  if (view.busy) return JOURNEY.final.reasonBusy
  if (blockedForPrice) return JOURNEY.final.reasonTick
  if (view.error) return JOURNEY.final.reasonAgain
  if (view.reviewed?.path === 'batch') return JOURNEY.final.reasonBatch
  return JOURNEY.final.reasonSteps
}

/**
 * Review's last control on Domino's new contracts, in today's place and look (components/create/StageReview.tsx
 * FinalControl): Create position, which runs the wallet's steps in order; the line under it; a failure said with its way
 * out ("I rejected it in my wallet", cancelling a public signature first); once the position exists, the created view with
 * its receipt. Under a `preview` gate the button stays disabled and the gate's sentence is its line.
 */
export function FinalControl({ gate, view, blockedForPrice, connected, onRun, onCancelSignature, onKeepSignature, onRejected }: {
  gate: Gate
  view: RunView
  blockedForPrice: boolean
  connected: boolean
  onRun: () => void
  onCancelSignature: () => void
  onKeepSignature: () => void
  onRejected: () => void
}) {
  const done = view.receipt !== null
  const ready = gate.mode === 'live' && view.stage === 'reviewed' && view.reviewed !== null && view.steps.length > 0 && !view.busy && !blockedForPrice && !done && !view.cancel
    && view.steps.some((step) => step.status === 'ready' || step.status === 'waiting') && !view.steps.some((step) => step.status === 'unknown' || (step.status === 'sent' && view.error !== null))
  return (
    <>
      <Button
        type="button"
        variant="primary"
        size="xl"
        className="w-full"
        data-create-position={done ? 'done' : view.busy ? 'running' : gate.mode}
        aria-describedby={done ? 'created-title' : 'create-reason'}
        aria-busy={view.busy || undefined}
        disabled={!ready}
        onClick={onRun}
      >
        {view.busy ? JOURNEY.final.creating : done ? JOURNEY.final.created : JOURNEY.final.create}
      </Button>
      {!done && (
        <p id="create-reason" className="dm-flow-reason" data-align="start" data-zap-reason={gate.mode}>
          {reasonOf(gate, view, blockedForPrice, connected)}
        </p>
      )}
      {view.steps.length > 0 && view.error && <ErrorLine error={view.error} onRejected={onRejected} busy={view.busy} />}
      {view.cancel && (
        <>
          <ErrorLine error={view.cancel.error} />
          {view.cancel.status === 'ready' ? (
            <>
              <Button type="button" variant="primary" size="md" className="w-full" onClick={onCancelSignature} data-cancel-signature="">
                {JOURNEY.final.cancelSignature}
              </Button>
              <Button type="button" variant="outline" size="md" className="w-full" onClick={onKeepSignature} data-keep-signature="">
                {JOURNEY.final.keepSignature}
              </Button>
            </>
          ) : (
            <p className="dm-flow-reason" data-align="start">{view.cancel.status === 'wallet' ? JOURNEY.live.wallet : JOURNEY.live.sent}</p>
          )}
        </>
      )}
      {done && view.receipt && view.reviewed && <Created view={view} />}
    </>
  )
}

/**
 * The position Create position just made, where today's created view stands (components/create/CreatedNext.tsx's look):
 * its NFT in the wallet, then the receipt read from the zap's own events and matched to the plan by its intentHash (spec
 * §2.11): what was paid in, each swap as measured, the Domino fee as FeeCharged says it, what went into the position,
 * what came back, the network fee from the receipt (Base adds its L1 data fee), and "Included", then "Finalized" (a delay
 * is never a failure). No USD.
 */
function Created({ view }: { view: RunView }) {
  const receipt = view.receipt
  const reviewed = view.reviewed
  if (!receipt || !reviewed) return null
  const chainId = reviewed.review.chainId
  const pool = reviewed.review.plan.plan.intent.pool
  const book = tokenBook(chainId)
  const amount = (token: Address, raw: bigint) => amountText(book, token, raw, 18)
  const read = receipt.read
  const tokenId = read?.summary.tokenId ?? null
  const state = receipt.state === 'finalized' ? JOURNEY.live.finalized : receipt.state === 'included' ? JOURNEY.live.included : JOURNEY.created.pending
  return (
    <section className="dm-created" aria-labelledby="created-title" data-created-position={tokenId?.toString() ?? ''} data-zap-receipt={receipt.state}>
      <p id="created-title" className="dm-created-line" role="status">
        {tokenId !== null ? JOURNEY.created.line(`#${tokenId.toString()}`) : JOURNEY.created.pending}
      </p>
      <dl className="dm-flow-facts" data-receipt="">
        <Fact label={JOURNEY.created.state} data="receipt-state" attrs={{ 'data-receipt-state': receipt.state }}>{state}</Fact>
        {read === null ? (
          <Fact label={JOURNEY.created.receipt} data="receipt-unreadable" attrs={{ 'data-error-code': receipt.unreadable ?? 'receipt_pending' }}>
            {receipt.unreadable ? JOURNEY.created.unreadable : JOURNEY.created.pending}
          </Fact>
        ) : (
          <>
            {read.lines.map((line) => <ReceiptRow key={line.logIndex} line={line} amount={amount} />)}
            <Fact label={JOURNEY.created.gas} data="receipt-gas" attrs={{ 'data-receipt-gas': read.gas.status }}>
              {read.gas.status === 'available' ? ethText(read.gas.totalWei) : <FigureDash reason={JOURNEY.created.gasUnavailable} />}
            </Fact>
          </>
        )}
      </dl>
      {tokenId !== null && (
        <nav className="dm-created-choices" aria-labelledby="created-title">
          <a className="dm-created-choice" href={v2PositionHref({ chainId, dex: pool.dex, tokenId })} aria-label={JOURNEY.created.view} data-created-next="position">
            <span className="dm-created-art" aria-hidden="true">
              <PlainArt />
            </span>
            <span className="dm-created-text">
              <span className="dm-created-name">{JOURNEY.created.positions}</span>
              <span className="dm-created-note">{`${labelOf(book, pool.currency0)} / ${labelOf(book, pool.currency1)} · ${v2Chain(chainId).name}`}</span>
            </span>
            <span className="dm-created-go">
              <span className="dm-created-go-text">{JOURNEY.created.view}</span>
              <IconChevronRight size={16} />
            </span>
          </a>
        </nav>
      )}
    </section>
  )
}

function ReceiptRow({ line, amount }: { line: ReceiptLine; amount: (token: Address, raw: bigint) => string }) {
  switch (line.kind) {
    case 'paid-in':
      return <Fact label={JOURNEY.created.paidIn} data="receipt-paid-in">{amount(line.token, line.amount)}</Fact>
    case 'swapped':
      return <Fact label={JOURNEY.created.swapped} data="receipt-swapped">{`${amount(line.tokenIn, line.amountIn)} → ${amount(line.tokenOut, line.amountOut)}`}</Fact>
    case 'fee':
      return <Fact label={JOURNEY.created.fee} data="receipt-fee" attrs={{ 'data-receipt-fee': line.amount.toString() }}>{amount(line.token, line.amount)}</Fact>
    case 'position':
      return (
        <Fact label={JOURNEY.created.added} data={`receipt-position-${line.step}`}>
          {line.amounts.map((a) => <span key={a.token} className="block">{amount(a.token, a.amount)}</span>)}
        </Fact>
      )
    case 'returned':
      return <Fact label={JOURNEY.created.returned} data="receipt-returned">{amount(line.token, line.amount)}</Fact>
  }
}
