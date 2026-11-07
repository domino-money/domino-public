/**
 * The pure half of ./positionFees.ts (added 2026-11-06, the owner: nothing pending on our side): what the page draws from
 * a position's stored fee history (read-v6 `position-fees`), with no read and no React, so tests/v2/position-stored-
 * fees.test.mjs runs it as it is.
 *   - the automation's lines (Robinhood Chain's AutomationImpact, read there from the vault's own record): the stored
 *     settlements an automatic compound made (`auto`, its `serviceFee`) stand in for that record, for a position whose
 *     vault the portfolio lists as Auto-compound or Domino-compound;
 *   - the settlements as Activity's rows (outside changes included), and the automatic ones named;
 *   - the Details' Fees history line, and whether the NFT is burned.
 */
import type { PortfolioResponse, PositionFees } from 'api-contracts/read-v6/types'
import { feesEvents, type FeesEvent } from '../../components/positions/visual/model'
import { basisOf, principalAt, valueUnits, type Basis, type QualifiedUsd } from '../../components/positions/visual/value'
import type { FeeTokenOf } from '../../lib/fees/positionFees'
import type { FeeEvent, FeeHistoryView, PositionState } from '../../lib/fees/types'
import { quoteIndex } from '../../lib/read/orientation'
import { protectionStanding } from '../autoexit/standing'
import type { Address } from '../../v2/types'
import type { LiveV6Position } from './model'
import { decimalsOf, labelOf, type TokenBook } from './tokens'

/** A token of the page's book as a fees view names it. */
export const feeTokenOf = (book: TokenBook): FeeTokenOf => (address) => ({ symbol: labelOf(book, address as Address), decimals: decimalsOf(book, address as Address) })

/** The automation's re-adds as Activity takes them (components/positions/PositionActivity.tsx AutomaticAdds). */
export interface StoredAutomaticAdds {
  adds: readonly { tx: string; value: bigint }[]
  by: string
}

/**
 * (2026-11-06, O-14) The block at which the stored history says this NFT no longer exists (`burned`), or null: not
 * burned, not known, or the route not open. The block its follower read it through, else its own burn's.
 */
export function burnedAt(position: PositionFees | null): number | null {
  if (position?.status !== 'burned') return null
  const burn = [...position.transfers].reverse().find((transfer) => /^0x0{40}$/i.test(transfer.toAddress))
  return position.through?.number ?? burn?.block.number ?? null
}

const WHOLE_DOLLAR = '1.000000000000000000'

/**
 * The side a position's fees are valued in where neither token is USDG: read-v6's qualified price (the chain's stable at
 * 1, ETH at Chainlink's, another token at its qualified pool), the stable's side first, then the app's quote side. Null
 * when neither has one: the quote token's own figures, as Robinhood Chain writes a pair without USDG.
 */
export function qualifiedUsdOf(currencies: readonly [string, string], book: TokenBook): QualifiedUsd | null {
  const usd = (index: 0 | 1) => book.get(currencies[index].toLowerCase() as Address)?.usd ?? null
  const quote = quoteIndex(currencies[0], currencies[1])
  const order: readonly (0 | 1)[] = usd(0) === WHOLE_DOLLAR ? [0] : usd(1) === WHOLE_DOLLAR ? [1] : [quote, quote === 0 ? 1 : 0]
  for (const into of order) {
    const price = usd(into)
    if (price) return { into, usd: price }
  }
  return null
}

/** The automations that compound a position (lib/automationImpact.ts AutomationKind). */
export type CompoundingKind = 'compound' | 'domino'

/**
 * What compounds this position now, as read-v6's portfolio lists its vault (Robinhood Chain reads the same from its chip's
 * own read: Auto-compound or Domino-compound): null for no vault, a vault not read, or Auto-exit's own.
 */
