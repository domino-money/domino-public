import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  Ref,
} from 'react'
import { IconCheck, IconChevronDown, IconClose, IconInfo, IconMenu, IconSearch } from './icons'

/*
 * Domino's primitives (DESIGN.md section C). Looks come from the component
 * classes in styles/shell.css, so a caller's Tailwind utility still wins, and
 * a file that may not import a new name can reach the same look through
 * `className` alone. This module imports nothing but React and ./icons.
 */

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}

/** Custom properties on a style object. */
const vars = (values: Record<string, string | number>) => values as CSSProperties

/**
 * A panel. Level 1 is the raised card (surface, ring, soft shadow, bottom lip),
 * level 2 an inset panel inside a card, level 3 a control-coloured block.
 * No padding of its own: the caller sets it.
 */
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
  ref?: Ref<HTMLDivElement>
} & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children'>) {
  const surface = level === 3 ? 'rounded-[var(--radius)] bg-surface-3' : level === 2 ? 'dm-inset' : 'dm-card'
  return (
    <div ref={ref} className={cx(surface, className)} {...rest}>
      {children}
    </div>
  )
}

/** A state a person scans for: in, out, waiting, neutral or Domino's own. */
export function Pill({
  children,
  className,
  tone = 'neutral',
  dot = false,
  ...rest
}: {
  children: ReactNode
  className?: string
  tone?: 'neutral' | 'accent' | 'in' | 'out' | 'wait'
  /** A small leading disc in the tone's colour, for a state a person scans for. */
  dot?: boolean
} & Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'className'>) {
  return (
    <span className={cx('dm-pill', `dm-pill--${tone}`, className)} {...rest}>
      {dot && <span aria-hidden="true" className="dm-pill-dot" />}
      {children}
    </span>
  )
}

export type ButtonVariant = 'primary' | 'accent' | 'outline' | 'ghost'
export type ButtonSize = 'sm' | 'md' | 'lg'

const buttonClass = (variant: ButtonVariant, size: ButtonSize, className?: string) =>
  cx('dm-btn dm-press', `dm-btn--${variant}`, `dm-btn--${size}`, className)

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** primary: the one main action (white on dark, ink on light). accent: only a step handed to the wallet. */
  variant?: ButtonVariant
  size?: ButtonSize
  ref?: Ref<HTMLButtonElement>
}

export function Button({ variant = 'primary', size = 'md', className, ...rest }: ButtonProps) {
  return <button className={buttonClass(variant, size, className)} {...rest} />
}

/**
 * A route link drawn exactly as Button, so a "New position" beside a
 * "Markets" button lines up. A change of route is a link and stays one: it
 * has an href, opens in a new tab on a modifier click, and is announced as
 * a link.
 */
export function LinkButton({
  variant = 'primary',
  size = 'md',
  className,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  children: ReactNode
  variant?: ButtonVariant
  size?: ButtonSize
  ref?: Ref<HTMLAnchorElement>
}) {
  return (
    <a className={buttonClass(variant, size, className)} {...rest}>
      {children}
    </a>
  )
}

/** A square button that is only an icon; `label` is its accessible name. */
export function IconButton({
  label,
  icon,
  size = 'md',
  variant = 'surface',
  className,
  type = 'button',
  ...rest
}: {
  label: string
  icon: ReactNode
  size?: 'sm' | 'md'
  variant?: 'surface' | 'ghost'
  ref?: Ref<HTMLButtonElement>
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      aria-label={label}
      className={cx('dm-icon-btn dm-press-icon', `dm-icon-btn--${variant}`, `dm-icon-btn--${size}`, className)}
      {...rest}
    >
      {icon}
    </button>
  )
}

/** Heading in the display serif. Sizes come from the caller (text-title, dm-display-title, …). */
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
  ref?: Ref<HTMLHeadingElement>
} & Omit<HTMLAttributes<HTMLHeadingElement>, 'className' | 'children'>) {
  return (
    <Tag ref={ref} className={cx('dm-display', className)} {...rest}>
      {children}
    </Tag>
  )
}

