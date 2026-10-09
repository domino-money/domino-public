import { isV2ChainId, v2Chain } from '../../v2/chains'
import type { Hex, V2ChainId } from '../../v2/types'

/** Recovery hints only. No signature, signed transaction, balance or financial authority lives here. */
export interface PendingClose {
  wallet: string
  chainId: V2ChainId
  positionManager: string
  dex: 3 | 4
  tokenIds: string[]
  data: Hex
  nonce: Hex
  hash: Hex | null
}
export const CLOSE_JOURNAL_KEY = 'domino.pending-close.v1'
const unavailable = (): never => { throw new Error('signature_journal_unavailable') }
const address = /^0x[0-9a-f]{40}$/
const hash = /^0x[0-9a-f]{64}$/
const hex = /^0x(?:[0-9a-f]{2})+$/
function valid(value: unknown): value is PendingClose {
  if (!value || typeof value !== 'object') return false
  const row = value as PendingClose
  if (!address.test(row.wallet) || !isV2ChainId(row.chainId) || ![3, 4].includes(row.dex)) return false
  const chain = v2Chain(row.chainId)
  if (row.positionManager !== (row.dex === 4 ? chain.uniswap.v4.positionManager : chain.uniswap.v3.positionManager)) return false
  return Array.isArray(row.tokenIds) && row.tokenIds.length >= 1 && row.tokenIds.length <= 2 && new Set(row.tokenIds).size === row.tokenIds.length
    && row.tokenIds.every((id) => typeof id === 'string' && /^[1-9][0-9]{0,77}$/.test(id))
    && typeof row.data === 'string' && row.data.length <= 65_536 && hex.test(row.data)
    && typeof row.nonce === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/.test(row.nonce)
    && (row.hash === null || typeof row.hash === 'string' && hash.test(row.hash))
}
function read(): PendingClose[] {
  try {
    const raw = localStorage.getItem(CLOSE_JOURNAL_KEY)
    if (raw === null) return []
    if (raw.length > 600_000) return unavailable()
    const rows: unknown = JSON.parse(raw)
    if (!Array.isArray(rows) || rows.length > 8 || !rows.every(valid) || new Set(rows.map((row) => row.wallet)).size !== rows.length) return unavailable()
    return rows
  } catch { return unavailable() }
}
function write(rows: PendingClose[]): void {
  try {
    const value = JSON.stringify(rows)
    localStorage.setItem(CLOSE_JOURNAL_KEY, value)
    if (localStorage.getItem(CLOSE_JOURNAL_KEY) !== value) unavailable()
  } catch { unavailable() }
}
export const pendingClose = (wallet: string): PendingClose | null => read().find((row) => row.wallet === wallet.toLowerCase()) ?? null
const same = (a: PendingClose, b: PendingClose) => a.wallet === b.wallet && a.chainId === b.chainId && a.positionManager === b.positionManager && a.nonce === b.nonce && a.data === b.data
function locked<T>(run: () => T): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) return Promise.reject(new Error('signature_journal_unavailable'))
  return navigator.locks.request(CLOSE_JOURNAL_KEY, run)
}
/** Must be durable before asking the wallet. Never evict an unresolved request to make room. */
export function beginClose(value: PendingClose): Promise<void> { return locked(() => {
  if (!valid(value) || value.hash !== null) return unavailable()
  const rows = read()
  if (rows.some((row) => row.wallet === value.wallet)) throw new Error('review_already_sent')
  if (rows.length >= 8) throw new Error('signature_journal_full')
  write([...rows, value])
}) }
export function rememberCloseHash(value: PendingClose, txHash: Hex, provedReplacementOf?: Hex): Promise<void> { return locked(() => {
  if (!hash.test(txHash)) return unavailable()
  const rows = read()
  const index = rows.findIndex((row) => same(row, value))
  if (index < 0 || rows[index].hash !== null && rows[index].hash !== txHash && rows[index].hash !== provedReplacementOf) return unavailable()
  rows[index] = { ...rows[index], hash: txHash }
  write(rows)
}) }
/** Call only on definite wallet refusal before acceptance or a canonical reverted/finalized receipt. */
export function settleClose(value: PendingClose): Promise<void> { return locked(() => {
  write(read().filter((row) => !same(row, value)))
}) }