export function compoundingKind(answer: Pick<PortfolioResponse, 'vaults' | 'mandates'>, position: Pick<LiveV6Position, 'chainId' | 'vault'>): CompoundingKind | null {
  const link = position.vault
  if (!link) return null
  const vault = answer.vaults.find((one) => one.chainId === position.chainId && one.address.toLowerCase() === link.address.toLowerCase())
  if (!vault || vault.state.status !== 'read' || protectionStanding(vault, answer.mandates ?? []) !== null) return null
  return vault.state.policy.mode === 'domino' ? 'domino' : 'compound'
}

/** The vault's record (lib/automationImpact.ts VaultRecord) as the stored settlements tell it: each automatic compound, a re-add into this position. */
export interface StoredRecord {
  executions: readonly { tx: string; block: number; action: number; destination: string }[]
  paid: null
}

/** contracts/src/DominoExecutionTypes.sol's GENERAL (lib/automationImpact.ts ACTION): a re-add into the parent. */
const GENERAL = 0

export function storedRecord(events: readonly FeeEvent[], tokenId: string): StoredRecord {
  const seen = new Set<string>()
  const executions: StoredRecord['executions'][number][] = []
  for (const event of events) {
    const tx = event.tx.toLowerCase()
    if (!event.auto || tx === '' || seen.has(tx)) continue
    seen.add(tx)
    executions.push({ tx, block: event.block, action: GENERAL, destination: tokenId })
  }
  // `paid: null`: a fee the answer does not carry is the policy's rate, written with "≈", as for a native currency there.
  return { executions, paid: null }
}

/** The basis the stored history is valued in on the page: read-v6's qualified USD where it has one (./RecordedInsights.tsx draws the card in it). */
export const storedBasis = (state: PositionState, book: TokenBook): Basis | null => basisOf(state, undefined, qualifiedUsdOf([state.currencies[0].address, state.currencies[1].address], book))

/** The settlements as the position's Activity lists them (components/positions/PositionActivity.tsx), newest first; empty without a history. */
export function storedFeesEvents(id: string, view: FeeHistoryView | null, book: TokenBook): FeesEvent[] {
  if (view?.phase !== 'verified' && view?.phase !== 'unclaimed-only') return []
  const list = view.phase === 'verified' ? view.history.events : view.events ?? []
  const basis = storedBasis(view.state, book)
  return basis ? feesEvents(id, list, basis, view.state.currencies) : []
}

/**
 * The automation's re-adds for Activity (components/positions/PositionActivity.tsx useAutomaticAdds), with lib/
 * automationImpact.ts's own arithmetic: each automatic increase, what the liquidity it added is worth now. Undefined when
 * nothing compounds the position or nothing was added back.
 */
export function storedAutomaticAdds(view: FeeHistoryView | null, kind: CompoundingKind | null, book: TokenBook, name: Readonly<Record<CompoundingKind, string>>): StoredAutomaticAdds | undefined {
  if (!kind || view?.phase !== 'verified') return undefined
  const basis = storedBasis(view.state, book)
  if (!basis) return undefined
  const { state } = view
  const adds = view.history.events
    .filter((event) => event.auto === true && event.tx !== '' && event.liquidityDelta > 0n)
    .map((event) => ({ tx: event.tx, value: valueUnits(basis, principalAt(event.liquidityDelta, state.sqrtPriceX96, state.tick, state.tickLower, state.tickUpper)) }))
  return adds.length > 0 ? { adds, by: name[kind] } : undefined
}

/**
 * The Details' Fees history line (screens/PositionDetail.tsx HistorySource): a stored history that measures every
 * settlement; else a dash, as Robinhood Chain's says it. Its points are the follower's, an hour apart.
 */
export function storedHistoryWords(view: FeeHistoryView): string {
  return view.phase === 'verified'
    ? `Every settlement of this position from its own events, through block ${view.history.through}, and the fees ready to collect at block ${view.state.block}. Measured at each compound or collect and once an hour; the line between points is a guide, not a measurement.`
    : '—'
}
