import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { cx, Segmented } from './ui'
import { shortAmount } from '../lib/format/amount'
import { compareDisplayed } from '../lib/format/change'
import { formatUsd, formatUsdFloor } from '../lib/format/usd'
import { rem } from '../lib/rootScale'

/*
 * Figure primitives (DESIGN-V2 §3.15). They present text the page already
 * has; none formats a figure it was not given, and none invents one. Node-
 * importable: React, ./ui and lib/format only, nothing at module top. Files
 * that may not import these reach the same look through the class twins in
 * shell.css (`.dm-delta`, `.dm-amount-tail`, `.dm-approx`, `.dm-fig-*`, …).
 */

/** Cents dimmed only where they are cents: at $1 and above, and at exactly $0.00 (never $0.004213 or $0.50). */
function centsAt(text: string): number {
  const dot = text.lastIndexOf('.')
  if (dot === -1 || !/^-?\$[\d,]+\.\d{2}$/.test(text)) return -1
  const whole = text.slice(0, dot)
  return whole.endsWith('$0') && text !== '$0.00' ? -1 : dot
}

/**
 * A figure that visibly ticks when its value changes after the first paint.
 * The final text is in the DOM at once; nothing is tweened. `whole` slides the
 * new value in; `digits` (hero and chart-header figures only) remounts only
 * the characters that changed, each a little after the previous one. With
 * `direction="auto"` the figure tints up or down for a moment. `children`
 * (whole only) is a custom rendering of the same text, e.g. a UsdText with
 * dim cents; in `digits` mode `dimCents` dims a USD figure's cents instead.
 * Never on a figure a test reads with getByText, never while scrubbing.
 */
export function LiveFigure({
  value,
  mode = 'whole',
  direction = 'auto',
  dimCents = false,
  className,
  children,
}: {
  /** The final text, also the change key. */
  value: string
  mode?: 'whole' | 'digits'
  direction?: 'auto' | 'none'
  /** digits only: dim the cents of a `$1,234.56` figure (as UsdText's `dimCents`). */
  dimCents?: boolean
  className?: string
  children?: ReactNode
}) {
  const root = useRef<HTMLSpanElement>(null)
  const inner = useRef<HTMLSpanElement>(null)
  const previous = useRef<string | null>(null)

  // DOM writes only: no state, no ref read during render.
  useLayoutEffect(() => {
    const host = root.current
    const before = previous.current
    if (!host || before === value) return
    previous.current = value
    const parts = Array.from(host.querySelectorAll<HTMLElement>('.dm-tick-d, .dm-tick-v'))
    if (before === null) {
      // The first value never animates.
      for (const part of parts) part.setAttribute('data-seen', '')
      return
    }
    const dir = direction === 'auto' ? compareDisplayed(before, value) : 0
    if (mode === 'whole') {
      const el = inner.current
      if (!el) return
      el.setAttribute('data-tick', '')
      if (dir !== 0) el.setAttribute('data-dir', dir > 0 ? 'up' : 'down')
      el.setAttribute('data-seen', '')
      return
    }
    let first = -1
    parts.forEach((part, index) => {
      if (part.hasAttribute('data-seen')) return
      if (first === -1) first = index
      part.setAttribute('data-tick', '')
      part.style.setProperty('--d', String(index - first))
    })
    for (const part of parts) part.setAttribute('data-seen', '')
    host.removeAttribute('data-dir')
    if (dir !== 0) {
      // Restart the tint even when it goes the same way twice.
      void host.offsetWidth
      host.setAttribute('data-dir', dir > 0 ? 'up' : 'down')
    }
  }, [value, mode, direction])

  if (mode === 'digits') {
    const cents = dimCents ? centsAt(value) : -1
    // Changed on purpose 2026-10-31 (QA round 2 follow-ups, R23): the figure is heard whole. A screen reader met one span
    // per character, and where the digits are flex items (the position's overview) read "$", "0", ".", "2" one per line.
    // role="img" with the value as its name makes the characters one figure for assistive technology (its children are
    // presentational), as animated-number components do. Not an sr-only copy: that would put the value in the text
    // twice ("$0.24$0.24") for anything that reads the page's text. Nothing on screen changes.
    return (
      <span ref={root} role="img" aria-label={value} className={cx('dm-tick-fig dm-tick-fig--digits', className)}>
        {Array.from(value).map((ch, i) => (
          <span key={`${i}:${ch}`} className={cx('dm-tick-d', cents !== -1 && i >= cents && 'dm-amount-tail')}>
            {ch}
          </span>
        ))}
      </span>
    )
  }
  return (
    <span ref={root} className={cx('dm-tick-fig', className)}>
      <span key={value} ref={inner} className="dm-tick-v">
        {children ?? value}
      </span>
    </span>
  )
}

/**
 * A signed change. The sign character is real text (visually hidden) so
 * innerText reads "+1.23%" / "−1.23%" / "0.00%"; the arrow is decoration,
 * omitted for 0. `children` is the unsigned text ("1.23%", "$12.34").
 */
export function Delta({
  sign,
  children,
  variant = 'text',
  size = 'sm',
  className,
  title,
}: {
  sign: -1 | 0 | 1
  children: ReactNode
  variant?: 'text' | 'pill'
  size?: 'sm' | 'md'
  className?: string
  /** What the change is measured from, in words (2026-10-02: the fees card's period, from its measured start). */
  title?: string
}) {
  return (
    <span className={cx('dm-delta', size === 'md' && 'dm-delta--md', className)} data-sign={sign} data-variant={variant} title={title}>
      <span className="dm-delta-arrow" aria-hidden="true" />
      {sign !== 0 && <span className="sr-only">{sign > 0 ? '+' : '−'}</span>}
      {children}
    </span>
  )
}

