import type { AutomationImpact as Impact } from '../../../lib/automationImpact'
import { positive, valueFigure, type Basis } from './value'

/** The automation's own name, as the header's chip says it (lib/automate/features.ts). */
export const AUTOMATION_NAME = { compound: 'Auto-compound', domino: 'Domino-compound' } as const

/** `1 time`, `3 times`. */
const times = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** A growth share as the card writes shares (two decimals), never a bare 0.00 %. */
const growthText = (share: number) => (share >= 0.0001 ? `${(share * 100).toFixed(2)}%` : 'under 0.01%')

/** The chart's mark for a re-add, small, beside the words that name it (decoration: the words say it all). */
export function AutoGlyph() {
  return (
    <svg className="dm-fees-auto-glyph" width="1rem" height="1rem" viewBox="-8 -8 16 16" aria-hidden="true" focusable="false">
      <circle r={6.5} className="dm-fees-auto-dot" />
      <path d="M-2.75 0H2.75M0 -2.75V2.75" className="dm-fees-auto-plus" />
    </svg>
  )
}

/**
 * What Domino's automation did for this position, in the Fees earned card (the owner, 2026-09-27: "essa informação do
 * Auto Compound é totalmente interessante e importante", and "não quero que fique feio e tão poluído"): at most two
 * short lines, in plain words, beside the chart's marks of the same colour. Nothing at all for a position no
 * automation acted on. Every figure is at the pool's price now, as the card's others are.
 */
export function AutomationImpact({ impact, basis, symbol }: { impact: Impact; basis: Pick<Basis, 'kind'>; symbol?: string | null }) {
  const name = AUTOMATION_NAME[impact.kind]
  const money = (units: bigint) => `${valueFigure(basis, units)}${basis.kind === 'quote' && symbol ? ` ${symbol}` : ''}`
  return (
    <div className="dm-fees-impact" data-automation-impact={impact.kind}>
      <AutoGlyph />
      <p className="dm-fees-impact-lines">
        {impact.adds.length > 0 && (
          <span className="dm-fees-impact-line" data-impact="added">
            {name} added <strong className="dm-fees-impact-fig">{money(impact.added)}</strong> back · {times(impact.adds.length, 'time', 'times')}
          </span>
        )}
        {impact.growth !== null && (
          <span className="dm-fees-impact-line" data-impact="growth">
            Your position grew <strong className="dm-fees-impact-fig">{growthText(impact.growth)}</strong> from fees
          </span>
        )}
        {impact.opened > 0 && (
          <span className="dm-fees-impact-line" data-impact="opened">
            {name} opened <strong className="dm-fees-impact-fig">{times(impact.opened, 'new position', 'new positions')}</strong>
            {positive(impact.moved) ? (
              <>
                {' '}
                with <strong className="dm-fees-impact-fig">{money(impact.moved)}</strong> of fees
              </>
            ) : null}
          </span>
        )}
      </p>
    </div>
  )
}
