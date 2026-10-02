/**
 * An automation vault's own logs (2026-09-27, moved here 2026-10-01 from lib/automationImpact.ts; the fees worker that
 * read them too is gone since 2026-10-02, RPC-SPEC §11.4). Pure and Node-safe: no
 * React, no network. See lib/automationImpact.ts for how an automatic compound looks on chain.
 */
import { ROBINHOOD_POOL_MANAGER } from '../config/chainIdentity'

/** keccak256("ExecutionCompleted(bytes32,bytes32,uint8,uint256,uint256,uint64)"), DominoVaultV4's. */
export const EXECUTION_COMPLETED = '0xa75f5619abce0f39b6b0ace7eb96f20ba345b963b9799beed8451480a406cde0'
/** keccak256("Transfer(address,address,uint256)"). */
export const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
/**
 * Uniswap v4's PoolManager on Robinhood Chain. Changed on purpose 2026-10-01 (the chain2 workstream, part B, audit item
 * G3): the chain registry's (config/chainIdentity.ts), no longer a copy.
 */
export const VAULT_POOL_MANAGER = ROBINHOOD_POOL_MANAGER

/** One ExecutionCompleted of the vault whose parent is the position. */
export interface Execution {
  tx: string
  block: number
  action: number
  destination: string
}

const HASH = /^0x[0-9a-f]{64}$/
const QUANTITY = /^0x[0-9a-f]{1,16}$/
const words = (data: string) => data.slice(2).match(/.{64}/g) ?? []

/** A log's fields as text, lowercase; null when it is not a log. */
export function fieldsOf(log: unknown) {
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
  const pool = `0x${VAULT_POOL_MANAGER.slice(2).padStart(64, '0')}`
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
