import type { InputHTMLAttributes, ReactNode } from 'react'
import { cx } from '../ui'

/**
 * A labelled text input with a hint line and an error line, the one
 * primitive ui.tsx does not have (SearchField is a search box). The error is
 * announced and tied to the input; the hint stays visible either way.
 */
export function TextField({
  id,
  label,
  hint,
  error,
  trailing,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  id: string
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  /** Text shown after the input, e.g. the unit. */
  trailing?: ReactNode
  className?: string
}) {
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  return (
    <div className={cx('min-w-0', className)}>
      <label htmlFor={id} className="dm-label">
        {label}
      </label>
      <div className="dm-flow-input" data-invalid={error ? '' : undefined}>
        <input
          id={id}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={cx(hint ? hintId : null, error ? errorId : null) || undefined}
          className="dm-flow-input-control tnum"
          {...rest}
        />
        {trailing && (
          <span aria-hidden="true" className="dm-flow-input-unit">
            {trailing}
          </span>
        )}
      </div>
      {hint && (
        <p id={hintId} className="dm-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="dm-error">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * The deposit budget: one large tabular input with its token beside it, and
 * a line under it for the wallet's balance. The panel shows the focus ring;
 * the hint, the raw units and any error sit below the panel.
 */
export function AmountField({
  id,
  label,
  unit,
  footer,
  hint,
  error,
  below,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & {
  id: string
  label: ReactNode
  /** The token, beside the figure. */
  unit: ReactNode
  /** The line inside the panel under the figure: the wallet balance. */
  footer?: ReactNode
  hint?: ReactNode
  error?: string | null
  /** Anything under the panel before the hint, such as the raw units. */
  below?: ReactNode
}) {
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="dm-label">
        {label}
      </label>
      <div className="dm-flow-amount" data-invalid={error ? '' : undefined}>
        <div className="dm-flow-amount-row">
          <input
            id={id}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={cx(hint ? hintId : null, error ? errorId : null) || undefined}
            className="dm-flow-amount-input tnum"
            {...rest}
          />
          <span className="dm-flow-amount-unit">{unit}</span>
        </div>
        {footer && <div className="dm-flow-amount-foot">{footer}</div>}
      </div>
      {error && (
        <p id={errorId} role="alert" className="dm-error">
          {error}
        </p>
      )}
      {below}
      {hint && (
        <p id={hintId} className="dm-hint">
          {hint}
        </p>
      )}
    </div>
  )
}
