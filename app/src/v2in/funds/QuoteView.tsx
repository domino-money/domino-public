import { Button, Card, KeyValue, KeyValueList, Pill, StepMarker } from '../../components/ui'
import { amountText, durationText } from '../../v2/crosschain/amounts'
import { bpsPercent, NOT_REPORTED, PROVIDER_NAME } from '../../v2/crosschain/copy'
import { originGasDetail, presentQuote, type CandidateView, type Naming } from '../../v2/crosschain/present'
import type { QuotePlan } from '../../v2/crosschain/types'
import { FUNDS_SHOW_BRIDGE_ELSEWHERE } from './constants'
import { bridgeElsewhereLine, FUNDS_TEXT } from './copy'
import type { FlowStage } from './flow'
import { stepWords } from './model'

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

/**
 * The bridge quote inside the offer (spec F7 §3.4, §3.5, §8.2 S2): both candidates, Relay then Across, and the winner;
 * for each priced one the §3.5 lines (the Domino fee with its chain, token and where it is charged; the provider's fee;
 * the output and the minimum; the origin's network fee "estimated by {provider}" or "Not reported"; Relay's gas
 * delivered on the destination; the time), and for the others the §3.4 sentence. `decision: null` is "No route available
 * right now." with one line per provider. The discrete line of decision #16 beside the fee and the provider. No USD
 * anywhere, not even the provider's own estimate. Then the wallet steps on the origin, two transactions and no batch
 * (decision #15): the switch, the exact approval (ERC-20 only) and the deposit. Copied on purpose from the rejected #/v2
 * section's quote card (src/v2ui/s2/QuoteCard.tsx, reference only), on the site's own kit.
 *
 * `locked` (the service not wired): the steps are shown up to the wallet, and Deposit stays closed with the offer's plain
 * sentence; nothing here can reach the wallet. Under Details only what a person may need to quote back: why this route,
 * each provider's network fee estimate, how long the quote is good for and each provider's request id (never calldata).
 */
