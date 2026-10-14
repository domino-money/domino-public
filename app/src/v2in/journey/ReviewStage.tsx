import { useState, type ReactNode } from 'react'
import { ModeArt, PlainArt } from '../../components/automate/ModeArt'
import { ExitThumb } from '../../components/home/Vignettes'
import { IconChevronRight } from '../../components/icons'
import { Button, cx, FigureDash, Pill, Skeleton } from '../../components/ui'
import { askAutoExitOnArrival, expectNewPosition } from '../../lib/automate/autoExitAsk'
import { AUTO_EXIT_FEATURE, FEATURES } from '../../lib/automate/features'
import { CREATE } from '../../lib/create/copy'
import { rangePosition } from '../../lib/read/screens/poolRange'
import type { ReceiptLine } from '../../finance/v2/receipt'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import { ethAboutText, ethText, EXACT_FRACTION, exitOffer, feesToCome, keptWhileRequoting, networkFeeLine, planNetworkCost, priceText, rangeBothWays, SHOWN_FRACTION, smallerUpToPercent, spanText } from '../../v2/plan/present'
import { ZERO_ADDRESS, type Address, type Dex, type V2ChainId } from '../../v2/types'
import { exitOrderKey } from '../autoexit/entry'
import { gateOpen, useGate } from '../automate/gate'
import { setupHref } from '../automate/intent'
import { v2PositionHref } from '../route'
import { JOURNEY_HIGH_SLIPPAGE_COPY, JOURNEY_SLIPPAGE_WARNING_ABOVE_BPS, NEW_POOL_CONFIRM_COPY, NEW_POOL_TITLE } from './constants'
import { JOURNEY } from './copy'
import { dexName, feePercent } from './model/pools'
import type { JourneyPriceState } from './model/price'
import type { JourneyState } from './model/state'
import { ErrorLine, Note, PoolChips, Tick, TokenDiscPair, TokenName } from './parts'
import { stepTitle, type Reviewed, type RunStep, type RunView } from './run'
import { amountText, decimalsOf, labelOf, tokenBook, type TokenBook } from './tokens'

type Gate = Extract<V2Gate, { mode: 'preview' | 'live' }>

/**
 * What each step says under its title once Create position runs (today's Review's own captions, plus the word for a step
 * that is in a block: "Confirmed" since 2026-10-14, incident C1, for both `included` and `finalized`; ./copy.ts live).
 */
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

/**
 * A step's marker state in today's list of wallet steps (styles/flow.css .dm-flow-wsteps). On a review kept from the last
 * quote (`stale`) a step already on chain keeps its check, and nothing else turns: that review waits for the new one.
 */
function markerOf(step: RunStep, stale: boolean): 'done' | 'current' | undefined {
  if (step.status === 'included' || step.status === 'finalized') return 'done'
  if (stale) return undefined
  if (step.status === 'wallet' || step.status === 'sent' || step.status === 'preparing') return 'current'
  return undefined
}

/**
 * The line under a step: its live state only (Changed on purpose 2026-10-06, the owner's point 4: titles only, no
 * sentence explaining each step, no fee on each). "Next" under the first step still waiting while Create position runs,
 * as today's Review says it; nothing before the press, nor on a review kept from the last quote.
 */
function captionOf(step: RunStep, index: number, next: number, busy: boolean, stale: boolean): string {
  if (stale) return ''
  if (step.status === 'waiting') return busy && index === next ? LIVE.waiting : ''
  return LIVE[step.status]
}

/** The figures a review draws, from a `live` review (the zap client's); null before one (and always under `preview`). */
function figuresOf(reviewed: Reviewed | null) {
  if (!reviewed) return null
  const { review, reply, request } = reviewed
  return { reply, request, legs: review.legs, warnings: review.warnings as readonly string[], createsPool: review.createsPool, replacesApproval: review.replacesApproval !== null, quoteLeft: reply.facts.expiresAt - Math.floor(reviewed.at) }
}

/**
 * What the last review drew, kept for the next quote of the same choices: its steps as they last stood (an approval
 * already on chain stays done), its fee per gas, and through its steps a batch's own ceiling and the approvals' fees.
 */
interface Kept {
  reviewed: Reviewed
  feePerGas: bigint | null
  steps: readonly RunStep[]
}

const batchFeeOf = (steps: readonly RunStep[]): bigint | null => steps.find((step) => step.kind === 'batch')?.feeWei ?? null

/**
 * Changed on purpose 2026-10-06 (the owner's point 4: a small cue, never a blank): while the same choices are quoted
 * again (the price moved, the quote ran out, or a signature was cancelled; ./run.ts clears its review for it), Review
 * keeps drawing the last review, greyed and marked busy, until the new one replaces it (present.ts keptWhileRequoting).
 * New choices start blank. Its steps are kept as they last stood, never redrawn as new: a re-quote that follows an
 * approval already on chain still shows that approval done (the new review then leaves it out, as it is no longer needed).
 */
