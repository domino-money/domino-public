/**
 * A preview's state on screen: eligibility, input issues, loading, a current
 * preview with its expiry, an expired one with its figures gone, or a failure.
 * A current preview carries the "Preview only" pill and says it is not a quote
 * lock, transaction or authorization. There is no Confirm, Swap, Deposit,
 * Sign or Approve control anywhere in it.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react'
import type { Clock } from '../../lib/clock'
import type { PreviewCatalog } from '../../onboarding/catalog'
import type { ControllerView, PreviewState } from '../../onboarding/controller'
import {
  ELIGIBILITY_COPY,
  EXPIRED_ON_ARRIVAL,
  EXPIRED_ON_ARRIVAL_REPEAT,
  FAILURE_COPY,
  LOADING_COPY,
  PREVIEW_ONLY,
  READY_COPY,
  expiredCopy,
} from '../../onboarding/copy'
import { projectPosition, projectSwap, type ChecksView, type PositionView, type SwapView } from '../../onboarding/project'
import type { OnboardingRoute, PositionPreview, SwapPreview } from '../../onboarding/types'
import { Button, Pill } from '../ui'
import { Callout, RowList, Section, ShownValue } from '../consumer/shared'

function ChecksList({ checks }: { checks: ChecksView }) {
  return (
    <div data-checks={checks.status}>
      <Pill tone={checks.tone}>{checks.label}</Pill>
      {checks.reasons.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-[13px]">
          {checks.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      {checks.note && <p className="mt-2 text-[12px] text-fg-subtle">{checks.note}</p>}
    </div>
  )
}

function SwapPreviewPanel({ view }: { view: SwapView }) {
  return (
    <>
      <ChecksList checks={view.checks} />
      <Section title="Amounts">
        <RowList rows={view.amounts} label="Swap amounts" />
      </Section>
      <Section title="Provider output fee">
        <RowList rows={view.fee} label="Provider output fee" />
        {view.feeOutputs === null ? (
          <p className="mt-2 text-[12px] text-fg-subtle">Itemised outputs not reported.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[12px]">
              <caption className="sr-only">Provider fee outputs</caption>
              <thead className="text-fg-subtle">
                <tr>
                  <th className="py-1 pr-3 font-medium">Recipient</th>
                  <th className="py-1 pr-3 font-medium">Amount</th>
                  <th className="py-1 pr-3 font-medium">Minimum</th>
                  <th className="py-1 pr-3 font-medium">Rate</th>
                  <th className="py-1 font-medium">Kind</th>
                </tr>
              </thead>
              <tbody>
                {view.feeOutputs.map((row, index) => (
                  <tr key={index} className="border-t">
                    <td className="break-all py-1 pr-3 font-mono">{row.recipient}</td>
                    <td className="py-1 pr-3 font-mono">{row.amount}</td>
                    <td className="py-1 pr-3 font-mono">{row.minimum}</td>
                    <td className="py-1 pr-3">
                      <ShownValue value={row.rate} />
                    </td>
                    <td className="py-1">{row.kind}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="Route">
        {view.paths.map((path) => (
          <div key={path.label} className="mb-2 text-[13px]">
            <p className="font-medium">
              {path.label}: <span className="font-mono">{path.share}</span>
            </p>
            <ol className="mt-1 list-decimal pl-5 font-mono text-[12px] text-fg-muted">
              {path.hops.map((hop) => (
                <li key={hop} className="break-all">
                  {hop}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </Section>
      <Section title="Network gas">
        <RowList rows={view.gas} label="Network gas" />
        <p className="mt-2 text-[12px] text-fg-subtle">Provider estimate. Excludes approvals. Not verified.</p>
      </Section>
      <Section title="Other">
        <RowList rows={view.other} label="Simulation, approval and fees" />
      </Section>
      <Section title="Provenance">
        <RowList rows={view.provenance} label="Provenance" />
      </Section>
    </>
  )
}

function PositionPreviewPanel({ view }: { view: PositionView }) {
  return (
    <>
      <ChecksList checks={view.checks} />
      <Section title="Tokens">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[12px]">
            <caption className="sr-only">Expected deposits, maximum debits and budgets per token</caption>
            <thead className="text-fg-subtle">
              <tr>
                <th className="py-1 pr-3 font-medium">Token</th>
                <th className="py-1 pr-3 font-medium">Expected deposit</th>
                <th className="py-1 pr-3 font-medium">Maximum debit</th>
                <th className="py-1 pr-3 font-medium">Your budget</th>
                <th className="py-1 pr-3 font-medium">Budget</th>
                <th className="py-1 pr-3 font-medium">Unspent (estimate)</th>
                <th className="py-1 font-medium">Unspent at maximum</th>
              </tr>
            </thead>
            <tbody>
              {view.tokens.map((token) => (
                <tr key={token.token} className="border-t align-top">
                  <td className="break-all py-1 pr-3 font-mono">{token.token}</td>
                  <td className="py-1 pr-3">
                    <ShownValue value={token.expected} />
                  </td>
                  <td className="py-1 pr-3">
                    <ShownValue value={token.maximum} />
                  </td>
                  <td className="py-1 pr-3">
                    <ShownValue value={token.budget} />
                  </td>
                  <td className="py-1 pr-3">{token.budgetStatus}</td>
                  <td className="py-1 pr-3">
                    <ShownValue value={token.unspent} />
                  </td>
                  <td className="py-1">
                    <ShownValue value={token.unspentAtMaximum} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Position">
        <RowList rows={view.position} label="Position" />
      </Section>
      <Section title="Native funding">
        <RowList rows={view.native} label="Native funding" />
      </Section>
      <Section title="Other">
        <RowList rows={view.other} label="Gas, fees and simulation" />
      </Section>
      <details className="mt-5 border-t pt-4 text-[13px]">
        <summary className="cursor-pointer text-fg-muted">Provider details</summary>
        <div className="mt-3">
          <RowList rows={view.provider} label="Provider details" />
        </div>
      </details>
      <p className="mt-4 text-[12px] text-fg-subtle">{view.statement}</p>
    </>
  )
}

function failureText(state: Extract<PreviewState<OnboardingRoute>, { status: 'failed' }>): ReactNode {
  const { failure } = state
  if (failure.kind === 'expired_on_arrival') {
    return (
      <>
        {EXPIRED_ON_ARRIVAL}
        {failure.repeated && <> {EXPIRED_ON_ARRIVAL_REPEAT}</>}
      </>
    )
  }
  const text = FAILURE_COPY[failure.kind]
  return 'retryAfterS' in failure && failure.retryAfterS !== undefined ? text.replace('{s}', String(failure.retryAfterS)) : text.replace('{s}', '60')
}

const localTime = (ms: number) => new Date(ms).toLocaleTimeString()

export function PreviewResult<R extends OnboardingRoute>({
  route,
  view,
  onRequest,
  catalog,
  clock,
}: {
  route: R
  view: ControllerView<R>
  onRequest: () => void
  catalog: PreviewCatalog
  clock: Clock
}) {
  const { state, canRequest, budget } = view
  const reasonId = useId()
  const figures = useRef<HTMLDivElement>(null)
  const expiredHeading = useRef<HTMLHeadingElement>(null)
  const focusWasInFigures = useRef(false)
  const previous = useRef(state.status)

  // Focus rule (R#34): if focus sat in the figures when they were hidden by
  // expiry, it moves to the expired panel's heading.
  useEffect(() => {
    if (previous.current === 'current' && state.status === 'expired' && focusWasInFigures.current) expiredHeading.current?.focus()
    if (state.status !== 'current') focusWasInFigures.current = false
    previous.current = state.status
  }, [state.status])

  const refresh = state.status === 'expired' || state.status === 'failed'
  let reason: string | null = null
  if (!canRequest) {
    if (state.status === 'ineligible') reason = ELIGIBILITY_COPY[state.block]
    else if (state.status === 'editing') reason = 'Fix the highlighted fields first.'
    else if (state.status === 'loading') reason = 'A preview is being requested.'
    else if (state.status === 'current') reason = 'This preview is still current. Refresh becomes available when it expires.'
    else if (!budget.ok) reason = `Preview limit reached. Available again in ${Math.max(1, Math.ceil((budget.retryAtMono - clock.monoMs()) / 1000))} s.`
    else if (state.status === 'failed') reason = 'This failure cannot be fixed by asking again.'
  }

  let announcement = ''
  switch (state.status) {
    case 'loading':
      announcement = LOADING_COPY
      break
    case 'current':
      announcement = state.secondsLeft === 10 ? 'The preview expires in 10 seconds.' : state.secondsLeft === 30 ? 'Preview received.' : ''
      break
    case 'expired':
      announcement = 'The preview expired. Its figures are hidden.'
      break
    case 'failed':
      announcement = 'The preview request failed.'
      break
    case 'ineligible':
      announcement = ELIGIBILITY_COPY[state.block]
      break
    default:
      announcement = ''
  }

  return (
    <div className="mt-6" data-preview-state={state.status}>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onRequest} disabled={!canRequest} aria-describedby={reason ? reasonId : undefined}>
          {refresh ? 'Refresh preview' : 'Get preview'}
        </Button>
        {reason && (
          <p id={reasonId} className="text-[12px] text-fg-muted">
            {reason}
          </p>
        )}
      </div>

      <div className="mt-5" aria-busy={state.status === 'loading' || undefined}>
        {state.status === 'ineligible' && (
          <Callout tone="wait" role="note" testId="preview-eligibility">
            {ELIGIBILITY_COPY[state.block]}
          </Callout>
        )}
        {state.status === 'editing' && (
          <div role="alert" className="text-[13px] text-money-out">
            <p className="font-medium">Some inputs need fixing:</p>
            <ul className="mt-1 list-disc pl-5">
              {state.issues.map((issue) => (
                <li key={`${issue.field}:${issue.message}`}>{issue.message}</li>
              ))}
            </ul>
          </div>
        )}
        {state.status === 'ready' && <p className="text-[13px] text-fg-muted">{READY_COPY}</p>}
        {state.status === 'loading' && <p className="text-[13px] text-fg-muted">{LOADING_COPY}</p>}
        {state.status === 'current' && (
          <div
            ref={figures}
            data-testid="preview-figures"
            onFocus={() => (focusWasInFigures.current = true)}
            onBlur={(event) => {
              if (!figures.current?.contains(event.relatedTarget as Node | null)) focusWasInFigures.current = false
            }}
          >
            <div className="flex flex-wrap items-center gap-3">
              <Pill tone="accent">Preview only</Pill>
              <span aria-live="off" className="tnum font-mono text-[12px] text-fg-muted" data-testid="preview-expiry">
                Expires in {state.secondsLeft} s
              </span>
            </div>
            <p className="mt-2 text-[13px] text-fg-muted">{PREVIEW_ONLY}</p>
            <div className="mt-4">
              {route === 'swap-preview' ? (
                <SwapPreviewPanel view={projectSwap(state.preview as SwapPreview, catalog, state.owner)} />
              ) : (
                <PositionPreviewPanel view={projectPosition(state.preview as PositionPreview, catalog)} />
              )}
            </div>
          </div>
        )}
        {state.status === 'expired' && (
          <Callout tone="wait">
            <h3 ref={expiredHeading} tabIndex={-1} className="font-medium focus-visible:outline-2 focus-visible:outline-[var(--ring)]">
              Preview expired
            </h3>
            <p className="mt-1">{expiredCopy(localTime(state.expiredAtWallMs))}</p>
          </Callout>
        )}
        {state.status === 'failed' && (
          <Callout tone="out" testId="preview-failure">
            <p>{failureText(state)}</p>
            {state.requestId && <p className="mt-1 font-mono text-[12px] text-fg-subtle">Support reference: {state.requestId}</p>}
          </Callout>
        )}
      </div>
    </div>
  )
}
