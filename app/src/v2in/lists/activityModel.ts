import type { ActivityResponse, PortfolioResponse } from 'api-contracts/read-v6/types'
import type { ExecutionItem } from '../../finance/execution'
import type { ReceiptView } from './model'
import type { ActivityItem } from './activityHistory'
import { compareChronology, logIndexOf, type Chronology } from './chronology'
import { localCloseKey, publicCloseProves, type LocalCloseReceipt } from './localReceipts'
import type { ConfirmedOperation, OperationReceipt, OperationScope } from '../../lib/confirmedOperations'

/** read-v6 has already validated finality against this chain's finalized snapshot. Reuse that evidence for an operation
 * this browser sent, without another RPC or inventing the NFT effects of a historical transaction.
 *
 * Changed on purpose 2026-10-14 (incident C2: the 429 on /api/chain/v1/confirmation). An unfinalized receipt the queue
 * did not know was handed to it as a new operation, up to 32 per answer, and on Robinhood Chain the queue then read each
 * from the node until its block was final: opening Receipts or a position was enough to start it, with nothing sent from
 * this browser. A receipt the index lists is confirmed because the index holds it and final when its own `tx.finality`
 * says so (model.ts receiptOf); it needs nothing from the queue. Only the exact inclusion the financial client already
 * checked is completed here: the same wallet, transaction, block number and block hash, once the index calls it final.
 */
export function indexedOperationEvidence(wallet: string, answer: Pick<ActivityResponse, 'wallet' | 'items'>, known: readonly ConfirmedOperation[]) {
  const owner = wallet.toLowerCase()
  const result: (OperationScope & { chainId: number; wallet: string; receipt: OperationReceipt })[] = []
  if (answer.wallet.toLowerCase() !== owner) return result
  const seen = new Set<string>()
  for (const item of answer.items) {
    const hash = item.tx.hash.toLowerCase(), blockHash = item.tx.snapshot.hash.toLowerCase()
    const identity = `${item.chainId}:${hash}`
    if (seen.has(identity)) continue
    seen.add(identity)
    const old = known.find(operation => operation.chainId === item.chainId && operation.hash === hash)
    if (!old || old.wallet !== owner || old.blockHash !== blockHash || old.block !== item.tx.snapshot.number
      || old.phase !== 'included' || item.tx.finality !== 'finalized') continue
    result.push({ indexed: true, chainId: item.chainId, wallet: owner, tokenIds: [], receipt: {
      transactionHash: hash, blockHash, blockNumber: BigInt(item.tx.snapshot.number), state: 'finalized',
    } })
    if (result.length >= 32) break
  }
  return result
}

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