function useKept(view: RunView): { reviewed: Reviewed | null; steps: readonly RunStep[]; feePerGas: bigint | null; stale: boolean } {
  const [last, setLast] = useState<Kept | null>(null)
  const now: Kept | null = view.reviewed ? { reviewed: view.reviewed, feePerGas: view.feePerGas, steps: view.steps } : null
  // Remembered as it is drawn (React's "information from previous renders"): set again only when it changed (the owner's
  // journey hands in a copy of the steps on every change, the zap path the run's own list, changed in place), and
  // forgotten when a quote for new choices starts (or the run is reset), so it can never stand for other choices.
  if (now && (last === null || last.reviewed !== now.reviewed || last.feePerGas !== now.feePerGas || last.steps !== now.steps)) setLast(now)
  else if (!now && last !== null && (view.stage === 'idle' || (view.stage === 'quoting' && !view.requoting))) setLast(null)
  const { shown, stale } = keptWhileRequoting(now, view.stage === 'quoting' && view.requoting, last)
  if (!stale || !shown) return { reviewed: view.reviewed, steps: view.steps, feePerGas: view.feePerGas, stale: false }
  return { reviewed: shown.reviewed, steps: shown.steps, feePerGas: shown.feePerGas, stale: true }
}

/**
 * Step 4, Review, on Domino's new contracts, in today's Review's look (components/create/StageReview.tsx): the position at
 * the top, then the wallet's steps, then the technical facts under a closed Details. Everything spec F7 rev2 §2.6.1
 * "Revisão" and §8.2 "S1, criar" ask for: the pool by its tokens, its network and tier (the DEX as ./parts.tsx PoolChips
 * says it: never its version as text); the range both ways round; what goes in; the Domino fee with its token, amount
 * and base (§2.8: "Domino fee: 3.25 USDG (0.65% of 500 USDG swapped)"; the receipt is exact); the network cost with the
 * plan's L1 data fee per stack (§2.4); the route leg by leg with what it should and must deliver and its pools' tiers;
 * how much smaller the position may come out within the slippage (§2.9); what comes back; how long the quote is good
 * for and what is signed for.
 *
 * Changed on purpose 2026-10-06 (the owner's point 4: "just a next button, click and done", little text): in view are
 * only the pair and its chips, the amounts (rounded: at most 6 decimals, every digit in the title), what you put in, the
 * range, ONE Domino fee line, ONE network fee line, and the notes that keep you safe (high slippage, out of range, WETH
 * leftovers, another app's permission replaced, a new pool's gas and its box to tick). The route, the leftovers, the
 * network fee's ceiling and L1 data fee, the deadlines, the "up to X% smaller" line and "Paying with ETH needs a direct
 * transaction." are under the one Details; the developer facts (plan and route hashes, nonce, raw deadline, contract,
 * consent path, raw liquidity, gas units, L1 fee in wei, quote internals) only as data-* attributes on it. The wallet's
 * steps are titles with their live state. A quote asked again for the same choices greys the last review instead of
 * blanking it; "Getting a quote…" is said once, under Create position. Amounts are rounded down ("about", "at least"),
 * except the Domino fee and an amount to allow, rounded up: never shown lower than they are.
 *
 * Changed on purpose 2026-10-06 (the review of the owner's point 4): the position's amounts read as the estimate they are
 * ("About 0.19 ETH + 490 USDG", as today's Review writes them), never "0" of a token the range does not take; "You put
 * in" is the very figure the wallet is asked to allow (both rounded up), and the receipt's "Paid in" too; the network fee
 * line says any part not read yet in one plain clause, and a fee not known at all in words, never "L1" or a bare dash in
 * view (the detail stays under Details). A wallet `short` of the amount asks no quote: the review then shows what the
 * position needs, and says once, in view, what the wallet has and the two ways on (bringing the token from another
 * network only where the offer can bring it, else adding it to the wallet, as today's Review says).
 *
 * Changed on purpose 2026-10-06 (the final check's F4: a lone dash in view on the path every new visitor takes): while no
 * quote has figures and none is under way (no wallet, a wallet not signed in, balances not read, a quote that failed), the
 * amounts are what the position holds as typed (`estimate`, from the owner's journey's own reading, as his Review and his
 * amount step write them: the typed amount and the one it pairs with, or after the swap when the wallet funds the deposit
 * from one token), "About" as the quoted figures are; the dash only when nothing can be worked out.
 *
 * Under a `preview` gate no plan is asked (real data only: nothing stands in): the review shows what was chosen (`asked`),
 * and the wallet's steps are not drawn: the gate's sentence stands in their place, once, under Create position too.
 *
 * Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, spec delta §1: a closed Details counts as "shown" for the
 * technical facts, but the minimum and every warning, offer or confirmation stay in view): §2.9's line ("…up to X%
 * smaller…") is in view, under the figures it bounds, no longer in Details. Details keeps what the delta lets it keep:
 * the route leg by leg with "At least" and its tiers, the leftovers, the L1 data fee and Base's ceiling, the deadlines,
 * §2.7's "Paying with ETH needs a direct transaction." and a new pool's tick and initSqrtPriceX96.
 */
