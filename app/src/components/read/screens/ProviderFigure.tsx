import { PROVIDER_LONG, type AttributedFigure } from '../../../lib/read/screens/figures'
import { cx } from '../../ui'

/**
 * Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): a figure with no value is the dash "—"; it used
 * to read "Not reported", "Unavailable" or "Rejected, not shown". Its state stays in `data-provider-figure`.
 */
const VALUE_TEXT = (figure: AttributedFigure) => (figure.state === 'attributed' || figure.state === 'attributed_stale' ? figure.value : '—')

/**
 * Where a figure with a value comes from, in words: the basis only. Changed on purpose 2026-10-15 (pack 7, the owner: no
 * status notices): this used to be provenanceText's long form, "Reported by a market data provider, retrieved
 * <HH:MM:SS UTC, date>. [This observation is stale (<reason>).] Provider-reported, not reconciled with chain data.", and
 * for a figure with no value why there is none ("Retrieved from a market data provider, which reported no value for this
 * figure.", "Nothing usable was retrieved from a market data provider (<reason>).", "What was retrieved from a market
 * data provider failed an identity check (<reason>) and is not shown."): a dash now has no words. provenanceText itself is
 * unchanged, for the other networks' notes (lib/create/otherChains.ts).
 */
const basisText = (figure: AttributedFigure): string | undefined =>
  figure.state === 'attributed' || figure.state === 'attributed_stale' ? `Reported by ${PROVIDER_LONG}. Provider-reported, not reconciled with chain data.` : undefined

/**
 * One provider figure with who reported it, as a word beside it: the
 * provider's name, and for a current figure its cache age. A stale figure
 * reads as the figure, in the same ink; when it was retrieved, that it is
 * stale and why a figure is missing are its title and data, never a caption
 * or a colour. `full` also gives that sentence to assistive technology.
 * With `dash` a missing figure is a dash, with why only in its title and
 * data, as in the markets tables; without it the missing figure says so in
 * words.
 *
 * Changed on purpose 2026-10-06 (rugged97's delta of 6 Oct §4): `note`, what
 * the figure says of itself in place of provenanceText's words, where the
 * provider is named (Base's and Arbitrum One's rows in New position: DEX
 * Screener and when it was read, or why there is no figure,
 * lib/create/otherChains.ts networkFigureNote). Its dash then carries the note
 * as its accessible name too (as FigureDash does), and its closed reason as
 * `data-provider-reason`. Without `note` nothing changes.
 */
export function ProviderFigure({ label, figure, full = false, dash = false, note }: { label: string; figure: AttributedFigure; full?: boolean; dash?: boolean; note?: string }) {
  const valued = figure.state === 'attributed' || figure.state === 'attributed_stale'
  const said = note ?? basisText(figure)
  const reason = note !== undefined && (figure.state === 'unavailable' || figure.state === 'rejected') ? figure.reason : undefined
  return (
    <div className="grid min-w-0 gap-0.5" data-provider-figure={figure.state} data-provider={figure.provider} data-provider-reason={reason} title={said}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-[0.8125rem] leading-[1.125rem] text-fg-muted">{label}</span>
        <span className={cx('tnum text-[0.8125rem] leading-[1.125rem]', valued ? 'font-medium text-fg' : 'text-fg-subtle')} aria-label={note !== undefined && dash && !valued ? note : undefined}>
          {valued || !dash ? VALUE_TEXT(figure) : '—'}
        </span>
      </div>
      {full && said && <p className="sr-only">{said}</p>}
    </div>
  )
}
