import type { PortfolioResponse } from 'api-contracts/read-v6/types'
import { isV2ChainId, positionManagerOrNull, v2Chain } from '../../v2/chains'
import type { V2ChainId } from '../../v2/types'

/**
 * A receipt-backed discovery hint, never a position balance or permission to transact. Changed on purpose (2026-10-15,
 * pack 8): Robinhood Chain's too (it was Base and Arbitrum One only): its row is drawn from the list's own state reading
 * of the NFT (./positionCollection.ts withCreatedPositions), never from the receipt.
 */
export interface CreatedPosition {
  wallet: string
  chainId: V2ChainId
  positionManager: string
  dex: 3 | 4
  tokenId: string
  hash: string
  block: number
  blockHash: string
  observedAt: number
  fee: number
  tokens: readonly { address: string; symbol: string | null; decimals: number | null }[]
}
const ADDRESS = /^0x[0-9a-f]{40}$/i, HASH = /^0x[0-9a-f]{64}$/i
const KEEP = 24 * 60 * 60_000
const EMPTY: readonly CreatedPosition[] = Object.freeze([])
export const createdPositionKey = (item: Pick<CreatedPosition, 'chainId' | 'positionManager' | 'tokenId'>) => `${item.chainId}:${item.positionManager.toLowerCase()}:${item.tokenId}`

function valid(item: CreatedPosition, wallet: string, now: number): boolean {
  return !!item && typeof item === 'object' && typeof item.wallet === 'string' && ADDRESS.test(item.wallet) && item.wallet.toLowerCase() === wallet
    && isV2ChainId(item.chainId) && (item.dex === 3 || item.dex === 4)
    && typeof item.positionManager === 'string' && item.positionManager.toLowerCase() === positionManagerOrNull(v2Chain(item.chainId), item.dex)
    && typeof item.tokenId === 'string' && /^[1-9][0-9]{0,77}$/.test(item.tokenId)
    && typeof item.hash === 'string' && HASH.test(item.hash) && typeof item.blockHash === 'string' && HASH.test(item.blockHash)
    && Number.isSafeInteger(item.block) && item.block > 0 && Number.isSafeInteger(item.observedAt) && item.observedAt <= now && now - item.observedAt < KEEP
    && Number.isInteger(item.fee) && item.fee >= 0 && item.fee <= 0xffffff
    && Array.isArray(item.tokens) && item.tokens.length === 2 && item.tokens.every(token => token && typeof token.address === 'string' && ADDRESS.test(token.address)
      && (token.symbol === null || (typeof token.symbol === 'string' && token.symbol.length <= 128))
      && (token.decimals === null || (Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 255)))
    && item.tokens[0].address.toLowerCase() !== item.tokens[1].address.toLowerCase()
}

/** Session storage helps a reload find the NFT. Restored hints cannot supply live figures or finality. */
export function createCreatedPositionStore(storage: Pick<Storage, 'getItem' | 'setItem'> | null, now = Date.now) {
  const values = new Map<string, readonly CreatedPosition[]>()
  const listeners = new Map<string, Set<() => void>>()
  const storageKey = (wallet: string) => `domino:created-positions:v1:${wallet}`
  const get = (wallet: string): readonly CreatedPosition[] => {
    const key = wallet.toLowerCase()
    if (!values.has(key)) {
      let rows = EMPTY
      try {
        const text = storage?.getItem(storageKey(key))
        const raw = text && text.length <= 64_000 ? JSON.parse(text) : null
        if (Array.isArray(raw) && raw.length <= 32) rows = raw.filter(item => valid(item, key, now()))
      } catch { /* Discovery continues without storage. */ }
      values.set(key, rows)
    }
    return values.get(key) ?? EMPTY
  }
  const save = (wallet: string, rows: readonly CreatedPosition[]) => {
    values.set(wallet, rows)
    try { storage?.setItem(storageKey(wallet), JSON.stringify(rows)) } catch { /* Never turn a successful transaction into an error. */ }
    for (const listener of listeners.get(wallet) ?? []) listener()
  }
  return {
    get,
    record(item: CreatedPosition) {
      const wallet = item.wallet.toLowerCase()
      if (!valid(item, wallet, now())) return
      const old = get(wallet)
      const known = old.find(row => createdPositionKey(row) === createdPositionKey(item))
      if (known?.hash === item.hash && known.blockHash === item.blockHash) return
      save(wallet, [structuredClone(item), ...old.filter(row => createdPositionKey(row) !== createdPositionKey(item) && valid(row, wallet, now()))].slice(0, 32))
    },
    reconcile(body: PortfolioResponse) {
      const wallet = body.wallet.toLowerCase(), old = get(wallet)
      const rows = old.filter(item => valid(item, wallet, now()) && !body.positions.some(position => createdPositionKey(position) === createdPositionKey(item)
        && position.state.status === 'live' && position.state.snapshot.number >= item.block))
      if (rows.length !== old.length) save(wallet, rows)
    },
    rollback(chainId: number, blockHash: string) {
      for (const [wallet, old] of values) {
        const rows = old.filter(item => item.chainId !== chainId || item.blockHash.toLowerCase() !== blockHash.toLowerCase())
        if (rows.length !== old.length) save(wallet, rows)
      }
    },
    /**
     * (2026-10-15, pack 8 review, L2): a reading the page already holds shows these NFTs burned or closed at `block`, at
     * or past a hint's own block: those hints go. A create then a burn before read-v6 listed the NFT left its hint for a
     * day: an "Updating" row with nothing to read, and its NFT asked of the state route in every batch.
     */
    ended(chainId: number, positionManager: string, tokenIds: readonly string[], block: number) {
      if (!tokenIds.length || !Number.isSafeInteger(block)) return
      const manager = positionManager.toLowerCase()
      for (const [wallet, old] of values) {
        const rows = old.filter(item => !(item.chainId === chainId && item.positionManager.toLowerCase() === manager && tokenIds.includes(item.tokenId) && block >= item.block))
        if (rows.length !== old.length) save(wallet, rows)
      }
    },
    subscribe(wallet: string, listener: () => void) {
      const key = wallet.toLowerCase(), found = listeners.get(key) ?? new Set<() => void>()
      found.add(listener); listeners.set(key, found)
      return () => { found.delete(listener); if (!found.size) listeners.delete(key) }
    },
  }
}
let storage: Storage | null = null
try { storage = typeof sessionStorage === 'undefined' ? null : sessionStorage } catch { /* Private browsing. */ }
export const CREATED_POSITIONS = createCreatedPositionStore(storage)

/**
 * (2026-10-15, pack 8 review, L2): the blocks a later reading shows replaced: read-v6 lists a transaction this tab kept
 * (a hint's or a session receipt's: `kept`) in another block of the same chain. No read is made for it. Pure.
 */
export function replacedBlocks(kept: readonly { chainId: number; hash: string; blockHash: string }[], items: readonly { chainId: number; tx: { hash: string; snapshot: { hash: string } } }[]): { chainId: number; blockHash: string }[] {
  const out = new Map<string, { chainId: number; blockHash: string }>()
  for (const item of kept) {
    const listed = items.find(one => one.chainId === item.chainId && one.tx.hash.toLowerCase() === item.hash.toLowerCase())
    if (listed && listed.tx.snapshot.hash.toLowerCase() !== item.blockHash.toLowerCase()) out.set(`${item.chainId}:${item.blockHash.toLowerCase()}`, { chainId: item.chainId, blockHash: item.blockHash.toLowerCase() })
  }
  return [...out.values()]
}
