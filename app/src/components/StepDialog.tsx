import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Button, Card, Display, Eyebrow, cx } from './ui'
import { useDialog } from '../lib/useDialog'
import { PAIR } from '../lib/pair'
import { TokenPair } from './TokenIcon'

/** The example pair's marks, overlapping the way exchanges show a pair. */
export function TokenAvatars({ size = 38 }: { size?: number }) {
  return <TokenPair base={PAIR.token} quote={PAIR.stable} size={size} />
}

export function PairHeading({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex items-center gap-3">
      <TokenAvatars />
      <div>
        <h3 className="text-[16px] font-medium">{PAIR.label}</h3>
        <p className="text-[12px] text-fg-subtle">{subtitle ?? PAIR.note}</p>
      </div>
    </div>
  )
}

/** Soft-tinted note block used for the "two assets", "already waiting" callouts. */
export function Callout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      className="rounded-[var(--radius)] border p-4"
      style={{ background: 'var(--accent)', borderColor: 'transparent' }}
    >
      <strong className="block text-[13px]" style={{ color: 'var(--accent-fg)' }}>
        {title}
      </strong>
      <div className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--accent-fg)', opacity: 0.85 }}>
        {children}
      </div>
    </div>
  )
}

/** A definition list styled as a receipt. */
export function Receipt({
  rows,
}: {
  rows: Array<{ label: ReactNode; value: ReactNode; total?: boolean }>
}) {
  return (
    <dl className="rounded-[var(--radius)] border bg-surface-1 px-4">
      {rows.map((row, i) => (
        <div
          key={i}
          className={cx(
            'flex items-baseline justify-between gap-4 border-b border-dashed py-3 last:border-b-0',
            row.total && 'font-medium',
          )}
        >
          <dt className={cx('text-[13px]', row.total ? 'text-fg' : 'text-fg-muted')}>{row.label}</dt>
          <dd className="tnum text-right font-mono text-[13px]">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Dialog shell for a multi-step procedure.
 *
 * The body is the only scrolling region — the header and the action footer stay
 * put, so a short screen or large text never hides Back/Continue.
 */
export function StepDialog({
  open,
  onClose,
  eyebrow,
  title,
  description,
  steps,
  step,
  children,
  onBack,
  onNext,
  backLabel,
  nextLabel,
  nextDisabled,
  error,
}: {
  open: boolean
  onClose: () => void
  eyebrow: string
  title: string
  description: string
  steps?: string[]
  step: number
  children: ReactNode
  onBack: () => void
  onNext: () => void
  backLabel: string
  nextLabel: string
  nextDisabled?: boolean
  error?: string
}) {
  const heading = useRef<HTMLHeadingElement>(null)

  // Move focus to the new heading on each step so screen readers announce it.
  // A timeout rather than a frame callback: a hidden tab never paints, and the
  // step would then open with focus left behind on the previous control.
  useEffect(() => {
    if (!open) return
    const id = setTimeout(() => heading.current?.focus(), 0)
    return () => clearTimeout(id)
  }, [step, open])

  // Escape, focus containment, inert background and focus restoration.
  const dialog = useDialog(open, onClose)

  if (!open) return null

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <Card
        level={2}
        role="dialog"
        aria-modal="true"
        aria-labelledby="step-dialog-title"
        ref={dialog}
        className="grid max-h-[92vh] w-full max-w-[480px] grid-rows-[auto_minmax(0,1fr)_auto] rounded-b-none sm:max-h-[86vh] sm:rounded-b-[var(--radius-lg)]"
      >
        <header className="border-b p-5">
          <Eyebrow>{eyebrow}</Eyebrow>
          <Display
            as="h2"
            id="step-dialog-title"
            ref={heading}
            tabIndex={-1}
            className="mt-2 text-[23px] outline-none"
          >
            {title}
          </Display>
          <p className="mt-1 text-[13px] text-fg-muted">{description}</p>

          {steps && (
            <ol className="mt-4 flex gap-1.5" aria-label="Progress">
              {steps.map((label, i) => (
                <li
                  key={label}
                  aria-current={i === step ? 'step' : undefined}
                  className="flex-1"
                >
                  <div
                    className="h-[3px] rounded-full transition-colors"
                    style={{ background: i <= step ? 'var(--primary)' : 'var(--surface-3)' }}
                  />
                  <span
                    className={cx(
                      'mt-1.5 block font-mono text-[10px] uppercase tracking-[0.5px]',
                      i <= step ? 'text-fg-muted' : 'text-fg-subtle',
                    )}
                  >
                    {label}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </header>

        <div className="grid gap-4 overflow-y-auto p-5">
          {children}
          {error && (
            <p role="alert" className="text-[13px]" style={{ color: 'var(--money-out)' }}>
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t p-5">
          <Button variant="ghost" onClick={onBack}>
            {backLabel}
          </Button>
          <Button onClick={onNext} disabled={nextDisabled}>
            {nextLabel}
          </Button>
        </footer>
      </Card>
    </div>
  )
}
