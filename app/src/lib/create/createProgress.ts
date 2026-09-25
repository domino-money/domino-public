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

/*
 * The position Create position made, once it is in the wallet (2026-09-24, the three features joined up): Review's
 * last control then offers what comes next, keeping it plain or automating it (components/create/CreatedNext.tsx),
 * instead of opening Positions by itself. Published by the same control, null again when it leaves the page.
 */
let created: string | null = null
const createdListeners = new Set<() => void>()
/**
 * Every position Create position made during this visit, in memory only (never the browser's storage): a read of the
 * chain from a node still behind the mint lacks it (the owned endpoint's kept answer did, before the page read the
 * chain itself), so the pages a success leads to (screens/Sequence.tsx, a position's own page) ask that list once more
 * for these ids and for no other.
 */
const madeHere = new Set<string>()

/** The new position's NFT id, or null. */
export function publishCreated(tokenId: string | null) {
  created = tokenId
  if (tokenId) madeHere.add(tokenId)
  for (const listener of createdListeners) listener()
}

/** Whether Create position made `tokenId` during this visit. */
export const createdHere = (tokenId: string) => madeHere.has(tokenId)

function subscribeCreated(listener: () => void): () => void {
  createdListeners.add(listener)
  return () => {
    createdListeners.delete(listener)
  }
}

/** The position just created on this page, or null. */
export function useCreated(): string | null {
  return useSyncExternalStore(subscribeCreated, () => created, () => null)
}
