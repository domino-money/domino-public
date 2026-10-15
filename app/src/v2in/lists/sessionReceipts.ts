import type { ActivityResponse } from 'api-contracts/read-v6/types'
import { isV2ChainId, v2Chain } from '../../v2/chains'
import type { V2ChainId } from '../../v2/types'
import type { ActivityPosition } from './activityModel'

/**
 * Added (2026-10-15, pack 8): a receipt of the person's own action, checked in this browser, shown in Receipts and in the
 * position's Activity at once, until read-v6 lists the same transaction (10 to 70 s on Robinhood Chain, its index's lag).
 * Then the indexed item takes its place in the same render: the row is never doubled, and nothing blinks between the two.
 *
 * Everything here is what the money client already verified for the screen that sent the transaction (its receipt in a
 * block with success, read by the zap's receipt reader or by the direct exit's): the action, the NFT, the block, the
 * amounts its own reader decoded, the gas the receipt states, and the block's time from the header the client read to
 * check the block (null when that read named none: then no time is drawn, never this page's clock). Nothing is asked of
 * any node or gateway for it. Kept in this tab's session storage, so a reload inside the index's lag keeps the row; never
 * inserted into read-v6's answer.
 */
export type SessionAction = 'create' | 'increase' | 'change_range' | 'exit' | 'collect'
export type SessionLine =
  | { kind: 'paid-in'; token: string; amount: string }
  | { kind: 'swapped'; tokenIn: string; tokenOut: string; amountIn: string; amountOut: string }
  | { kind: 'added' | 'removed' | 'collected'; tokenId: string; amounts: readonly { token: string; amount: string }[] }
  | { kind: 'returned'; token: string; amount: string | null }

export interface SessionReceipt {
  wallet: string
  chainId: V2ChainId
  positionManager: string
  dex: 3 | 4
  hash: string
  block: number
  blockHash: string
  /** The block's time (Unix seconds) from the header the money client read; null when it named none. */
  at: number | null
  /** When this page saw it in its block (ms, this page's clock): order and expiry only, never drawn. */
  observedAt: number
  state: 'included' | 'finalized'
  action: SessionAction
  tokenId: string
  previousTokenId: string | null
  lines: readonly SessionLine[]
  /** The Domino fee as the receipt's FeeCharged says it; null when none was charged. */
  fee: { token: string; amount: string } | null
  gas: { sender: string; gasUsed: string; effectiveGasPrice: string; l1Fee: string | null } | null
  /** The names the sending screen held for the tokens (symbol, decimals), for the words; read-v6's own come first. */
  tokens: readonly { address: string; symbol: string | null; decimals: number | null }[]
}

const ADDRESS = /^0x[0-9a-f]{40}$/i, HASH = /^0x[0-9a-f]{64}$/i, RAW = /^(0|[1-9][0-9]{0,77})$/, ID = /^[1-9][0-9]{0,77}$/
const ACTIONS: readonly SessionAction[] = ['create', 'increase', 'change_range', 'exit', 'collect']
/** As long as a created position's hint (./createdPositions.ts): a day. A direct exit is never indexed, so it ends here. */
const KEEP = 24 * 60 * 60_000
const MAX = 32
const EMPTY: readonly SessionReceipt[] = Object.freeze([])
export const sessionReceiptKey = (item: Pick<SessionReceipt, 'chainId' | 'hash'>) => `${item.chainId}:${item.hash.toLowerCase()}`

const address = (value: unknown): value is string => typeof value === 'string' && ADDRESS.test(value)
const raw = (value: unknown): value is string => typeof value === 'string' && RAW.test(value)
function validLine(line: SessionLine): boolean {
  if (!line || typeof line !== 'object') return false
  switch (line.kind) {
    case 'paid-in': return address(line.token) && raw(line.amount)
    case 'swapped': return address(line.tokenIn) && address(line.tokenOut) && raw(line.amountIn) && raw(line.amountOut)
    case 'returned': return address(line.token) && (line.amount === null || raw(line.amount))
    case 'added': case 'removed': case 'collected':
      return typeof line.tokenId === 'string' && ID.test(line.tokenId) && Array.isArray(line.amounts) && line.amounts.length === 2 && line.amounts.every((entry) => entry && address(entry.token) && raw(entry.amount))
  }
  return false
}