/**
 * A token amount at a readable length (§6.1): `cut` shows at most six
 * significant digits with the full value in `title`; `dim-tail` keeps every
 * digit (for nodes whose full precision is compared) and dims the digits past
 * the sixth. Whole digits are never cut.
 */
export function AmountText({ text, mode = 'cut', className }: { text: string; mode?: 'cut' | 'dim-tail'; className?: string }) {
  const amount = shortAmount(text)
  if (mode === 'dim-tail') {
    return (
      <span className={className}>
        {amount.head}
        {amount.tail && <span className="dm-amount-tail">{amount.tail}</span>}
      </span>
    )
  }
  return (
    <span title={amount.cut ? amount.full : undefined} className={className}>
      {amount.short}
    </span>
  )
}

/**
 * "$1,234.56" from a decimal string (§6.2). Null when the value is null:
 * never a placeholder. `block` puts the valuation's pool block in the title;
 * `dimCents` dims the cents (hero figures only); `approx` prefixes a dim ≈;
 * `floor` writes a positive amount under a cent as "<$0.01", its exact figure
 * in the title (the position screens, audit E7, 2026-10-01).
 */
export function UsdText({
  value,
  block,
  dimCents = false,
  approx = false,
  floor = false,
  className,
}: {
  value: string | null
  block?: number
  dimCents?: boolean
  approx?: boolean
  floor?: boolean
  className?: string
}) {
  if (value === null) return null
  const exact = formatUsd(value)
  const text = floor ? formatUsdFloor(value) : exact
  const cents = dimCents ? centsAt(text) : -1
  const where = block === undefined ? null : `Pool price at block ${block}`
  const title = text === exact ? where : [exact, where].filter(Boolean).join(' · ')
  return (
    <span className={cx('tnum', className)} title={title ?? undefined}>
      {approx && <span className="dm-approx">≈</span>}
      {cents === -1 ? (
        text
      ) : (
        <>
          {text.slice(0, cents)}
          <span className="dm-amount-tail">{text.slice(cents)}</span>
        </>
      )}
    </span>
  )
}

export type StackTone = 'primary' | 'primary-soft' | 'in' | 'neutral' | 'muted'

/**
 * Shares of one whole on a pill track, 2px apart. aria-hidden: its legend
 * carries the words. Shares are normalised; a NaN, negative or zero share is
 * dropped, and a zero or missing total draws only the bare track.
 */
export function StackedBar({ parts, height = 6, className }: { parts: ReadonlyArray<{ share: number; tone: StackTone }>; height?: 4 | 6 | 8; className?: string }) {
  const shown = parts.filter((part) => Number.isFinite(part.share) && part.share > 0)
  const total = shown.reduce((sum, part) => sum + part.share, 0)
  return (
    <span aria-hidden="true" className={cx('dm-stack', className)} style={{ height: rem(height) }}>
      {total > 0 &&
        shown.map((part, index) => <span key={index} className="dm-stack-seg" data-tone={part.tone} style={{ flexGrow: part.share / total, flexBasis: 0 }} />)}
    </span>
  )
}

/** An icon on a small tile: 20 in activity rows, 36 in lists, 44 in empty states. Decoration only. */
export function IconTile({ icon, tone = 'neutral', size = 36 }: { icon: ReactNode; tone?: 'neutral' | 'primary'; size?: 20 | 36 | 44 }) {
  return (
    <span aria-hidden="true" className="dm-icon-tile" data-tone={tone} data-size={size}>
      {icon}
    </span>
  )
}

/** A module title (`.dm-title` for h2, `.dm-subtitle` for h3) with an optional aside beside it and an action at the right. */
export function SectionHead({
  title,
  id,
  as: Tag = 'h2',
  aside,
  action,
  className,
}: {
  title: ReactNode
  id?: string
  as?: 'h2' | 'h3'
  aside?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cx('dm-section-head', className)}>
      <div className="dm-section-head-main">
        <Tag id={id} className={Tag === 'h2' ? 'dm-title' : 'dm-subtitle'}>
          {title}
        </Tag>
        {aside && <span className="dm-section-head-aside">{aside}</span>}
      </div>
      {action && <div className="dm-section-head-action">{action}</div>}
    </div>
  )
}

export type PeriodKey = '24h' | '7d' | '30d' | 'all'

const PERIODS: ReadonlyArray<{ key: PeriodKey; label: string }> = [
  { key: '24h', label: '24H' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: 'all', label: 'All' },
]

/**
 * The fees module's periods: a small Segmented over 24H 7D 30D All. A period
 * not in `available` is not rendered (never disabled). The choice lives in
 * React state only, never in storage.
 */
export function PeriodTabs({
  value,
  onChange,
  available,
  stretch = false,
  label,
}: {
  value: PeriodKey
  onChange: (k: PeriodKey) => void
  available: ReadonlyArray<PeriodKey>
  stretch?: boolean
  label: string
}) {
  const items = PERIODS.filter((period) => available.includes(period.key))
  return <Segmented items={items} value={value} onChange={onChange} label={label} size="sm" stretch={stretch} />
}
