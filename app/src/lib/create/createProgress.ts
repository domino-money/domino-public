/**
 * Create position's steps as they happen, published by the control that runs
 * them (components/create/CreatePosition.tsx, in the wallet chunk) and read by
 * Review's list of wallet steps (StageReview.tsx), which marks each one as it
 * is asked for, sent and done. Nothing here imports the wallet feature: the
 * steps arrive as plain values.
 */
import { useSyncExternalStore } from 'react'
import type { TokenDisplay } from '../read/types'

export type LiveState = 'waiting' | 'reading' | 'wallet' | 'chain' | 'done' | 'failed'

export interface LiveStep {
  /** 'fund', 'swap', 'mint', 'refund', or `approve:<token address>`. */
  key: string
  title: string
  token?: TokenDisplay
  state: LiveState
}

let current: readonly LiveStep[] | null = null
const listeners = new Set<() => void>()

/** The run's steps now; null ends the run and Review shows its plan again. */
export function publishCreateProgress(next: readonly LiveStep[] | null) {
  current = next
  for (const listener of listeners) listener()
}

export function getCreateProgress(): readonly LiveStep[] | null {
  return current
}

export function subscribeCreateProgress(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The run's steps, live; null while nothing runs. */
export function useCreateProgress(): readonly LiveStep[] | null {
  return useSyncExternalStore(subscribeCreateProgress, getCreateProgress, () => null)
}
