import { lazy, Suspense, useState, type LazyExoticComponent } from 'react'
import { CREATE } from '../../lib/create/copy'
import { networkFiguresAt, poolOnOtherChain, useOtherChains } from '../../lib/create/otherChains'
import { pricePair } from '../../lib/read/orientation'
import { automateHref } from '../explore/routes'
import type { PairBalancesState } from './usePairBalances'
import { batchedSteps, priceOf, takesOnly, validateSlippage, walletSteps, type JourneyState } from '../../lib/create/journey'
import { slippageWarns, slippageWritten } from '../../lib/create/slippage'
import { formatUnits } from '../../lib/read/decimal'
import { rangePosition } from '../../lib/read/screens/poolRange'
import { Address } from '../read/screens/Address'
import { SymbolText } from '../read/screens/SymbolText'
import { Button } from '../ui'
import { ASSISTED_SWAP_FEE_BPS, type DepositPlan } from '../../lib/create/depositPlan'
import { reviewPlan } from '../../lib/create/reviewPlan'
import { NATIVE_CURRENCY } from '../../lib/read/screens/identity'
import { useMarketOption } from '../../lib/read/screens/knownMarkets'
import { useBatchAbility, useCreateProgress, useCreated, type LiveState } from '../../lib/create/createProgress'
import { useRoutedReview } from '../../lib/create/routedReview'
import { PoolPair, RangeSummary } from './StepList'
import { CreatedNext } from './CreatedNext'
import { NewPositionAgain } from './createdParts'
import { AmountText, UsdText } from '../figures'
import { TokenMarkPair } from '../TokenIcon'
import { coversFullRange, heldAmounts, poolSizeLine, rawBalances, reportedTvl } from './valuation'
import type { PoolOption } from '../../lib/read/screens/poolsList'

/** One side of the position: an amount of one of the pool's tokens, in whole tokens, grouped as the read writes it. */
interface HeldSide {
  amount: string
  token: PoolOption['currencies'][number]
}
const routeRemainder = (total: string, gross: string) => BigInt(total) - BigInt(gross)

const sideOf = (pool: PoolOption, index: 0 | 1, raw: bigint | string): HeldSide => {
  const currency = pool.currencies[index]
  const units = formatUnits(String(raw), currency.decimals)
  return { amount: units && units.kind === 'units' ? units.text : String(raw), token: currency }
}

/**
 * One amount in the headline: short for reading (six significant digits, lib/format/amount.ts), the exact figure in
 * its title and on `data-exact` (Create position works from the exact amounts, never from this text). The symbol is
 * untrusted text, isolated by SymbolText.
 */
function Side({ side, index, lead }: { side: HeldSide; index: 0 | 1; lead?: string }) {
  // The words as before, each part in its own inline span for the V4 well (new.html .yp-a): "About" and the unit small,
  // the figure in the serif, the + quiet. The lead keeps its trailing space as a text node.
  const word = lead?.trim()
  return (
    <span className="dm-flow-headline-side" data-review-side={index} data-exact={side.amount}>
      {word && (
        <>
          <span className={word === '+' ? 'dm-rv-plus' : 'dm-rv-about'}>{word}</span>{lead?.slice(lead.indexOf(word) + word.length)}
        </>
      )}
      <span className="dm-rv-num">
        <AmountText text={side.amount} />
      </span>{' '}
      <span className="dm-rv-unit">
        <SymbolText token={side.token} />
      </span>
    </span>
  )
}

/** How the wallet funds these choices, from the balances the read service reported: what Review shows, and what the final control's line says. */
const planFor = (state: JourneyState, balances: PairBalancesState): DepositPlan | null => reviewPlan(state, rawBalances(balances))?.plan ?? null

/** What each live state says under its step, once Create position runs. */
const LIVE_CAPTION: Record<LiveState, string> = {
  waiting: 'Next',
  reading: 'Checking…',
  wallet: 'Confirm in your wallet',
  chain: 'Waiting for the network',
  done: 'Done',
  failed: 'Stopped',
}

