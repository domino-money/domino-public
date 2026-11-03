import { priceInputToTick, type PriceInputResult } from '../read/screens/RangePriceInput'
import type { PoolPrice, PracticeRange } from '../read/screens/poolRange'
import { figureProblemText, readFigure, type Decimal } from './typedFigure'

/**
 * Added 2026-11-02 (review of the money PRs, M4): a price typed for a position's range, to a tick. Read first by the rule
 * every figure for a transaction is read by (./typedFigure.ts: a page-style "1,747.65" loses its separators, a decimal
 * comma is read where the person's language writes one, and an ambiguous "1,250" is refused saying both readings), then
 * by priceInputToTick. New position's range steps (components/create/RangeStep.tsx, v2in/journey/RangeStage.tsx)
 * stripped the separators of any one-group figure themselves, so a "1,250" typed for 1.25 set the range at 1250. The
 * pool page's range controls, which create nothing, keep priceInputToTick's own rule (no comma at all).
 * `decimal`: the person's language's separator, handed in by a test.
 */
export function typedPriceToTick(text: string, which: 'lower' | 'upper', range: PracticeRange, price: Extract<PoolPrice, { state: 'usable' }>, decimal?: Decimal): PriceInputResult {
  const read = readFigure(text, decimal)
  if (read.ok) return priceInputToTick(read.text, which, range, price)
  return { ok: false, message: figureProblemText(read) ?? 'Price must be greater than zero.' }
}
