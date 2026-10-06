import { Button, KeyValue, KeyValueList } from '../../components/ui'
import { durationText } from '../../v2/crosschain/amounts'
import { NOT_REPORTED, PROVIDER_NAME } from '../../v2/crosschain/copy'
import { originGasDetail, presentQuote, shortAmountText, type CandidateView, type Naming } from '../../v2/crosschain/present'
import type { QuotePlan } from '../../v2/crosschain/types'
import { FUNDS_SHOW_BRIDGE_ELSEWHERE } from './constants'
import { bridgeElsewhereLine, FUNDS_TEXT } from './copy'
import type { FlowStage } from './flow'
import { runLine, stepWords } from './model'

/** Where the deposit's wallet steps stand, as the offer draws them. */
export interface StepsView {
  running: boolean
  stage: FlowStage | null
  /** The approval was found already covered, or went through. */
  approval: 'waiting' | 'wallet' | 'sent' | 'included' | 'finalized' | 'skipped'
  deposit: 'waiting' | 'wallet' | 'done'
  notice: { copy: string; code: string | null } | null
}

export const IDLE_STEPS: StepsView = { running: false, stage: null, approval: 'waiting', deposit: 'waiting', notice: null }

/** "Get gas on {destination}" shown in the card (§3.9): only when the destination's ETH was read as none. Never pre-chosen. */
export interface GasChoice {
  destination: string
  chosen: boolean
  disabled: boolean
  onChange: (chosen: boolean) => void
}

/**
 * The bridge quote inside the offer (spec F7 §3.4, §3.5, §8.2 S2).
 *
 * Changed on purpose 2026-10-06 (the owner's point 4: "just a Next button, click and done"; little text, everything
 * behind the scenes with one small sign of what is happening): what shows is the winner's two §3.5 sentences, word for
 * word with their amounts rounded ("You receive about {amount} on {destination} (at least {minimum})", "Arrives in about
 * {duration}"), the one button, one live line while the wallet works ("Step 1 of 2 · approve in your wallet"), and
 * decision #16's discrete line. Everything else the spec has the quote show is in ONE Details in the same card: both
 * candidates and their §3.5 lines (Domino's fee with its chain, token and where charged; the provider's fee; the origin's
 * network fee; Relay's gas on the destination), the §3.4 sentence of a candidate with no price, why this route, each
 * provider's network fee estimate, how long the quote is good for and each request id (never calldata). No "Quote"
 * heading and no "Best" pill. The deposit's two transactions stay two (decision #15): the line counts them. Every error
 * and notice stays, and so does V1's "I rejected it in my wallet". `decision: null` is "No route available right now."
 * with one line per provider. No USD anywhere, not even the provider's own estimate.
 *
 * Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, F7 delta of 6 Oct §1 and §2; spec §8.2):
 *   - in view, not only in Details: the Domino fee with its amount and token, its chain and where it is charged (§3.5's
 *     sentence for the winner, in decision #16's discrete line, which showed only "Domino fee 0.35% · via …"), and one
 *     network cost line: the winner's gas on the origin as its provider estimated it (Details' own words), or "Not
 *     reported", never 0. The other candidate, the provider's fee and the request ids stay in Details;
 *   - the owner revoked decision #15: when the approval and the deposit go as one batch, the live line says "Approval and
 *     deposit in one confirmation".
 *
 * `locked` (the service not wired): Deposit stays closed with the offer's plain sentence; nothing here reaches the wallet.
 */
