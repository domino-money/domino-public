/**
 * What Domino's automation did for one position (the owner, 2026-09-27: "o quanto que o Auto Compound impactou?
 * Quando que a gente acrescentou mais liquidez?"), from public chain logs only, with no session.
 *
 * How an automatic compound looks on chain (read on the owner's NFT 3325113, 2026-09-27;
 * contracts/src/DominoVaultV4.sol execute, executionModify, executionApply and _settleServiceFee): the operator sends
 * one transaction to the position's sequence vault (the NFT stays in the owner's wallet; the vault is its
 * PositionManager subscriber). Inside it the vault collects the fees (a ModifyLiquidity of 0: DECREASE_LIQUIDITY 0
 * and TAKE_PAIR to the vault) and adds them back (a ModifyLiquidity above 0: INCREASE_LIQUIDITY), or, with the NET
 * action, adds them in one increase that settles the fees itself; it pays its service fee (2 % of the fees it puts
 * back for Auto-compound, 4 % for Domino-compound, the policy's serviceFeeBps) to the fee recipient as ERC-20
 * transfers from the vault, and emits ExecutionCompleted(intentId, planHash, action, parentTokenId,
 * destinationTokenId, stateNonce). A manual increase has the same ModifyLiquidity (sender the PositionManager, salt
 * the NFT id): only the vault's ExecutionCompleted in the same transaction tells them apart.
 *
 * So a position whose automation names a vault gets its record (RPC-SPEC §2.5.5: the site's fixed route
 * POST /api/automation/v1/record, which reads Domino's own node): the vault's ExecutionCompleted logs from the NFT's
 * mint to its latest settlement (a settlement is the only thing that can bring a new one), and, when both currencies
 * are ERC-20s, their transfers out of the vault in the blocks of those executions: every one of them that is not the
 * vault paying the PoolManager is the service fee. The page still parses every log itself (lib/vaultLogs.ts).
 *
 * What is worked out, all at the pool's price now (the Fees earned card's one price, visual/value.ts):
 * - each automatic re-add: its time, what the liquidity it added is worth now, and the service fee paid on it (exactly:
 *   the engine's BudgetApplied for the position, which its ledger carries (2026-10-02, RPC-SPEC §11.4), native currency
 *   included; else the vault's transfers; else, for a native currency, the policy's rate on the fees put back,
 *   value × bps / (10,000 − bps), written with "≈");
 * - how many, and their total;
 * - how much larger the position is than the owner's own deposits: the liquidity the vault added against the rest,
 *   each decrease taking from both in proportion;
 * - for Domino-compound, the next positions it opened (MINT) and the fees it moved out for them (MINT and FUND).
 * Nothing is invented: without the vault's logs, or with any log that is not what was asked for, there is no figure.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { type Basis, principalAt, valueUnits } from '../components/positions/visual/value'
import { postVaultRecord, type RouteOptions, type VaultRecordRequest } from './edge/chainRoutes'
import type { FeeHistory, PositionState, RelayAnswer } from './fees/types'
import { EXECUTION_COMPLETED, executionsOf, paymentsOf, type Execution } from './vaultLogs'
import { mintHints } from './fees/mintHints'

// 2026-10-01: the vault's logs are parsed in lib/vaultLogs.ts (no React there); the same names here.
export { EXECUTION_COMPLETED, executionsOf, paymentsOf, type Execution }

const NATIVE = '0x0000000000000000000000000000000000000000'
/** contracts/src/DominoExecutionTypes.sol: GENERAL and NET add to the parent; FUND adds to an existing successor; MINT opens one. */
export const ACTION = { GENERAL: 0, NET: 1, FUND: 2, MINT: 3 } as const
/** The service fee of each automation (functions/_lib/automation.ts MODE_OF_FEE), in basis points. */
export const SERVICE_FEE_BPS = { compound: 200, domino: 400 } as const

export type AutomationKind = keyof typeof SERVICE_FEE_BPS

/** Per execution's transaction, the service fee the vault paid in it, per currency (raw amounts). */
export type Paid = ReadonlyMap<string, readonly [bigint, bigint]>

/** What the vault's logs say: its executions for the position, and the fees paid in them (null when they leave no log). */
export interface VaultRecord {
  executions: readonly Execution[]
  paid: Paid | null
}

/** One automatic re-add into the position. */
export interface AutoAdd {
  tx: string
  timestamp: number
  liquidity: bigint
  /** What the liquidity added is worth now, in the basis' scaled units. */
  value: bigint
  /** The service fee paid on it, at the same price. */
  fee: bigint
}

