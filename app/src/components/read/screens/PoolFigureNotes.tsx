import { presentMetric, turnover, type Market } from '../../../lib/markets'
import { COPY, screenReason } from '../../../lib/read/screens/copy'
import { figureNoteId, presentedNoteCode, utcTime } from '../../../lib/read/screens/figures'
import { TokenLabel } from '../TokenLabel'

const KIND_WORD = { unavailable: 'Unavailable', absent: 'Not reported', not_current: 'Not current' } as const

/**
 * The notes under the Top pools table in the read builds: where each row's
 * provider figures came from and when they were retrieved (payload times,
 * UTC), and every reason a cell shows no number, as visible text the cell
 * points at with aria-describedby. No figure value is repeated here.
 */
export function PoolFigureNotes({ markets }: { markets: Market[] }) {
  const reasons = new Map<string, string>()
  for (const m of markets) {
    // The read contract reports TVL, 24 h volume and pool APR; there is no
    // 30-day volume in it, so no note can be owed for one.
    const shown = [m.tvlUsd, m.volume24hUsd, m.feeAprPercent].map((metric) => presentMetric(metric))
    shown.push(turnover(m))
    for (const figure of shown) {
      const code = presentedNoteCode(figure)
      if (code && figure.kind !== 'value') reasons.set(code, `${KIND_WORD[figure.kind]}: ${screenReason(code)}.`)
    }
  }
  const provided = markets.filter((m) => [m.tvlUsd, m.volume24hUsd].some((metric) => metric.source === 'GeckoTerminal' && metric.asOf !== undefined))
  if (reasons.size === 0 && provided.length === 0) return null
  return (
    <section aria-labelledby="pool-figure-notes-title" className="border-t px-5 py-3 text-[12px] leading-relaxed text-fg-subtle" data-pool-figure-notes="">
      <h3 id="pool-figure-notes-title" className="font-medium text-fg-muted">
        {COPY.figures.legend}
      </h3>
      <ul className="mt-1 grid gap-0.5">
        {provided.map((m) => {
          const retrieved = m.tvlUsd.asOf ?? m.volume24hUsd.asOf ?? 0
          const age = m.provenance?.market.cacheAgeSeconds
          return (
            <li key={m.key} data-provider-note="">
              <TokenLabel token={m.tokens.base} />/<TokenLabel token={m.tokens.quote} />: GeckoTerminal figures retrieved {utcTime(retrieved)}
              {age === null || age === undefined ? '' : `, cache ${age} s`}. {COPY.figures.providerDetail}
            </li>
          )
        })}
        {[...reasons].map(([code, text]) => (
          <li key={code} id={figureNoteId(code)} data-figure-note={code}>
            {text}
          </li>
        ))}
      </ul>
    </section>
  )
}