export function QuoteView({
  quote,
  name,
  note,
  steps,
  handedOver,
  locked,
  waiting = false,
  gas,
  short,
  onDeposit,
  onForget,
}: {
  quote: QuotePlan
  name: Naming
  note: string | null
  steps: StepsView
  /** This quote's deposit was already handed to the wallet on this page: never again. */
  handedOver: boolean
  /** The gate's plain sentence while the option runs only up to the review; null when it runs for real. */
  locked: string | null
  /** Added 2026-10-06: an earlier quote shown while a new one comes: its button stays closed. */
  waiting?: boolean
  /** "Get gas on {destination}", shown here when the destination's ETH reads as none (§3.9); else null. */
  gas: GasChoice | null
  /**
   * Added 2026-10-06 (the owner's point 2b): the one line saying the holding is smaller than what the position lacks
   * (`holding`). Changed on purpose 2026-10-06 (rugged's delta of 6 Oct §3): the `quote` kind ("may bring less") is gone,
   * since a quote by output guarantees at least what the position lacks (minimumOutputRaw >= amountRaw).
   */
  short: { text: string; kind: 'holding' } | null
  onDeposit: () => void
  /** "I rejected it in my wallet", under the wallet_request_open sentence. */
  onForget: () => void
}) {
  const view = presentQuote(quote, name)
  const words = stepWords(quote, name)
  const winner = view.winner
  const other = view.candidates.find((c) => !c.winner && c.lines !== null && c.status === 'quoted') ?? null
  const advantage = quote.comparison.advantageRaw
  const lifetime = quote.expiresAt - quote.requestedAt
  const lockedId = 'funds-deposit-locked'
  const approval = words.approval && steps.approval !== 'skipped'
  const stage = steps.stage?.stage ?? null
  // A batch is one confirmation, whatever the steps' count (Changed on purpose 2026-10-06, rugged's answer of 6 Oct).
  const live = !steps.running ? null : stage === 'batch_wallet' || stage === 'batch_sent' ? FUNDS_TEXT.batchLine(stage === 'batch_sent') : runLine(stage, approval, words.origin)
  const sendable = quote.decision !== null && quote.steps.length > 0
  // In view (Changed on purpose 2026-10-06, rugged's answer of 6 Oct, F7 delta of 6 Oct §1): the winner's Domino fee, §3.5's
  // sentence (its amount rounded up, exact in the title), and its provider's gas estimate on the origin, never 0.
  const winning = quote.candidates.find((c) => c.provider === quote.decision) ?? null
  const fee = winner?.lines?.[0] ?? null
  const feeExact = winner?.exactLines?.[0] ?? null
  const gasFee = winning ? originGasDetail(quote, winning, name) : null
  const gasExact = winning ? originGasDetail(quote, winning, name, true) : null
  // The winner first, then the other: each with its §3.5 lines (exact in the title) or its §3.4 sentence.
  const candidate = (c: CandidateView) => (
    <div key={c.provider} className="dm-funds-candidate" data-funds-candidate={c.provider} data-funds-status={c.status} data-funds-winner={c.winner ? '' : undefined}>
      <p className="dm-funds-candidate-name">{c.winner ? FUNDS_TEXT.chosenRoute(c.name) : c.name}</p>
      {c.text && <p data-funds-candidate-text="">{c.text}</p>}
      {c.lines && (
        <ul data-funds-lines="">
          {c.lines.map((line, index) => (
            <li key={line} title={c.exactLines?.[index] !== line ? c.exactLines?.[index] : undefined}>
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
  return (
    <div className="dm-funds-quote" data-funds-quote="" data-funds-decision={view.decision ?? 'none'}>
      {note && (
        <p role="status" className="dm-funds-note" data-funds-quote-note="">
          {note}
        </p>
      )}
      {view.headline && (
        <div className="dm-funds-none" data-funds-no-route="">
          <p role="status">{view.headline}</p>
          <ul>
            {view.candidates.map((c) =>
              c.text ? (
                <li key={c.provider} data-funds-candidate={c.provider} data-funds-status={c.status}>
                  {c.text}
                </li>
              ) : null,
            )}
          </ul>
        </div>
      )}
      {winner?.receive && (
        <div className="dm-funds-receive" data-funds-receive="">
          <p className="dm-funds-delivery" title={winner.receive.exact !== winner.receive.text ? winner.receive.exact : undefined}>
            {winner.receive.text}
          </p>
          {winner.eta && <p className="dm-funds-eta" data-funds-eta="">{winner.eta}</p>}
        </div>
      )}
      {short && (
        <p className="dm-hint" data-funds-short-holding={short.kind}>
          {short.text}
        </p>
      )}
      {gas && sendable && (
        <label className="dm-acct-check dm-funds-gas" data-funds-destination-gas="suggested" data-funds-gas-card="">
          <input type="checkbox" checked={gas.chosen} disabled={gas.disabled || waiting || steps.running} onChange={(event) => gas.onChange(event.target.checked)} />
          <span>
            {FUNDS_TEXT.gasOffer(gas.destination)}
            <span className="dm-hint dm-funds-gas-why">{FUNDS_TEXT.gasWhy(gas.destination)}</span>
          </span>
        </label>
      )}
      {sendable && (
        <div className="dm-funds-act" data-funds-steps="" data-funds-step-approval={steps.approval} data-funds-step-deposit={steps.deposit}>
          {/* A deposit handed to the wallet is never offered again from this quote (F1); while the gate is `preview` it is never offered at all. */}
          <Button
            variant="accent"
            className="dm-funds-go"
            disabled={locked !== null || waiting || steps.running || handedOver}
            aria-describedby={locked !== null ? lockedId : undefined}
            onClick={locked !== null ? undefined : onDeposit}
            title={words.exact !== words.amount ? FUNDS_TEXT.bring(words.exact, words.origin) : undefined}
            data-funds-deposit-button=""
          >
            {FUNDS_TEXT.bring(words.amount, words.origin)}
          </Button>
          {live && (
            <p role="status" className="dm-funds-status" data-funds-run-status={steps.stage?.stage ?? ''}>
              {live}
            </p>
          )}
          {steps.notice && steps.notice.copy && (
            <p role="alert" className="dm-error" data-error-code={steps.notice.code ?? undefined} data-funds-run-notice="">
              {steps.notice.copy}
            </p>
          )}
          {/* V1's way out of a request handed to the wallet with no answer: said below its sentence, as V1 does. */}
          {steps.notice?.code === 'wallet_request_open' && !steps.running && (
            <Button variant="outline" size="sm" className="justify-self-start" onClick={onForget} data-funds-run-forget="">
              {FUNDS_TEXT.rejectedInWallet}
            </Button>
          )}
          {handedOver && (
            <p className="dm-hint" data-funds-handed-over="">
              {FUNDS_TEXT.depositHandedOver}
            </p>
          )}
          {locked !== null && (
            <p id={lockedId} className="dm-hint" data-funds-locked="">
              {locked}
            </p>
          )}
        </div>
      )}
      {/* Decision #16: the discrete small line beside the fee and the provider (§3.5, §8.2 S2), the fee in full since 2026-10-06. */}
      {quote.decision !== null && fee !== null && (
        <p
          className="dm-funds-elsewhere"
          data-funds-bridge-elsewhere=""
          data-funds-domino-fee=""
          title={feeExact !== null && feeExact !== fee ? (FUNDS_SHOW_BRIDGE_ELSEWHERE ? bridgeElsewhereLine(feeExact) : feeExact) : undefined}
        >
          {FUNDS_SHOW_BRIDGE_ELSEWHERE ? bridgeElsewhereLine(fee) : fee}
        </p>
      )}
      {quote.decision !== null && (
        <p
          className="dm-funds-elsewhere"
          data-funds-network-fee={gasFee === null ? 'not-reported' : 'estimated'}
          title={gasExact !== null && gasExact !== gasFee ? FUNDS_TEXT.networkFee(view.origin, gasExact, PROVIDER_NAME[quote.decision]) : undefined}
        >
          {FUNDS_TEXT.networkFee(view.origin, gasFee, PROVIDER_NAME[quote.decision])}
        </p>
      )}
      {/* Nothing to detail without a route: the headline and each provider's line say it all. */}
      {view.decision !== null && <details className="dm-details dm-funds-details" data-funds-quote-details="">
        <summary>{FUNDS_TEXT.details}</summary>
        <div className="dm-funds-details-body">
          {view.candidates.filter((c) => c.winner).concat(view.candidates.filter((c) => !c.winner)).map(candidate)}
          <KeyValueList>
            <KeyValue label={FUNDS_TEXT.youSend} data-funds-send="">
              <span title={words.exact !== words.amount ? words.exact : undefined}>{words.amount}</span>
            </KeyValue>
            {winner && advantage !== null && other && (
              <KeyValue label={FUNDS_TEXT.whyThisRoute}>
                {/* Changed on purpose 2026-10-06 (rugged's delta of 6 Oct §3): the decision is the better rate, so the margin is for the same amount sent. */}
                {`${winner.name} delivers ${shortAmountText(advantage, quote.request.destinationToken, name.book(quote.request.destinationChainId, quote.request.destinationToken))} more than ${other.name} for the same amount sent, after every fee.`}
              </KeyValue>
            )}
            {winner && quote.reason === 'only_quote' && <KeyValue label={FUNDS_TEXT.whyThisRoute}>{`Only ${winner.name} quoted this deposit.`}</KeyValue>}
            {quote.candidates.map((c) => {
              if (c.outputRaw === null) return null
              const fee = originGasDetail(quote, c, name)
              return (
                <KeyValue key={c.provider} label={`${PROVIDER_NAME[c.provider]}: network fee on ${view.origin}`} data-funds-origin-gas={c.provider}>
                  {fee === null ? NOT_REPORTED : `About ${fee}, estimated by ${PROVIDER_NAME[c.provider]}`}
                </KeyValue>
              )
            })}
            <KeyValue label="Quote valid for">{durationText(lifetime)}</KeyValue>
            {quote.candidates.map((c) =>
              c.tracking?.requestId ? (
                <KeyValue key={`${c.provider}-id`} label={`${PROVIDER_NAME[c.provider]} request`} mono>
                  {c.tracking.requestId}
                </KeyValue>
              ) : null,
            )}
          </KeyValueList>
        </div>
      </details>}
    </div>
  )
}