export function ReviewStage({ state, gate, view, price, confirmed, onConfirmed, onRejected, onNewPool, onPoolRace, short = null, estimate = null }: {
  state: JourneyState
  gate: Gate
  view: RunView
  price: JourneyPriceState | null
  confirmed: boolean
  onConfirmed: (next: boolean) => void
  onRejected: () => void
  onNewPool: () => void
  onPoolRace: () => void
  /**
   * The wallet cannot fund the amount (no quote is asked): what the position takes of each token, and the token it lacks;
   * `bring` when a deposit from another network can bring that token here now (else it is added to the wallet).
   */
  short?: { amounts: readonly [bigint, bigint]; token: Address; have: bigint; need: bigint; bring: boolean } | null
  /**
   * What the position holds of each token as typed, in pool order (no quote needed; after the swap when the wallet funds it
   * from one token), for the headline until a quote has figures.
   */
  estimate?: readonly [bigint, bigint] | null
}) {
  const kept = useKept(view)
  const pool = state.pool
  if (!pool) return null
  const chain = v2Chain(state.chainId)
  const reviewed = kept.reviewed
  const figures = figuresOf(reviewed)
  const facts = figures?.reply.facts ?? null
  const stale = kept.stale
  const quoting = view.stage === 'quoting'
  const book: TokenBook = tokenBook(state.chainId, [...pool.tokens])
  // Rounded where it is drawn (at most 6 decimals, present.ts SHOWN_FRACTION); every digit in the title. A fee and an
  // amount to allow round up (`owed`): never shown lower than they are.
  const amount = (token: Address, raw: bigint) => amountText(book, token, raw)
  const owed = (token: Address, raw: bigint) => amountText(book, token, raw, SHOWN_FRACTION, 'up')
  const exact = (token: Address, raw: bigint) => amountText(book, token, raw, EXACT_FRACTION)
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
    if (figures.replacesApproval) warnings.push({ key: 'replaces_approval', text: JOURNEY.review.replacesApproval })
    if (figures.createsPool) warnings.push({ key: 'new_pool_gas', text: JOURNEY.newPool.gas })
  }
  const l1Fee = facts?.l1DataFee ?? null
  const cost = facts && facts.gasUnits !== null && kept.feePerGas !== null && l1Fee
    ? planNetworkCost({ gasUnits: facts.gasUnits, feePerGas: kept.feePerGas, l1: l1Fee.status === 'ok' ? (l1Fee.source === 'op_gas_price_oracle' ? { source: l1Fee.source, wei: l1Fee.wei, upperBoundWei: l1Fee.upperBoundWei } : { source: l1Fee.source, wei: l1Fee.wei, l1GasUnits: l1Fee.l1GasUnits }) : null })
    : null
  // The plan's cost and the approvals still to send (each a transaction of its own), or a batch's own ceiling.
  const network = networkFeeLine({ cost, l1Available: l1Fee?.status === 'ok', batchFee: batchFeeOf(kept.steps), others: feesToCome(kept.steps) })
  const fee = facts?.fee ?? null
  const recovery = view.error?.recovery
  const permit2 = chain.permit2 as Address
  const intent = figures?.reply.plan.plan.intent ?? null
  const next = kept.steps.findIndex((step) => step.status === 'waiting')
  // What the position holds (the plan's estimate), or while the wallet is short what it needs: each token it takes, never
  // "0" of the other (today's Review's rule for a range beside the price). With no quote's figures and none under way, what
  // it holds as typed (`estimate`); while a first quote is under way, the resting bubble below.
  const currencies = [pool.pool.currency0, pool.pool.currency1] as const
  const held = facts?.expected.amounts ?? short?.amounts ?? (quoting ? null : estimate)
  const sides = held === null ? [] : held[0] > 0n || held[1] > 0n ? ([0, 1] as const).filter((i) => held[i] > 0n) : ([0, 1] as const)
  const heldText = (write: (token: Address, raw: bigint) => string) => (held === null ? '' : sides.map((i) => write(currencies[i], held[i])).join(' + '))

  return (
    <div className="dm-flow-stack" data-stage="review" data-zap-review={gate.mode} data-zap-review-stage={view.stage} data-review-stale={stale ? '' : undefined}>
      <section aria-labelledby="zap-choices-heading" className="dm-flow-section">
        <h3 id="zap-choices-heading" className="dm-flow-subtitle">
          {CREATE.review.choices}
        </h3>
        <div className={cx('dm-flow-headline', stale && 'opacity-60 transition-opacity')} data-review-headline="" aria-busy={quoting || undefined}>
          <p className="dm-flow-headline-pair">
            <TokenDiscPair chainId={state.chainId} first={pool.tokens[0]} second={pool.tokens[1]} size={24} ring="var(--flow-well, var(--surface-1))" />
            <span className="min-w-0" data-review-pool="">
              <TokenName token={pool.tokens[0]} /> / <TokenName token={pool.tokens[1]} />
            </span>
          </p>
          <PoolChips chainId={state.chainId} dex={pool.pool.dex} fee={pool.pool.fee} />
          <p className={cx('dm-flow-headline-amounts tnum', stale && 'animate-pulse-soft')} data-review-amounts="" title={held ? heldText(exact) : undefined}>
            {held ? (
              `${CREATE.review.about} ${heldText(amount)}`
            ) : quoting ? (
              // The figures are on their way: the page's resting bubble, never a digit (components/ui.tsx Skeleton).
              <Skeleton className="inline-block h-[1.25em] w-48 max-w-full align-middle" />
            ) : (
              CREATE.page.notChosen
            )}
          </p>
          {inputs.length > 0 && (
            // What goes in, as the wallet is asked to allow it: the same figure, rounded up, every digit in the title.
            <p className="dm-flow-headline-line tnum" data-review-inputs="" title={inputs.map((input) => exact(input.token, input.amount)).join(' + ')}>
              {JOURNEY.review.youPut} {inputs.map((input) => owed(input.token, input.amount)).join(' + ')}.
            </p>
          )}
          <p className="dm-flow-headline-line tnum" data-review-range="">
            {CREATE.amount.rangeHeading}:{' '}
            {both && priceText(both.forward.low) && priceText(both.forward.high)
              ? `1 ${l0} = ${priceText(both.forward.low)} to ${priceText(both.forward.high)} ${l1} · 1 ${l1} = ${priceText(both.inverse.low) ?? '—'} to ${priceText(both.inverse.high) ?? '—'} ${l0}`
              : range ? CREATE.review.summary.rangeTicks(range.lower, range.upper) : CREATE.page.notChosen}
          </p>
          {/* A new pool's starting price, in view: the box to tick below speaks of "this price" (§2.6.5). */}
          {facts?.initialPrice && (
            <p className="dm-flow-headline-line tnum" data-fact="review-start">
              {`${JOURNEY.newPool.price}: 1 ${l0} = ${facts.initialPrice.price0In1} ${l1} · 1 ${l1} = ${facts.initialPrice.price1In0} ${l0}`}
            </p>
          )}
          {facts && (
            // §2.8, one line: "Domino fee: 3.25 USDG (0.65% of 500 USDG swapped)", or "No Domino fee".
            <p className="dm-flow-headline-line tnum" data-review-fee={fee ? 'charged' : 'none'} data-review-fee-state={fee ? 'charged' : 'none'}>
              {fee ? (
                <>
                  {JOURNEY.review.fee}: <span data-review-fee-amount="" title={exact(fee.token, fee.amount)}>{owed(fee.token, fee.amount)}</span> (
                  <span data-review-fee-base="" title={JOURNEY.review.feeBase(exact(fee.token, fee.basis))}>{JOURNEY.review.feeBase(amount(fee.token, fee.basis))}</span>)
                </>
              ) : (
                JOURNEY.review.noFee
              )}
            </p>
          )}
          {facts && (
            // §2.4, one line: the plan's cost and the approvals still to send (each read at the review, ./run.ts). Changed
            // on purpose 2026-10-06 (the review of the owner's point 4: no jargon, no bare dash in view): a part that could
            // not be read (the plan's L1 data fee, or an approval that waits for an earlier one) is one plain clause beside
            // the figure, never a 0 and never left out; Details says which part. With no figure yet, the resting bubble
            // while a step is checked, else the words (a signature first: no transaction to read a fee from yet).
            <p
              className="dm-flow-headline-line tnum"
              data-review-network-fee={network.kind}
              data-review-network-wei={network.kind === 'unknown' ? undefined : network.wei.toString()}
              data-review-network-others={network.kind === 'about' && network.othersMissing ? 'unprepared' : undefined}
              data-review-l1-fee={l1Fee && l1Fee.status === 'ok' ? l1Fee.wei.toString() : 'unavailable'}
            >
              {JOURNEY.review.networkFee}:{' '}
              {network.kind === 'about'
                ? JOURNEY.review.networkAbout(ethAboutText(network.wei))
                : network.kind === 'upTo'
                  ? JOURNEY.review.networkUpTo(ethText(network.wei))
                  : !stale && kept.steps.some((step) => step.status === 'preparing')
                    ? <Skeleton className="inline-block h-[1em] w-24 align-middle" />
                    : JOURNEY.review.networkLater}
              {network.kind === 'about' && (network.l1Missing || network.othersMissing) && `, ${JOURNEY.review.networkMore}`}
            </p>
          )}
        </div>
        {/* §2.9's minimum, in view (Changed on purpose 2026-10-06, rugged's answer of 6 Oct, delta §1: it was in Details). */}
        {smaller !== null && <Note data-review-smaller={smaller}>{JOURNEY.review.smaller(smaller)}</Note>}
        {short && (
          // Said once, here in view (Changed on purpose 2026-10-06, the review of the owner's point 4): what the wallet has
          // of the token it lacks, what the position needs, and the two ways on; Create position's line only says why it waits.
          <Note data-review-short={short.token}>
            {JOURNEY.review.walletShort(amount(short.token, short.have), owed(short.token, short.need), labelOf(book, short.token), short.token === ZERO_ADDRESS, short.bring)}
          </Note>
        )}
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

      {facts && figures?.createsPool && (
        <Tick checked={confirmed} onChange={onConfirmed} data-new-pool-confirm="">
          {NEW_POOL_CONFIRM_COPY}
        </Tick>
      )}

      {/* The wallet's steps once a review lists them; before that, nothing here ("Getting a quote…" is said once, under Create position). */}
      {(gate.mode === 'preview' || kept.steps.length > 0) && (
        <section aria-labelledby="zap-steps-heading" className="dm-flow-section">
          <h3 id="zap-steps-heading" className="dm-flow-subtitle">
            {CREATE.review.steps}
          </h3>
          {gate.mode === 'preview' ? (
            <p role="status" className="dm-flow-position" data-tone="neutral" data-v2-locked="" data-wallet-steps="locked">
              <span>{gate.lockedCopy}</span>
            </p>
          ) : (
            <ol
              className={cx('dm-flow-wsteps', stale && 'opacity-60 transition-opacity')}
              data-wallet-steps={reviewed?.path ?? ''}
              data-live={view.busy ? '' : undefined}
              aria-live="polite"
              aria-busy={stale || undefined}
            >
              {kept.steps.map((step, index) => {
                const caption = captionOf(step, index, next, view.busy, stale)
                const marker = markerOf(step, stale)
                const row = marker === 'done' ? 'done' : stale ? undefined : step.status === 'wallet' ? 'wallet' : step.status === 'sent' ? 'chain' : step.status === 'preparing' ? 'reading' : undefined
                const label = (token: Address) => labelOf(book, token)
                // An amount to allow rounded up, as the wallet will ask for it; every digit in the title.
                const title = stepTitle(step, owed, label, permit2)
                const whole = stepTitle(step, exact, label, permit2)
                return (
                  <li key={`${step.kind}-${index}`} data-wallet-step={step.kind} data-step-status={step.status} data-step-state={row}>
                    <span aria-hidden="true" className="dm-step-marker" data-state={marker}>
                      {marker === 'done' ? '✓' : index + 1}
                    </span>
                    <span className="dm-flow-wstep-body">
                      <span className="dm-flow-wstep-title">
                        <span title={whole}>{title}</span>
                      </span>
                      {caption && <span className="dm-flow-wstep-note">{caption}</span>}
                    </span>
                  </li>
                )
              })}
            </ol>
          )}
        </section>
      )}

      {figures && facts && reviewed && intent && (
        // The developer facts stay on the element for tests and support, never as text (2026-10-06, the owner's point 4).
        <details
          className={cx('dm-details dm-flow-advanced', stale && 'opacity-60 transition-opacity')}
          data-review-details=""
          data-plan-hash={reviewed.review.intentHash}
          data-routes-hash={intent.routesHash}
          data-nonce={intent.nonce.toString()}
          data-deadline={intent.deadline.toString()}
          data-zap={reviewed.review.zap}
          data-consent={`${reviewed.path} ${reviewed.consent.reason} ${reviewed.consent.account} ${reviewed.consent.atomic}`}
          data-liquidity={`${facts.expected.liquidity.toString()} ${facts.minimums.liquidity.toString()}`}
          data-gas-units={facts.gasUnits === null ? '' : facts.gasUnits.toString()}
          data-l1-wei={l1Fee && l1Fee.status === 'ok' ? `${l1Fee.wei.toString()} ${l1Fee.source}` : `unavailable ${l1Fee?.source ?? ''}`.trim()}
          data-quote={`${facts.contractVersion} ${facts.block.number.toString()} ${facts.simulation.status} ${facts.routing}`}
        >
          <summary>
            <span>{CREATE.review.details}</span>
          </summary>
          <div className="grid gap-3">
            {/* §2.7's sentence, which the delta of 6 Oct (§1) lets Details keep. */}
            {paysEth && (
              <div className="grid gap-2 pt-2">
                <Note data-review-warning="eth_direct">{JOURNEY.review.ethDirect}</Note>
              </div>
            )}
            <dl className="dm-flow-facts" data-review-plan="">
              {figures.legs.map((leg, i) => (
                <Fact key={i} label={figures.legs.length > 1 ? `${JOURNEY.review.route} ${i + 1}` : JOURNEY.review.route} data={`route-leg-${i}`}>
                  <span className="block" title={exact(leg.tokenIn, leg.amountIn)}>{amount(leg.tokenIn, leg.amountIn)} → {labelOf(book, leg.tokenOut)}</span>
                  <span className="block text-fg-muted" title={exact(leg.tokenOut, leg.expectedOut)}>{JOURNEY.review.expected} {amount(leg.tokenOut, leg.expectedOut)}</span>
                  <span className="block" data-review-at-least="" title={exact(leg.tokenOut, leg.minAmountOut)}>{JOURNEY.review.atLeast} {amount(leg.tokenOut, leg.minAmountOut)}</span>
                  <span className="block text-fg-subtle">
                    {/* Each pool of the leg by its tier; the DEX says "Uniswap", its version in the title only (./parts.tsx PoolChips' rule). */}
                    {leg.pools.map((p, j) => (
                      <span key={j} title={dexName(p.dex)} data-route-pool-dex={p.dex}>{`${j > 0 ? ', ' : ''}Uniswap · ${feePercent(p.fee)}`}</span>
                    ))}
                    {leg.asQuoted ? ` (${JOURNEY.review.asQuoted})` : ''}
                  </span>
                </Fact>
              ))}
              <Fact label={JOURNEY.review.leftovers} data="review-leftovers">
                {facts.expected.returned.length === 0
                  ? JOURNEY.review.leftoversNone
                  : facts.expected.returned.map((item) => <span key={item.token} className="block" title={exact(item.token, item.amount)}>{amount(item.token, item.amount)}</span>)}
              </Fact>
              {/* §2.4: the plan's L1 data fee per stack (Robinhood's a measured 0, an unread one a dash), and Base's ceiling
                  under a label of its own (with the approvals the line in view counts, so never below it). */}
              {network.kind === 'about' && network.ceiling !== null && (
                <Fact label={JOURNEY.review.networkCeiling} data="review-network-fee">
                  {ethText(network.ceiling)}
                  {network.othersMissing && (
                    <>
                      {' + '}
                      {JOURNEY.review.networkOthers} <FigureDash reason={JOURNEY.review.networkUnknown} />
                    </>
                  )}
                </Fact>
              )}
              <Fact label={JOURNEY.review.l1Fee} data="review-l1-fee">
                {l1Fee && l1Fee.status === 'ok' ? ethText(l1Fee.wei) : <FigureDash reason={JOURNEY.review.l1Unavailable} />}
              </Fact>
              <Fact label={JOURNEY.review.deadline} data="review-deadline">
                <span className="block">{JOURNEY.review.deadlineValue(spanText(figures.quoteLeft))}</span>
                <span className="block text-fg-subtle">{JOURNEY.review.signedFor(spanText(Number(facts.deadline) - facts.requestedAt))}</span>
              </Fact>
              <Fact label={JOURNEY.review.network} data="details-network">{chain.name}</Fact>
              <Fact label={CREATE.amount.slippageLabel} data="details-slippage">{`${figures.request.slippageBps / 100}%`}</Fact>
              {range && <Fact label={CREATE.review.detailRows.ticks} data="details-ticks">{`${range.lower} to ${range.upper}`}</Fact>}
              <Fact label={CREATE.review.detailRows.contracts} data="details-tokens">
                <span className="block">{pool.pool.currency0 === ZERO_ADDRESS ? `ETH (${CREATE.review.detailRows.native})` : pool.pool.currency0}</span>
                <span className="block">{pool.pool.currency1}</span>
              </Fact>
              <Fact label={CREATE.review.detailRows.pool} data="details-pool">{pool.id}</Fact>
              {/* §8.2 "Criar pool": the starting price's exact tick and sqrt price, with the price itself in view above. */}
              {facts.initialPrice && <Fact label={JOURNEY.newPool.tick} data="details-start-tick">{String(facts.initialPrice.tick)}</Fact>}
              {facts.initialPrice && <Fact label={JOURNEY.newPool.sqrt} data="details-start-sqrt">{facts.initialPrice.sqrtPriceX96.toString()}</Fact>}
            </dl>
          </div>
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

/**
 * Why Create position cannot be pressed yet, or what pressing it does (the line under it, today's #create-reason). While
 * a quote is asked it is the one place that says so (Changed on purpose 2026-10-06, the owner's point 4: once, not three
 * times), "Getting a fresh quote…" when the same choices are quoted again, whatever the reason (a price that moved, a
 * quote that ran out, a cancelled signature).
 *
 * Changed on purpose 2026-10-06 (the final check's F5): with nothing reviewed and no quote under way, never "Your wallet
 * will ask you to confirm each step." under a button that cannot be pressed: why nothing is quoted yet (`waiting`, the
 * owner's journey's reason: his wallet's balances still being read, say), else that a quote is asked next.
 *
 * Changed on purpose 2026-10-06 (the final check's F5, a second look): it never asks for a press of a Create position that
 * cannot be pressed (`ready`). A quote that failed before any review says there is no quote yet (Review again under it
 * asks one, FinalControl); "Press Create position to try again." only for a step that failed on a reviewed plan, where
 * Create position can be pressed again. A step the wallet may have sent, or a signature to cancel first, adds nothing
 * here: the line under it says what happened and the way on.
 */
function reasonOf(gate: Gate, view: RunView, blockedForPrice: boolean, connected: boolean, waiting: string | null, ready: boolean): string {
  if (gate.mode === 'preview') return gate.lockedCopy
  if (!connected) return JOURNEY.final.reasonNoWallet
  if (view.stage === 'quoting') return view.requoting ? JOURNEY.review.requoting : JOURNEY.final.reasonQuote
  if (view.busy) return JOURNEY.final.reasonBusy
  if (blockedForPrice) return JOURNEY.final.reasonTick
  if (view.reviewed === null) return waiting ?? (view.error ? JOURNEY.final.reasonNoQuote : JOURNEY.final.reasonQuote)
  if (view.error) return ready ? JOURNEY.final.reasonAgain : ''
  if (view.reviewed.path === 'batch') return JOURNEY.final.reasonBatch
  return JOURNEY.final.reasonSteps
}

/**
 * A failure whose own way on is drawn with it (Added 2026-10-06, the final check's F5, a second look): a pool to give a
 * starting price, a pool someone priced first (Review's body), "I rejected it in my wallet" (its ErrorLine). Review again
 * is not offered beside these.
 */
const ownWayOn = (error: RunView['error']): boolean =>
  error !== null && (error.recovery === 'offer-new-pool' || error.recovery === 'pool-race' || error.code === 'zap_action_unsettled')

/**
 * Review's last control on Domino's new contracts, in today's place and look (components/create/StageReview.tsx
 * FinalControl): Create position, which runs the wallet's steps in order; the line under it; a failure said with its way
 * out ("I rejected it in my wallet", cancelling a public signature first); once the position exists, the created view with
 * its receipt. Under a `preview` gate the button stays disabled and the gate's sentence is its line.
 *
 * Changed on purpose 2026-10-06 (the final check's F5, a second look): a quote that failed before any review left a
 * disabled Create position under "Press Create position to try again." and nothing on Review asked the quote again (only
 * Back then Continue did). Its line now says there is no quote yet, and an outline Review again under it asks one
 * (`onQuote`, the run's start()), unless the failure brings its own way on (ownWayOn).
 */
export function FinalControl({ gate, view, blockedForPrice, connected, onRun, onCancelSignature, onKeepSignature, onRejected, onQuote, waiting = null }: {
  gate: Gate
  view: RunView
  blockedForPrice: boolean
  connected: boolean
  onRun: () => void
  onCancelSignature: () => void
  onKeepSignature: () => void
  onRejected: () => void
  /** Asks the quote again for the same choices (the run's start()); absent where none can be asked now. */
  onQuote?: () => void
  /** Why no quote is under way while nothing is reviewed (the line under the button then); null: one is asked next. */
  waiting?: string | null
}) {
  const done = view.receipt !== null
  // Not while the current step is still being checked (2026-10-06: the review now also reads the later approvals' fees,
  // ./run.ts): a press then would do nothing.
  const ready = gate.mode === 'live' && view.stage === 'reviewed' && view.reviewed !== null && view.steps.length > 0 && !view.busy && !blockedForPrice && !done && !view.cancel
    && view.steps[view.current]?.status !== 'preparing'
    && view.steps.some((step) => step.status === 'ready' || step.status === 'waiting') && !view.steps.some((step) => step.status === 'unknown' || (step.status === 'sent' && view.error !== null))
  // The quote failed before any review: nothing to press, so a new quote is the way on.
  const again = onQuote !== undefined && gate.mode === 'live' && view.stage === 'failed' && view.reviewed === null && !view.busy && !ownWayOn(view.error)
  return (
    <>
      <Button
        type="button"
        variant="primary"
        size="xl"
        className="w-full"
        data-create-position={done ? 'done' : view.busy ? 'running' : gate.mode}
        aria-describedby={done ? 'created-title' : 'create-reason'}
        aria-busy={view.busy || view.stage === 'quoting' || undefined}
        disabled={!ready}
        onClick={onRun}
      >
        {view.busy ? JOURNEY.final.creating : done ? JOURNEY.final.created : JOURNEY.final.create}
      </Button>
      {!done && (
        <p id="create-reason" className="dm-flow-reason" data-align="start" data-zap-reason={gate.mode} data-zap-quoting={view.stage === 'quoting' ? '' : undefined} aria-live="polite">
          {reasonOf(gate, view, blockedForPrice, connected, waiting, ready)}
        </p>
      )}
      {again && (
        <Button type="button" variant="outline" size="md" className="w-full col-span-full" onClick={onQuote} data-create-review-again="">
          {JOURNEY.review.reviewAgain}
        </Button>
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
 * is never a failure). No USD. Changed on purpose 2026-10-06 (the owner's point 4): each amount rounded to at most 6
 * decimals, every digit in its title; FeeCharged's exact amount stays in the fee's title and its data-receipt-fee
 * (spec L1024), the fee itself rounded up as Review's fee line is (never shown lower than it is), and what was paid in as
 * Review's "You put in" (the same figure above it). Changed on purpose 2026-10-06 (the review of the owner's point 5):
 * Auto-exit offered beside the position's link (CreatedExit). Changed on purpose 2026-10-14 (incident C1; the owner's
 * decision D0): Status says "Confirmed" once the transaction is in a block with success and keeps that word when the block
 * is final (./copy.ts live.included and live.finalized); it was "Included", then "Finalized" some 16 minutes later on
 * Robinhood Chain. Finality is a line in Receipts' Details (../lists/words.ts); data-receipt-state keeps the state itself.
 */
function Created({ view }: { view: RunView }) {
  const receipt = view.receipt
  const reviewed = view.reviewed
  if (!receipt || !reviewed) return null
  const chainId = reviewed.review.chainId
  const intent = reviewed.review.plan.plan.intent
  const pool = intent.pool
  const facts = reviewed.reply.facts
  const book = tokenBook(chainId, reviewed.tokens)
  const amount = (token: Address, raw: bigint, round: 'down' | 'up' = 'down'): ReactNode => <span title={amountText(book, token, raw, EXACT_FRACTION)}>{amountText(book, token, raw, SHOWN_FRACTION, round)}</span>
  const read = receipt.read
  const tokenId = read?.summary.tokenId ?? null
  const failed = receipt.state === 'reverted' || receipt.state === 'not-included'
  const state = receipt.state === 'finalized' ? JOURNEY.live.finalized : receipt.state === 'included' ? JOURNEY.live.included : receipt.state === 'reverted' ? JOURNEY.created.revertedStatus : receipt.state === 'not-included' ? JOURNEY.created.notIncludedStatus : JOURNEY.created.pending
  return (
    <section className="dm-created" aria-labelledby="created-title" data-created-position={tokenId?.toString() ?? ''} data-zap-receipt={receipt.state}>
      <p id="created-title" className="dm-created-line" role="status">
        {receipt.state === 'reverted' ? JOURNEY.created.reverted : receipt.state === 'not-included' ? JOURNEY.created.notIncluded : tokenId !== null ? JOURNEY.created.line(`#${tokenId.toString()}`) : JOURNEY.created.pending}
      </p>
      <dl className="dm-flow-facts" data-receipt="">
        <Fact label={JOURNEY.created.state} data="receipt-state" attrs={{ 'data-receipt-state': receipt.state }}>{state}</Fact>
        {read === null ? failed ? null : (
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
          {/* The page waits for read-v6 to list the position it opens (lib/automate/autoExitAsk.ts, 2026-10-06). */}
          <a className="dm-created-choice" href={v2PositionHref({ chainId, dex: pool.dex, tokenId })} onClick={() => expectNewPosition(exitOrderKey(tokenId.toString(), chainId, pool.dex))} aria-label={JOURNEY.created.view} data-created-next="position">
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
          <CreatedCompound chainId={chainId} dex={pool.dex} tokenId={tokenId} />
          <CreatedExit chainId={chainId} dex={pool.dex} tokenId={tokenId} offer={exitOffer(intent.tickLower, intent.tickUpper, pool.tickSpacing, facts.pool.tick ?? facts.initialPrice?.tick ?? null)} />
        </nav>
      )}
    </section>
  )
}

/**
 * Added 2026-10-06 (the review of the owner's point 5; rugged97: "someone makes an LP to buy or sell; when the price hits
 * the edge of the range we close the position automatically"): Auto-exit beside the position's link, as today's created
 * view offers it on Robinhood Chain (components/create/CreatedNext.tsx), for every position this view shows (Base, Arbitrum
 * One, and the zap path's): recommended when the range sits beside the plan's price, never offered for a range that covers
 * every price (present.ts exitOffer). Only where Auto-exit opens on that network (the vault's and Auto-exit's gates, as the
 * position's page asks them). It opens the position's page with Auto-exit's dialog asked for (lib/automate/autoExitAsk.ts),
 * which the page's automation panel opens once it offers it there, by the panel's own key (../autoexit/entry.ts).
 */
function CreatedCompound({ chainId, dex, tokenId }: { chainId: V2ChainId; dex: Dex; tokenId: bigint }) {
  const gate = useGate('vault', chainId)
  if (!gateOpen(gate)) return null
  return <>{(['compound', 'domino'] as const).map((mode) => <a key={mode} className="dm-created-choice" href={setupHref({ chainId, dex, tokenId }, mode)} data-created-next={mode}>
    <span className="dm-created-art" aria-hidden="true"><ModeArt mode={mode} size="card" play="none" /></span>
    <span className="dm-created-text"><span className="dm-created-name">{FEATURES[mode].name}<span className="dm-created-fee"> · {FEATURES[mode].fee}</span></span><span className="dm-created-note">{FEATURES[mode].line}</span></span>
    <span className="dm-created-go"><span className="dm-created-go-text">Set up</span><IconChevronRight size={16} /></span>
  </a>)}</>
}

function CreatedExit({ chainId, dex, tokenId, offer }: { chainId: V2ChainId; dex: Dex; tokenId: bigint; offer: ReturnType<typeof exitOffer> }) {
  const vault = useGate('vault', chainId)
  const exit = useGate('autoExit', chainId)
  if (offer === 'none' || !gateOpen(vault) || !gateOpen(exit)) return null
  const beside = offer === 'recommended'
  return (
    <a
      className="dm-created-choice"
      href={v2PositionHref({ chainId, dex, tokenId })}
      onClick={() => askAutoExitOnArrival(exitOrderKey(tokenId.toString(), chainId, dex))}
      data-created-next="autoexit"
      data-created-recommended={beside ? '' : undefined}
    >
      <span className="dm-created-art" aria-hidden="true">
        <ExitThumb />
      </span>
      <span className="dm-created-text">
        <span className="dm-created-name">
          {AUTO_EXIT_FEATURE.name}
          <span className="dm-created-fee"> · {AUTO_EXIT_FEATURE.fee}</span>
          {beside && (
            <>
              {' '}
              <Pill tone="accent" className="dm-created-pill">{JOURNEY.created.recommended}</Pill>
            </>
          )}
        </span>
        <span className="dm-created-note">{AUTO_EXIT_FEATURE.line}</span>
      </span>
      <span className="dm-created-go">
        <span className="dm-created-go-text">{JOURNEY.created.turnOn}</span>
        <IconChevronRight size={16} />
      </span>
    </a>
  )
}

function ReceiptRow({ line, amount }: { line: ReceiptLine; amount: (token: Address, raw: bigint, round?: 'down' | 'up') => ReactNode }) {
  switch (line.kind) {
    case 'paid-in':
      // What went in, rounded up as Review's "You put in" and each "Allow" write it: one figure on one screen (2026-10-06).
      return <Fact label={JOURNEY.created.paidIn} data="receipt-paid-in">{amount(line.token, line.amount, 'up')}</Fact>
    case 'swapped':
      return <Fact label={JOURNEY.created.swapped} data="receipt-swapped">{amount(line.tokenIn, line.amountIn)} → {amount(line.tokenOut, line.amountOut)}</Fact>
    case 'fee':
      return <Fact label={JOURNEY.created.fee} data="receipt-fee" attrs={{ 'data-receipt-fee': line.amount.toString() }}>{amount(line.token, line.amount, 'up')}</Fact>
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