/** Small uppercase label. New screens use none; kept for existing callers. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx('dm-kicker', className)}>{children}</p>
}

/** A small label: `soft` under a name ("Uniswap · 0.02%"), `plate` on a plate (the hero chip, pair badges). */
export function Chip({
  children,
  icon,
  variant = 'soft',
  className,
  title,
  ...rest
}: {
  children: ReactNode
  icon?: ReactNode
  variant?: 'soft' | 'plate'
  className?: string
  title?: string
} & Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'className' | 'title'>) {
  return (
    <span className={cx('dm-chip', variant === 'plate' && 'dm-chip--plate', className)} title={title} {...rest}>
      {icon}
      {children}
    </span>
  )
}

/**
 * A small dot that is only lit by real data. Unlit (the default) it rests in a
 * faint tone; lit, it turns the in-tone and its ring pulses three times from
 * the moment it lights, then rests. Decoration only; the hero chip uses it.
 */
export function LiveDot({ lit = false, className }: { lit?: boolean; className?: string }) {
  return <span aria-hidden="true" data-lit={lit ? '' : undefined} className={cx('dm-live-dot', className)} />
}

const BADGES = {
  estimate: { tone: 'neutral', text: 'est.' },
  stale: { tone: 'wait', text: 'stale' },
  'in-range': { tone: 'in', text: 'In range' },
  'out-of-range': { tone: 'out', text: 'Out of range' },
} as const

/**
 * A fixed-wording state pill. There is no "live" badge: freshness is always
 * "retrieved N s ago" or "stale". Places with pinned strings keep their own Pill text.
 */
export function Badge({ kind, ...rest }: { kind: 'estimate' | 'stale' | 'in-range' | 'out-of-range' } & Omit<HTMLAttributes<HTMLSpanElement>, 'children'>) {
  const badge = BADGES[kind]
  return (
    <Pill {...rest} tone={badge.tone} dot={kind === 'in-range' || kind === 'out-of-range'}>
      {badge.text}
    </Pill>
  )
}

/**
 * A plate with a dotted grid: `hero` (visible dots, a vignette, a faint warm
 * floor), `plate` (barely there) or `chart` (dots that dissolve at the top and
 * bottom, over `ground`). Children sit above the grid layers.
 */
export function DottedSurface({
  variant,
  ground = 'surface-1',
  className,
  children,
  style,
  ...rest
}: {
  variant: 'hero' | 'plate' | 'chart'
  ground?: 'surface-1' | 'surface-2'
  className?: string
  children?: ReactNode
} & HTMLAttributes<HTMLDivElement>) {
  const chart = variant === 'chart' ? vars({ '--chart-ground': ground === 'surface-2' ? 'var(--surface-2)' : 'var(--surface-1)' }) : undefined
  return (
    <div className={cx('dm-plate', `dm-dots-${variant}`, className)} style={chart || style ? { ...chart, ...style } : undefined} {...rest}>
      <div className="relative z-[1]">{children}</div>
    </div>
  )
}

/** The one `main` of a routed screen, at its content width. */
export function PageShell({
  width = 'default',
  children,
  className,
  ...rest
}: {
  width?: 'default' | 'pool' | 'flow' | 'narrow'
  children: ReactNode
} & HTMLAttributes<HTMLElement>) {
  return (
    <main className={cx('dm-page', width !== 'default' && `dm-page--${width}`, className)} {...rest}>
      {children}
    </main>
  )
}

/** The top of a page: what it is, in one line, and what a person can do from it. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  size = 'title',
  align = 'start',
  className,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /** title: page titles (34/38, phone 28/32). display: Positions and New position (44/48, phone 34/38). */
  size?: 'title' | 'display'
  align?: 'start' | 'center'
  className?: string
}) {
  const center = align === 'center'
  return (
    <div className={cx('flex flex-wrap gap-x-8 gap-y-4', center ? 'flex-col items-center text-center' : 'items-end justify-between', className)}>
      <div className={cx('min-w-0', center && 'flex flex-col items-center')}>
        {eyebrow && (
          <div className="mb-3">
            <Chip>{eyebrow}</Chip>
          </div>
        )}
        <Display as="h1" className={size === 'display' ? 'dm-display-h1' : 'dm-display-title'}>
          {title}
        </Display>
        {description && <p className={cx('mt-2 max-w-[60ch] text-body text-fg-muted', center && 'mx-auto')}>{description}</p>}
      </div>
      {actions && <div className={cx('flex shrink-0 flex-wrap items-center gap-2', center && 'justify-center')}>{actions}</div>}
    </div>
  )
}