export function validSessionReceipt(value: unknown, wallet: string, now: number): value is SessionReceipt {
  if (!value || typeof value !== 'object') return false
  const item = value as SessionReceipt
  return address(item.wallet) && item.wallet.toLowerCase() === wallet && isV2ChainId(item.chainId) && (item.dex === 3 || item.dex === 4)
    && typeof item.positionManager === 'string' && item.positionManager.toLowerCase() === v2Chain(item.chainId).uniswap[item.dex === 3 ? 'v3' : 'v4'].positionManager
    && typeof item.hash === 'string' && HASH.test(item.hash) && typeof item.blockHash === 'string' && HASH.test(item.blockHash)
    && Number.isSafeInteger(item.block) && item.block > 0 && (item.at === null || (Number.isSafeInteger(item.at) && item.at > 0))
    && Number.isSafeInteger(item.observedAt) && item.observedAt <= now && now - item.observedAt < KEEP
    && (item.state === 'included' || item.state === 'finalized') && ACTIONS.includes(item.action)
    && typeof item.tokenId === 'string' && ID.test(item.tokenId) && (item.previousTokenId === null || (typeof item.previousTokenId === 'string' && ID.test(item.previousTokenId)))
    && Array.isArray(item.lines) && item.lines.length <= 40 && item.lines.every(validLine)
    && (item.fee === null || (!!item.fee && address(item.fee.token) && raw(item.fee.amount)))
    && (item.gas === null || (!!item.gas && address(item.gas.sender) && raw(item.gas.gasUsed) && raw(item.gas.effectiveGasPrice) && (item.gas.l1Fee === null || raw(item.gas.l1Fee))))
    && Array.isArray(item.tokens) && item.tokens.length <= 8 && item.tokens.every((token) => token && address(token.address)
      && (token.symbol === null || (typeof token.symbol === 'string' && token.symbol.length <= 128))
      && (token.decimals === null || (Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 255)))
}

/** Whether read-v6 lists this transaction: any of its items of the same chain and hash. */
export const sessionReceiptIndexed = (item: Pick<SessionReceipt, 'chainId' | 'hash'>, indexed: readonly ActivityResponse['items'][number][]): boolean =>
  indexed.some((one) => one.chainId === item.chainId && one.tx.hash.toLowerCase() === item.hash.toLowerCase())

/**
 * The session receipts to draw: the wallet's own, not yet listed by read-v6 (`indexed`, the items the page holds), and
 * for a position's Activity only those that name it (its NFT, or the one it came from), newest first.
 * (2026-10-15, pack 8 review, L5): none older than KEEP at `now`: a tab open for more than a day held them in memory
 * (the store checks their age only when it reads storage or records one).
 */
export function sessionReceipts(wallet: string | null, entries: readonly SessionReceipt[], indexed: readonly ActivityResponse['items'][number][], position?: ActivityPosition, now: number = Date.now()): SessionReceipt[] {
  if (!wallet) return []
  const key = wallet.toLowerCase()
  return entries.filter((item) => item.wallet.toLowerCase() === key && now - item.observedAt < KEEP && !sessionReceiptIndexed(item, indexed)
    && (!position || (item.chainId === position.chainId && item.dex === position.dex && (item.tokenId === position.tokenId || item.previousTokenId === position.tokenId
      || item.lines.some((line) => 'tokenId' in line && line.tokenId === position.tokenId)))))
    .sort((a, b) => b.observedAt - a.observedAt)
}