/**
 * Step 4, Review: the position at the top, then the wallet steps in order,
 * each turning green as Create position completes it, then the technical facts
 * under a closed Details. No Domino fee on the deposit: automation, with its
 * fee on earned fees, is applied later from Automate. When the wallet holds
 * only one of the two tokens, the headline is what the position holds after
 * part of it is swapped, and the steps include that swap with its fee.
 *
 * Changed on purpose (round 6, 2026-09-27, the owner: plain words, fewer
 * numbers, the technical parts closed): the amounts are short, the range reads
 * "1 ETH = 1,747.65 to 3,766.84 USDG", each wallet step is one short line and
 * names its token by symbol only, and the slippage tolerance, the ticks, the
 * pool id and the token contracts are under Details.
 */
export function StageReview({ state, now, balances }: { state: JourneyState; now: number; balances: PairBalancesState }) {
  const pool = state.pool
  const price = priceOf(pool, now)
  const usable = price && price.state === 'usable' ? price : null
  const inside = usable && state.range ? rangePosition(state.range, usable.tick) === 'inside' : null
  const planned = reviewPlan(state, rawBalances(balances))
  const plan = planned?.plan ?? null
  const swap = plan && plan.kind === 'swap' ? plan : null
  const routed = useRoutedReview()
  const routeKept = routed ? routeRemainder(routed.totalInput, routed.gross) : 0n
  const fee = `${ASSISTED_SWAP_FEE_BPS / 100}%`
  // A wallet that signs every step at once (EIP-5792 `atomic` supported, as Create position read it): the one step it
  // asks for, from the start (2026-09-28). A wallet that could only after turning on its smart account keeps the steps,
  // with the one-signature choice under Create position; one that cannot batch, or not yet read, keeps them too.
  const ability = useBatchAbility()
  const ordinary = walletSteps(state, swap ? swap.from : null, fee)
  // The swap through Uniswap, when the onboarding service offers one (finance/routedSwap.ts), in CREATE's plain words
  // (audit E20, 2026-10-01): no "router" and no "guaranteed" on the screen.
  const ROUTED = CREATE.review.routed
  const inOrder = routed && pool ? [
    ...(pool.currencies[routed.from].address !== NATIVE_CURRENCY ? [
      { key: 'route-approve', title: ROUTED.approveStep, token: pool.currencies[routed.from], detail: ROUTED.approveDetail },
      { key: 'route-permit', title: ROUTED.permitStep, detail: ROUTED.permitDetail },
    ] : []),
    { key: 'route-swap', title: ROUTED.swapStep, detail: ROUTED.swapDetail(fee) },
    ...pool.currencies.filter((token, i) => token.address !== NATIVE_CURRENCY && (i !== routed.from || routeKept > 0n))
      .map((token) => ({ key: `approve:${token.address}`, title: CREATE.review.approveStep, token, detail: ROUTED.approveOnlyIfShort })),
    { key: 'fund', title: CREATE.review.fundStep, detail: '' },
    { key: 'mint', title: CREATE.review.mintStep, detail: '' },
  ] : ordinary
  const steps = ability === 'supported'
    ? routed ? [{ key: 'batch', title: ROUTED.batchStep, detail: CREATE.review.batchStepDetail }] : batchedSteps(inOrder)
    : inOrder
  // Once Create position runs, its own steps, as they happen: the tokens it found in the wallet decide them.
  const progress = useCreateProgress()
  const live = progress && progress.length > 0 ? progress : null
  // "Next" is said under the first step still waiting, and only there.
  const next = live ? live.findIndex((step) => step.state === 'waiting') : -1
  const shown = live
    ? live.map((step, index) => ({ ...step, caption: step.state === 'waiting' && index !== next ? '' : LIVE_CAPTION[step.state] }))
    : steps.map((step) => ({ ...step, state: null as LiveState | null, caption: step.detail }))
  const held = pool && planned ? ([sideOf(pool, 0, planned.need[0]), sideOf(pool, 1, planned.need[1])] as const) : null
  const slippage = validateSlippage(state.slippageBps)
  // The headline's value in USD (USDG pairs only).
  const total = planned ? (heldAmounts(state, balances)?.total ?? null) : null
  // QA round 2, N51 (the owner's yes above 10%) and Q20: the same plain sentence the amount step says beside its total
  // (valuation.ts poolSizeLine, one helper for both, its review), on the TVL its preview card and Markets show (N8, pass 3).
  const marketPool = useMarketOption(pool)
  const sizeText = marketPool && total !== null ? poolSizeLine(reportedTvl(networkFiguresAt(marketPool, Math.floor(now / 1000))), total) : null
  // QA round 2, Q24: the pair named as its price is written, marks matched to the names.
  const pair = pool ? pricePair(pool.currencies[0], pool.currencies[1]) : null
  // QA round 2, Q23/N37: the pool's network beside its fee, where the chosen pool's panel names it (other networks offered).
  const others = useOtherChains()
  const network = pool ? (others?.name(pool.currencies[0].chainId) ?? null) : null
  // QA round 2, Q12: automation is added from Automate once the position exists; once it does, the created view offers it.
  const created = useCreated()
  const other = swap ? (swap.from === 0 ? 1 : 0) : 0
  // A range that takes one token alone (2026-09-28, one-sided): the headline names that token only, never "0" of the
  // other; and a deposit swapped whole for it is said as all of it, never "about 0" kept.
  const only = takesOnly(state)
  const whole = swap !== null && swap.swap >= swap.deposit
  return (
    <div className="dm-flow-stack" data-stage="review">
      {/* The created view opens here, above Your position, once the position exists (CreatedNext, createdParts.tsx). */}
      <div data-created-slot="" />
      <section aria-labelledby="create-choices-heading" className="dm-flow-section">
        <h3 id="create-choices-heading" className="dm-flow-subtitle">
          {CREATE.review.choices}
        </h3>
        <div className="dm-flow-headline" data-review-headline="">
          {/* PoolPair already ends in the fee ("ETH / TOKEN · 0.30%"); a chip beside it said the same thing twice. */}
          <p className="dm-flow-headline-pair">
            {pool ? (
              <>
                <TokenMarkPair base={pair?.base ?? pool.currencies[0]} quote={pair?.quote ?? pool.currencies[1]} size={40} ring="#1a1815" />
                <span className="min-w-0">
                  <PoolPair option={pool} network={network} />
                </span>
              </>
            ) : (
              CREATE.page.notChosen
            )}
          </p>
          <p className="dm-flow-headline-amounts tnum" data-review-amounts="" data-review-plan={plan?.kind}>
            {/* Each side is one phrase that keeps its line, and the + leads the second, so a narrow line breaks only before the +. */}
            {routed && pool ? (
              <>
                {routeKept > 0n && <Side side={sideOf(pool, routed.from, routeKept)} index={routed.from} lead={`${CREATE.review.about} `} />}
                {' '}<Side side={sideOf(pool, routed.from === 0 ? 1 : 0, routed.minimum)} index={routed.from === 0 ? 1 : 0} lead={routeKept > 0n ? '+ ' : `${CREATE.review.about} `} />
              </>
            ) : swap && pool && whole ? (
              // All of the one token swapped: what it buys, an estimate before the pool's own price impact.
              <Side side={sideOf(pool, other, swap.receive)} index={other} lead={`${CREATE.review.about} `} />
            ) : swap && pool ? (
              // What the position holds once part of the one token is swapped: estimates, before the pool's own price impact.
              <>
                <Side side={sideOf(pool, swap.from, swap.deposit - swap.swap)} index={swap.from} lead={`${CREATE.review.about} `} />{' '}
                <Side side={sideOf(pool, other, swap.receive)} index={other} lead="+ " />
              </>
            ) : held && only !== null ? (
              <Side side={held[only]} index={only} />
            ) : held ? (
              <>
                <Side side={held[0]} index={0} /> <Side side={held[1]} index={1} lead="+ " />
              </>
            ) : (
              CREATE.page.notChosen
            )}
          </p>
          {!routed && total !== null && (
            <p className="dm-usd-line dm-flow-headline-usd">
              <span>{CREATE.review.total}</span>
              {/* QA round 2, N2 (d): under a cent it reads "<$0.01", as every Estimated total does. */}
              <UsdText value={total} floor />
            </p>
          )}
          {!routed && sizeText !== null && (
            <p className="dm-flow-headline-line" data-review-pool-share="">
              {sizeText}
            </p>
          )}
          {!routed && swap && pool && (
            <p className="dm-flow-headline-line tnum" data-review-swap={swap.from} data-review-swap-whole={whole ? '' : undefined}>
              You put in <AmountText text={sideOf(pool, swap.from, swap.deposit).amount} /> <SymbolText token={pool.currencies[swap.from]} />.{' '}
              {whole ? (
                <>
                  All of it is swapped for <SymbolText token={pool.currencies[other]} />.
                </>
              ) : (
                <>
                  About <AmountText text={sideOf(pool, swap.from, swap.swap).amount} /> <SymbolText token={pool.currencies[swap.from]} /> of it is swapped for{' '}
                  <SymbolText token={pool.currencies[other]} />.
                </>
              )}
            </p>
          )}
          {routed && pool && (
            <>
              <p className="dm-flow-headline-line tnum" data-review-route="uniswap">
                {ROUTED.lead} <AmountText text={sideOf(pool, routed.from, routed.gross).amount} /> <SymbolText token={pool.currencies[routed.from]} /> {ROUTED.via}{' '}
                {routed.poolUnfilled ? ROUTED.unfilled : routed.advantageBps !== null ? ROUTED.better((routed.advantageBps / 100).toFixed(2)) : ''}
              </p>
              <p className="dm-flow-headline-line tnum" data-review-route-minimum="">
                {ROUTED.atLeast} <AmountText text={sideOf(pool, routed.from === 0 ? 1 : 0, routed.minimum).amount} /> <SymbolText token={pool.currencies[routed.from === 0 ? 1 : 0]} /> {ROUTED.afterFee}{' '}
                {ROUTED.feeLead} <AmountText text={sideOf(pool, routed.from === 0 ? 1 : 0, routed.fee).amount} /> <SymbolText token={pool.currencies[routed.from === 0 ? 1 : 0]} /> {ROUTED.feeOnce(fee)}
                {' '}{ROUTED.keep}
              </p>
            </>
          )}
          <p className="dm-flow-headline-line tnum" data-review-range="">
            {state.range && usable ? (
              <>
                {CREATE.amount.rangeHeading}: <RangeSummary range={state.range} price={usable} />
              </>
            ) : state.range ? (
              CREATE.review.summary.rangeTicks(state.range.lower, state.range.upper)
            ) : (
              CREATE.page.notChosen
            )}
          </p>
        </div>
        {slippage.ok && slippageWarns(slippage.bps) && (
          <p role="status" className="dm-flow-position" data-tone="neutral" data-review-slippage-warning="">
            {CREATE.amount.slippageWarning}
          </p>
        )}
        {/* Only when there is something to warn about, as the range step does:
            a range that does not hold the price earns no fees until the price
            moves into it. The ordinary case is silent on screen. */}
        {inside === false && usable && (
          // A price read more than 5 minutes ago keeps its sentence in normal type, with no note about its age (QA round 2
          // sweep: no stale notices); data-stale keeps it as data.
          <p role="status" className="dm-flow-position" data-tone="neutral" data-review-position="" data-stale={usable.stale ? '' : undefined}>
            {CREATE.review.outOfRange}
          </p>
        )}
        {inside === true && usable && <span className="sr-only" data-review-position="inside">{CREATE.review.inRange}</span>}
        {routed?.sequential && (
          <p role="status" className="dm-flow-position" data-tone="neutral" data-review-route-risk="">
            <span>{ROUTED.sequential}</span>
          </p>
        )}
        {!routed && swap && pool && (
          // One span: the line is a flex row (its dot, then the sentence), and the symbols must stay inside the sentence.
          <p role="status" className="dm-flow-position" data-tone="neutral" data-review-swap-note="">
            {whole ? (
              <span>
                You don’t have enough <SymbolText token={pool.currencies[other]} />, so the <SymbolText token={pool.currencies[swap.from]} /> you put in is swapped for it in
                this pool first. {CREATE.review.swapAllNote(fee)}
              </span>
            ) : (
              <span>
                You don’t have enough <SymbolText token={pool.currencies[other]} />, so part of your <SymbolText token={pool.currencies[swap.from]} /> is swapped for it in this pool
                first. {CREATE.review.swapNote(fee)}
              </span>
            )}
          </p>
        )}
        {/* The pool's liquidity figure is reported and zero: the swap has nothing to trade against. Create position checks the pool on chain too, before anything is deposited. */}
        {!routed && swap && planned?.noLiquidity && (
          <p role="status" className="dm-flow-position" data-tone="neutral" data-review-liquidity="none">
            {CREATE.review.emptyPool}
          </p>
        )}
        {plan && plan.kind === 'short' && pool && (
          <p role="status" className="dm-flow-position" data-tone="neutral" data-review-short={plan.token}>
            <span>
              Your wallet has <AmountText text={sideOf(pool, plan.token, plan.have).amount} /> <SymbolText token={pool.currencies[plan.token]} />
              {pool.currencies[plan.token].address === NATIVE_CURRENCY ? ' after network fees' : ''}; this position needs{' '}
              <AmountText text={sideOf(pool, plan.token, plan.need).amount} />. Lower the amount, or add <SymbolText token={pool.currencies[plan.token]} /> to your wallet.
            </span>
          </p>
        )}
        {/* Changed on purpose 2026-10-30 (QA round 2, final review create-1): Automate opens in a new tab, so Review and every
            choice before it stay as they are (a same-tab link left New position, and Back started an empty flow); a screen
            reader hears where it opens. Once the position exists, the created view offers Automate in place. */}
        {created === null && (
          <p className="dm-flow-position" data-tone="neutral" data-review-automate-later="">
            <span>
              {pool && coversFullRange(state.range, pool.tickSpacing) ? CREATE.review.automateLaterFull : CREATE.review.automateLater}{' '}
              <a className="underline" href={automateHref} target="_blank" rel="noopener noreferrer">
                {CREATE.review.automateLink}
                <span className="sr-only">{CREATE.page.newTab}</span>
              </a>
              .
            </span>
          </p>
        )}
      </section>

      <section aria-labelledby="create-steps-heading" className="dm-flow-section">
        <h3 id="create-steps-heading" className="dm-flow-subtitle">
          {/* QA round 2, Q31 (2026-10-30): titled for what to do while no wallet is connected, as V2's Review is; "In your
              wallet" once one is. */}
          {balances.status === 'disconnected' ? CREATE.review.stepsConnect : CREATE.review.steps}
        </h3>
        {/* What the steps are is said once, under Create position (its reason line), not again here. */}
        <ol className="dm-flow-wsteps" data-wallet-steps="" data-live={live ? '' : undefined} aria-live="polite">
          {shown.map((step, index) => (
            <li key={step.key} data-wallet-step={step.key} data-step-state={step.state ?? undefined}>
              <span
                aria-hidden="true"
                className="dm-step-marker"
                data-state={step.state === 'done' ? 'done' : step.state === 'wallet' || step.state === 'chain' || step.state === 'reading' ? 'current' : undefined}
              >
                {step.state === 'done' ? '✓' : index + 1}
              </span>
              <span className="dm-flow-wstep-body">
                <span className="dm-flow-wstep-title">
                  {/* "Approve USDG": the token by its symbol; its contract is under Details. */}
                  <span>
                    {step.title}
                    {step.token && (
                      <>
                        {' '}
                        <SymbolText token={step.token} />
                      </>
                    )}
                  </span>
                </span>
                {step.caption && <span className="dm-flow-wstep-note">{step.caption}</span>}
              </span>
            </li>
          ))}
        </ol>
        {/* Where the ember rests while no pointer moves (new.html: 70px in from the card's left, 40px over its top). */}
        <span className="dm-np-ember-at" data-ember-rest="" aria-hidden="true" />
      </section>

      {/* The technical facts behind the position, closed until opened: for whoever wants them, never in the way. */}
      {pool && (
        <details className="dm-details dm-flow-advanced" data-review-details="">
          <summary>
            <span>{CREATE.review.details}</span>
          </summary>
          <dl className="dm-flow-facts">
            <div data-review-slippage={slippage.ok ? slippage.bps : undefined}>
              <dt>{CREATE.amount.slippageLabel}</dt>
              <dd className="tnum">{slippage.ok ? slippageWritten(slippage.bps) : CREATE.page.notChosen}</dd>
            </div>
            {state.range && (
              <div>
                <dt>{CREATE.review.detailRows.ticks}</dt>
                <dd className="tnum">{CREATE.review.summary.rangeTicks(state.range.lower, state.range.upper).replace(/^ticks /, '')}</dd>
              </div>
            )}
            <div>
              <dt>{CREATE.review.feeLabels.pool}</dt>
              <dd className="tnum">{pool.fee}</dd>
            </div>
            {swap && (
              <div>
                <dt>{CREATE.review.feeLabels.swap}</dt>
                <dd>{routed ? ROUTED.feeRow(fee) : CREATE.review.feeValues.swap}</dd>
              </div>
            )}
            {/* How far the swap through Uniswap moves its price, as the route reported it: a technical fact, here only. */}
            {routed && (
              <div data-review-route-impact="">
                <dt>{ROUTED.impactLabel}</dt>
                <dd className="tnum">{ROUTED.impact(routed.priceImpact)}</dd>
              </div>
            )}
            <div>
              <dt>{CREATE.review.detailRows.contracts}</dt>
              <dd className="dm-flow-facts-tokens">
                {pool.currencies.map((currency) => (
                  <span key={currency.address}>
                    <SymbolText token={currency} />{' '}
                    {currency.address === NATIVE_CURRENCY ? <span className="text-fg-subtle">{CREATE.review.detailRows.native}</span> : <Address value={currency.address} short />}
                  </span>
                ))}
              </dd>
            </div>
            <div>
              <dt>{CREATE.review.detailRows.pool}</dt>
              <dd>
                <Address value={pool.key} short />
              </dd>
            </div>
          </dl>
        </details>
      )}
    </div>
  )
}