/**
 * A labelled figure: the label small and quiet, the value large and tabular,
 * an optional line under it for the source or the age. The value is whatever
 * the caller presents: this never formats a number and never invents one.
 * Must sit inside a `dl` (StatStrip is one). The label is uppercased by CSS,
 * so innerText reads it in capitals.
 */
export function Stat({
  label,
  children,
  sub,
  size = 'md',
  info,
  className,
  ...rest
}: {
  label: ReactNode
  children: ReactNode
  sub?: ReactNode
  size?: 'md' | 'lg'
  /** An explanation, on a small info mark beside the label (its title and accessible name). */
  info?: string
  className?: string
} & Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className'>) {
  return (
    <div className={cx('min-w-0', className)} {...rest}>
      <dt className="dm-kicker">
        {label}
        {info && (
          <span role="img" title={info} aria-label={info} className="ml-1 inline-flex align-[-2px] text-fg-subtle">
            <IconInfo size={12} />
          </span>
        )}
      </dt>
      <dd
        className={cx(
          'tnum mt-1.5 truncate font-medium',
          size === 'lg' ? 'text-stat md:text-stat-lg' : 'text-stat-sm md:text-stat',
        )}
      >
        {children}
      </dd>
      {sub && <dd className="mt-1 text-caption text-fg-subtle">{sub}</dd>}
    </div>
  )
}

/** A row of Stats with dividers: `cols` equal columns from 1024px, fewer below, no dividers on a phone. */
export function StatStrip({
  children,
  className,
  cols = 4,
  ...rest
}: { children: ReactNode; className?: string; cols?: 4 | 5 } & Omit<HTMLAttributes<HTMLDListElement>, 'children' | 'className'>) {
  return (
    <dl className={cx('dm-stats', cols === 5 ? 'dm-stats--5' : 'dm-stats--4', className)} {...rest}>
      {children}
    </dl>
  )
}

/**
 * The sliding thumb shared by Tabs and Segmented: measured from the chosen
 * item, moved by translate and width, re-measured when anything resizes
 * (a web font arriving, a count changing). Until it is placed the chosen item
 * carries its own fill, so the choice is visible without script.
 */
function useThumb(activeIndex: number) {
  const track = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const root = track.current
    const mark = thumb.current
    if (!root || !mark) return
    const place = () => {
      const item = activeIndex < 0 ? null : root.querySelectorAll<HTMLElement>('[data-seg-item]')[activeIndex]
      if (!item) {
        mark.style.opacity = '0'
        return
      }
      mark.style.width = `${item.offsetWidth}px`
      mark.style.translate = `${item.offsetLeft}px 0`
      mark.style.opacity = '1'
    }
    place()
    let alive = true
    let frame = 0
    if (!root.hasAttribute('data-thumb')) frame = requestAnimationFrame(() => root.setAttribute('data-thumb', ''))
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    if (observer) {
      observer.observe(root)
      root.querySelectorAll('[data-seg-item]').forEach((item) => observer.observe(item))
    }
    // The web fonts swap in after the first paint and change every item's width.
    void document.fonts?.ready.then(() => {
      if (alive) place()
    })
    return () => {
      alive = false
      cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [activeIndex])
  return { track, thumb }
}

/** Accessible tab strip. The panel it controls is the caller's. `size` is accepted and ignored. */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: ReadonlyArray<{ key: T; label: ReactNode; count?: number }>
  value: T
  onChange: (next: T) => void
  label: string
  size?: 'md' | 'lg'
  className?: string
}) {
  const { track, thumb } = useThumb(items.findIndex((item) => item.key === value))
  return (
    <div ref={track} role="tablist" aria-label={label} className={cx('dm-seg', className)}>
      <span ref={thumb} aria-hidden="true" className="dm-seg-thumb" />
      {items.map((item) => {
        const active = item.key === value
        return (
          <button key={item.key} type="button" role="tab" aria-selected={active} data-seg-item="" onClick={() => onChange(item.key)} className="dm-seg-item">
            {item.label}
            {item.count !== undefined && <Chip>{item.count}</Chip>}
          </button>
        )
      })}
    </div>
  )
}

