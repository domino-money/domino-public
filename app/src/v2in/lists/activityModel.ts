import type { ActivityResponse, PortfolioResponse } from 'api-contracts/read-v6/types'
import type { ExecutionItem } from '../../finance/execution'
import type { ReceiptView } from './model'
import type { ActivityItem } from './activityHistory'

export interface ActivityPosition { chainId: number; dex: 3 | 4; tokenId: string }

/** Correlate only identities present in receipts/portfolio, never symbols or a matching token id on another DEX.
 * A vault-wide setting belongs to every position known to be in that vault. A wallet-wide nonce invalidation does
 * not identify a position and stays in wallet history. Discovery includes old creation/registration receipts so a
 * bounded current portfolio is not the only source of historical membership.
 */
export function positionActivity(items: readonly ActivityItem[], position: ActivityPosition, portfolio: PortfolioResponse | null): ActivityItem[] {
  const { chainId, dex, tokenId } = position
  const vaults = new Set<string>()
  const vaultDex = new Map<string, number>()
  const mandates = new Set<string>()
  for (const vault of portfolio?.vaults ?? []) if (vault.chainId === chainId) {
    vaultDex.set(vault.address.toLowerCase(), vault.dex)
    if (vault.dex === dex && (vault.rootTokenId === tokenId || vault.members.some((member) => member.tokenId === tokenId))) vaults.add(vault.address.toLowerCase())
  }
  for (const found of portfolio?.positions ?? []) if (found.chainId === chainId && found.dex === dex && found.tokenId === tokenId && found.vault) vaults.add(found.vault.address.toLowerCase())
  for (const item of items) if (item.chainId === chainId && item.kind === 'vault_created') {
    vaultDex.set(item.vault.toLowerCase(), item.dex)
    if (item.dex === dex && item.rootTokenId === tokenId) vaults.add(item.vault.toLowerCase())
  }
  for (const item of items) if (item.chainId === chainId && 'vault' in item && item.vault && vaultDex.get(item.vault.toLowerCase()) === dex) {
    if ((item.kind === 'vault_execution' && (item.compounded.tokenId === tokenId || item.successor?.tokenId === tokenId || item.successor?.parentTokenId === tokenId))
      || ((item.kind === 'auto_exit' || item.kind === 'auto_exit_event') && item.tokenId === tokenId)) vaults.add(item.vault.toLowerCase())
  }
  for (const mandate of portfolio?.mandates ?? []) if (mandate.chainId === chainId && mandate.tokenId === tokenId && vaults.has(mandate.vault.toLowerCase())) mandates.add(mandate.mandateHash)
  for (const item of items) if (item.chainId === chainId && item.kind === 'auto_exit_event' && item.tokenId === tokenId && item.vault && vaults.has(item.vault.toLowerCase()) && item.mandateHash) mandates.add(item.mandateHash)
  return items.filter((item) => {
    if (item.chainId !== chainId) return false
    if (item.kind === 's1_action') return item.steps.some((step) => step.pool.dex === dex && step.tokenId === tokenId)
      || ((item.tokenId === tokenId || item.previousTokenId === tokenId) && item.steps.some((step) => step.pool.dex === dex))
    if (item.kind === 'zap_event') return false
    if (item.kind === 'auto_exit_event' && item.mandateHash && mandates.has(item.mandateHash)) return true
    if (!('vault' in item) || !item.vault || !vaults.has(item.vault.toLowerCase())) return false
    if (item.kind === 'auto_exit' || item.kind === 'auto_exit_event') return item.tokenId === null || item.tokenId === tokenId
    if (item.kind === 'vault_execution') return item.compounded.tokenId === tokenId || item.successor?.tokenId === tokenId || item.successor?.parentTokenId === tokenId
    return true
  })
}

export type TimelineRow = { id: string; at: number | null } & (
  { kind: 'public'; receipt: ReceiptView } | { kind: 'private'; item: ExecutionItem }
)

/** A timestamp is reused only from the same chain/block/hash. No estimate from block number or browser receipt time. */
export function privateTimes(items: readonly ExecutionItem[], publicItems: readonly ActivityItem[]): Map<string, number> {
  const blocks = new Map(publicItems.map((item) => [`${item.chainId}:${item.tx.snapshot.number}:${item.tx.snapshot.hash.toLowerCase()}`, item.tx.snapshot.timestamp]))
  const times = new Map<string, number>()
  for (const item of items) if (item.receipt) {
    const key = `4663:${item.receipt.blockNumberRaw}:${item.receipt.blockHash.toLowerCase()}`
    const at = blocks.get(key)
    if (at !== undefined) times.set(item.intentId, at)
  }
  return times
}

/** Each source's stable operation identity is deduplicated. Different logs of one transaction are never discarded. */
export function timelineRows(receipts: readonly ReceiptView[], privateItems: readonly ExecutionItem[], times: ReadonlyMap<string, number> = new Map()): TimelineRow[] {
  const rows = new Map<string, TimelineRow>()
  for (const receipt of receipts) rows.set(`public:${receipt.id}`, { id: `public:${receipt.id}`, kind: 'public', at: receipt.at, receipt })
  for (const item of privateItems) if (item.state !== 'cancelled') rows.set(`private:${item.intentId}`, { id: `private:${item.intentId}`, kind: 'private', at: times.get(item.intentId) ?? null, item })
  return [...rows.values()].sort((a, b) => {
    if (a.at === null || b.at === null) return a.at === null ? b.at === null ? a.id.localeCompare(b.id) : 1 : -1
    return b.at - a.at || a.id.localeCompare(b.id)
  })
}

/** Whole wallet activity remains available when a portfolio is bounded. Position attribution says when it is partial. */
export const contextLimited = (portfolio: PortfolioResponse | null): boolean => portfolio === null || portfolio.truncated.vaults || portfolio.truncated.positions || portfolio.truncated.mandates

export function withItems(answer: ActivityResponse, items: ActivityItem[]): ActivityResponse { return { ...answer, items } }
