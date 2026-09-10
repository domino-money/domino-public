import { useEffect, useRef, useState } from 'react'
import type { CompoundDecision } from 'core/compound'
import type { PracticeEvent, PracticeFunding } from 'core/practice'
import { usd } from 'core/position'
import { PAIR } from '../lib/pair'
import { Amount, Button, Card, Display, Eyebrow, Pill, cx } from './ui'
import { TokenPair } from './TokenIcon'
import { useDialog } from '../lib/useDialog'

type Tab = 'amounts' | 'costs' | 'decision'

/**
 * The full receipt for one reinvestment run, in three tabs, with a switch for
 * exact six-place amounts. Content mirrors the workbench receipt line for line.
 */
/** One receipt line. Declared here so its identity is stable across renders. */
function Row({
  label,
  value,
  exact,
  tone = 'neutral',
  total,
}: {
  label: string
  value: string
  exact: boolean
  tone?: 'in' | 'out' | 'wait' | 'neutral'
  total?: boolean
}) {
  return (
    <div className={cx('flex items-baseline justify-between gap-4 border-b border-dashed py-3 last:border-b-0', total && 'font-medium')}>
      <dt className={cx('text-[13px]', total ? 'text-fg' : 'text-fg-muted')}>{label}</dt>
      <dd className="text-[13px]">
        <Amount value={value} tone={tone} exact={exact} />
      </dd>
    </div>
  )
}

