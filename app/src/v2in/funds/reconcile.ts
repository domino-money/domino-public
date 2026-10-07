import type { ChainBalancesResponse } from 'api-contracts/read-v6/types'
import type { ReadV6Reply } from '../../v2/read/v6'

/** The read service caches balances for ten seconds. Never treat its first post-fill reply as proof of a new read. */
export const BALANCE_CACHE_WAIT_MS = 11_000
export const BALANCE_RECONCILE_MAX_MS = 120_000
export const BALANCE_RECONCILE_ATTEMPTS = 6

export interface BalanceSnapshot {
  block: number
  hash: string
  timestamp: number
  balances: readonly { token: string; raw: string }[]
}

export type BalanceRead =
  | { kind: 'ok'; snapshot: BalanceSnapshot }
  | { kind: 'unavailable'; retryAfterMs?: number }

/** A complete observed balance for this owner, chain and exact token set; no estimate or missing-as-zero conversion. */
export function balanceSnapshot(reply: ReadV6Reply<ChainBalancesResponse>, owner: string, chainId: number, tokens: readonly string[]): BalanceRead {
  if (reply.kind !== 'ok') {
    const retry = reply.kind === 'unavailable' ? reply.retryAfterSeconds : undefined
    return retry === undefined ? { kind: 'unavailable' } : { kind: 'unavailable', retryAfterMs: retry * 1000 }
  }
  if (reply.body.wallet.toLowerCase() !== owner.toLowerCase()) return { kind: 'unavailable' }
  const chain = reply.body.chains.find((entry) => entry.chainId === chainId)
  if (chain?.status !== 'current' || !chain.snapshot || tokens.length === 0) return { kind: 'unavailable' }
  const balances: { token: string; raw: string }[] = []
  for (const token of tokens) {
    const entry = chain.balances.find((row) => row.address.toLowerCase() === token.toLowerCase())
    if (entry?.status !== 'read' || entry.balanceRaw === null || !/^(0|[1-9][0-9]*)$/.test(entry.balanceRaw)) return { kind: 'unavailable' }
    balances.push({ token: token.toLowerCase(), raw: entry.balanceRaw })
  }
  return { kind: 'ok', snapshot: { block: chain.snapshot.number, hash: chain.snapshot.hash, timestamp: chain.snapshot.timestamp, balances } }
}

export interface ReconcileDeps {
  read(): Promise<BalanceRead>
  monoMs(): number
  wait(ms: number): Promise<void>
  current(): boolean
  /** Called with observed snapshots only. The receiving amount step re-reads its own balances. */
  onSnapshot(snapshot: BalanceSnapshot): void
}

/**
 * A bounded post-fill read, independent of the wallet's active network. A second advancing snapshot beyond the cache
 * window closes reconciliation. A slower or unavailable reader stays explicitly unresolved and can be retried; it
 * never credits a quoted bridge output to the wallet. Account/intent changes cancel before any callback.
 */
export async function reconcileBalances(deps: ReconcileDeps): Promise<'ready' | 'unavailable' | 'cancelled'> {
  const started = deps.monoMs()
  let first: { snapshot: BalanceSnapshot; at: number } | null = null
  let latest: BalanceSnapshot | null = null
  let waitMs = 0
  for (let attempt = 0; attempt < BALANCE_RECONCILE_ATTEMPTS; attempt += 1) {
    if (!deps.current()) return 'cancelled'
    if (waitMs > 0) {
      if (deps.monoMs() - started + waitMs > BALANCE_RECONCILE_MAX_MS) return 'unavailable'
      await deps.wait(waitMs)
      if (!deps.current()) return 'cancelled'
    }
    let read: BalanceRead
    try {
      read = await deps.read()
    } catch {
      read = { kind: 'unavailable' }
    }
    if (!deps.current()) return 'cancelled'
    if (deps.monoMs() - started > BALANCE_RECONCILE_MAX_MS) return 'unavailable'
    if (read.kind === 'ok') {
      const next = read.snapshot
      const sameBlock = latest !== null && next.block === latest.block
      const consistent = latest === null || (next.block >= latest.block && next.timestamp >= latest.timestamp
        && (!sameBlock || (next.hash === latest.hash && JSON.stringify(next.balances) === JSON.stringify(latest.balances))))
      // A regressed, reorged or contradictory sample cannot overwrite the highest observed block. Repeated cached
      // snapshots need no callback: the next actual observation will refresh every amount-step consumer together.
      if (consistent) {
        if (!sameBlock) deps.onSnapshot(next)
        latest = next
        if (first !== null && deps.monoMs() - first.at >= BALANCE_CACHE_WAIT_MS && next.block > first.snapshot.block && next.hash !== first.snapshot.hash) return 'ready'
        first ??= { snapshot: next, at: deps.monoMs() }
      }
    }
    waitMs = Math.max(BALANCE_CACHE_WAIT_MS, read.kind === 'unavailable' ? (read.retryAfterMs ?? 0) : 0)
  }
  return 'unavailable'
}
