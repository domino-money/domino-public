/**
 * One deposit operation on screen, rendered from presentOperation's view.
 * Conflicts sit on top and cannot be dismissed; attention is support-required;
 * a prepared step can be reviewed field by field, with the pre-sign checklist
 * and a status line where a send control would be. There is no Send button:
 * this build has no wallet handoff.
 */
import { useId, useState } from 'react'
import type { AllowanceReport, Operation } from '../../deposit/types'
import { REPORT_HINT, SUPPORT_REQUIRED } from '../../deposit/copy'
import { handoffStatus, presentAllowances, type ActionId, type DepositView } from '../../deposit/present'
import type { PreSignRow } from '../../deposit/presign'
import { Button, Pill } from '../ui'
import { Callout, FactList, Section } from '../consumer/shared'

const TONE = { in: 'in', out: 'out', wait: 'wait', neutral: 'neutral' } as const

export function OperationPanel({
  op,
  view,
  onAction,
  preSign,
  summaryAcknowledged,
  onAcknowledge,
  allowances,
}: {
  op: Operation
  view: DepositView
  onAction: (id: ActionId, hash?: string) => void
  preSign: PreSignRow[] | null
  summaryAcknowledged: boolean
  onAcknowledge: (value: boolean) => void
  allowances: AllowanceReport | null
}) {
  const titleId = useId()
  const reasonBase = useId()
  const [hash, setHash] = useState('')
  const report = view.actions.find((action) => action.id === 'report')
  return (
    <section aria-labelledby={titleId} data-view={view.kind} className="rounded-[var(--radius-lg)] border bg-surface-1 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={titleId} className="text-[18px] font-medium">
          {view.title}
        </h3>
        {view.supportRequired && <Pill tone="out">Support required</Pill>}
        {view.reserved && <Pill tone="wait">Reserved slot</Pill>}
      </div>
      <p className="mt-1 font-mono text-[12px] text-fg-subtle">Deposit {op.id} · version {op.version}</p>

      {view.conflicts.length > 0 && (
        <div role="note" aria-label="Reported conflicts" data-testid="conflicts" className="mt-4 space-y-2">
          {view.conflicts.map((conflict) => (
            <Callout key={`${conflict.step}:${conflict.text}`} tone="out">
              {conflict.text}
            </Callout>
          ))}
        </div>
      )}

      <div className="mt-3 space-y-2 text-[14px]">
        {view.body.map((line) => (
          <p key={line} className={line === SUPPORT_REQUIRED ? 'font-medium' : undefined}>
            {line}
          </p>
        ))}
        {view.reserved && <p className="text-[13px] text-fg-muted">{view.reserved}</p>}
      </div>

      {view.actions.filter((action) => action.id !== 'report').length > 0 && (
        <div className="mt-4 flex flex-wrap items-start gap-2" aria-label="Actions">
          {view.actions
            .filter((action) => action.id !== 'report')
            .map((action) => (
              <div key={action.id}>
                <Button
                  variant={action.id === 'prepare' || action.id === 'reopen' ? 'primary' : 'outline'}
                  disabled={!action.enabled}
                  aria-describedby={action.reason ? `${reasonBase}-${action.id}` : undefined}
                  onClick={() => onAction(action.id)}
                >
                  {action.label}
                </Button>
                {action.reason && (
                  <p id={`${reasonBase}-${action.id}`} className="mt-1 max-w-[46ch] text-[12px] text-fg-muted">
                    {action.reason}
                  </p>
                )}
              </div>
            ))}
        </div>
      )}

      {report && (
        <form
          className="mt-4 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            onAction('report', hash)
          }}
        >
          <label className="text-[12px] text-fg-muted">
            Transaction hash from your wallet
            <input
              value={hash}
              onChange={(event) => setHash(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="mt-1 block w-[min(66ch,80vw)] rounded-[var(--radius)] border border-line-strong bg-surface-1 px-3 py-2 font-mono text-[12px] text-fg"
            />
          </label>
          <Button variant="outline" type="submit" disabled={!report.enabled}>
            Report hash
          </Button>
          <p className="w-full text-[12px] text-fg-subtle">{REPORT_HINT}</p>
        </form>
      )}

      {view.step && (
        <Section title={`Wallet step: ${view.step.summary}`}>
          <div className="space-y-2 text-[14px]" data-testid="step-lines">
            {view.step.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p className="text-[13px] text-fg-muted">{view.step.admission}</p>
          </div>
          <div className="mt-3">
            <FactList facts={view.step.facts} label="Transaction summary" />
          </div>
          <div className="mt-3">
            <FactList facts={view.step.gas} label="Prepared gas" />
          </div>
          {view.step.native && (
            <div className="mt-3">
              <FactList facts={view.step.native} label="Native headroom" />
            </div>
          )}
          <details className="mt-3 text-[12px]">
            <summary className="cursor-pointer text-fg-muted">Exact transaction data ({view.step.selector})</summary>
            <p className="mt-2 break-all font-mono text-fg-muted" data-testid="calldata">
              {view.step.calldata}
            </p>
          </details>
          {preSign && (
            <div className="mt-4">
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={summaryAcknowledged} onChange={(event) => onAcknowledge(event.target.checked)} />
                I reviewed every field of this wallet step
              </label>
              <ul aria-label="Pre-sign checks" data-testid="presign" className="mt-3 space-y-1 text-[13px]">
                {preSign.map((row) => (
                  <li key={row.id} data-check={row.id} data-ok={row.ok}>
                    <Pill tone={row.ok ? 'in' : 'out'}>{row.ok ? 'Passed' : 'Not met'}</Pill> {row.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p role="note" data-testid="handoff-status" className="mt-4 text-[13px] font-medium">
            {handoffStatus(op)}
          </p>
        </Section>
      )}

      {view.receipt && (
        <Section title="Receipt">
          {view.receipt.breach && (
            <Callout tone="out" role="note" testId="breach">
              {view.receipt.breach}
            </Callout>
          )}
          {view.receipt.envelope && (
            <Callout tone="wait" role="note" testId="envelope">
              {view.receipt.envelope}
            </Callout>
          )}
          {view.receipt.notFinal && <p className="mb-2 text-[13px] text-money-wait">{view.receipt.notFinal}</p>}
          <div className="mt-3">
            <FactList facts={view.receipt.facts} label="Receipt facts" />
          </div>
          <div className="mt-3" data-testid="gas-block">
            <FactList facts={view.receipt.gas} label="Nitro gas" />
          </div>
          {view.receipt.position && (
            <div className="mt-3" data-testid="amounts-block">
              <FactList facts={view.receipt.position.facts} label="Position" />
              <div className="mt-3">
                <FactList facts={view.receipt.position.amounts} label="Received amounts and their evidence" />
              </div>
              <p className="mt-2 text-[13px] text-fg-muted">{view.receipt.position.owner}</p>
            </div>
          )}
        </Section>
      )}

      {allowances && <AllowancesPanel report={allowances} />}

      {view.history.length > 0 && (
        <Section title="History">
          <FactList facts={view.history} label="Steps" />
        </Section>
      )}

      <ul className="mt-5 border-t pt-3 text-[12px] text-fg-subtle">
        {view.facts.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
      <span className="sr-only">Tone: {TONE[view.tone]}</span>
    </section>
  )
}

function AllowancesPanel({ report }: { report: AllowanceReport }) {
  const view = presentAllowances(report)
  return (
    <Section title="Allowances">
      <p className="text-[13px] text-fg-muted">{view.header}</p>
      <div className="mt-3 space-y-3" data-testid="allowances">
        {view.rows.map((row) => (
          <div key={row.currency}>
            <p className="font-mono text-[12px]">{row.currency}</p>
            <FactList facts={[row.erc20, row.permit2]} label={`Allowances for ${row.currency}`} />
          </div>
        ))}
      </div>
      <p className="mt-3 text-[13px]" data-testid="revocation-guidance">
        {view.guidance}
      </p>
    </Section>
  )
}
