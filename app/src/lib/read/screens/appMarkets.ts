/**
 * The Top pools provider of the read builds, over the app's one scheduled
 * source, with the same 60 s per-read budget (queued time included) the read
 * screens have. buildMode.ts and the screens lab both build it here, so the
 * lab's figures cases test exactly what the app runs.
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
  return createReadMarketsProvider({ source: withReadBudget(source, { budgetMs, clock }), poolIds, kind })
}
