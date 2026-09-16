/**
 * The Top pools provider of the read builds, over the app's one scheduled
 * source, with the same 60 s per-read budget (queued time included) the read
 * screens have. The screens lab builds it here, so the lab's figures cases
 * test the provider the app runs; the same clock times the budget, the leave
 * grace and the quiet re-asks.
 */
import { createReadMarketsProvider, type MarketsProvider } from '../marketsProvider'
import type { Clock } from '../pipeline'
import type { ReadSource } from '../types'
import { withReadBudget } from './screenRead'

export interface AppMarketsOptions {
  source: ReadSource
  poolIds: readonly string[]
  kind: 'fixture' | 'bridge'
  budgetMs?: number
  clock?: Clock
}

export function createAppMarketsProvider({ source, poolIds, kind, budgetMs, clock }: AppMarketsOptions): MarketsProvider {
  return createReadMarketsProvider({ source: withReadBudget(source, { budgetMs, clock }), poolIds, kind, clock })
}