/** A group where exactly one is chosen: sort orders, chart tokens, filters. */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: ReadonlyArray<{ key: T; label: ReactNode; disabled?: boolean }>
  value: T
  onChange: (next: T) => void
  label: string
  className?: string
}) {
  const { track, thumb } = useThumb(items.findIndex((item) => item.key === value))
  return (
    <div ref={track} role="radiogroup" aria-label={label} className={cx('dm-seg', className)}>
      <span ref={thumb} aria-hidden="true" className="dm-seg-thumb" />
      {items.map((item) => {
        const active = item.key === value
        return (
          <button
            key={item.key}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={item.disabled}
            data-seg-item=""
            onClick={() => onChange(item.key)}
            className="dm-seg-item"
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * A figure that is not there, and why. The dash is all a sighted reader needs;
 * the reason is for everyone else, since `title` never appears on touch and is
 * dropped on a generic span.
 *
 * The reason is the element's accessible NAME, not a visually hidden child.
 * A hidden child would join the cell's own text, so a table reading "—" would
 * start reading "— TVL unavailable" to everything that walks text rather than
 * the accessibility tree — including our own screen tests. `aria-label` says
 * the same thing to a screen reader and leaves the text alone.
 */
export function FigureDash({ reason }: { reason?: string }) {
  return (
    <span className="text-fg-subtle" title={reason} aria-label={reason ?? 'Unavailable'} data-figure="none">
      —
    </span>
  )
}

/** A resting block while a figure is on its way. Sized by the caller; never shown in place of a value that failed. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx('block rounded-[var(--radius-sm)] bg-skeleton animate-pulse-soft', className)} />
}

/** Search input with the icon inside and the submit on Enter. Width is the caller's. */
export function SearchField({
  className,
  onSubmitValue,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { onSubmitValue?: (value: string) => void }) {
  return (
    <label className={cx('dm-search', className)}>
      <IconSearch size={14} className="dm-search-icon" />
      <input
        type="search"
        spellCheck={false}
        autoComplete="off"
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSubmitValue?.(event.currentTarget.value)
        }}
        className="dm-search-input"
        {...rest}
      />
    </label>
  )
}

/**
 * Where a position sits against the price: the chosen band, and where the
 * pool's price is now. Positions are fractions of the drawn width that the
 * caller has already worked out on its own scale, so this draws and says
 * nothing about prices itself.
 */
export function RangeBar({
  lower,
  upper,
  current,
  inRange,
  className,
  label = 'Price range',
}: {
  /** 0 to 1 across the drawn width. */
  lower: number
  upper: number
  /** 0 to 1, or null when the current price is not known. */
  current: number | null
  inRange: boolean | null
  className?: string
  label?: string
}) {
  const clamp = (n: number) => Math.min(1, Math.max(0, n))
  const left = clamp(lower)
  const width = Math.max(0.01, clamp(upper) - left)
  // In range: the informational Tangerine. Out of range: the out tone, full strength (the words say so beside it).
  // Unknown, or no liquidity (null): no band and no current-price marker, only a hatched outline.
  const band = inRange === true ? 'bg-primary-ink' : inRange === false ? 'bg-money-out' : 'dm-range-unknown'
  return (
    <div className={cx('relative h-1.5 w-full rounded-[var(--radius-pill)] bg-surface-3', className)} role="img" aria-label={label}>
      <div
        className={cx('absolute inset-y-0 rounded-[var(--radius-pill)] transition-[left,width] duration-300 ease-enter', band)}
        style={{ left: `${left * 100}%`, width: `${width * 100}%` }}
      />
      {current !== null && inRange !== null && (
        <span
          aria-hidden="true"
          className="absolute top-1/2 h-3.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg outline-2 outline-[var(--surface-2)]"
          style={{ left: `${clamp(current) * 100}%` }}
        />
      )}
    </div>
  )
}

/**
 * The words for a list with nothing in it, and the one thing to do next. With
 * an icon, it sits in a small tile inside ripple rings. The icon is never a
 * domino (no IconPositions): use IconSearch, IconReceipt, IconWallet, IconInfo
 * or IconRange.
 */
export function EmptyState({
  title,
  body,
  action,
  icon,
  className,
  ...rest
}: {
  title: ReactNode
  body?: ReactNode
  action?: ReactNode
  icon?: ReactNode
  className?: string
} & Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'children' | 'className'>) {
  return (
    <div className={cx('dm-empty', className)} {...rest}>
      {icon && (
        <div aria-hidden="true" className="dm-empty-art">
          <span className="dm-empty-ring dm-empty-ring--3" />
          <span className="dm-empty-ring dm-empty-ring--2" />
          <span className="dm-empty-ring dm-empty-ring--1" />
          <span className="dm-empty-tile">{icon}</span>
        </div>
      )}
      <p className="text-body font-medium text-fg">{title}</p>
      {body && <p className="mt-1 max-w-[36ch] text-body text-fg-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/**
 * Table cells that agree on padding and on where numbers sit (the geometry is
 * `.dm-table` in shell.css). `col="wide"` hides the whole cell below 768px;
 * never hide part of a header label.
 */
export function Th({ children, numeric, className, col }: { children?: ReactNode; numeric?: boolean; className?: string; col?: 'wide' }) {
  return (
    <th scope="col" data-col={col} className={cx(numeric ? 'text-right' : 'text-left', className)}>
      {children}
    </th>
  )
}

export function Td({
  children,
  numeric,
  className,
  colSpan,
  col,
}: {
  children?: ReactNode
  numeric?: boolean
  className?: string
  colSpan?: number
  col?: 'wide'
}) {
  return (
    <td colSpan={colSpan} data-col={col} className={cx(numeric ? 'tnum whitespace-nowrap text-right' : 'text-left', className)}>
      {children}
    </td>
  )
}

/**
 * The table card: an optional serif title with an action, a status slot, and
 * the table with its rounded header band and row pills. Horizontal scroll
 * stays inside it, never on the page.
 */
export function TableShell({
  children,
  className,
  label,
  title,
  titleRef,
  action,
  status,
  rowHeight,
  data,
  style,
  ...rest
}: {
  children: ReactNode
  className?: string
  label: string
  title?: ReactNode
  /** Lands on the title `h2` (tabIndex -1, text only the title): the focus target after a retry. */
  titleRef?: Ref<HTMLHeadingElement>
  action?: ReactNode
  status?: ReactNode
  rowHeight?: 56 | 64 | 72
  /** Spread on the card as data attributes: `{ 'selected-pools': '' }` becomes `data-selected-pools=""`. */
  data?: Record<string, string>
} & Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'children' | 'className'>) {
  const attributes = data ? Object.fromEntries(Object.entries(data).map(([key, value]) => [`data-${key}`, value])) : undefined
  const rows = rowHeight ? vars({ '--row-h': `${rowHeight}px` }) : undefined
  return (
    <div className={cx('dm-card dm-table-card', className)} style={rows || style ? { ...rows, ...style } : undefined} {...attributes} {...rest}>
      {(title || action) && (
        <div className="dm-table-head">
          {title ? (
            <Display as="h2" ref={titleRef} tabIndex={-1} className="dm-display-card outline-none">
              {title}
            </Display>
          ) : (
            <span />
          )}
          {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
        </div>
      )}
      {status && <div className="dm-table-status">{status}</div>}
      {/* Positioned, so an absolutely placed descendant (a screen-reader-only
          label in a header or a cell) is contained and clipped here too: with a
          static ancestry it sits against the viewport and widens the page. */}
      <div className="relative overflow-x-auto">
        <table className="dm-table" aria-label={label}>
          {children}
        </table>
      </div>
    </div>
  )
}

/** A definition list of facts as rows: label left, value right; two columns from 768px. */
export function KeyValueList({
  columns = 1,
  className,
  children,
  ...rest
}: { columns?: 1 | 2; className?: string; children: ReactNode } & Omit<HTMLAttributes<HTMLDListElement>, 'children' | 'className'>) {
  return (
    <dl className={cx('dm-kv', columns === 2 && 'dm-kv--two', className)} {...rest}>
      {children}
    </dl>
  )
}

/** One fact. `action` is a control the caller passes (a CopyButton, for instance). */
export function KeyValue({
  label,
  children,
  mono,
  action,
  ...rest
}: { label: ReactNode; children: ReactNode; mono?: boolean; action?: ReactNode } & Omit<HTMLAttributes<HTMLDivElement>, 'children'>) {
  return (
    <div {...rest}>
      <dt>{label}</dt>
      <dd className={mono ? 'dm-kv-mono' : undefined}>
        {children}
        {action && <span className="dm-kv-action">{action}</span>}
      </dd>
    </div>
  )
}

/** The numbered square beside a step title. Decoration: `label` ("Step 2, done") is read instead. */
export function StepMarker({
  index,
  state,
  label,
  className,
  ...rest
}: { index: number; state: 'upcoming' | 'current' | 'done'; label: string } & Omit<HTMLAttributes<HTMLSpanElement>, 'children'>) {
  return (
    <span className={cx('relative inline-flex shrink-0', className)} {...rest}>
      <span aria-hidden="true" className="dm-step-marker" data-state={state}>
        {state === 'done' ? <IconCheck size={14} /> : index}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  )
}

/**
 * A select-only combobox (DESIGN.md C.9): a trigger button that keeps focus
 * and an in-place listbox of option buttons, reached through
 * aria-activedescendant, never by Tab. Keyboard, all on the trigger: Enter,
 * Space or ArrowDown opens; arrows, Home and End move; a typed letter jumps;
 * Enter or Space chooses; Escape closes and focus stays; Tab closes. A pointer
 * press outside closes.
 */
export function Select<T extends string | null>({
  id,
  label,
  value,
  options,
  onChange,
  className,
}: {
  id: string
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: ReactNode; icon?: ReactNode; separatorAfter?: boolean }>
  onChange: (v: T) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const wrapper = useRef<HTMLDivElement>(null)
  const typed = useRef({ text: '', at: 0 })
  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = selectedIndex === -1 ? null : options[selectedIndex]
  const last = options.length - 1
  const optionId = (index: number) => `${id}-opt-${index}`

  const openAt = (index: number) => {
    setActive(Math.min(Math.max(index, 0), Math.max(last, 0)))
    setOpen(true)
  }
  const choose = (index: number) => {
    const option = options[index]
    if (option) onChange(option.value)
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [open])

  useEffect(() => {
    if (open) document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, id])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      // Enter and Space open through the button's own click.
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        openAt(selectedIndex === -1 ? 0 : selectedIndex)
      }
      return
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive((index) => Math.min(last, index + 1))
        return
      case 'ArrowUp':
        event.preventDefault()
        setActive((index) => Math.max(0, index - 1))
        return
      case 'Home':
        event.preventDefault()
        setActive(0)
        return
      case 'End':
        event.preventDefault()
        setActive(Math.max(last, 0))
        return
      case 'Enter':
      case ' ':
        event.preventDefault()
        choose(active)
        return
      case 'Escape':
        event.preventDefault()
        setOpen(false)
        return
      case 'Tab':
        setOpen(false)
        return
    }
    if (event.key.length !== 1 || event.altKey || event.ctrlKey || event.metaKey) return
    const fresh = event.timeStamp - typed.current.at > 700
    const text = (fresh ? event.key : typed.current.text + event.key).toLowerCase()
    typed.current = { text, at: event.timeStamp }
    const start = text.length === 1 ? active + 1 : active
    for (let step = 0; step < options.length; step++) {
      const index = (start + step) % options.length
      const words = (document.getElementById(optionId(index))?.textContent ?? '').trim().toLowerCase()
      if (words.startsWith(text)) {
        setActive(index)
        return
      }
    }
  }

  return (
    <div ref={wrapper} className={cx('dm-select', className)}>
      <button
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        aria-label={label}
        aria-activedescendant={open && options.length > 0 ? optionId(active) : undefined}
        onClick={() => (open ? setOpen(false) : openAt(selectedIndex === -1 ? 0 : selectedIndex))}
        onKeyDown={onKeyDown}
        className="dm-select-trigger dm-press"
      >
        {selected?.icon}
        <span className="min-w-0 truncate">{selected?.label}</span>
        <IconChevronDown size={14} className="dm-select-chevron" />
      </button>
      {open && (
        <div id={`${id}-listbox`} role="listbox" aria-label={label} className="dm-listbox">
          {options.map((option, index) => (
            <Fragment key={index}>
              <button
                id={optionId(index)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === selectedIndex}
                data-active={index === active ? '' : undefined}
                // The trigger keeps focus: a press on an option never moves it.
                onMouseDown={(event) => event.preventDefault()}
                onPointerMove={() => setActive(index)}
                onClick={() => choose(index)}
                className="dm-option"
              >
                {option.icon}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {index === selectedIndex && <IconCheck size={14} className="dm-option-check" />}
              </button>
              {option.separatorAfter && <hr aria-hidden="true" className="dm-listbox-sep" />}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

export type MenuEntry =
  | { kind: 'link'; href: string; label: ReactNode; icon?: ReactNode; current?: boolean; mobileOnly?: boolean }
  | { kind: 'separator'; mobileOnly?: boolean }
  | { kind: 'heading'; label: ReactNode }

/**
 * A menu of links behind one icon button. The trigger says `aria-haspopup="menu"`
 * (never "dialog": in the header that selector belongs to the wallet control).
 * The panel exists only while open; focus goes to its first item, arrows, Home
 * and End move, Escape closes and returns focus, and choosing a link, a
 * pointer press outside or a route change closes it. `mobileOnly` entries show
 * only below 768px, decided when the menu opens.
 */
export function Menu({
  id,
  label,
  trigger,
  items,
  align = 'end',
}: {
  id: string
  label: string
  /** The trigger's content; by default a menu glyph that turns into a close glyph while open. */
  trigger?: ReactNode
  items: ReadonlyArray<MenuEntry>
  align?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    panel.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onPointer = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false)
    }
    const onRoute = () => setOpen(false)
    document.addEventListener('pointerdown', onPointer)
    window.addEventListener('hashchange', onRoute)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('hashchange', onRoute)
    }
  }, [open])

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    setNarrow(typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches)
    setOpen(true)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const links = Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const at = links.findIndex((link) => link === document.activeElement)
    const move = (index: number) => {
      event.preventDefault()
      if (links.length > 0) links[(index + links.length) % links.length].focus()
    }
    switch (event.key) {
      case 'ArrowDown':
        move(at + 1)
        return
      case 'ArrowUp':
        move(at === -1 ? -1 : at - 1)
        return
      case 'Home':
        move(0)
        return
      case 'End':
        move(links.length - 1)
        return
      case 'Escape':
        event.preventDefault()
        setOpen(false)
        button.current?.focus()
        return
      case 'Tab':
        setOpen(false)
        return
    }
  }

  const shown = items.filter((entry) => entry.kind === 'heading' || !entry.mobileOnly || narrow)

  return (
    <div ref={anchor} className="dm-menu-anchor">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={toggle}
        className="dm-icon-btn dm-icon-btn--ghost dm-icon-btn--md dm-press-icon dm-menu-trigger"
      >
        {trigger ?? (
          <span className="dm-menu-glyph">
            <IconMenu className="dm-menu-glyph-open" />
            <IconClose className="dm-menu-glyph-close" />
          </span>
        )}
      </button>
      {open && (
        <div ref={panel} id={id} role="menu" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown} className={cx('dm-menu', align === 'start' ? 'dm-menu--start' : 'dm-menu--end')}>
          {shown.map((entry, index) =>
            entry.kind === 'separator' ? (
              <hr key={index} className="dm-menu-sep" />
            ) : entry.kind === 'heading' ? (
              <div key={index} role="presentation" className="dm-menu-heading">
                {entry.label}
              </div>
            ) : (
              <a
                key={index}
                role="menuitem"
                href={entry.href}
                aria-current={entry.current ? 'page' : undefined}
                onClick={() => setOpen(false)}
                className="dm-menu-item"
              >
                {entry.icon}
                <span className="min-w-0 truncate">{entry.label}</span>
              </a>
            ),
          )}
        </div>
      )}
    </div>
  )
}
