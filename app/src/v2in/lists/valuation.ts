import { currentUsd, USD_CURRENT_SECONDS, type PoolUsdValue, type UsdInputs } from '../usd'

/**
 * The last complete valuation of each position this page has shown, and the one place a row or a page asks for its
 * dollars (the list's rows, Robinhood Chain's own position page and the V2 page alike).
 *
 * Changed on purpose 2026-10-14 (the incident of 2026-10-13, package V1; the owner's decision D4: "the last complete
 * figure with 'as of HH:MM' in place of 'USD unavailable'"). Until then a valuation was kept 90 s, only across a failed
 * price read, only while every amount was unchanged, and never for a row with its own state reading; a late or refused
 * read, a stale chain or a hold after an action each wrote "USD unavailable". Now:
 *   - a current valuation (../usd.ts currentUsd) is the answer, and a complete one (value and fees both) is kept, with
 *     the time it is as of;
 *   - when no current complete one can be worked out, the kept one is the answer, marked `saved`, to be shown with that
 *     time; its time is never renewed by a retry;
 *   - a kept valuation is of one size of position: it is never the answer for another liquidity (a withdrawal, an add,
 *     a compound), so a figure from before the person's own action is shown only while the reading on screen still is;
 *   - a price the source disqualified (not one it failed to read for the moment) clears it;
 *   - nothing is kept past POSITION_USD_MEMORY_MS, nor for more than MAX_KEPT positions. Memory only: a reload starts
 *     with none.
 *
 * Changed on purpose 2026-10-14 (package V1, the review of the first pass). Three rules were wrong or missing:
 *   - "a price the source disqualified" looked at every currency without a price, also the one that never had one. In
 *     an estimate at the pool's price (ETH / IMD) that side always carries a standing reason, so the kept valuation was
 *     thrown away the moment ETH's own price could not be read: the incident's own condition. An entry now remembers
 *     the currencies whose price it was worked out with (`used`), and only one of those, now without a price for a
 *     reason that is a judgement of the source, clears it;
 *   - the kept valuation was returned whole although one of its two figures could be worked out from what is read now
 *     (after Collect fees with the prices unreadable: "$1.50 as of 13:05" over fees of 0 and 0). The figure that can be
 *     worked out now is the answer for itself (`now`), with its own time; only the missing one is the kept one;
 *   - a kept estimate lost what it is an estimate of. An entry keeps the block of its reading and whether its priced
 *     currency stood at the chain's own dollar, so its basis line can still be said, beside its time.
 */

/** How long a kept valuation may still be shown with its time: a day, as this browser's own copy of the positions list (lib/browserCopies.ts). */
export const POSITION_USD_MEMORY_MS = 86_400_000
/** The position collection's own bound (./positionSync.ts MAX_POSITIONS). */
const MAX_KEPT = 512
/** A price its source could not read for the moment: the last valuation stays. Any other reason read-v6 gives is a disqualification. */
const PASSING = new Set(['price_read_failed', 'pricing_limit_reached', 'eth_usd_stale', 'sequencer_down'])

export interface PositionUsdAsk extends UsdInputs {
  /** The NFT: chain, position manager and id (./positionSync.ts positionKey). */
  key: string
  /** Raw liquidity of the reading; null when not read. */
  liquidity: string | bigint | null
  /** After the person's own action, until a reading at or past its block: nothing new is worked out. */
  held?: boolean
  /** read-v6's reason for each currency it gives no price (pool order); null or absent: it said nothing. */
  missing?: readonly (string | null | undefined)[]
  /** The block of the reading, for the basis line of an estimate (kept with it); null or absent: not said. */
  block?: number | null
  /** The prices are the chain's own dollar, not read-v6's (../usd.ts chainDollar): said so in an estimate's basis line. */
  dollar?: boolean
}

export interface PositionUsd {
  /** Decimal strings at 18 places; null: no figure (never a zero). */
  value: string | null
  fees: string | null
  valueBasis?: PoolUsdValue['basis']
  feesBasis?: PoolUsdValue['basis']
  /** The priced currency of a pool-price estimate, when either figure is one. */
  anchor?: 0 | 1
  /** Of that estimate: the block of the reading it was worked out from (a kept one's own), when known. */
  block?: number
  /** Of that estimate: its priced currency stood at the chain's own dollar. */
  dollar?: true
  /** What the figures are as of (Unix ms): the older of their amounts and their prices; null with no figure. */
  at: number | null
  /** The last complete valuation, not one of what is read now: shown with its time. */
  saved: boolean
  /**
   * With `saved`: this one of the two figures is of what is read now all the same (a measured zero needs no price),
   * as of `at` here (Unix ms). Only the other figure is the kept one, as of the answer's own `at`.
   */
  now?: { figure: 'value' | 'fees'; at: number }
  /** Why there is no current complete valuation (a data attribute; ../position/usdAvailability.ts has the words). */
  reason?: string
}

interface Kept {
  value: string
  fees: string
  valueBasis: PoolUsdValue['basis']
  feesBasis: PoolUsdValue['basis']
  anchor?: 0 | 1
  block?: number
  dollar?: true
  at: number
  size: string
  until: number
  /** The currencies whose price this valuation was worked out with (pool order): one held above zero, or an estimate's priced one. */
  used: readonly [boolean, boolean]
}

