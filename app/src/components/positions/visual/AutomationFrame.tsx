import type { HTMLAttributes, ReactNode } from 'react'
import { ModeArt } from '../../automate/ModeArt'
import { IconAutomate, IconReceipt } from '../../icons'
import { cx } from '../../ui'

/** A 44px tile in three quiet rings (the empty state's art): decoration only. */
function Ripples({ icon }: { icon: ReactNode }) {
  return (
    <span className="dm-empty-art">
      <span className="dm-empty-ring dm-empty-ring--3" />
      <span className="dm-empty-ring dm-empty-ring--2" />
      <span className="dm-empty-ring dm-empty-ring--1" />
      <span className="dm-empty-tile">{icon}</span>
    </span>
  )
}

/**
 * The automation frame (DESIGN-V2 §13.6): the fees card's frame for what
 * automation does, used today by Managed positions and Receipts. The head is
 * the caller's own title (and chip); the body is the caller's content. While
 * that content is only a sentence (signed out, empty, loading: a
 * `.dm-acct-plot` or `.dm-acct-quiet`), it becomes a dotted plate with the
 * art above the sentence: the Domino-compound machine (plays while in view,
 * nothing on the plate is clickable) or a receipt tile in ripple rings. The
 * art is decoration only: no text, no digits, no `%`.
 */
export function AutomationFrame({
  title,
  titleId,
  art,
  aside,
  empty,
  children,
  className,
  ...rest
}: {
  title: ReactNode
  titleId?: string
  art: 'compound' | 'domino' | 'receipt'
  aside?: ReactNode
  /** The sentence when there is no content (the fees card's automation kinds). */
  empty?: ReactNode
  children?: ReactNode
  className?: string
} & Omit<HTMLAttributes<HTMLElement>, 'title' | 'children' | 'className'>) {
  return (
    <section className={cx('dm-card dm-auto-frame', className)} aria-labelledby={titleId} {...rest}>
      <div className="dm-auto-frame-head">
        <h2 id={titleId} className="dm-title">
          {title}
        </h2>
        {aside}
      </div>
      <div className="dm-auto-frame-body" data-art={art}>
        <div aria-hidden="true" className="dm-auto-frame-art">
          {art === 'receipt' ? (
            <Ripples icon={<IconReceipt />} />
          ) : (
            <>
              <ModeArt mode={art} size="card" play="loop" />
              {/* While the machine is not drawn (an empty ModeArt), the automation glyph in the same rings: the plate is never an empty slot. */}
              <span className="dm-auto-frame-standin">
                <Ripples icon={<IconAutomate />} />
              </span>
            </>
          )}
        </div>
        {children ?? <div className="dm-acct-plot">{empty}</div>}
      </div>
    </section>
  )
}
