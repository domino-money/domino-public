/**
 * The markets provider as React sees it: one per app, shared through
 * context, so the ticker and the table render one result set from one load.
 */
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import type { MarketsProvider, MarketsState } from './marketsProvider'
import type { MarketsResult } from '../markets'

const LOADING: MarketsState = { phase: 'loading', previous: null, retrying: null }

/** Outside a provider nothing is read and nothing is made up: a loading state that never starts. */
const IDLE: MarketsProvider = {
  kind: 'bridge',
  getSnapshot: () => LOADING,
  subscribe: () => () => undefined,
  ensure: () => undefined,
  refresh: () => undefined,
  recoverQuietly: () => () => undefined,
}

export const MarketsContext = createContext<MarketsProvider>(IDLE)

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
