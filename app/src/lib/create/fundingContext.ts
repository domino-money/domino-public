import type { JourneyState } from './journey'

/** A read-only handoff to the Amount step's single Continue action. */
export type FundingContinuation = { state: 'none' } | { state: 'waiting' | 'attention'; copy: string } | { state: 'ready'; copy: string; run: () => Promise<boolean> }

/** A receipt belongs to this visit, owner and position choice. Live prices are not a new choice. */
export function fundingContext(state: JourneyState, walletKey: string, flowKey: string): string {
  return JSON.stringify([flowKey, walletKey, state.pool?.currencies[0].chainId, state.pool?.key,
    state.range?.lower, state.range?.upper, state.token?.key, state.budget, state.slippageBps])
}
