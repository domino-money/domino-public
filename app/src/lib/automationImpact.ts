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
 * So, in the page's chain code (lib/chain/chainCode.ts), a position whose automation names a vault gets two small
 * log reads: the vault's ExecutionCompleted logs from the NFT's mint to its latest settlement (a settlement is the
 * only thing that can bring a new one), and, when both currencies are ERC-20s, their transfers out of the vault in
 * the blocks of those executions: every one of them that is not the vault paying the PoolManager is the service fee.
 *
 * What is worked out, all at the pool's price now (the Fees earned card's one price, visual/value.ts):
 * - each automatic re-add: its time, what the liquidity it added is worth now, and the service fee paid on it (the
 *   transfers, exactly; for a native currency, whose moves leave no log, the policy's rate on the fees put back,
 *   value × bps / (10,000 − bps), written with "≈");
 * - how many, and their total;
 * - how much larger the position is than the owner's own deposits: the liquidity the vault added against the rest,
 *   each decrease taking from both in proportion;
 * - for Domino-compound, the next positions it opened (MINT) and the fees it moved out for them (MINT and FUND).
 * Nothing is invented: without the vault's logs, or with any log that is not what was asked for, there is no figure.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { OwnedDeps } from '../../functions/_lib/owned'
import { type Basis, principalAt, valueUnits } from '../components/positions/visual/value'
import type { FeeHistory, PositionState } from './fees/types'

/** keccak256("ExecutionCompleted(bytes32,bytes32,uint8,uint256,uint256,uint64)"), DominoVaultV4's. */
export const EXECUTION_COMPLETED = '0xa75f5619abce0f39b6b0ace7eb96f20ba345b963b9799beed8451480a406cde0'
/** keccak256("Transfer(address,address,uint256)"). */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
/** Uniswap v4's PoolManager on Robinhood Chain (functions/_lib/fees.ts POOL_MANAGER, repeated here). */
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const NATIVE = '0x0000000000000000000000000000000000000000'
/** contracts/src/DominoExecutionTypes.sol: GENERAL and NET add to the parent; FUND adds to an existing successor; MINT opens one. */
export const ACTION = { GENERAL: 0, NET: 1, FUND: 2, MINT: 3 } as const
/** The service fee of each automation (functions/_lib/automation.ts MODE_OF_FEE), in basis points. */
export const SERVICE_FEE_BPS = { compound: 200, domino: 400 } as const

export type AutomationKind = keyof typeof SERVICE_FEE_BPS

/** One ExecutionCompleted of the vault whose parent is the position. */
export interface Execution {
  tx: string
  block: number
  action: number
  destination: string
}

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
  /** The fees are the transfers themselves (false: the policy's rate on the value, "≈"). */
  exactFees: boolean
  /** The re-added share of the position now, as a share of the owner's own (0.0264 is 2.64 % larger); null when there is none of the owner's left. */
  growth: number | null
  /** Domino-compound: the next positions opened, and the fees moved out of this one for them (MINT and FUND), valued now. */
  opened: number
  moved: bigint
}

const HASH = /^0x[0-9a-f]{64}$/
const QUANTITY = /^0x[0-9a-f]{1,16}$/
const words = (data: string) => data.slice(2).match(/.{64}/g) ?? []

/** A log's fields as text, lowercase; null when it is not a log. */
function fieldsOf(log: unknown) {
  if (!log || typeof log !== 'object') return null
  const entry = log as Record<string, unknown>
  const topics = Array.isArray(entry.topics) ? entry.topics.map((topic) => String(topic).toLowerCase()) : []
  const tx = String(entry.transactionHash).toLowerCase()
  const block = String(entry.blockNumber).toLowerCase()
  if (!HASH.test(tx) || !QUANTITY.test(block) || !topics.every((topic) => HASH.test(topic))) return null
  return { removed: entry.removed === true, address: String(entry.address).toLowerCase(), topics, data: String(entry.data).toLowerCase(), tx, block: Number(BigInt(block)) }
}

/**
 * The vault's ExecutionCompleted logs whose parent is `tokenId`, oldest first; null when any log is not what was
 * asked for (another address or event, a malformed word): an answer that cannot be trusted names nothing. A removed
 * log (a reorg) is left out.
 */
export function executionsOf(logs: unknown, vault: string, tokenId: string): Execution[] | null {
  if (!Array.isArray(logs)) return null
  const parent = BigInt(tokenId)
  const out: Execution[] = []
  for (const log of logs) {
    const f = fieldsOf(log)
    if (!f || f.address !== vault || f.topics.length !== 3 || f.topics[0] !== EXECUTION_COMPLETED || !/^0x[0-9a-f]{256}$/.test(f.data)) return null
    if (f.removed) continue
    const [action, from, to] = words(f.data).map((word) => BigInt(`0x${word}`))
    if (action > 255n) return null
    if (from !== parent) continue
    out.push({ tx: f.tx, block: f.block, action: Number(action), destination: to.toString() })
  }
  return out.sort((a, b) => a.block - b.block)
}