export interface AutomationImpact {
  kind: AutomationKind
  /** Oldest first. */
  adds: AutoAdd[]
  /** Their total value now, and the fees on them. */
  added: bigint
  fees: bigint
  /** The fees are the engine's or the transfers' own figures (false: the policy's rate on the value, "≈"). */
  exactFees: boolean
  /** The re-added share of the position now, as a share of the owner's own (0.0264 is 2.64 % larger); null when there is none of the owner's left. */
  growth: number | null
  /** Domino-compound: the next positions opened, and the fees moved out of this one for them (MINT and FUND), valued now. */
  opened: number
  moved: bigint
}

/**
 * What the automation did, from the position's verified fees history (its ledger's settlements), its state now, the card's
 * basis and the vault's record. Null when it did nothing yet: the card then says nothing of it.
 */
export function automationImpact({
  tokenId,
  kind,
  history,
  state,
  basis,
  record,
}: {
  tokenId: string
  kind: AutomationKind
  history: Pick<FeeHistory, 'events'>
  state: Pick<PositionState, 'sqrtPriceX96' | 'tick' | 'tickLower' | 'tickUpper'>
  basis: Basis
  record: VaultRecord
}): AutomationImpact | null {
  const byTx = new Map(record.executions.map((execution) => [execution.tx, execution]))
  // The engine's service fee per transaction, as the position's ledger carries it (BudgetApplied): exact, ETH included.
  const service = new Map<string, readonly [bigint, bigint]>()
  for (const event of history.events) if (event.service) service.set(event.tx.toLowerCase(), event.service)
  let estimated = false
  const bps = BigInt(SERVICE_FEE_BPS[kind])
  const worth = (liquidity: bigint) => valueUnits(basis, principalAt(liquidity, state.sqrtPriceX96, state.tick, state.tickLower, state.tickUpper))
  const adds: AutoAdd[] = []
  let own = 0n
  let auto = 0n
  let moved = 0n
  // Chain order (the history's events are; a stable sort keeps a collect before the increase of its own transaction).
  const events = [...history.events].sort((a, b) => a.block - b.block)
  for (const event of events) {
    const tx = event.tx.toLowerCase()
    const execution = byTx.get(tx)
    const delta = event.liquidityDelta
    const readds = execution && execution.destination === tokenId && (execution.action === ACTION.GENERAL || execution.action === ACTION.NET)
    if (delta > 0n && readds) {
      const value = worth(delta)
      const own = service.get(tx)
      const paid = record.paid?.get(tx)
      if (!own && !record.paid) estimated = true
      adds.push({ tx: event.tx, timestamp: event.timestamp, liquidity: delta, value, fee: own ? valueUnits(basis, own) : record.paid ? (paid ? valueUnits(basis, paid) : 0n) : (value * bps) / (10_000n - bps) })
      auto += delta
    } else if (delta > 0n) {
      own += delta
    } else if (delta < 0n) {
      // A decrease takes from the owner's part and the automation's alike.
      const total = own + auto
      const left = total + delta > 0n ? total + delta : 0n
      if (total > 0n) {
        own = (own * left) / total
        auto = (auto * left) / total
      }
    }
    if (execution && execution.destination !== tokenId && (execution.action === ACTION.MINT || execution.action === ACTION.FUND)) moved += valueUnits(basis, event.fees ?? [0n, 0n])
  }
  const opened = record.executions.filter((execution) => execution.action === ACTION.MINT && execution.destination !== tokenId).length
  if (adds.length === 0 && opened === 0) return null
  return {
    kind,
    adds,
    added: adds.reduce((sum, add) => sum + add.value, 0n),
    fees: adds.reduce((sum, add) => sum + add.fee, 0n),
    exactFees: !estimated,
    growth: own > 0n && auto > 0n ? Number((auto * 1_000_000n) / own) / 1_000_000 : null,
    opened,
    moved,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * The vault's record for `tokenId` in blocks [from, to], through the site's route (RPC-SPEC §2.5.5, which reads it from
 * Domino's own node in windows of its own): its executions, and when there are any and both currencies are ERC-20s, the
 * transfers out of the vault in their blocks. Every log is parsed here (lib/vaultLogs.ts executionsOf, paymentsOf). Null
 * when it could not be read, when any log is not what was asked for, or while the node is behind `to` (the store asks
 * again). `post` is the route's client (lib/edge/chainRoutes.ts); tests hand in their own.
 */
export async function readVault(
  vault: string,
  tokenId: string,
  currencies: readonly [string, string],
  from: number,
  to: number,
  post: (request: VaultRecordRequest, options?: RouteOptions) => Promise<RelayAnswer<unknown>> = postVaultRecord,
  signal?: AbortSignal,
): Promise<VaultRecord | null> {
  // The deployable builds and the wallet test builds (whose browsers answer the site's routes from a fake chain) read it.
  if (!(__DOMINO_DEPLOYABLE__ || __DOMINO_TEST_HOOKS__)) return null
  if (!/^0x[0-9a-f]{40}$/.test(vault) || !/^[1-9]\d{0,77}$/.test(tokenId) || !(Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to >= from)) return null
  // 2026-09-28 (speed wave B, item 26): read beside the position's chart, not a read its fees lane waits for.
  if (signal?.aborted) return null
  const pair = [currencies[0].toLowerCase(), currencies[1].toLowerCase()] as const
  try {
    const answer = await post({ vault, tokenId, currencies: pair, from, to }, { signal })
    if (signal?.aborted || !answer.ok || !isRecord(answer.value) || answer.value.v !== 1) return null
    const value = answer.value
    // The node is behind the blocks asked: nothing yet, asked again by the store.
    if (value.behind === true) return null
    const executions = executionsOf(value.executions, vault, tokenId)
    if (!executions) return null
    if (executions.length === 0) return { executions, paid: new Map() }
    // A native currency's moves leave no log: the route reads none (`transfers: null`), and the fees are the policy's rate.
    if (pair.includes(NATIVE)) return { executions, paid: null }
    const paid = paymentsOf(value.transfers, vault, pair, new Set(executions.map((execution) => execution.tx)))
    return paid ? { executions, paid } : null
  } catch {
    return null
  }
}

/**
 * What the store keeps per vault and NFT: the blocks read from and up to, the record (null until one read succeeded) and
 * when the last read failed (0: it did not).
 */
export interface VaultEntry {
  from: number
  to: number
  record: VaultRecord | null
  failedAt: number
}

/** A warm or retained record is displayable only when it covers the entire requested interval. */
export function coveredVaultRecord(entry: VaultEntry | null, from: number, to: number): VaultRecord | null {
  return entry && entry.from <= from && entry.to >= to ? entry.record : null
}

type Ask = [vault: string, tokenId: string, currencies: readonly [string, string], from: number, to: number]

/**
 * The records read so far per vault and NFT, for the visit (memory only): a later settlement reads only the blocks
 * after the last one read. A read that fails keeps what was read and is asked again `retryMs` later, with the latest
 * blocks wanted, for as long as a screen shows it (2026-09-27, review: one 429 must not hide the lines for the visit).
 * `read` and `timers` are the page's own unless a test hands in its own.
 */
export function vaultStore(read: (...ask: [...Ask, AbortSignal]) => Promise<VaultRecord | null> = (vault, tokenId, currencies, from, to, signal) => readVault(vault, tokenId, currencies, from, to, undefined, signal), retryMs = 60_000, timers: { set: (run: () => void, ms: number) => unknown; clear?: (timer: unknown) => void; now: () => number } = { set: (run, ms) => setTimeout(run, ms), clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>), now: () => Date.now() }) {
  const kept = new Map<string, VaultEntry>()
  const latest = new Map<string, Ask>()
  const asking = new Map<string, AbortController>()
  const retrying = new Map<string, { timer: unknown }>()
  const listeners = new Map<string, Set<() => void>>()
  const interested = (key: string) => (listeners.get(key)?.size ?? 0) > 0

  function retry(key: string, delay: number) {
    if (!interested(key) || retrying.has(key)) return
    const pending = { timer: undefined as unknown }
    retrying.set(key, pending)
    pending.timer = timers.set(() => {
      if (retrying.get(key) !== pending) return
      retrying.delete(key)
      const again = latest.get(key)
      if (again && interested(key)) want(...again)
    }, delay)
  }

  function want(...ask: Ask) {
    const [vault, tokenId, currencies, from, to] = ask
    const key = `${vault}:${tokenId}`
    latest.set(key, ask)
    const entry = kept.get(key)
    // 2026-09-28 (speed wave B, item 26): a record read from a later block than asked (warmVault's, from the factory's
    // first block) is read again from the block asked, whole.
    const earlier = !!entry?.record && from < entry.from
    if (asking.has(key) || (entry?.record && entry.to >= to && !earlier)) return
    if (entry?.failedAt && timers.now() - entry.failedAt < retryMs) {
      retry(key, retryMs - (timers.now() - entry.failedAt))
      return
    }
    const known = earlier ? null : (entry?.record ?? null)
    const end = Math.max(to, earlier && entry ? entry.to : to)
    const controller = new AbortController()
    asking.set(key, controller)
    void read(vault, tokenId, currencies, known && entry ? entry.to + 1 : from, end, controller.signal).catch(() => null).then((got) => {
      if (asking.get(key) !== controller || controller.signal.aborted) return
      asking.delete(key)
      const record = got && known ? { executions: [...known.executions, ...got.executions], paid: known.paid && got.paid ? new Map([...known.paid, ...got.paid]) : null } : got
      kept.set(key, got ? { from: known && entry ? entry.from : from, to: end, record, failedAt: 0 } : { from: entry?.from ?? from, to: entry?.to ?? -1, record: entry?.record ?? null, failedAt: timers.now() })
      if (!got) retry(key, retryMs)
      for (const listener of listeners.get(key) ?? []) listener()
      // The blocks a screen asked while this read was on its way (a card's own, while the page's early read went).
      const again = latest.get(key)
      if (got && again && interested(key)) want(...again)
    })
  }

  function subscribe(vault: string, tokenId: string, listener: () => void) {
    const key = `${vault}:${tokenId}`
    const group = listeners.get(key) ?? new Set<() => void>()
    group.add(listener)
    listeners.set(key, group)
    return () => {
      if (!group.delete(listener) || listeners.get(key) !== group) return
      if (group.size > 0) return
      listeners.delete(key)
      const pending = retrying.get(key)
      if (pending) timers.clear?.(pending.timer)
      retrying.delete(key)
      asking.get(key)?.abort()
      asking.delete(key)
      latest.delete(key)
    }
  }

  return { want, subscribe, get: (vault: string, tokenId: string) => kept.get(`${vault}:${tokenId}`) ?? null }
}

const store = vaultStore()

/** The first block any vault of Domino's factory can have an execution in: the factory's own (docs/deployments/v1-robinhood-mainnet-2026-09-21). */
export const VAULT_FIRST_BLOCK = 69_239_633
/**
 * 2026-09-28 (speed wave B, item 26: an automated position's Fees earned card waited for its vault's record, read only
 * once the chart was drawn, as the history named the blocks): read as soon as the page's own read names the vault, from
 * the factory's first block to that read's (`block`); the card takes its own blocks' part of it (useVaultRecord).
 */
export function warmVault(vault: string, tokenId: string, currencies: readonly [string, string], block: number, signal?: AbortSignal): void {
  if (signal?.aborted) return
  if (signal) {
    const stop = store.subscribe(vault, tokenId, () => undefined)
    signal.addEventListener('abort', stop, { once: true })
  }
  // 2026-10-01 (fees items A10 and A24): from the NFT's mint when this browser knows it (no execution for it is older),
  // where it was the factory's first block (millions of blocks read again on every visit).
  const mint = mintHints.get(tokenId)?.block
  store.want(vault, tokenId, currencies, mint && mint >= VAULT_FIRST_BLOCK && mint <= block ? mint : VAULT_FIRST_BLOCK, block)
}

/**
 * The vault's record for `tokenId` from its mint (`from`) to its latest settlement (`to`): null while unknown, and
 * `settled` once a first read from `from` answered or failed. A failure is not
 * coverage: `record` remains null until the complete interval has been read.
 * The independently verified fee chart does not wait for this attribution.
 */
export function useVaultRecord(vault: string | null, tokenId: string, currencies: readonly [string, string] | null, from: number, to: number): { record: VaultRecord | null; settled: boolean } {
  const first = currencies?.[0] ?? ''
  const second = currencies?.[1] ?? ''
  useEffect(() => {
    if (vault && first && second) store.want(vault, tokenId, [first, second], from, to)
  }, [vault, tokenId, first, second, from, to])
  const subscribe = useCallback((listener: () => void) => vault ? store.subscribe(vault, tokenId, listener) : () => undefined, [vault, tokenId])
  const entry = useSyncExternalStore(
    subscribe,
    () => (vault ? store.get(vault, tokenId) : null),
    () => null,
  )
  // A record read wider than asked (warmVault): its executions in [from, to] only, as a read of those blocks has them.
  const record = coveredVaultRecord(entry, from, to)
  const own = useMemo(() => record && { ...record, executions: record.executions.filter((execution) => execution.block >= from && execution.block <= to) }, [record, from, to])
  return { record: own ?? null, settled: entry !== null && (entry.from <= from || entry.failedAt > 0) }
}
