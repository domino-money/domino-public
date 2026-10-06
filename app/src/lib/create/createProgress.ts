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
 * What the connected wallet can do with a batch on this chain (EIP-5792 `atomic`: finance/batch.ts atomicStatus), as
 * Create position read it for that wallet: `supported` signs every step at once, so Review's list shows the one step
 * the wallet will ask for before anything is pressed (the owner, 2026-09-28: fewer wallet steps when the wallet can
 * batch). Null while unread, for no wallet, and once the control leaves the page. A plain value: nothing of the wallet
 * feature is imported here.
 */
export type BatchAbility = 'supported' | 'ready' | 'unsupported'
let ability: BatchAbility | null = null
const abilityListeners = new Set<() => void>()

/** What the connected wallet can do with a batch, or null. */
export function publishBatchAbility(next: BatchAbility | null) {
  if (next === ability) return
  ability = next
  for (const listener of abilityListeners) listener()
}

function subscribeBatchAbility(listener: () => void): () => void {
  abilityListeners.add(listener)
  return () => {
    abilityListeners.delete(listener)
  }
}

/** What the connected wallet can do with a batch, live; null while unread. */
export function useBatchAbility(): BatchAbility | null {
  return useSyncExternalStore(subscribeBatchAbility, () => ability, () => null)
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
 * for these ids and for no other. Each with the wallet that made it (lowercase; null when the caller did not name it).
 */
const madeHere = new Map<string, string | null>()

/** The new position's NFT id, or null; `owner`, the wallet that made it (RPC fix round 2: a list asks only for its own). */
export function publishCreated(tokenId: string | null, owner: string | null = null) {
  created = tokenId
  if (tokenId) madeHere.set(tokenId, owner && owner.toLowerCase())
  for (const listener of createdListeners) listener()
}

/** Whether Create position made `tokenId` during this visit. */
export const createdHere = (tokenId: string) => madeHere.has(tokenId)
/** 2026-09-28 (speed wave B, item 18): how many it made, so a wallet's list kept before the last is not drawn after it. */
export const madeCount = () => madeHere.size
/**
 * 2026-10-02 (review of the RPC switch, finding 8): the positions it made, for a list that should name them
 * (walletPositions.ts). Changed on purpose 2026-10-02 (RPC fix round 2): with `owner`, only that wallet's (and any whose
 * wallet was not named), so another wallet's list is not asked again for them.
 */
export const madeIds = (owner?: string): readonly string[] => [...madeHere].filter(([, by]) => owner === undefined || by === null || by === owner.toLowerCase()).map(([id]) => id)

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

/*
 * Added 2026-10-06 (the final check's F1/F6, a second look): whether the flow open now made its position on Domino V2, on
 * any network (src/v2in/journey/JourneyCreateV2.tsx; the zap path's ZapJourney.tsx too): Review's Back rests on it
 * (components/create/Journey.tsx), and New position's own link then starts a fresh flow (screens/NewPosition.tsx), as
 * `created` above does for Robinhood Chain. Set by the control that made it, false again when that control goes. Never
 * a list's marker: `created` and madeHere stay Robinhood Chain's (Base's and Arbitrum One's positions are not theirs).
 */
let flowMade = false
const flowMadeListeners = new Set<() => void>()

/** Whether the flow open now made its position (true), or no longer shows it (false). */
export function publishFlowMade(made: boolean) {
  if (made === flowMade) return
  flowMade = made
  for (const listener of flowMadeListeners) listener()
}

function subscribeFlowMade(listener: () => void): () => void {
  flowMadeListeners.add(listener)
  return () => {
    flowMadeListeners.delete(listener)
  }
}

/** Whether the flow open now made its position on Domino V2, live. */
export function useFlowMade(): boolean {
  return useSyncExternalStore(subscribeFlowMade, () => flowMade, () => false)
}
