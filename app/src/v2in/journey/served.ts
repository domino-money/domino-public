import type { ChainPoolsResponse, ReadV6Route } from 'api-contracts/read-v6/types'
import { whenVisibleAfter } from '../../lib/read/screens/quietRead'
import { quietDelayMs } from '../../lib/read/screens/transient'
import type { V2Gate } from '../../v2/gate'
import { readChainPools, type ReadV6Reply } from '../../v2/read/v6'
import { routeServes } from '../../v2/routes'
import { v2Transports, type V2Transports } from '../transports'
import { createAnswerReuse, passingAfter, passingReply, poolsKey, retryAfterOf } from './model/chainReads'

export { PASSING } from './model/chainReads'

/**
 * Domino's service's chain reads (read-v6 chain-pools, chain-balances, chain-tokens) as New position asks them, one rule
 * for every caller: moved here on purpose 2026-10-06 from ./otherChains.ts (Base and Arbitrum One), unchanged, so
 * Robinhood Chain's pool prices (./poolPrices.ts) use the same route verification and quiet waits. Public discovery also
 * accepts an execution-locked preview gate, only while the read route serves that read (the read Worker's capabilities), a failure saying whether it may
 * pass, and the quiet waits of the read screens.
 *
 * Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §1: each visitor has a budget per lane of the reader, the
 * gateway's Retry-After is now the real time to the lane's next token, and "don't repeat chain-pools of the same token
 * before 15 s, which is the reader's cache"): a busy reader's 429 is asked again no sooner than the Retry-After it named
 * (`patiently`), and one chain-pools answer serves every caller of the page for 20 s (`chainPoolsOn`): Base's and
 * Arbitrum One's rows, a pasted address and Robinhood Chain's prices alike, across visits to New position.
 */

export type LiveGate = Extract<V2Gate, { mode: 'live' }>
/** Both modes can read public chain data; the execution clients still require LiveGate. */
export type ReadGate = Exclude<V2Gate, { mode: 'off' }>

/**
 * What one of the service's chain reads came to: its answer; the route off (the wallet's own way); or a failure.
 * `retryAfterS` (added 2026-10-06): the Retry-After a busy reader named with it, in whole seconds.
 */
export type Served<T> = { kind: 'ok'; body: T; receivedAt: number } | { kind: 'off' } | { kind: 'failed'; passing: boolean; retryAfterS?: number }
export const OFF = { kind: 'off' } as const

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
 * (./poolPrices.ts) wait the same way, a few times more. Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §1): a
 * busy reader's Retry-After is the least it waits (model/chainReads.ts passingAfter).
 */
export async function patiently<T>(ask: () => Promise<Served<T>>, signal: AbortSignal, reasks = 1): Promise<Served<T>> {
  for (let attempt = 0; ; attempt += 1) {
    const said = await ask()
    if (said.kind !== 'failed' || !said.passing || signal.aborted || attempt >= reasks) return said
    const wait = quietDelayMs(passingAfter(said.retryAfterS), attempt)
    if (wait === null || !(await quietly(wait, signal))) return said
  }
}

/**
 * One of the service's chain reads under `gate` (null: no readable network) while its route serves. Changed on purpose 2026-10-06:
 * a failure says whether it may pass (a dropped connection, a busy reader, a capabilities read that failed for the
 * moment), so it can be asked again, and (rugged's answer of 6 Oct, §1) the Retry-After a busy reader named; a route
 * that is off is said at once.
 */
export async function servedOn<T>(gate: ReadGate | null, route: ReadV6Route, read: (transports: V2Transports) => Promise<ReadV6Reply<T>>): Promise<Served<T>> {
  const transports = gate ? v2Transports(gate) : null
  if (!transports) return OFF
  try {
    const state = await transports.routeState('readV6')
    if (!state.on) return state.reason === 'unavailable' || state.reason === 'aborted' ? { kind: 'failed', passing: true } : OFF
    if (!routeServes(state, route)) return OFF
    const reply = await read(transports)
    if (reply.kind === 'ok') return { kind: 'ok', body: reply.body, receivedAt: Date.now() }
    const retryAfterS = retryAfterOf(reply)
    return retryAfterS === undefined ? { kind: 'failed', passing: passingReply(reply) } : { kind: 'failed', passing: passingReply(reply), retryAfterS }
  } catch {
    return { kind: 'failed', passing: true }
  }
}

/**
 * The page's chain-pools answers, shared by every caller (Added 2026-10-06, rugged's answer of 6 Oct, §1); a busy reader's
 * refusal is kept until its Retry-After has passed, so no caller asks that read again sooner.
 */
const POOL_ANSWERS = createAnswerReuse<Served<ChainPoolsResponse>>(
  (said) => said.kind === 'ok',
  Date.now,
  64,
  (said) => (said.kind === 'failed' && said.retryAfterS !== undefined ? said.retryAfterS * 1000 : 0),
)

/**
 * chain-pools for a token on a network (or a pair: `paired`) under `gate` (null: none is live, nothing is read or reused),
 * one read for every ask of the page within 20 s of each other (model/chainReads.ts POOLS_REUSE_MS), and never again
 * within the reader's own 15 s, whatever `maxAgeMs` asks (a price read again: READER_POOLS_CACHE_MS); a failure is not
 * kept, but a busy reader's is until its Retry-After has passed (Added 2026-10-06, rugged's answer of 6 Oct, §1; until
 * then each caller kept its own, or none).
 */
export function chainPoolsOn(gate: ReadGate | null, chainId: number, token: string, paired?: string, maxAgeMs?: number): Promise<Served<ChainPoolsResponse>> {
  if (!gate) return Promise.resolve(OFF)
  return POOL_ANSWERS.ask(poolsKey(chainId, token, paired), () => servedOn<ChainPoolsResponse>(gate, 'chain-pools', (t) => readChainPools(t.read, t.readRuntime, chainId, token, paired)), maxAgeMs)
}