const anchorOf = (...marks: readonly (PoolUsdValue | null)[]): 0 | 1 | undefined => marks.flatMap((mark) => (mark?.basis === 'pool-price' ? [mark.anchor] : []))[0]
/** What an estimate's basis line needs, for an answer or an entry; nothing for figures at qualified prices alone. */
const estimateOf = (anchor: 0 | 1 | undefined, ask: { block?: number | null; dollar?: boolean }): Pick<PositionUsd, 'anchor' | 'block' | 'dollar'> =>
  anchor === undefined ? {} : { anchor, ...(typeof ask.block === 'number' ? { block: ask.block } : {}), ...(ask.dollar ? { dollar: true as const } : {}) }

/**
 * Added 2026-10-14 (package V1, review): whether something this page took at `seen` (its own clock, ms: a reading, a
 * portfolio answer) is older than a figure is current for (../usd.ts USD_CURRENT_SECONDS). Then nothing newer has
 * arrived for two minutes, and a figure worked out from it says its time. Never a comparison of this page's clock with
 * a server's: only how long ago, here, it arrived. Null or undefined: nothing of now to date.
 */
export const usdAged = (seen: number | null | undefined, now: number): boolean => typeof seen === 'number' && now - seen > USD_CURRENT_SECONDS * 1000

export function createPositionValuations(now: () => number = () => Date.now()) {
  const kept = new Map<string, Kept>()
  function value(ask: PositionUsdAsk): PositionUsd {
    const time = now()
    const current = ask.held ? null : currentUsd(ask)
    if (current?.value && current.fees) {
      const anchor = anchorOf(current.value, current.fees)
      const answer = { value: current.value.value, fees: current.fees.value, valueBasis: current.value.basis, feesBasis: current.fees.basis, ...estimateOf(anchor, ask), at: current.at * 1000 }
      const priced = (index: 0 | 1) => !!ask.prices[index] && (anchor === index || (ask.principal?.[index] ?? 0n) > 0n || (ask.fees?.[index] ?? 0n) > 0n)
      kept.delete(ask.key)
      kept.set(ask.key, { ...answer, size: String(ask.liquidity), until: time + POSITION_USD_MEMORY_MS, used: [priced(0), priced(1)] })
      while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!)
      return { ...answer, saved: false }
    }
    const unpriced = ask.prices.flatMap((price, index) => (price ? [] : [ask.missing?.[index] ?? 'token_price_unavailable']))
    const reason = ask.held ? 'awaiting_receipt_block' : current === null ? 'stale_position_or_chain' : [...new Set(unpriced)].join(',') || 'amount_unavailable'
    const entry = kept.get(ask.key)
    if (entry) {
      // Explicit disqualification supersedes an earlier price; a source that could not answer for the moment does not.
      // Only of a currency this valuation was worked out with: the side a pool-price estimate marks never had a price,
      // and its standing reason (pool_depth_below_floor, no_qualified_price_source) says nothing new of the estimate.
      const disqualified = current !== null && entry.used.some((used, index) => {
        const said = ask.missing?.[index]
        return used && !ask.prices[index] && !!said && !PASSING.has(said)
      })
      if (disqualified || entry.until <= time) kept.delete(ask.key)
      else if (ask.liquidity !== null && String(ask.liquidity) === entry.size) {
        const whole: PositionUsd = { value: entry.value, fees: entry.fees, valueBasis: entry.valueBasis, feesBasis: entry.feesBasis, ...estimateOf(entry.anchor, entry), at: entry.at, saved: true, reason }
        // One of the two figures can be worked out from what is read now (never both: that is a current valuation, above).
        const mark = current?.value ?? current?.fees ?? null
        if (!current || !mark) return whole
        const figure = current.value ? 'value' as const : 'fees' as const
        const keptBasis = figure === 'value' ? entry.feesBasis : entry.valueBasis
        // One line says the basis of a position's estimate: two estimates of two readings are never mixed.
        if (mark.basis === 'pool-price' && keptBasis === 'pool-price') return whole
        const estimate = mark.basis === 'pool-price' ? estimateOf(mark.anchor, ask) : keptBasis === 'pool-price' ? estimateOf(entry.anchor, entry) : {}
        return {
          value: figure === 'value' ? mark.value : entry.value,
          fees: figure === 'fees' ? mark.value : entry.fees,
          valueBasis: figure === 'value' ? mark.basis : entry.valueBasis,
          feesBasis: figure === 'fees' ? mark.basis : entry.feesBasis,
          ...estimate,
          at: entry.at,
          saved: true,
          now: { figure, at: current.at * 1000 },
          reason,
        }
      }
    }
    const anchor = anchorOf(current?.value ?? null, current?.fees ?? null)
    return {
      value: current?.value?.value ?? null,
      fees: current?.fees?.value ?? null,
      ...(current?.value ? { valueBasis: current.value.basis } : {}),
      ...(current?.fees ? { feesBasis: current.fees.basis } : {}),
      ...estimateOf(anchor, ask),
      at: current && (current.value || current.fees) ? current.at * 1000 : null,
      saved: false,
      reason,
    }
  }
  return { value }
}

export type PositionValuations = ReturnType<typeof createPositionValuations>
export const POSITION_VALUATIONS = createPositionValuations()
