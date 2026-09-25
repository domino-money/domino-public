import { useState } from 'react'
import type { ReactNode } from 'react'
import { IconTile } from '../../figures'
import { IconClose, IconMinus, IconPlus } from '../../icons'
import { Button } from '../../ui'
import { shortDate, shortTime } from '../../../lib/format/time'
import type { StateCurrency } from '../../../lib/fees/types'
import type { FeesEvent, FeesView } from './model'
import { amountTexts, anyPositive, positive, valueFigure } from './value'

/** The verbs of the activity rows (DESIGN-V2 §0.2). */
const VERB: Readonly<Record<FeesEvent['kind'], string>> = { mint: 'Minted', collect: 'Collected', increase: 'Increased', decrease: 'Decreased', close: 'Closed' }

/** A Tangerine pip for a collect (the one motif borrowed from the tile), glyphs for the others. */
function Glyph({ kind }: { kind: FeesEvent['kind'] }) {
  if (kind === 'collect') return <span aria-hidden="true" className="dm-fees-act-pip" />
  const icon: ReactNode = kind === 'mint' || kind === 'increase' ? <IconPlus /> : kind === 'decrease' ? <IconMinus /> : <IconClose />
  return <IconTile icon={icon} size={20} />
}

const STEP = 5

/** A token amount as the value band writes it (six significant digits), every digit in its title. */
export function TokenFigure({ raw, currency }: { raw: bigint; currency: StateCurrency }) {
  const texts = amountTexts(raw, currency)
  if (!texts) return null
  return <span title={texts.text === texts.full ? undefined : texts.full}>{texts.text}</span>
}

/** A symbol from /state, as text (untrusted); the short address when unreadable. */
const symbolOf = (currency: { address: string; symbol: string | null }) => currency.symbol ?? `${currency.address.slice(0, 6)}…${currency.address.slice(-4)}`

/**
 * What happened to the position's fees, newest first (DESIGN-V2 §13.2): each
 * settlement with its date, its transaction (text only, no explorer link),
 * the fees it settled and their value at the pool's price now. Five rows, then
 * Show {n} more. `ids` marks each row with its NFT on the list's aggregate.
 */
export function FeesActivity({ view, ids = false }: { view: FeesView; ids?: boolean }) {
  const [shown, setShown] = useState(STEP)
  const rows = view.events.slice(0, shown)
  const more = view.events.length - rows.length
  if (view.events.length === 0) return null
  return (
    <div className="dm-fees-activity">
      <h3 className="dm-subtitle">Activity</h3>
      <ol className="dm-fees-act-list">
        {rows.map((event, index) => {
          const { currencies } = event.source.state
          const settled = anyPositive(event.fees)
          // The second event of one transaction (a collect and an increase in one call) hangs under the first, without its date.
          const sameTx = index > 0 && rows[index - 1].tx === event.tx && rows[index - 1].id === event.id
          return (
            <li
              key={`${event.id}:${event.tx}:${event.kind}:${index}`}
              className="dm-fees-act"
              data-kind={event.kind}
              data-settled={settled ? '' : undefined}
              data-same-tx={sameTx ? '' : undefined}
            >
              <span className="dm-fees-act-verb">
                <Glyph kind={event.kind} />
                <span>{VERB[event.kind]}</span>
                {ids && (
                  <span className="dm-fees-act-id dm-mono" translate="no">
                    #{event.id}
                  </span>
                )}
              </span>
              <span className="dm-fees-act-when">
                <span className="dm-fees-act-date">
                  {shortDate(event.timestamp)} {shortTime(event.timestamp)}
                </span>
                <span className="dm-hex" title={event.tx} translate="no">
                  {event.tx}
                </span>
              </span>
              {/* What it settled, value first (USD or the quote token), then the tokens on one quiet line. A mint or an increase settles nothing: no column. */}
              {settled && (
                <span className="dm-fees-act-amounts">
                  <span className="dm-fig-xs dm-fees-act-value" title={`Pool price at block ${event.basis.block}`}>
                    {valueFigure(event.basis, event.value)}
                    {event.basis.kind === 'quote' && <span className="dm-fees-sym"> {symbolOf(currencies[event.basis.into])}</span>}
                  </span>
                  <span className="dm-fees-act-tokens">
                    {([0, 1] as const).map((i) =>
                      positive(event.fees[i]) ? (
                        <span key={i}>
                          <TokenFigure raw={event.fees[i]} currency={currencies[i]} /> {symbolOf(currencies[i])}
                        </span>
                      ) : null,
                    )}
                  </span>
                </span>
              )}
            </li>
          )
        })}
      </ol>
      {more > 0 && (
        <div className="dm-fees-more">
          <Button type="button" variant="ghost" size="sm" onClick={() => setShown((n) => n + Math.max(STEP, more))}>
            Show {more} more
          </Button>
        </div>
      )}
    </div>
  )
}
