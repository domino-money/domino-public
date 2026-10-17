import { useLayoutEffect, useRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDialog } from '../../lib/useDialog'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { IconChevronDown, IconChevronLeft, IconClose, IconLock } from '../icons'
import { IconButton, cx } from '../ui'

/*
 * The position action dialogs, one family (Changed on purpose 2026-10-03, the owner: "the UIs you built for them are
 * literally ugly. Horrible."): V1's Collect fees and Close position (PositionActions.tsx), the fees waiting in a vault
 * (FeeReserves.tsx) and Domino V2's Add liquidity, Change range, Withdraw and Collect fees (src/v2in/position) draw the
 * same frame and the same parts, in New position's visual language (styles/dialogs.css):
 *   - the frame: the title, one plain line under it, Close, and a Back chevron on a dialog's second step; a sheet from
 *     the bottom on a phone (.dm-dialog), the action's one button at the foot;
 *   - a card: what moves, as token rows (each token's mark, its figure large, its symbol quiet), under a short caption;
 *   - facts: the quieter lines under it (At least, the fees), label left, value right;
 *   - notes, the step in progress, a failure, the gate's locked sentence and a quiet disclosure for the settings.
 * Presentation only: every data-* hook, word and decision stays the caller's.
 */

type Data = Record<`data-${string}`, string | undefined>

/**
 * A position sheet's way out (V4's .as-dlg closing): the dialog itself leaves the page at once (its role, focus and every
 * hook go with it), and a still copy of it, with no role, name, id, link or test hook and taking no input, fades and sinks
 * for 220ms (slides down on a phone, 280ms) before it is removed. Only the position sheets ([data-position-dialog]) leave
 * one; never under reduced motion or the stilled site.
 */
