import type { InputHTMLAttributes, ReactNode } from 'react'
import { cx } from '../ui'

/** How large the amount is drawn, by its length, so a long figure shrinks instead of running under its token (DESIGN-V2 §10.2). */
const lengthStep = (length: number) => (length <= 8 ? 's' : length <= 12 ? 'm' : length <= 16 ? 'l' : 'xl')

/**
 * The deposit budget, as a swap panel: one large tabular input with its token
 * in a pill beside it, then its USD value on the left and the wallet's
 * balance on the right. The panel shows the focus ring; the hint, the raw
 * units and any error sit below the panel. The figure shrinks as it grows
 * longer and keeps its full value in its title.
 */
export function AmountField({
  id,
  label,
  unit,
  footer,
  usd,
  hint,
  error,
  below,
  value,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'value'> & {
  id: string
  label: ReactNode
  /** The token, beside the figure. */
  unit: ReactNode
  /** The line inside the panel under the figure: the wallet balance. */
  footer?: ReactNode
  /** The amount's USD value, under the figure on the left (USDG pairs only). */
  usd?: ReactNode
  hint?: ReactNode
  error?: string | null
  /** Anything under the panel before the hint, such as the raw units. */
  below?: ReactNode
  value: string
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
            value={value}
            title={value || undefined}
            data-len={lengthStep(value.length)}
            {...rest}
          />
          <span className="dm-flow-amount-unit">{unit}</span>
        </div>
        {usd && <div className="dm-flow-amount-usd">{usd}</div>}
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
