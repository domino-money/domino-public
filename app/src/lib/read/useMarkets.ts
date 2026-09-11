/**
 * The markets provider as React sees it: one per screen, shared through
 * context, so the ticker and the table render the same rows from one load.
 */
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import { sampleMarkets, type MarketsProvider, type MarketsState } from './marketsProvider'
import type { MarketsResult } from '../markets'

export const MarketsContext = createContext<MarketsProvider>(sampleMarkets)

/** The rows a screen may show in a state: current ones, the ones being refreshed, or the retained stale ones. */
export function shownResult(state: MarketsState): MarketsResult | null {
  if (state.phase === 'ready') return state.result
  if (state.phase === 'loading') return state.previous
  return state.retained?.result ?? null
}

export function useMarkets() {
  const provider = useContext(MarketsContext)
  const state = useSyncExternalStore(provider.subscribe, provider.getSnapshot)
  useEffect(() => {
    provider.ensure()
  }, [provider])
  return { state, provider }
}