// The retired setup control belongs only to non-V2 wallet test builds. V2 creation has its own gated chunk in Journey.
const CreateControl = __DOMINO_WALLET_SESSION__ && !__DOMINO_V2__
  ? lazy(() =>
      import('./DepositAmounts')
        .then((module) => ({ default: module.CreatePosition }))
        .catch(() => ({ default: () => <CreateUnavailable note={CREATE.review.loadFailed} /> })),
    )
  : null

type CreateComponent = NonNullable<typeof CreateControl> extends LazyExoticComponent<infer C> ? C : never
/** Create position once the chunk asked ahead is in, for Review to render as it is. */
let loadedCreate: CreateComponent | null = null

/**
 * The same chunk, asked ahead once a pool is chosen (Journey.tsx), so Review finds Create position loaded instead of
 * waiting for it behind the disabled button (speed wave, 2026-09-28; study item 33): the chunk's download, and the
 * 300 ms React holds a lazy control's stand-in on screen once it has shown it. Loading runs nothing: the module only
 * defines the control, which runs once Review renders it. The same import(), behind the same flag.
 */
export const preloadCreateControl = __DOMINO_WALLET_SESSION__ && !__DOMINO_V2__
  ? () => void import('./DepositAmounts').then((module) => { loadedCreate = module.CreatePosition }, () => undefined)
  : () => undefined