/**
 * The service fee paid in each of `txs`: the pair's transfers out of the vault in them, but the vault's payments to
 * the PoolManager (liquidity). Null when any log is not what was asked for.
 */
export function paymentsOf(logs: unknown, vault: string, currencies: readonly [string, string], txs: ReadonlySet<string>): Map<string, readonly [bigint, bigint]> | null {
  if (!Array.isArray(logs)) return null
  const from = `0x${vault.slice(2).padStart(64, '0')}`
  const pool = `0x${POOL_MANAGER.slice(2).padStart(64, '0')}`
  const out = new Map<string, readonly [bigint, bigint]>()
  for (const log of logs) {
    const f = fieldsOf(log)
    const side = f ? currencies.indexOf(f.address) : -1
    if (!f || side === -1 || f.topics.length !== 3 || f.topics[0] !== TRANSFER || f.topics[1] !== from || !/^0x[0-9a-f]{64}$/.test(f.data)) return null
    if (f.removed || !txs.has(f.tx) || f.topics[2] === pool) continue
    const amount = BigInt(f.data)
    const [a, b] = out.get(f.tx) ?? [0n, 0n]
    out.set(f.tx, side === 0 ? [a + amount, b] : [a, b + amount])
  }
  return out
}

/**
 * What the automation did, from the position's verified (or estimated) fees history, its state now, the card's basis
 * and the vault's record. Null when it did nothing yet: the card then says nothing of it.
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
      const paid = record.paid?.get(tx)
      adds.push({ tx: event.tx, timestamp: event.timestamp, liquidity: delta, value, fee: record.paid ? (paid ? valueUnits(basis, paid) : 0n) : (value * bps) / (10_000n - bps) })
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
    if (execution && execution.destination !== tokenId && (execution.action === ACTION.MINT || execution.action === ACTION.FUND)) moved += valueUnits(basis, event.fees)
  }
  const opened = record.executions.filter((execution) => execution.action === ACTION.MINT && execution.destination !== tokenId).length
  if (adds.length === 0 && opened === 0) return null
  return {
    kind,
    adds,
    added: adds.reduce((sum, add) => sum + add.value, 0n),
    fees: adds.reduce((sum, add) => sum + add.fee, 0n),
    exactFees: record.paid !== null,
    growth: own > 0n && auto > 0n ? Number((auto * 1_000_000n) / own) / 1_000_000 : null,
    opened,
    moved,
  }
}

/** The fewest blocks a log range the RPC refuses as too large is split down to (functions/_lib/owned.ts MIN_SPLIT_BLOCKS). */
const MIN_SPLIT = 2_000
/**
 * 2026-09-28: the most blocks the RPC reads for one filter, and for a filter with several addresses
 * (functions/_lib/owned.ts LOG_BLOCKS_ONE and LOG_BLOCKS_MANY): a longer record is asked in windows of the first, oldest
 * first, and the vault's payments over a longer span than the second one currency at a time, not refused and halved.
 */
const ONE_VALUE_BLOCKS = 10_000_000
const MANY_VALUES_BLOCKS = 100_000

/**
 * The vault's record for `tokenId` in blocks [from, to], read from the chain by the page: its executions (one
 * eth_getLogs, split only when the RPC refuses the range), and when there are any and both currencies are ERC-20s,
 * the transfers out of the vault in their blocks (one more). Null when either could not be read. `deps` is the page's
 * runtime (lib/chain/browser.ts) unless a test hands in its own.
 */
