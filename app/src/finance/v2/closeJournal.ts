import { isV2ChainId, positionManagerOrNull, v2Chain } from '../../v2/chains'
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
  // A row of a version the chain lacks (v3 on a chain with v4 alone) names no manager of it: never kept.
  if (row.positionManager !== positionManagerOrNull(chain, row.dex)) return false
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
  // Changed on purpose 2026-10-14 (incident C3): a close may wait for its proof among the included ones (below). That list
  // unreadable, this settles what it did before; the list then holds every direct exit (`unavailable`), as this one does.
  try {
    const included = readIncluded()
    if (included.some((row) => same(row, value))) writeIncluded(included.filter((row) => !same(row, value)))
  } catch { /* said by every later read of the list */ }
}) }

/**
 * Added 2026-10-14 (incident C3: screens finish at inclusion). "Close positions" was done only once its block was final,
 * about 16 minutes per group on Robinhood Chain, and its next group waited that long. Now a group is done once its close
 * is in a block with success, and its intent moves here, under its own key, until the chain's finalized block passes it
 * (today's protection kept, the owner's design §2.1): its positions stay held from any other direct exit
 * (finance/v2/direct.ts heldByJournal), and the next group's intent may take the one unresolved place a wallet has
 * above. A page from before this change reads only that place, so it never meets two rows of one wallet.
 * A row here is settled by the money client's own final read (settleClose), registered with the confirmation queue
 * on Robinhood Chain and with the shared receipt follow elsewhere (v2in/lists/BulkClosePositions.tsx). At most 8.
 *
 * Changed on purpose 2026-10-14 (C3 review): at most 8 per wallet, 64 in all (8 wallets, as the unresolved places
 * above). The 8 were the whole browser's, so closes another wallet of the same browser left waiting (a reload before
 * finality, then another account) took the room, and every later group waited for finality again.
 */
export interface IncludedClose extends PendingClose {
  hash: Hex
  block: number
  blockHash: Hex
}
export const CLOSE_INCLUDED_KEY = 'domino.included-close.v1'
/** How many included closes wait at once: per wallet, and in all. */
const INCLUDED_PER_WALLET = 8
const INCLUDED_IN_ALL = 64
function validIncluded(value: unknown): value is IncludedClose {
  if (!valid(value)) return false
  const row = value as IncludedClose
  return row.hash !== null && Number.isSafeInteger(row.block) && row.block > 0 && typeof row.blockHash === 'string' && hash.test(row.blockHash)
}
function readIncluded(): IncludedClose[] {
  try {
    const raw = localStorage.getItem(CLOSE_INCLUDED_KEY)
    if (raw === null) return []
    if (raw.length > 600_000) return unavailable()
    const rows: unknown = JSON.parse(raw)
    if (!Array.isArray(rows) || rows.length > INCLUDED_IN_ALL || !rows.every(validIncluded)) return unavailable()
    return rows
  } catch { return unavailable() }
}
function writeIncluded(rows: IncludedClose[]): void {
  try {
    const value = JSON.stringify(rows)
    localStorage.setItem(CLOSE_INCLUDED_KEY, value)
    if (localStorage.getItem(CLOSE_INCLUDED_KEY) !== value) unavailable()
  } catch { unavailable() }
}
/** The closes of this wallet in a block and not final yet: their positions stay held. */
export const includedCloses = (wallet: string): IncludedClose[] => readIncluded().filter((row) => row.wallet === wallet.toLowerCase())
/**
 * The unresolved intent `value`, proved in a block, moves among the included ones. Refused (`signature_journal_full`)
 * when 8 of this wallet (or 64 in all) wait there already: the intent then stays where it is, and the next group waits
 * for it as before.
 */
export function includedClose(value: PendingClose, txHash: Hex, block: number, blockHash: Hex): Promise<IncludedClose> { return locked(() => {
  const row: IncludedClose = { ...value, hash: txHash, block, blockHash }
  if (!validIncluded(row)) return unavailable()
  const included = readIncluded().filter((one) => !same(one, value))
  if (included.filter((one) => one.wallet === value.wallet).length >= INCLUDED_PER_WALLET || included.length >= INCLUDED_IN_ALL) throw new Error('signature_journal_full')
  // Written among the included first: a failure between the two writes leaves the intent held in both, never in neither.
  writeIncluded([...included, row])
  write(read().filter((one) => !same(one, value)))
  return row
}) }
/**
 * A close whose block left the chain: back to the unresolved place, with its hash, so the dialog checks it again ("Check
 * status"; nothing is offered again). When that place is taken by a newer intent, it stays held here. True when it moved.
 */
export function reopenClose(value: IncludedClose): Promise<boolean> { return locked(() => {
  const rows = read()
  const included = readIncluded()
  if (!included.some((row) => same(row, value)) || rows.some((row) => row.wallet === value.wallet) || rows.length >= 8) return false
  const { wallet, chainId, positionManager, dex, tokenIds, data, nonce, hash: txHash } = value
  write([...rows, { wallet, chainId, positionManager, dex, tokenIds, data, nonce, hash: txHash }])
  writeIncluded(included.filter((row) => !same(row, value)))
  return true
}) }
