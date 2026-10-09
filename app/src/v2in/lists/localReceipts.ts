import type { ActivityResponse } from 'api-contracts/read-v6/types'
import { isV2ChainId, v2Chain } from '../../v2/chains'
import type { V2ChainId } from '../../v2/types'

/** A verified owner transaction, retained on this device. Never inserted into read-v6's indexed response. */
export interface LocalCloseReceipt {
  wallet: string
  chainId: V2ChainId
  positionManager: string
  dex: 3 | 4
  hash: string
  block: number
  blockHash: string
  tokenIds: string[]
  amounts: { token: string; amount: string | null }[]
  at: number | null
  state: 'included' | 'finalized'
  gas?: { gasUsed: string; effectiveGasPrice: string; l1Fee: string | null }
}
const ADDRESS = /^0x[0-9a-f]{40}$/i, HASH = /^0x[0-9a-f]{64}$/i, RAW = /^(0|[1-9][0-9]{0,77})$/
const EMPTY: readonly LocalCloseReceipt[] = Object.freeze([])
export const localCloseKey = (item: LocalCloseReceipt) => `${item.chainId}:${item.positionManager.toLowerCase()}:${item.hash.toLowerCase()}`

export function validLocalClose(value: unknown): value is LocalCloseReceipt {
  if (!value || typeof value !== 'object') return false
  const item = value as LocalCloseReceipt
  return typeof item.wallet === 'string' && ADDRESS.test(item.wallet) && isV2ChainId(item.chainId)
    && typeof item.positionManager === 'string' && ADDRESS.test(item.positionManager) && (item.dex === 3 || item.dex === 4)
    && item.positionManager.toLowerCase() === v2Chain(item.chainId).uniswap[item.dex === 3 ? 'v3' : 'v4'].positionManager
    && typeof item.hash === 'string' && HASH.test(item.hash) && typeof item.blockHash === 'string' && HASH.test(item.blockHash)
    && Number.isSafeInteger(item.block) && item.block > 0 && (item.at === null || (Number.isSafeInteger(item.at) && item.at > 0))
    && (item.state === 'included' || item.state === 'finalized')
    && Array.isArray(item.tokenIds) && item.tokenIds.length > 0 && item.tokenIds.length <= 40
    && item.tokenIds.every((id) => typeof id === 'string' && RAW.test(id) && id !== '0') && new Set(item.tokenIds).size === item.tokenIds.length
    && Array.isArray(item.amounts) && item.amounts.length <= 80 && item.amounts.every((entry) => entry && typeof entry.token === 'string' && ADDRESS.test(entry.token) && (entry.amount === null || (typeof entry.amount === 'string' && RAW.test(entry.amount))))
    && new Set(item.amounts.map((entry) => entry.token.toLowerCase())).size === item.amounts.length
    && (item.gas === undefined || (!!item.gas && typeof item.gas.gasUsed === 'string' && RAW.test(item.gas.gasUsed) && typeof item.gas.effectiveGasPrice === 'string' && RAW.test(item.gas.effectiveGasPrice) && (item.gas.l1Fee === null || (typeof item.gas.l1Fee === 'string' && RAW.test(item.gas.l1Fee)))))
}

