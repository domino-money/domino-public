/**
 * One deposit operation on screen, rendered from presentOperation's view.
 * Conflicts sit on top and cannot be dismissed; attention is support-required;
 * the owner's selection sits above the actions; a prepared step can be
 * reviewed field by field, with the pre-sign checklist and a status line where
 * a send control would be. The Send control, where there is one, is the
 * screen's, never this panel's. Notes are plain lines, never tinted panels.
 */
import { useId, useState } from 'react'
import type { AllowanceReport, Operation } from '../../deposit/types'
import { REPORT_HINT, SUPPORT_REQUIRED } from '../../deposit/copy'
import { handoffStatus, presentAllowances, type ActionId, type DepositView } from '../../deposit/present'
import type { PreSignRow } from '../../deposit/presign'
import { Button, Pill } from '../ui'
import { FactList, Section } from '../consumer/shared'

const TONE = { in: 'in', out: 'out', wait: 'wait', neutral: 'neutral' } as const

export function OperationPanel({
  op,
  view,
  onAction,
  preSign,
  summaryAcknowledged,
  onAcknowledge,
  allowances,
  handoffAvailable = false,
}: {
  op: Operation
  view: DepositView
  onAction: (id: ActionId, hash?: string) => void
  preSign: PreSignRow[] | null
  summaryAcknowledged: boolean
  onAcknowledge: (value: boolean) => void
  allowances: AllowanceReport | null
  handoffAvailable?: boolean
}) {
  const titleId = useId()
  const reasonBase = useId()
  const [hash, setHash] = useState('')
  const report = view.actions.find((action) => action.id === 'report')
  return (
    <section aria-labelledby={titleId} data-view={view.kind} className="dm-card dm-acct-op">
      <div className="dm-acct-op-head">
        <h3 id={titleId} className="dm-acct-panel-title">
          {view.title}
        </h3>
        {view.supportRequired && <Pill tone="out">Support required</Pill>}
        {view.reserved && <Pill>Reserved slot</Pill>}
      </div>
      <p className="dm-acct-hash">Deposit {op.id} · version {op.version}</p>

      {view.conflicts.length > 0 && (
        <div role="note" aria-label="Reported conflicts" data-testid="conflicts" className="dm-acct-op-stack">
          {view.conflicts.map((conflict) => (
            <p key={`${conflict.step}:${conflict.text}`} className="dm-acct-line font-medium">
              {conflict.text}
            </p>
          ))}
        </div>
      )}

      <div className="dm-acct-op-stack dm-acct-op-body">
        {view.body.map((line) => (
          <p key={line} className={line === SUPPORT_REQUIRED ? 'font-medium' : undefined}>
            {line}
          </p>
        ))}
        {view.reserved && <p className="dm-acct-panel-note">{view.reserved}</p>}
      </div>

      <div data-testid="selection">
        <FactList facts={view.selection} label="Your selection" />
      </div>

      {view.actions.filter((action) => action.id !== 'report').length > 0 && (
        <div className="dm-acct-op-actions" aria-label="Actions">
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
                  <p id={`${reasonBase}-${action.id}`} className="dm-hint max-w-[46ch]">
                    {action.reason}
                  </p>
                )}
              </div>
            ))}
        </div>
      )}

      {report && (
        <form
          className="dm-acct-op-report"
          onSubmit={(event) => {
            event.preventDefault()
            onAction('report', hash)
          }}
        >
          <label className="dm-label dm-acct-lf">
            Transaction hash from your wallet
            <input
              value={hash}
              onChange={(event) => setHash(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="dm-field dm-acct-mono-field"
            />
          </label>
          <Button variant="outline" type="submit" disabled={!report.enabled}>
            Report hash
          </Button>
          <p className="dm-hint w-full">{REPORT_HINT}</p>
        </form>
      )}

      {view.step && (
        <Section title={`Wallet step: ${view.step.summary}`}>
          <div className="dm-acct-op-stack dm-acct-op-body" data-testid="step-lines">
            {view.step.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p className="dm-acct-panel-note">{view.step.admission}</p>
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
          <details className="dm-details dm-acct-disclosure">
            <summary>Exact transaction data ({view.step.selector})</summary>
            <p className="dm-acct-hash" data-testid="calldata">
              {view.step.calldata}
            </p>
          </details>
          {preSign && (
            <div className="mt-4">
              <label className="dm-acct-check">
                <input type="checkbox" checked={summaryAcknowledged} onChange={(event) => onAcknowledge(event.target.checked)} />
                I reviewed every field of this wallet step
              </label>
              <ul aria-label="Pre-sign checks" data-testid="presign" className="dm-acct-presign">
                {preSign.map((row) => (
                  <li key={row.id} data-check={row.id} data-ok={row.ok}>
                    <Pill tone={row.ok ? 'in' : 'out'}>{row.ok ? 'Passed' : 'Not met'}</Pill> {row.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p role="note" data-testid="handoff-status" className="dm-acct-panel-note mt-4">
            {handoffAvailable ? "Only your wallet can authorize this step. If its response is lost, reconcile the operation before any new attempt." : handoffStatus(op)}
          </p>
        </Section>
      )}

      {view.receipt && (
        <Section title="Receipt">
          {view.receipt.breach && (
            <p role="note" data-testid="breach" className="dm-acct-line font-medium">
              {view.receipt.breach}
            </p>
          )}
          {view.receipt.envelope && (
            <p role="note" data-testid="envelope" className="dm-acct-line">
              {view.receipt.envelope}
            </p>
          )}
          {view.receipt.notFinal && <p className="dm-acct-line">{view.receipt.notFinal}</p>}
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
              <p className="dm-acct-panel-note mt-2">{view.receipt.position.owner}</p>
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

      <ul className="dm-acct-op-facts">
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
      <p className="dm-acct-panel-note">{view.header}</p>
      <div className="dm-acct-op-stack mt-3" data-testid="allowances">
        {view.rows.map((row) => (
          <div key={row.currency}>
            <p className="dm-acct-hash">{row.currency}</p>
            <FactList facts={[row.erc20, row.permit2]} label={`Allowances for ${row.currency}`} />
          </div>
        ))}
      </div>
      <p className="dm-acct-line mt-3" data-testid="revocation-guidance">
        {view.guidance}
      </p>
    </Section>
  )
}
