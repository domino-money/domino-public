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
type Evidence = { kind: 'state'; value: StateResponse } | { kind: 'confirmed'; value: PositionChange }

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

export function createPositionEvidence() {
  const states = new Map<string, StateResponse>()
  const confirmations: PositionChange[] = []
  const listeners = new Set<(event: Evidence) => void>()
  return {
    state(value: StateResponse) {
      for (const position of value.positions) {
        if (!position.ok || value.block <= (states.get(position.tokenId)?.block ?? 0)) continue
        states.delete(position.tokenId)
        states.set(position.tokenId, { v: value.v, block: value.block, timestamp: value.timestamp, positions: [position] })
      }
      while (states.size > 512) states.delete(states.keys().next().value as string)
      for (const listener of listeners) listener({ kind: 'state', value })
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
      for (const value of states.values()) listener({ kind: 'state', value })
      return () => { listeners.delete(listener) }
    },
  }
}

const evidence = createPositionEvidence()
export const notePositionState = evidence.state
export const notePositionConfirmation = evidence.confirmed
export const subscribePositionEvidence = evidence.subscribe