function leaveGhost(backdrop: HTMLElement) {
  if (typeof window === 'undefined' || !backdrop.isConnected || !backdrop.querySelector('.dm-dialog:is([data-position-dialog], [data-bulk-close])')) return
  if (document.documentElement.classList.contains('dm-still') || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  // Where the sheet had scrolled to, so the copy leaves from what was on screen.
  const scrolls = Array.from(backdrop.querySelectorAll<HTMLElement>('.dm-dialog, .dm-pa-body')).map((node) => node.scrollTop)
  // After the commit: a sheet still on the page (React's StrictMode rehearsal) leaves nothing behind.
  queueMicrotask(() => {
    if (backdrop.isConnected) return
    const ghost = backdrop.cloneNode(true) as HTMLElement
    for (const element of [ghost, ...Array.from(ghost.querySelectorAll<Element>('*'))]) {
      for (const name of element.getAttributeNames()) {
        if (name === 'id' || name === 'role' || name === 'name' || name === 'for' || name === 'tabindex' || name === 'href' || name === 'title' || name.startsWith('aria-')) element.removeAttribute(name)
      }
    }
    // The sheet's own hooks name no action on the copy (its look keys on the attribute being there, never on its value).
    for (const sheet of Array.from(ghost.querySelectorAll<HTMLElement>('.dm-dialog'))) {
      for (const name of sheet.getAttributeNames()) if (name.startsWith('data-')) sheet.removeAttribute(name)
      sheet.setAttribute('data-position-dialog', '')
    }
    ghost.setAttribute('aria-hidden', 'true')
    ghost.inert = true
    ghost.classList.add('dm-dialog-ghost')
    document.body.append(ghost)
    Array.from(ghost.querySelectorAll<HTMLElement>('.dm-dialog, .dm-pa-body')).forEach((node, index) => { node.scrollTop = scrolls[index] ?? 0 })
    window.setTimeout(() => ghost.remove(), window.matchMedia('(max-width: 639px)').matches ? 280 : 220)
  })
}

export function ActionSheet({ id, title, lede, back, onClose, footer, children, ...data }: {
  /** The ids' stem: `<id>-title`, `<id>-lede`. */
  id: string
  title: ReactNode
  /** One plain line under the title (the dialog's description). */
  lede?: ReactNode
  /** A Back chevron left of the title: the second step's way back to the first. */
  back?: ({ onClick: () => void; disabled?: boolean } & Data) | null
  onClose: () => void
  footer: ReactNode
  children: ReactNode
} & Data) {
  const dialog = useDialog(true, onClose)
  const backdrop = useRef<HTMLDivElement>(null)
  // The sheet catches the ember on its rim and in a wash (EmberLight's .dm-lit) where it is a card, from 640px; on a
  // phone its first pseudo-element is the bottom sheet's handle.
  const lit = useMediaQuery('(min-width: 640px)')
  useLayoutEffect(() => {
    const node = backdrop.current
    return () => {
      if (node) leaveGhost(node)
    }
  }, [])
  const titleId = `${id}-title`
  const ledeId = `${id}-lede`
  return createPortal(
    <div ref={backdrop} role="presentation" className="dm-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={lede ? ledeId : undefined} className={cx('dm-dialog dm-flow-dialog dm-pa', lit && 'dm-lit')} {...data}>
        <div className={cx('dm-flow-dialog-head dm-pa-head', back && 'dm-pa-head--back')}>
          {back && <BackButton {...back} />}
          <h2 id={titleId} tabIndex={-1} className="dm-dialog-title dm-pa-title outline-none">
            {title}
          </h2>
          {lede && (
            <p id={ledeId} className="dm-receipt-lede dm-pa-lede">
              {lede}
            </p>
          )}
          <IconButton label="Close" icon={<IconClose />} variant="ghost" size="sm" className="dm-dialog-close" onClick={onClose} />
        </div>
        <div className="dm-flow-dialog-body dm-pa-body">{children}</div>
        <div className="dm-flow-dialog-foot dm-pa-foot">{footer}</div>
      </div>
    </div>,
    document.body,
  )
}

function BackButton({ onClick, disabled, ...data }: { onClick: () => void; disabled?: boolean } & Data) {
  return <IconButton label="Back" icon={<IconChevronLeft />} variant="ghost" size="sm" className="dm-pa-back" disabled={disabled} onClick={onClick} {...data} />
}

/** A card of what moves: a short caption (and on its right, a quiet figure such as the USD value), then the rows. */
export function SheetCard({ caption, aside, children, className, ...rest }: { caption?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string } & Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className'>) {
  return (
    <div className={cx('dm-pa-card', className)} {...rest}>
      {(caption || aside) && (
        <div className="dm-pa-card-head">
          {caption && <span className="dm-pa-caption">{caption}</span>}
          {aside && <span className="dm-pa-card-aside tnum">{aside}</span>}
        </div>
      )}
      {children}
    </div>
  )
}

/** Token rows: `lg` in a card (the dialog's answer), `sm` as a fact's value. */
export function TokenRows({ size = 'lg', children, className, ...rest }: { size?: 'lg' | 'sm'; children: ReactNode; className?: string } & Omit<HTMLAttributes<HTMLUListElement>, 'children' | 'className'>) {
  return (
    <ul className={cx('dm-pa-tokens', size === 'sm' && 'dm-pa-tokens--sm', className)} {...rest}>
      {children}
    </ul>
  )
}

/**
 * One token's amount: its mark, the figure, the symbol. The figure and the symbol are one run of text ("0.5 UFG"), so a
 * row reads and copies as the amount it is; `amount` replaces both where the caller draws its own (a skeleton, a dash).
 */
export function TokenRow({ mark, figure, symbol, amount, title, ...rest }: { mark?: ReactNode; figure?: ReactNode; symbol?: ReactNode; amount?: ReactNode; title?: string } & Data) {
  return (
    <li className="dm-pa-token" {...rest}>
      {mark ?? <span aria-hidden="true" className="dm-pa-token-blank" />}
      {amount ?? (
        <span className="dm-pa-token-amount tnum" title={title}>
          {figure} <bdi className="dm-pa-token-symbol">{symbol}</bdi>
        </span>
      )}
    </li>
  )
}

/** The quieter facts under a card: label left, value right. */
export function SheetFacts({ children, className, ...rest }: { children: ReactNode; className?: string } & Omit<HTMLAttributes<HTMLDListElement>, 'children' | 'className'>) {
  return (
    <dl className={cx('dm-pa-facts', className)} {...rest}>
      {children}
    </dl>
  )
}

export function SheetFact({ label, children, ...rest }: { label: ReactNode; children: ReactNode } & Omit<HTMLAttributes<HTMLDivElement>, 'children'>) {
  return (
    <div {...rest}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** A short line: `info` (a quiet dot) or `warn` (the dot in the warm ink, the words in full ink). */
export function SheetNote({ tone = 'info', children, ...rest }: { tone?: 'info' | 'warn'; children: ReactNode } & Data) {
  return (
    <p className="dm-pa-note" data-tone={tone} {...rest}>
      {children}
    </p>
  )
}

/** What the dialog is doing now: a turning arc while the wallet or the network has it, a check once it is done. */
export function SheetStatus({ state = 'busy', children, ...rest }: { state?: 'busy' | 'done'; children: ReactNode } & Data) {
  return (
    <p role="status" className="dm-pa-status" data-state={state} {...rest}>
      {children}
    </p>
  )
}

/** A failure, in words (its code stays the caller's data attribute). */
export function SheetAlert({ children, ...rest }: { children: ReactNode } & Data) {
  return (
    <p role="alert" className="dm-pa-alert" {...rest}>
      {children}
    </p>
  )
}

/** The gate's sentence where the action's button would be: a closed slot with a lock, never a button. */
export function SheetLocked({ children, ...rest }: { children: ReactNode } & Data) {
  return (
    <p role="status" className="dm-pa-locked" {...rest}>
      <IconLock size={16} />
      <span>{children}</span>
    </p>
  )
}

/** The settings, closed until asked for: a quiet line of text with the current value on its right, never a field. */
export function SheetMore({ label, value, children, ...rest }: { label: ReactNode; value?: ReactNode; children: ReactNode } & Data) {
  return (
    <details className="dm-pa-more" {...rest}>
      <summary>
        <span className="dm-pa-more-label">{label}</span>
        {value && <span className="dm-pa-more-value tnum">{value}</span>}
        <IconChevronDown size={14} className="dm-pa-more-chevron" />
      </summary>
      <div className="dm-pa-more-body">{children}</div>
    </details>
  )
}

/**
 * Options as cards in a row (one is chosen): each with a picture, a title and, when it helps, a short line. A radio group,
 * every option a button in the tab order, as the site's Segmented.
 */
export function SheetChoices<T extends string>({ label, value, items, onChange, className, ...rest }: {
  label: string
  value: T
  items: ReadonlyArray<{ key: T; title: ReactNode; sub?: ReactNode; icon?: ReactNode; disabled?: boolean; data?: Data }>
  onChange: (next: T) => void
  className?: string
} & Data) {
  return (
    <div role="radiogroup" aria-label={label} className={cx('dm-pa-choices', className)} data-count={items.length} {...rest}>
      {items.map((item) => (
        <ChoiceButton key={item.key} checked={item.key === value} disabled={item.disabled} onClick={() => onChange(item.key)} {...item.data}>
          {item.icon && <span className="dm-pa-choice-icon">{item.icon}</span>}
          <span className="dm-pa-choice-title">{item.title}</span>
          {item.sub && <span className="dm-pa-choice-sub">{item.sub}</span>}
        </ChoiceButton>
      ))}
    </div>
  )
}

function ChoiceButton({ checked, children, ...rest }: { checked: boolean; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>) {
  return (
    <button type="button" role="radio" aria-checked={checked} className="dm-pa-choice dm-press" {...rest}>
      {children}
    </button>
  )
}