export function QuoteView({
  quote,
  name,
  note,
  walletChainId,
  steps,
  handedOver,
  locked,
  onDeposit,
  onForget,
}: {
  quote: QuotePlan
  name: Naming
  note: string | null
  /** The chain the connected wallet is on; null while the offer is locked (no wallet of the person's sends it). */
  walletChainId: number | null
  steps: StepsView
  /** This quote's deposit was already handed to the wallet on this page: never again. */
  handedOver: boolean
  /** The gate's plain sentence while the option runs only up to the review; null when it runs for real. */
  locked: string | null
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
  const onOrigin = walletChainId === quote.request.originChainId
  const stepState = (state: 'waiting' | 'current' | 'done') => (state === 'done' ? 'done' : state === 'current' ? 'current' : 'upcoming')
  const switchState = onOrigin ? 'done' : steps.stage?.stage === 'switching' ? 'current' : 'waiting'
  const approvalState = steps.approval === 'included' || steps.approval === 'finalized' || steps.approval === 'skipped' ? 'done' : steps.approval === 'waiting' ? 'waiting' : 'current'
  const depositState = steps.deposit === 'done' ? 'done' : steps.deposit === 'wallet' ? 'current' : 'waiting'
  const lockedId = 'funds-deposit-locked'
  const candidate = (c: CandidateView) => (
    <Card key={c.provider} level={2} className="dm-funds-candidate" data-funds-candidate={c.provider} data-funds-status={c.status} data-funds-winner={c.winner ? '' : undefined}>
      <div className="flex items-center gap-2">
        <span className="dm-subtitle">{c.name}</span>
        {c.winner && <Pill tone="accent">{FUNDS_TEXT.best}</Pill>}
      </div>
      {c.text && <p className="mt-2 text-body" data-funds-candidate-text="">{c.text}</p>}
      {c.lines && <div className="dm-funds-quote-lines" data-funds-lines="">
        <p className="dm-funds-delivery">{c.lines[2]}</p>
        <ul>{c.lines.filter((_, index) => index !== 2).map((line) => <li key={line}>{line}</li>)}</ul>
      </div>}
    </Card>
  )
  let index = 0
  return (
    <div className="grid gap-4" data-funds-quote="" data-funds-decision={view.decision ?? 'none'}>
      <h4 className="dm-subtitle">{FUNDS_TEXT.quoteTitle}</h4>
      {note && (
        <p role="status" className="text-body" data-funds-quote-note="">
          {note}
        </p>
      )}
      {view.headline && (
        <p role="status" className="text-body" data-funds-no-route="">
          {view.headline}
        </p>
      )}
      <div className="grid gap-3">{view.candidates.filter((c) => !winner || c.winner).map(candidate)}</div>
      {winner && <details className="dm-details dm-funds-alternatives" data-funds-alternatives="">
        <summary>Compare routes</summary>
        <div>{view.candidates.filter((c) => !c.winner).map(candidate)}</div>
      </details>}
      {/* Decision #16: the discrete small line beside the fee and the provider (§3.5, §8.2 S2). */}
      {FUNDS_SHOW_BRIDGE_ELSEWHERE && quote.decision !== null && (
        <p className="text-caption text-fg-muted" data-funds-bridge-elsewhere="">
          {bridgeElsewhereLine(bpsPercent(quote.appFeeBps), PROVIDER_NAME[quote.decision])}
        </p>
      )}
      <details className="dm-details" data-funds-quote-details="">
        <summary>{FUNDS_TEXT.details}</summary>
        <KeyValueList>
          {winner && advantage !== null && other && (
            <KeyValue label="Why this route">
              {`${winner.name} delivers ${amountText(advantage, quote.request.destinationToken, name.book(quote.request.destinationChainId, quote.request.destinationToken))} more than ${other.name}, after every fee.`}
            </KeyValue>
          )}
          {winner && quote.reason === 'only_quote' && <KeyValue label="Why this route">{`Only ${winner.name} quoted this deposit.`}</KeyValue>}
          {quote.candidates.map((c) => {
            if (c.outputRaw === null) return null
            const gas = originGasDetail(quote, c, name)
            return (
              <KeyValue key={c.provider} label={`${PROVIDER_NAME[c.provider]}: network fee on ${view.origin}`} data-funds-origin-gas={c.provider}>
                {gas === null ? NOT_REPORTED : `About ${gas}, estimated by ${PROVIDER_NAME[c.provider]}`}
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
      </details>
      {quote.decision !== null && quote.steps.length > 0 && (
        <div className="grid gap-3" data-funds-steps="">
          <h4 className="dm-subtitle">{FUNDS_TEXT.stepsTitle(words.origin)}</h4>
          <ol className="grid gap-2">
            <li className="flex items-center gap-3" data-funds-step="switch" data-state={switchState}>
              <StepMarker index={++index} state={stepState(switchState)} label={`Step ${index}`} />
              <span>{FUNDS_TEXT.stepSwitch(words.origin)}</span>
            </li>
            {words.approval && (
              <li className="flex items-center gap-3" data-funds-step="approval" data-state={steps.approval}>
                <StepMarker index={++index} state={stepState(approvalState)} label={`Step ${index}`} />
                <span>{steps.approval === 'skipped' ? FUNDS_TEXT.stepApproveSkipped(words.amount) : FUNDS_TEXT.stepApprove(words.amount)}</span>
                {steps.approval !== 'waiting' && steps.approval !== 'skipped' && <span className="text-caption text-fg-muted">{FUNDS_TEXT.stepWords[steps.approval]}</span>}
              </li>
            )}
            <li className="flex items-center gap-3" data-funds-step="deposit" data-state={steps.deposit}>
              <StepMarker index={++index} state={stepState(depositState)} label={`Step ${index}`} />
              <span>{FUNDS_TEXT.stepDeposit(words.amount)}</span>
              {steps.deposit === 'wallet' && <span className="text-caption text-fg-muted">{FUNDS_TEXT.stepWords.wallet}</span>}
            </li>
          </ol>
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
          {/* A deposit handed to the wallet is never offered again from this quote (F1); while the gate is `preview` it is never offered at all. */}
          <Button
            className="justify-self-start"
            variant="accent"
            disabled={locked !== null || steps.running || handedOver}
            aria-describedby={locked !== null ? lockedId : undefined}
            onClick={locked !== null ? undefined : onDeposit}
            data-funds-deposit-button=""
          >
            {FUNDS_TEXT.deposit(words.origin)}
          </Button>
          {locked !== null && (
            <p id={lockedId} className="dm-hint" data-funds-locked="">
              {locked}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