export function CreateUnavailable({ note }: { note: string }) {
  return (
    <>
      <Button type="button" variant="primary" size="xl" className="w-full" disabled data-create-position="" aria-describedby="create-reason">
        {CREATE.page.create}
      </Button>
      <p id="create-reason" className="dm-flow-reason" data-align="start">
        {note}
      </p>
    </>
  )
}

/**
 * The non-V2 flow's last control. A V2 build draws only the unavailable stand-in here, never the retired setup.
 * This is the one control that depends on the build, so it lives here, where
 * the build flag is defined, and not in lib/create/copy.ts, which is compiled
 * for tests without it.
 */
export function FinalControl({ state, balances, onBusy }: { state: JourneyState; balances: PairBalancesState; onBusy?: (busy: boolean) => void }) {
  // The position Create position just made: what comes next is offered under it (2026-09-24, the three features).
  const created = useCreated()
  // Create position as the chunk asked ahead left it, drawn at once; else lazily, behind the stand-in, as before
  // (2026-09-28). Chosen once for the control's life, so it never changes type, and loses nothing, under the person.
  const [Control] = useState(() => loadedCreate ?? CreateControl)
  // Added 2026-10-05 (New position on Base and Arbitrum One): a pool of another network opens through Domino V2 alone
  // (src/v2in/journey/JourneyCreateV2.tsx), never through Domino V1's setup contract, which is Robinhood Chain's. This
  // control stands there only when that code could not load.
  // A V2 build must never fall through to the retired setup contract, even if its V2 chunk fails to load.
  if (__DOMINO_V2__) return <CreateUnavailable note={CREATE.review.loadFailed} />
  if (poolOnOtherChain(state.pool)) return <CreateUnavailable note={CREATE.review.otherNetwork} />
  if (Control) {
    return (
      <>
        <Suspense fallback={<CreateUnavailable note={CREATE.review.loading} />}>
          <Control state={state} reviewed={planFor(state, balances)} onBusy={onBusy} />
        </Suspense>
        {created && <CreatedNext tokenId={created} state={state} />}
        {created && <NewPositionAgain />}
      </>
    )
  }
  return <CreateUnavailable note={CREATE.review.noWallet} />
}