export function createLocalReceiptStore(storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
  const values = new Map<string, readonly LocalCloseReceipt[]>()
  const listeners = new Map<string, Set<() => void>>()
  const keyOf = (wallet: string) => `domino:confirmed-closes:v1:${wallet.toLowerCase()}`
  const get = (wallet: string): readonly LocalCloseReceipt[] => {
    const key = wallet.toLowerCase()
    if (!values.has(key)) {
      let rows: readonly LocalCloseReceipt[] = EMPTY
      try {
        const text = storage?.getItem(keyOf(key))
        const parsed: unknown = text && text.length <= 200_000 ? JSON.parse(text) : null
        if (Array.isArray(parsed) && parsed.length <= 40 && parsed.every((item) => validLocalClose(item) && item.wallet.toLowerCase() === key)) rows = parsed
      } catch { /* Storage may be unavailable; the confirmed operation remains usable in memory. */ }
      values.set(key, rows)
    }
    return values.get(key) ?? EMPTY
  }
  return {
    get,
    record(item: LocalCloseReceipt) {
      if (!validLocalClose(item)) return
      const wallet = item.wallet.toLowerCase()
      const rows = [structuredClone(item), ...get(wallet).filter((old) => localCloseKey(old) !== localCloseKey(item))].slice(0, 40)
      values.set(wallet, rows)
      try { storage?.setItem(keyOf(wallet), JSON.stringify(rows)) } catch { /* No false transaction failure for storage denial. */ }
      for (const listener of listeners.get(wallet) ?? []) listener()
    },
    forget(wallet: string, chainId: V2ChainId, positionManager: string, hash: string) {
      const key = wallet.toLowerCase()
      const old = get(key), rows = old.filter((item) => item.chainId !== chainId || item.positionManager.toLowerCase() !== positionManager.toLowerCase() || item.hash.toLowerCase() !== hash.toLowerCase())
      if (rows.length === old.length) return
      values.set(key, rows)
      try { storage?.setItem(keyOf(key), JSON.stringify(rows)) } catch { /* Keep the corrected in-memory view. */ }
      for (const listener of listeners.get(key) ?? []) listener()
    },
    subscribe(wallet: string, listener: () => void) {
      const key = wallet.toLowerCase(), found = listeners.get(key) ?? new Set<() => void>()
      found.add(listener); listeners.set(key, found)
      return () => { found.delete(listener); if (!found.size) listeners.delete(key) }
    },
  }
}
let storage: Storage | null = null
try { storage = typeof localStorage === 'undefined' ? null : localStorage } catch { /* Private browsing. */ }
export const LOCAL_RECEIPTS = createLocalReceiptStore(storage)
export const recordLocalClose = (item: LocalCloseReceipt): void => LOCAL_RECEIPTS.record(item)
export const forgetLocalClose = (wallet: string, chainId: V2ChainId, positionManager: string, hash: string): void => LOCAL_RECEIPTS.forget(wallet, chainId, positionManager, hash)

/** A tx match alone cannot hide a receipt: prove the same manager, exits, NFT set and token totals. */
export function publicCloseProves(local: LocalCloseReceipt, items: readonly ActivityResponse['items'][number][]): boolean {
  const manager = v2Chain(local.chainId).uniswap[local.dex === 3 ? 'v3' : 'v4'].positionManager
  if (manager.toLowerCase() !== local.positionManager.toLowerCase() || local.amounts.some((entry) => entry.amount === null)) return false
  const same = items.filter((item) => item.chainId === local.chainId && item.tx.hash.toLowerCase() === local.hash.toLowerCase()
    && item.tx.snapshot.number === local.block && item.tx.snapshot.hash.toLowerCase() === local.blockHash.toLowerCase())
  const exits = same.filter((item): item is Extract<ActivityResponse['items'][number], { kind: 's1_action' }> => item.kind === 's1_action' && item.action === 'exit')
  if (!exits.length) return false
  const ids = new Set(exits.flatMap((item) => item.steps.filter((step) => step.pool.dex === local.dex && BigInt(step.liquidityDelta) < 0n).map((step) => step.tokenId)))
  if (ids.size !== local.tokenIds.length || local.tokenIds.some((id) => !ids.has(id))) return false
  const amounts = new Map(local.amounts.map((entry) => [entry.token.toLowerCase(), BigInt(entry.amount!)]))
  for (const item of exits) for (const refund of item.refunds) amounts.set(refund.token.toLowerCase(), (amounts.get(refund.token.toLowerCase()) ?? 0n) - BigInt(refund.amount))
  return [...amounts.values()].every((amount) => amount === 0n)
}
