/** Bounded public evidence handoff. It imports no wallet, V2 runtime or transport. */
import type { StateResponse } from './fees/types'

export interface PositionChange {
  kind?: 'confirmed' | 'state'
  chainId: number
  positionManager?: string
  tokenIds?: readonly string[]
  wallet?: string
  block?: number | bigint
  blockHash?: string
  burnedTokenIds?: readonly string[]
}
/**
 * Changed on purpose 2026-10-14 (the incident of 2026-10-13, package V1, review): a state reading is handed on with the
 * moment it arrived here, by this page's own clock (`at`, ms), which a late subscriber gets too (the retained readings
 * are replayed with the moment they came, not the moment of the replay). A figure worked out from a reading says its
 * time once nothing newer has arrived for two minutes (v2in/lists/valuation.ts usdAged), and that is counted from here.
 */
type Evidence = { kind: 'state'; value: StateResponse; at: number } | { kind: 'confirmed'; value: PositionChange }

/** Public wallet balances may lag an included action. This is a read barrier, never an optimistic balance. */
export function createWalletReadGuard(wallet: string, chainId = 4663) {
  const owner = wallet.toLowerCase()
  let minimum = 0
  let latest = 0
  let notBefore = 0
  return {
    confirm(change: PositionChange): boolean {
      const block = change.block === undefined ? 0 : Number(change.block)
      if (change.chainId !== chainId || change.wallet?.toLowerCase() !== owner || !Number.isSafeInteger(block) || block <= minimum) return false
      minimum = block
      return true
    },
    accept(block: number | null | undefined): boolean {
      if (!Number.isSafeInteger(block) || block! <= 0 || block! < minimum || block! < latest) return false
      latest = block!
      return true
    },
    defer(retryAfterSeconds: number, now: number) {
      if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) notBefore = Math.max(notBefore, now + retryAfterSeconds * 1000)
    },
    delay(now: number, wait = 0): number { return Math.max(0, wait, notBefore - now) },
  }
}

export function createPositionEvidence(now: () => number = () => Date.now()) {
  const states = new Map<string, StateResponse>()
  // When each retained reading arrived (see Evidence above); gone with the reading itself.
  const arrived = new WeakMap<StateResponse, number>()
  const confirmations: PositionChange[] = []
  const listeners = new Set<(event: Evidence) => void>()
  return {
    state(value: StateResponse) {
      const at = now()
      for (const position of value.positions) {
        if (!position.ok || value.block <= (states.get(position.tokenId)?.block ?? 0)) continue
        const kept: StateResponse = { v: value.v, block: value.block, timestamp: value.timestamp, positions: [position] }
        states.delete(position.tokenId)
        states.set(position.tokenId, kept)
        arrived.set(kept, at)
      }
      while (states.size > 512) states.delete(states.keys().next().value as string)
      for (const listener of listeners) listener({ kind: 'state', value, at })
    },
    confirmed(value: PositionChange) {
      confirmations.push(value)
      if (confirmations.length > 64) confirmations.shift()
      for (const listener of listeners) listener({ kind: 'confirmed', value })
    },
    subscribe(listener: (event: Evidence) => void) {
      listeners.add(listener)
      // A screen can finish a read before the V2 collection's chunk loads. Apply confirmation
      // minimums first, so an older retained state cannot reopen a position during that handoff.
      for (const value of confirmations) listener({ kind: 'confirmed', value })
      for (const value of states.values()) listener({ kind: 'state', value, at: arrived.get(value) ?? now() })
      return () => { listeners.delete(listener) }
    },
  }
}

const evidence = createPositionEvidence()
export const notePositionState = evidence.state
export const notePositionConfirmation = evidence.confirmed
export const subscribePositionEvidence = evidence.subscribe