export function ReceiptModal({
  event,
  decision,
  funding,
  cardNumber,
  onClose,
}: {
  event: PracticeEvent
  decision: CompoundDecision
  funding?: PracticeFunding
  cardNumber: number
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>('amounts')
  const [exact, setExact] = useState(false)
  const d = decision
  const eligible = d.decision === 'eligible'

  // Escape, focus containment, inert background and focus restoration.
  const dialog = useDialog(true, onClose)
  const heading = useRef<HTMLHeadingElement>(null)

  // Move focus into the receipt when it opens, the way the step dialog does.
  useEffect(() => {
    requestAnimationFrame(() => heading.current?.focus())
  }, [])

  return (
    <div role="presentation" className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <Card ref={dialog} level={2} role="dialog" aria-modal="true" aria-labelledby="receipt-title" className="grid max-h-[92vh] w-full max-w-[500px] grid-rows-[auto_minmax(0,1fr)_auto] rounded-b-none sm:max-h-[86vh] sm:rounded-b-[var(--radius-lg)]">
        <header className="border-b p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Eyebrow>Card {cardNumber} · Practice receipt</Eyebrow>
              <Display as="h2" id="receipt-title" ref={heading} tabIndex={-1} className="mt-2 text-[23px] outline-none">{eligible ? 'Your fees, accounted for.' : 'Waiting for a better moment.'}</Display>
              <p className="mt-1 text-[13px] text-fg-muted">{new Date(event.at).toLocaleString('en-US')} · Simulation only</p>
            </div>
            <TokenPair base={PAIR.token} quote={PAIR.stable} size={30} />
          </div>
          <div role="tablist" className="mt-4 flex gap-1 rounded-[var(--radius-pill)] border bg-surface-1 p-1">
            {([['amounts', 'Amounts'], ['costs', 'Costs'], ['decision', 'Why this action?']] as const).map(([key, label]) => (
              <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={cx('flex-1 rounded-[var(--radius-pill)] px-3 py-1.5 text-[12px] transition', tab === key ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg')}>
                {label}
              </button>
            ))}
          </div>
        </header>

        <div className="grid gap-4 overflow-y-auto p-5">
          {tab === 'amounts' && (
            <>
              <dl className="rounded-[var(--radius)] border bg-surface-1 px-4">
                {funding ? (
                  <>
                    <Row exact={exact} label="Previously waiting" value={funding.waitingFeesUsd} tone="wait" />
                    <Row exact={exact} label="New fees" value={funding.newFeesUsd} />
                  </>
                ) : (
                  <p className="py-3 text-[12px] leading-relaxed text-fg-subtle">The split between waiting and new fees is unavailable in this older record. Its recorded totals are preserved below.</p>
                )}
                <Row exact={exact} label="Total available" value={d.availableFeesUsd} total />
                <Row exact={exact} label="Reinvested" value={d.reinvestedUsd} tone="in" />
                <Row exact={exact} label="Service fee" value={d.serviceFeeUsd} tone="out" />
                <Row exact={exact} label="Still waiting" value={d.reserveUsd} tone="wait" />
              </dl>
              <p className="text-[12px] leading-relaxed text-fg-subtle">
                Waiting fees stay available. <strong className="text-fg-muted">They are charged only when used.</strong>
              </p>
            </>
          )}

          {tab === 'costs' && (
            <>
              <div className="rounded-[var(--radius)] border bg-surface-1 p-4">
                <p className="text-[12px] text-fg-muted">Service fee</p>
                <p className="mt-1 text-[13px]">
                  <strong>2%</strong> × <strong className="tnum font-mono">{exact ? `$${d.consumedFeesUsd}` : usd(Number(d.consumedFeesUsd))}</strong> of fees used
                </p>
                <p className="mt-2 text-[22px]"><Amount value={d.serviceFeeUsd} tone="out" exact={exact} /></p>
              </div>
              <dl className="rounded-[var(--radius)] border bg-surface-1 px-4">
                <Row exact={exact} label={eligible ? 'Gas paid from the service fee' : 'Estimated gas if executed'} value={d.gasUsd} />
                <Row exact={exact} label="Service keeps after gas" value={d.operatorMarginUsd} />
              </dl>
              <p className="text-[13px] leading-relaxed text-fg-muted">
                {eligible ? (
                  <><strong className="text-fg">Gas is included in the service fee.</strong> It is not a second deduction from your fees.</>
                ) : (
                  <><strong className="text-fg">No service fee or gas was charged.</strong> Gas is an estimate for a future action.</>
                )}
              </p>
              <p className="text-[12px] text-fg-subtle">{exact ? 'Six decimal places shown.' : 'Rounded for readability; enable exact amounts for the full calculation.'}</p>
            </>
          )}

          {tab === 'decision' && (
            <>
              <div className="rounded-[var(--radius)] border bg-surface-1 p-4">
                <Pill tone={eligible ? 'in' : 'wait'}>{eligible ? 'Cost check passed' : 'Waiting'}</Pill>
                <h3 className="mt-3 text-[15px] font-medium">
                  {eligible ? 'The cost check passed.' : d.reason === 'no_fees' ? 'No fees to reinvest yet.' : 'The network cost is too high.'}
                </h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">
                  {eligible ? (
                    <>The 2% service fee covers gas with a <strong className="text-fg">15% cost buffer</strong>.</>
                  ) : d.reason === 'no_fees' ? (
                    'Add hypothetical fees to try another scenario.'
                  ) : (
                    <>This check needs at least <strong className="tnum font-mono text-fg">${d.minimumFeesUsd}</strong> in usable fees. Recheck when fees or gas change.</>
                  )}
                </p>
              </div>
              <div className="rounded-[var(--radius)] border bg-surface-1 p-4">
                <h3 className="text-[14px] font-medium">Same position · Card {cardNumber}</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">
                  {eligible ? 'The reinvested amount was added to this practice position.' : 'When the check passes, fees can be reinvested in this practice position.'}
                </p>
              </div>
              <div className="rounded-[var(--radius)] border p-4" style={{ background: 'var(--accent)', borderColor: 'transparent' }}>
                <h3 className="text-[14px] font-medium" style={{ color: 'var(--accent-fg)' }}>
                  {d.policyVersion === 2 ? 'Use all eligible fees.' : 'Older policy · 15% addition limit'}
                </h3>
                <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--accent-fg)', opacity: 0.85 }}>
                  {d.policyVersion === 2 ? 'No fixed percentage is held back.' : 'This receipt retains the former limit on net additions.'}
                </p>
              </div>
              <p className="text-[12px] text-fg-subtle"><strong className="text-fg-muted">Transaction hash:</strong> none, simulation</p>
            </>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t p-5">
          <label htmlFor="receipt-exact" className="flex cursor-pointer items-center gap-2.5 text-[13px] text-fg-muted">
            <input id="receipt-exact" type="checkbox" checked={exact} onChange={(e) => setExact(e.target.checked)} className="h-4 w-4 accent-[var(--primary)]" />
            Exact amounts
          </label>
          <Button onClick={onClose}>Done</Button>
        </footer>
      </Card>
    </div>
  )
}
