import type { CSSProperties } from 'react'
import { BrandMark } from '../BrandMark'
import { Display, Stat } from '../ui'

/**
 * The Domino token's place. A token will exist; nothing about it is set, so
 * nothing about it is written here: no ticker, supply, price, chain,
 * distribution or date. The three cells are deliberately empty and carry no
 * figure attribute, so a count of a page's figures never counts them. The mark
 * sits on the card surface alone, upright, with nothing behind it and no light
 * around it; it only drifts. Reads nothing.
 *
 * `wide` is Home's banner row; `compact` fits a 340px rail (Positions).
 */

const FLOAT = { '--dur': '14s', '--dx': '5px', '--dy': '-9px' } as CSSProperties

const UNSET = ['Ticker', 'Supply', 'Launch'] as const

const TITLE = 'The Domino token is coming.'
const BODY = 'Ticker, supply and launch date are not announced.'

export function DominoTokenCard({ variant = 'wide' }: { variant?: 'wide' | 'compact' }) {
  if (variant === 'compact') {
    return (
      <div className="dm-card p-5" data-domino-token="">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Display as="h2" className="dm-display-rail">
              {TITLE}
            </Display>
            <p className="mt-1.5 text-[13px] leading-[18px] text-fg-muted">{BODY}</p>
          </div>
          <div className="dm-float mr-1 mt-1 shrink-0" style={FLOAT}>
            <BrandMark width={18} height={31} />
          </div>
        </div>
        <dl className="mt-5 grid grid-cols-3 gap-3">
          {UNSET.map((label) => (
            <Stat key={label} label={label}>
              <span className="text-fg-subtle">—</span>
            </Stat>
          ))}
        </dl>
      </div>
    )
  }
  return (
    <div className="dm-card px-5 py-5 sm:px-6" data-domino-token="">
      <div className="grid items-center gap-x-10 gap-y-5 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 items-center gap-5">
          <div className="dm-float shrink-0" style={FLOAT}>
            <BrandMark width={24} height={41} />
          </div>
          <div className="min-w-0">
            <Display as="h2" className="dm-display-rail">
              {TITLE}
            </Display>
            <p className="mt-1 text-[13px] leading-[18px] text-fg-muted">{BODY}</p>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-x-4 lg:min-w-[440px] lg:gap-x-0 lg:[&>*]:px-6 lg:[&>*+*]:border-l lg:[&>*+*]:border-line">
          {UNSET.map((label) => (
            <Stat key={label} label={label} sub="Not announced">
              <span className="text-fg-subtle">—</span>
            </Stat>
          ))}
        </dl>
      </div>
    </div>
  )
}

/** The old name, kept for callers that still use it. */
export const DominoToken = () => <DominoTokenCard variant="wide" />
