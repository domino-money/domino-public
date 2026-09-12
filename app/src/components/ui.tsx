import type { ReactNode, ButtonHTMLAttributes } from 'react'

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}

/** Raised panel. Depth comes from the surface step plus a faint line — never a shadow. */
export function Card({
  children,
  className,
  level = 1,
  ref,
  ...rest
}: {
  children: ReactNode
  className?: string
  level?: 1 | 2 | 3
  ref?: React.Ref<HTMLDivElement>
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'children'>) {
  const surface = level === 3 ? 'bg-surface-3' : level === 2 ? 'bg-surface-2' : 'bg-surface-1'
  return (
    <div ref={ref} className={cx('rounded-[var(--radius-lg)] border', surface, className)} {...rest}>
      {children}
    </div>
  )
}

export function Pill({
  children,
  className,
  tone = 'neutral',
}: {
  children: ReactNode
  className?: string
  tone?: 'neutral' | 'accent' | 'in' | 'out' | 'wait'
}) {
  const tones = {
    neutral: 'bg-surface-3 text-fg-muted',
    accent: 'bg-accent text-accent-fg',
    in: 'bg-money-in-bg text-money-in',
    out: 'bg-money-out-bg text-money-out',
    wait: 'bg-money-wait-bg text-money-wait',
  }
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] px-2.5 py-1 text-[12px] font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'outline'
}

export function Button({ variant = 'primary', className, ...rest }: ButtonProps) {
  const variants = {
    primary: 'bg-primary text-primary-fg hover:brightness-[1.06]',
    outline: 'border border-line-strong text-fg hover:bg-surface-2',
    ghost: 'text-fg-muted hover:text-fg',
  }
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-[var(--radius-pill)] px-4 py-2 text-[13px] font-medium transition',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        className,
      )}
      {...rest}
    />
  )
}

/** Section heading in the display serif. */
export function Display({
  children,
  className,
  as: Tag = 'h2',
  ref,
  ...rest
}: {
  children: ReactNode
  className?: string
  as?: 'h1' | 'h2' | 'h3'
  ref?: React.Ref<HTMLHeadingElement>
} & Omit<React.HTMLAttributes<HTMLHeadingElement>, 'className' | 'children'>) {
  return (
    <Tag ref={ref} className={cx('font-display font-normal leading-[1.08]', className)} {...rest}>
      {children}
    </Tag>
  )
}

/** Small uppercase mono label. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cx(
        'font-mono text-[11px] uppercase tracking-[0.7px] text-fg-subtle',
        className,
      )}
    >
      {children}
    </p>
  )
}