export type TimelineRow = Chronology & (
  { kind: 'public'; receipt: ReceiptView; receipts: ReceiptView[]; evidence: ExecutionItem[]; events: ActivityItem[]; showGas: boolean }
  | { kind: 'private'; item: ExecutionItem } | { kind: 'local'; item: LocalCloseReceipt }
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

const financial = (item: ActivityItem) => item.kind === 's1_action' || item.kind === 'vault_execution' || item.kind === 'auto_exit'
const transactionKey = (item: ActivityItem) => `${item.chainId}:${item.tx.snapshot.hash.toLowerCase()}:${item.tx.hash.toLowerCase()}`
const vaultOf = (item: ActivityItem) => 'vault' in item && item.vault ? item.vault.toLowerCase() : null
const operationKey = (item: ActivityItem): string => item.kind === 's1_action' ? `s1:${item.intentHash}`
  : item.kind === 'vault_execution' ? `run:${item.vault}:${item.planHash}`
    : item.kind === 'auto_exit' ? `exit:${item.mandateHash}`
      : item.kind === 'auto_exit_event' ? `exit-event:${item.mandateHash ?? item.id}:${item.event}`
        : `vault:${vaultOf(item) ?? item.id}`

/** Only one matching financial effect can absorb auxiliary settings. Separate operations in the same tx survive. */
function operationOf(item: ActivityItem, siblings: readonly ActivityItem[]): string {
  if (financial(item) || item.kind === 'auto_exit_event') return operationKey(item)
  const vault = vaultOf(item)
  if (vault) {
    const matches = siblings.filter((other) => vaultOf(other) === vault && financial(other))
    if (matches.length === 1) return operationKey(matches[0])
    const registered = siblings.filter((other) => vaultOf(other) === vault && other.kind === 'auto_exit_event' && other.event === 'MandateRegistered')
    if (matches.length === 0 && registered.length === 1 && (item.kind === 'vault_created' || item.kind === 'vault_event')) return operationKey(registered[0])
  }
  return operationKey(item)
}

/** Matching a tx alone is insufficient: this private compound must prove the same liquidity and currency fees. */
function sameExecution(privateItem: ExecutionItem, item: ActivityItem): boolean {
  const receipt = privateItem.receipt
  if (privateItem.state !== 'reconciled' || !receipt || item.kind !== 'vault_execution' || item.chainId !== 4663 || item.tx.finality !== 'finalized'
    || receipt.transactionHash.toLowerCase() !== item.tx.hash.toLowerCase() || receipt.blockHash.toLowerCase() !== item.tx.snapshot.hash.toLowerCase()
    || receipt.blockNumberRaw !== String(item.tx.snapshot.number) || receipt.liquidityIncreaseRaw !== item.compounded.liquidityAdded) return false
  const fees = new Map<string, bigint>()
  for (const source of receipt.sources) fees.set(source.currency.toLowerCase(), (fees.get(source.currency.toLowerCase()) ?? 0n) + BigInt(source.serviceFeeRaw))
  for (const tariff of item.tariffs) {
    if (tariff.kind !== 'automation' || tariff.rateBps !== receipt.serviceFeeBps) return false
    const token = tariff.token.toLowerCase()
    fees.set(token, (fees.get(token) ?? 0n) - BigInt(tariff.amount))
  }
  return [...fees.values()].every((value) => value === 0n)
}

const importance = (view: ReceiptView) => ['auto_exit', 'vault_execution', 's1_action', 'auto_exit_event', 'vault_event', 'reserves_returned', 'vault_created'].indexOf(view.kind)

/** Operations retain all original event identities. A group's gas is displayed once, never added per event. */
export function timelineRows(receipts: readonly ReceiptView[], privateItems: readonly ExecutionItem[], times: ReadonlyMap<string, number> = new Map(), publicItems: readonly ActivityItem[] = [], local: readonly LocalCloseReceipt[] = []): TimelineRow[] {
  const rows = new Map<string, TimelineRow>()
  const events = new Map(publicItems.map((item) => [item.id, item]))
  const transactions = new Map<string, ActivityItem[]>()
  for (const item of publicItems) {
    const key = transactionKey(item)
    transactions.set(key, [...(transactions.get(key) ?? []), item])
  }
  for (const receipt of new Map(receipts.map((view) => [view.id, view])).values()) {
    const item = events.get(receipt.id)
    const id = item ? `public:${transactionKey(item)}:${operationOf(item, transactions.get(transactionKey(item)) ?? [])}` : `public:${receipt.id}`
    const found = rows.get(id)
    const point = { id, at: receipt.at, chainId: receipt.chainId, block: receipt.block, logIndex: logIndexOf(receipt.id) }
    if (found?.kind === 'public') {
      found.receipts.push(receipt)
      if (item) found.events.push(item)
      if (importance(receipt) >= 0 && (importance(found.receipt) < 0 || importance(receipt) < importance(found.receipt))) found.receipt = receipt
      if (compareChronology(point, found) < 0) Object.assign(found, point)
    } else rows.set(id, { ...point, kind: 'public', receipt, receipts: [receipt], evidence: [], events: item ? [item] : [], showGas: true })
  }
  for (const item of new Map(privateItems.map((value) => [value.intentId, value])).values()) if (item.state !== 'cancelled') {
    const matches = [...rows.values()].filter((row) => row.kind === 'public' && row.events.filter((event) => sameExecution(item, event)).length === 1)
    if (matches.length === 1 && matches[0].kind === 'public') matches[0].evidence.push(item)
    else rows.set(`private:${item.intentId}`, { id: `private:${item.intentId}`, kind: 'private', at: times.get(item.intentId) ?? null, chainId: 4663, block: item.receipt?.blockNumberRaw, item })
  }
  for (const item of local) if (!publicCloseProves(item, publicItems)) {
    const block = publicItems.find((event) => event.chainId === item.chainId && event.tx.snapshot.number === item.block && event.tx.snapshot.hash.toLowerCase() === item.blockHash.toLowerCase())
    const id = `local:${localCloseKey(item)}`
    rows.set(id, { id, kind: 'local', item, at: item.at ?? block?.tx.snapshot.timestamp ?? null, chainId: item.chainId, block: item.block })
  }
  const sorted = [...rows.values()].sort(compareChronology)
  const gasTransactions = new Set<string>()
  for (const row of sorted) if (row.kind === 'public') {
    const key = `${row.receipt.chainId}:${row.receipt.block}:${row.receipt.hash.toLowerCase()}`
    row.showGas = !gasTransactions.has(key)
    gasTransactions.add(key)
  }
  return sorted
}

/** Whole wallet activity remains available when a portfolio is bounded. Position attribution says when it is partial. */
export const contextLimited = (portfolio: PortfolioResponse | null): boolean => portfolio === null || portfolio.truncated.vaults || portfolio.truncated.positions || portfolio.truncated.mandates

export function withItems(answer: ActivityResponse, items: ActivityItem[]): ActivityResponse { return { ...answer, items } }

/**
 * Added 2026-10-15 (pack 7): how long after an action of this browser's (in any of its tabs) a wallet's activity head keeps
 * its minute (activity.tsx notes each one in this browser's storage). Longer than any catch-up after an action (five
 * minutes) and than the hold a confirmed action puts on a wallet's rows (positionSync.ts WALLET_HOLD_MS).
 */
export const OWN_ACTION_QUIET_MS = 600_000

/**
 * Added 2026-10-15 (pack 7): whether nothing of this browser's own concerns `wallet`, so its activity head may take its idle
 * period (activityHistory.ts IDLE_HEAD_DELAY): no operation this tab recorded for it (any phase), no created position still
 * waiting for the index, no close kept on this device that the receipts held (`items`) do not prove yet, and no action of
 * this browser in any tab within OWN_ACTION_QUIET_MS (`ownActionAt`, ms; a time ahead of `now` counts as recent). Pure.
 */
export function quietWallet(wallet: string, items: readonly ActivityItem[], facts: {
  operations: readonly Pick<ConfirmedOperation, 'wallet'>[]
  created: number
  local: readonly LocalCloseReceipt[]
  ownActionAt: number | null
  now: number
  /** (2026-10-15, pack 8): any automation of the wallet is on (automationOn): its head keeps main's minute, never idle. */
  automated?: boolean
}): boolean {
  const key = wallet.toLowerCase()
  if (facts.automated) return false
  if (facts.operations.some((operation) => operation.wallet.toLowerCase() === key)) return false
  if (facts.created > 0) return false
  if (facts.local.some((close) => !publicCloseProves(close, items))) return false
  return facts.ownActionAt === null || facts.now - facts.ownActionAt >= OWN_ACTION_QUIET_MS
}

/**
 * Added (2026-10-15, pack 8; the owner: every compound must reach Receipts quickly): whether any automation of `wallet` is
 * on in the portfolio answer the page already holds: a vault of its own that is armed (or not known disarmed) and not
 * paused, or an Auto-exit order of its own. The backend's keeper acts for such a wallet with nothing sent from here, so
 * its receipts come only from the activity head: its head keeps main's minute (quietWallet), never the idle two. Pure.
 */
export function automationOn(wallet: string, portfolio: Pick<PortfolioResponse, 'wallet' | 'vaults' | 'mandates'> | null): boolean {
  const key = wallet.toLowerCase()
  if (!portfolio || portfolio.wallet.toLowerCase() !== key) return false
  return portfolio.vaults.some((vault) => vault.owner.toLowerCase() === key && vault.custody.armed !== false && vault.pausedBy === null && !(vault.state.status === 'read' && vault.state.paused))
    || portfolio.mandates.some((mandate) => mandate.owner.toLowerCase() === key)
}