export async function readVault(vault: string, tokenId: string, currencies: readonly [string, string], from: number, to: number, deps?: OwnedDeps): Promise<VaultRecord | null> {
  // The deployable builds and the wallet test builds (whose browsers answer the RPC with a fake chain) read the chain.
  if (!(__DOMINO_DEPLOYABLE__ || __DOMINO_TEST_HOOKS__)) return null
  if (!/^0x[0-9a-f]{40}$/.test(vault) || !/^[1-9]\d{0,77}$/.test(tokenId) || !(from >= 0 && to >= from)) return null
  try {
    const code = await import('./chain/chainCode')
    // 2026-09-28 (speed wave B, item 26): read beside the position's chart, not a read its fees lane waits for.
    const rt = deps ?? code.chainDeps(undefined, true)
    const budget = { calls: 0, started: rt.now(), logBytes: 0 }
    const logs = async (filter: { address: string | string[]; topics: (string | null)[] }, a: number, b: number) => {
      const queue: [number, number][] = [[a, b]]
      const out: unknown[] = []
      while (queue.length > 0) {
        const [start, end] = queue.shift() as [number, number]
        if (end - start >= ONE_VALUE_BLOCKS) {
          queue.unshift([start, start + ONE_VALUE_BLOCKS - 1], [start + ONE_VALUE_BLOCKS, end])
          continue
        }
        try {
          const got = await code.paced(rt, budget, 'eth_getLogs', [{ ...filter, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }])
          if (!Array.isArray(got)) throw new code.ChainError('fatal', 'invalid_logs')
          out.push(...got)
        } catch (error) {
          if (!(error instanceof code.ChainError) || error.kind !== 'range' || end - start + 1 < 2 * MIN_SPLIT) throw error
          const middle = start + Math.floor((end - start) / 2)
          queue.unshift([start, middle], [middle + 1, end])
        }
      }
      return out
    }
    const executions = executionsOf(await logs({ address: vault, topics: [EXECUTION_COMPLETED] }, from, to), vault, tokenId)
    if (!executions) return null
    const pair = [currencies[0].toLowerCase(), currencies[1].toLowerCase()] as const
    if (executions.length === 0) return { executions, paid: new Map() }
    if (pair.includes(NATIVE)) return { executions, paid: null }
    const vaultWord = `0x${vault.slice(2).padStart(64, '0')}`
    const [first, last] = [executions[0].block, executions[executions.length - 1].block]
    const transfers = last - first + 1 > MANY_VALUES_BLOCKS ? [...(await logs({ address: pair[0], topics: [TRANSFER, vaultWord] }, first, last)), ...(await logs({ address: pair[1], topics: [TRANSFER, vaultWord] }, first, last))] : await logs({ address: [...pair], topics: [TRANSFER, vaultWord] }, first, last)
    const paid = paymentsOf(transfers, vault, pair, new Set(executions.map((execution) => execution.tx)))
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
export function vaultStore(read: (...ask: Ask) => Promise<VaultRecord | null> = (...ask) => readVault(...ask), retryMs = 60_000, timers: { set: (run: () => void, ms: number) => unknown; now: () => number } = { set: (run, ms) => setTimeout(run, ms), now: () => Date.now() }) {
  const kept = new Map<string, VaultEntry>()
  const latest = new Map<string, Ask>()
  const asking = new Set<string>()
  const retrying = new Set<string>()
  const listeners = new Set<() => void>()

  function want(...ask: Ask) {
    const [vault, tokenId, currencies, from, to] = ask
    const key = `${vault}:${tokenId}`
    latest.set(key, ask)
    const entry = kept.get(key)
    // 2026-09-28 (speed wave B, item 26): a record read from a later block than asked (warmVault's, from the factory's
    // first block) is read again from the block asked, whole.
    const earlier = !!entry?.record && from < entry.from
    if (asking.has(key) || (entry?.record && entry.to >= to && !earlier) || (entry?.failedAt && timers.now() - entry.failedAt < retryMs)) return
    const known = earlier ? null : (entry?.record ?? null)
    const end = Math.max(to, earlier && entry ? entry.to : to)
    asking.add(key)
    void read(vault, tokenId, currencies, known && entry ? entry.to + 1 : from, end).then((got) => {
      asking.delete(key)
      const record = got && known ? { executions: [...known.executions, ...got.executions], paid: known.paid && got.paid ? new Map([...known.paid, ...got.paid]) : null } : got
      kept.set(key, got ? { from: known && entry ? entry.from : from, to: end, record, failedAt: 0 } : { from: entry?.from ?? from, to: entry?.to ?? -1, record: entry?.record ?? null, failedAt: timers.now() })
      if (!got && !retrying.has(key)) {
        retrying.add(key)
        timers.set(() => {
          retrying.delete(key)
          const again = latest.get(key)
          if (again && listeners.size > 0) want(...again)
        }, retryMs)
      }
      for (const listener of listeners) listener()
      // The blocks a screen asked while this read was on its way (a card's own, while the page's early read went).
      const again = latest.get(key)
      if (got && again) want(...again)
    })
  }

  function subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
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
export function warmVault(vault: string, tokenId: string, currencies: readonly [string, string], block: number): void {
  store.want(vault, tokenId, currencies, VAULT_FIRST_BLOCK, block)
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
  const entry = useSyncExternalStore(
    store.subscribe,
    () => (vault ? store.get(vault, tokenId) : null),
    () => null,
  )
  // A record read wider than asked (warmVault): its executions in [from, to] only, as a read of those blocks has them.
  const record = coveredVaultRecord(entry, from, to)
  const own = useMemo(() => record && { ...record, executions: record.executions.filter((execution) => execution.block >= from && execution.block <= to) }, [record, from, to])
  return { record: own ?? null, settled: entry !== null && (entry.from <= from || entry.failedAt > 0) }
}
