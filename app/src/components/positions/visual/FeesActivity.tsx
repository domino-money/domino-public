import { useState } from 'react'
import type { ReactNode } from 'react'
import { IconTile } from '../../figures'
import { IconClose, IconMinus, IconPlus } from '../../icons'
import { Button } from '../../ui'
import { shortDate, shortTime } from '../../../lib/format/time'
import type { StateCurrency } from '../../../lib/fees/types'
import type { AutoAdd } from '../../../lib/automationImpact'
import { activityRows, ROW_VERB, type RowKind } from './activityRows'
import { AutoGlyph } from './AutomationImpact'
import type { FeesEvent } from './model'
import { amountTexts, anyPositive, positive, valueFigure } from './value'

/** A Tangerine pip for a collect (the one motif borrowed from the tile), the chart's own mark for the automation's re-add, glyphs for the others. */
function Glyph({ kind }: { kind: RowKind }) {
  if (kind === 'auto')
    return (
      <span aria-hidden="true" className="dm-fees-act-pip" data-auto="">
        <AutoGlyph />
      </span>
    )
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
 * What happened to the position, newest first (DESIGN-V2 §13.2), in plain words (visual/activityRows.ts): each
 * settlement with its date, the fees it settled and their value at the pool's price now. The transaction is in data-tx
 * only (2026-09-27, the owner's rule: no raw hash on the main screen). Five rows, then Show {n} more. `bare` leaves out
 * the heading, for a card that has its own (the position's page, 2026-09-27). `automatic` (2026-09-27): the
 * automation's re-adds into the position, from its vault's own record (lib/automationImpact.ts), and the automation's
 * name. Each is one "Fees added back" row with the chart's own mark, and its figure is what it put back, as the card's
 * line and the chart's tooltip say it. Nothing else is ever called the automation's. Changed on purpose 2026-10-02
 * (RPC-SPEC §11.4): a settlement whose fees the ledger cannot tell apart (an owner's add or withdrawal) keeps its row,
 * with no figure.
 */
export function FeesActivity({ events, bare = false, automatic }: { events: ReadonlyArray<FeesEvent>; bare?: boolean; automatic?: { adds: readonly Pick<AutoAdd, 'tx' | 'value'>[]; by: string } }) {
  const [shown, setShown] = useState(STEP)
  const added = new Map(automatic?.adds.map((add) => [add.tx, add.value]))
  const all = activityRows(events, added)
  // Show more never cuts a pair in half (r5/charts' review): a row of the same transaction as the last one shown comes with it.
  let cut = Math.min(shown, all.length)
  while (cut > 0 && cut < all.length && all[cut].event.tx === all[cut - 1].event.tx && all[cut].event.id === all[cut - 1].event.id) cut++
  const rows = all.slice(0, cut)
  const more = all.length - rows.length
  if (all.length === 0) return null
  return (
    <div className={bare ? 'dm-fees-act-bare' : 'dm-fees-activity'}>
      {!bare && <h3 className="dm-subtitle">Activity</h3>}
      <ol className="dm-fees-act-list">
        {rows.map(({ event, kind, inFees }, index) => {
          const { currencies } = event
          const auto = kind === 'auto'
          // The figure: what the automation put back, or the fees the step settled (none, or not known: no column).
          const figure = auto ? (added.get(event.tx) ?? null) : event.known && anyPositive(event.fees) ? event.value : null
          // The second event of one transaction (a collect and an increase in one call) hangs under the first, without its date.
          const sameTx = index > 0 && rows[index - 1].event.tx === event.tx && rows[index - 1].event.id === event.id
          return (
            <li
              key={`${event.id}:${event.tx}:${kind}:${index}`}
              className="dm-fees-act"
              data-kind={kind}
              data-settled={figure !== null ? '' : undefined}
              data-same-tx={sameTx ? '' : undefined}
              data-auto={auto ? '' : undefined}
              data-tx={event.tx}
            >
              <span className="dm-fees-act-verb" title={auto ? `${automatic?.by} added these fees back into your position` : undefined}>
                <Glyph kind={kind} />
                <span>{ROW_VERB[kind]}</span>
              </span>
              <span className="dm-fees-act-when">
                <time className="dm-fees-act-date" dateTime={new Date(event.timestamp * 1000).toISOString()}>
                  {shortDate(event.timestamp)} {shortTime(event.timestamp)}
                </time>
              </span>
              {/* What it settled, value first (USD or the quote token), then the tokens on one quiet line; a re-add, what it put back and by whom. An opening settles nothing: no column. */}
              {figure !== null && (
                <span className="dm-fees-act-amounts">
                  <span className="dm-fig-xs dm-fees-act-value" title={`Pool price at block ${event.basis.block}`}>
                    {valueFigure(event.basis, figure)}
                    {event.basis.kind === 'quote' && <span className="dm-fees-sym"> {symbolOf(currencies[event.basis.into])}</span>}
                    {/* Only a collect and a re-add are all fees by their names: elsewhere the figure is the fees the step took along. */}
                    {inFees && <span className="dm-fees-sym"> in fees</span>}
                  </span>
                  {/* A re-add names who made it (the verb's title cannot be read by a finger). */}
                  {auto && <span className="dm-fees-act-tokens">by {automatic?.by}</span>}
                  {!auto && (
                    <span className="dm-fees-act-tokens">
                      {([0, 1] as const).map((i) =>
                        positive(event.fees[i]) ? (
                          <span key={i}>
                            <TokenFigure raw={event.fees[i]} currency={currencies[i]} /> {symbolOf(currencies[i])}
                          </span>
                        ) : null,
                      )}
                    </span>
                  )}
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
