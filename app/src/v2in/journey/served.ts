import type { ReadV6Route } from 'api-contracts/read-v6/types'
import { whenVisibleAfter } from '../../lib/read/screens/quietRead'
import { quietDelayMs, type TransientCandidate } from '../../lib/read/screens/transient'
import type { V2Gate } from '../../v2/gate'
import type { ReadV6Reply } from '../../v2/read/v6'
import { routeServes } from '../../v2/routes'
import { v2Transports, type V2Transports } from '../transports'
import { passingReply } from './model/chainReads'

/**
 * Domino's service's chain reads (read-v6 chain-pools, chain-balances, chain-tokens) as New position asks them, one rule
 * for every caller: moved here on purpose 2026-10-06 from ./otherChains.ts (Base and Arbitrum One), unchanged, so
 * Robinhood Chain's pool prices (./poolPrices.ts) are asked exactly as those networks' reads are: only under a live S1
 * gate, only while the read route serves that read (the read Worker's capabilities), a failure saying whether it may
 * pass, and the quiet waits of the read screens.
 */

export type LiveGate = Extract<V2Gate, { mode: 'live' }>

/** What one of the service's chain reads came to: its answer; the route off (the wallet's own way); or a failure. */
export type Served<T> = { kind: 'ok'; body: T; receivedAt: number } | { kind: 'off' } | { kind: 'failed'; passing: boolean }
export const OFF = { kind: 'off' } as const

/** A failure that may pass, as the read screens' one rule waits for it (lib/read/screens/transient.ts): a dropped connection's. */
export const PASSING: TransientCandidate = { state: 'unavailable', cause: { kind: 'network' } }

/** Resolves true once `ms` have passed with the page visible (quietRead's timer), false if `signal` aborts first. */
export function quietly(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((done) => {
    if (signal.aborted) {
      done(false)
      return
    }
    const stop = () => {
      cancel()
      done(false)
    }
    const cancel = whenVisibleAfter(ms, () => {
      signal.removeEventListener('abort', stop)
      done(true)
    })
    signal.addEventListener('abort', stop, { once: true })
  })
}

/**
 * A read asked again after a quiet wait while it failed for the moment (the read screens' waits), up to `reasks` times
 * after the first; anything else, or the last failure, is what it came to. Moved here on purpose 2026-10-06 from
 * ./otherChains.ts, where it asks once more (the wallet's own read comes only after), so Robinhood Chain's pool prices
 * (./poolPrices.ts) wait the same way, a few times more.
 */
export async function patiently<T>(ask: () => Promise<Served<T>>, signal: AbortSignal, reasks = 1): Promise<Served<T>> {
  for (let attempt = 0; ; attempt += 1) {
    const said = await ask()
    if (said.kind !== 'failed' || !said.passing || signal.aborted || attempt >= reasks) return said
    const wait = quietDelayMs(PASSING, attempt)
    if (wait === null || !(await quietly(wait, signal))) return said
  }
}

/**
 * One of the service's chain reads under `gate` (null: none is live) while its route serves. Changed on purpose 2026-10-06:
 * a failure says whether it may pass (a dropped connection, a busy reader, a capabilities read that failed for the
 * moment), so it can be asked again; a route that is off is said at once.
 */
export async function servedOn<T>(gate: LiveGate | null, route: ReadV6Route, read: (transports: V2Transports) => Promise<ReadV6Reply<T>>): Promise<Served<T>> {
  const transports = gate ? v2Transports(gate) : null
  if (!transports) return OFF
  try {
    const state = await transports.routeState('readV6')
    if (!state.on) return state.reason === 'unavailable' || state.reason === 'aborted' ? { kind: 'failed', passing: true } : OFF
    if (!routeServes(state, route)) return OFF
    const reply = await read(transports)
    return reply.kind === 'ok' ? { kind: 'ok', body: reply.body, receivedAt: Date.now() } : { kind: 'failed', passing: passingReply(reply) }
  } catch {
    return { kind: 'failed', passing: true }
  }
}