/** This tab's session receipts, by wallet; storage may be missing (private browsing): then they live in memory. */
export function createSessionReceiptStore(storage: Pick<Storage, 'getItem' | 'setItem'> | null, now = Date.now) {
  const values = new Map<string, readonly SessionReceipt[]>()
  const listeners = new Map<string, Set<() => void>>()
  const storageKey = (wallet: string) => `domino:session-receipts:v1:${wallet}`
  const get = (wallet: string): readonly SessionReceipt[] => {
    const key = wallet.toLowerCase()
    if (!values.has(key)) {
      let rows = EMPTY
      try {
        const text = storage?.getItem(storageKey(key))
        const parsed: unknown = text && text.length <= 200_000 ? JSON.parse(text) : null
        if (Array.isArray(parsed) && parsed.length <= MAX) rows = Object.freeze(parsed.filter((item) => validSessionReceipt(item, key, now())))
      } catch { /* The row is still drawn from memory in this tab. */ }
      values.set(key, rows)
    }
    return values.get(key) ?? EMPTY
  }
  const save = (wallet: string, rows: readonly SessionReceipt[]) => {
    values.set(wallet, Object.freeze(rows))
    try { storage?.setItem(storageKey(wallet), JSON.stringify(rows)) } catch { /* Never turn a confirmed transaction into an error. */ }
    for (const listener of listeners.get(wallet) ?? []) listener()
  }
  return {
    get,
    record(item: SessionReceipt) {
      const wallet = item.wallet.toLowerCase()
      if (!validSessionReceipt(item, wallet, now())) return
      const old = get(wallet)
      const known = old.find((row) => sessionReceiptKey(row) === sessionReceiptKey(item))
      // The same inclusion said again (a later read of the same receipt) changes nothing but a finality it reached.
      if (known && known.blockHash.toLowerCase() === item.blockHash.toLowerCase() && (known.state === 'finalized' || item.state === 'included')) return
      const kept = known && known.blockHash.toLowerCase() === item.blockHash.toLowerCase() ? { ...structuredClone(item), observedAt: known.observedAt } : structuredClone(item)
      save(wallet, [kept, ...old.filter((row) => sessionReceiptKey(row) !== sessionReceiptKey(item) && validSessionReceipt(row, wallet, now()))].slice(0, MAX))
    },
    /** What read-v6 now lists leaves storage (it was already no longer drawn). */
    reconcile(wallet: string, indexed: readonly ActivityResponse['items'][number][]) {
      const key = wallet.toLowerCase(), old = get(key)
      const rows = old.filter((item) => !sessionReceiptIndexed(item, indexed) && validSessionReceipt(item, key, now()))
      if (rows.length !== old.length) save(key, rows)
    },
    /** A block the money client found replaced: its receipts go (a checked reinclusion records them again). */
    rollback(chainId: number, blockHash: string) {
      for (const [wallet, old] of values) {
        const rows = old.filter((item) => item.chainId !== chainId || item.blockHash.toLowerCase() !== blockHash.toLowerCase())
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
export const SESSION_RECEIPTS = createSessionReceiptStore(storage)

/** The token names a screen holds, as the receipt keeps them. */
type Names = readonly { address: string; symbol: string | null; decimals: number | null }[]
const namesOf = (tokens: Names, wanted: readonly string[]) => [...new Set(wanted.map((token) => token.toLowerCase()))].slice(0, 8).map((token) => {
  const found = tokens.find((one) => one.address.toLowerCase() === token)
  return { address: token, symbol: found?.symbol ?? null, decimals: found?.decimals ?? null }
})
const ZERO = '0x0000000000000000000000000000000000000000'
interface Included {
  blockHash: string
  blockNumber: bigint
  /** The block's header time (Unix seconds), when the money client's read named it. */
  blockTimestamp?: number
  state: 'included' | 'finalized' | 'reverted' | string
  gasUsed: bigint
  effectiveGasPrice: bigint
  l1Fee: bigint | null
}
const gasOf = (wallet: string, receipt: Included) => ({ sender: wallet.toLowerCase(), gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString(), l1Fee: receipt.l1Fee === null ? null : receipt.l1Fee.toString() })
const atOf = (receipt: Included) => typeof receipt.blockTimestamp === 'number' && Number.isSafeInteger(receipt.blockTimestamp) && receipt.blockTimestamp > 0 ? receipt.blockTimestamp : null

/** The decoded zap receipt's shape this needs (finance/v2/receipt.ts ZapReceipt). */
interface ZapRead {
  summary: { actionName: 'create' | 'increase' | 'changeRange' | 'exit'; tokenId: bigint; previousTokenId: bigint }
  lines: readonly (
    | { kind: 'paid-in'; token: string; amount: bigint }
    | { kind: 'swapped'; tokenIn: string; tokenOut: string; amountIn: bigint; amountOut: bigint }
    | { kind: 'fee'; token: string; amount: bigint }
    | { kind: 'position'; step: 'added' | 'removed' | 'collected'; tokenId: bigint; amounts: readonly { token: string; amount: bigint }[] }
    | { kind: 'returned'; token: string; amount: bigint }
  )[]
  fee: { token: string; amount: bigint } | null
}

/** A zap action's session receipt (create, add, change of range, a converted withdrawal), from its decoded receipt. */
export function sessionReceiptOfZap(input: { wallet: string; chainId: V2ChainId; dex: 3 | 4; hash: string; receipt: Included; read: ZapRead; tokens: Names; now?: number }): SessionReceipt | null {
  const { receipt, read } = input
  if (receipt.state !== 'included' && receipt.state !== 'finalized') return null
  const action: SessionAction = read.summary.actionName === 'changeRange' ? 'change_range' : read.summary.actionName
  const lines: SessionLine[] = []
  for (const line of read.lines) {
    if (line.kind === 'paid-in') lines.push({ kind: 'paid-in', token: line.token.toLowerCase(), amount: line.amount.toString() })
    else if (line.kind === 'swapped') lines.push({ kind: 'swapped', tokenIn: line.tokenIn.toLowerCase(), tokenOut: line.tokenOut.toLowerCase(), amountIn: line.amountIn.toString(), amountOut: line.amountOut.toString() })
    else if (line.kind === 'position') lines.push({ kind: line.step, tokenId: line.tokenId.toString(), amounts: line.amounts.map((entry) => ({ token: entry.token.toLowerCase(), amount: entry.amount.toString() })) })
    else if (line.kind === 'returned') lines.push({ kind: 'returned', token: line.token.toLowerCase(), amount: line.amount.toString() })
  }
  const tokens = lines.flatMap((line) => line.kind === 'swapped' ? [line.tokenIn, line.tokenOut] : line.kind === 'paid-in' || line.kind === 'returned' ? [line.token] : line.amounts.map((entry) => entry.token))
  const previous = read.summary.previousTokenId > 0n && read.summary.previousTokenId !== read.summary.tokenId ? read.summary.previousTokenId.toString() : null
  return {
    wallet: input.wallet.toLowerCase(), chainId: input.chainId, dex: input.dex, positionManager: v2Chain(input.chainId).uniswap[input.dex === 3 ? 'v3' : 'v4'].positionManager,
    hash: input.hash.toLowerCase(), block: Number(receipt.blockNumber), blockHash: receipt.blockHash.toLowerCase(), at: atOf(receipt), observedAt: input.now ?? Date.now(),
    state: receipt.state, action, tokenId: read.summary.tokenId.toString(), previousTokenId: previous, lines,
    fee: read.fee ? { token: read.fee.token.toLowerCase(), amount: read.fee.amount.toString() } : null,
    gas: gasOf(input.wallet, receipt), tokens: namesOf(input.tokens, [...tokens, ...(read.fee ? [read.fee.token] : [])].filter((token) => token !== ZERO)),
  }
}

/** A direct exit's session receipt (Collect fees, or Withdraw to both tokens straight at Uniswap): what Uniswap paid. */
export function sessionReceiptOfDirect(input: { wallet: string; chainId: V2ChainId; dex: 3 | 4; tokenId: bigint; kind: 'collect' | 'close'; hash: string; receipt: Included; paid: readonly { token: string; amount: bigint | null }[]; tokens: Names; now?: number }): SessionReceipt | null {
  const { receipt } = input
  if (receipt.state !== 'included' && receipt.state !== 'finalized') return null
  const tokenId = input.tokenId.toString()
  const lines: SessionLine[] = input.kind === 'collect' && input.paid.every((entry) => entry.amount !== null)
    ? [{ kind: 'collected', tokenId, amounts: input.paid.map((entry) => ({ token: entry.token.toLowerCase(), amount: entry.amount!.toString() })) }]
    : input.paid.map((entry) => ({ kind: 'returned' as const, token: entry.token.toLowerCase(), amount: entry.amount === null ? null : entry.amount.toString() }))
  return {
    wallet: input.wallet.toLowerCase(), chainId: input.chainId, dex: input.dex, positionManager: v2Chain(input.chainId).uniswap[input.dex === 3 ? 'v3' : 'v4'].positionManager,
    hash: input.hash.toLowerCase(), block: Number(receipt.blockNumber), blockHash: receipt.blockHash.toLowerCase(), at: atOf(receipt), observedAt: input.now ?? Date.now(),
    state: receipt.state, action: input.kind === 'collect' ? 'collect' : 'exit', tokenId, previousTokenId: null, lines, fee: null,
    gas: gasOf(input.wallet, receipt), tokens: namesOf(input.tokens, input.paid.map((entry) => entry.token).filter((token) => token !== ZERO)),
  }
}
