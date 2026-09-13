/**
 * Pieces the preview screen and the deposit lab share. Every value arrives as
 * text already decided by a pure module; nothing here formats, rounds or
 * defaults a figure. An unknown is always labelled as such, never blank and
 * never zero.
 */
import { Component, type ReactNode } from 'react'
import type { Shown } from '../../onboarding/project'
import type { Fact } from '../../deposit/present'
import { cx } from '../ui'

/** Keeps a failure in either screen from taking the page down. */
export class ConsumerBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <p role="alert" className="mx-auto max-w-[1220px] px-5 py-10 text-[14px] text-fg-muted">
        This screen couldn't load. Reload to try again.
      </p>
    )
  }
}

export function Unknown({ reason }: { reason: string }) {
  return (
    <span className="text-money-wait">
      <span className="font-medium">Unknown</span>
      <span className="text-fg-muted">: {reason}</span>
    </span>
  )
}

export function ShownValue({ value }: { value: Shown }) {
  if (value.kind === 'unknown') return <Unknown reason={value.reason} />
  return (
    <>
      <span className="tnum break-all font-mono">{value.text}</span>
      {value.note && <span className="block text-[12px] text-fg-subtle">{value.note}</span>}
    </>
  )
}

export function RowList({ rows, label }: { rows: ReadonlyArray<{ id: string; label: string; value: Shown }>; label?: string }) {
  return (
    <dl aria-label={label} className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
      {rows.map((row) => (
        <div key={row.id} className="contents" data-row={row.id}>
          <dt className="text-fg-muted">{row.label}</dt>
          <dd className="min-w-0">
            <ShownValue value={row.value} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function FactList({ facts, label }: { facts: readonly Fact[]; label?: string }) {
  return (
    <dl aria-label={label} className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
      {facts.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="text-fg-muted">{fact.label}</dt>
          <dd className="min-w-0">
            {fact.unknown ? <Unknown reason={fact.value} /> : <span className="tnum break-all font-mono">{fact.value}</span>}
            {fact.note && <span className="block text-[12px] text-fg-subtle">{fact.note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cx('mt-5 border-t pt-4', className)}>
      <h4 className="mb-3 font-mono text-[11px] uppercase tracking-[0.7px] text-fg-subtle">{title}</h4>
      {children}
    </section>
  )
}

export function Callout({ tone = 'neutral', children, role, testId }: { tone?: 'neutral' | 'wait' | 'out' | 'in'; children: ReactNode; role?: 'note' | 'alert' | 'status'; testId?: string }) {
  const tones = {
    neutral: 'bg-surface-2 text-fg',
    wait: 'bg-money-wait-bg text-fg',
    out: 'bg-money-out-bg text-fg',
    in: 'bg-money-in-bg text-fg',
  }
  return (
    <div role={role} data-testid={testId} className={cx('rounded-[var(--radius)] px-4 py-3 text-[13px] leading-relaxed', tones[tone])}>
      {children}
    </div>
  )
}
