/**
 * Your positions: the position NFTs the connected wallet holds, found for it,
 * so nobody types an NFT id to see their own.
 *
 * The list comes from the site's own endpoint, POST /api/owned/v1/positions
 * (functions/_lib/owned.ts), which reads the chain's public RPC: which NFTs
 * the wallet holds, whether each is open (liquidity above zero) or closed,
 * and the setup deposits it has not turned into a position. The address
 * travels in the POST body, never in a URL, and nothing here is stored.
 *
 * The figures of each row are not in that answer. They come from the read
 * service's nft-positions read, ten ids at a time, open positions first and
 * closed ones only once their tab is opened; a row whose owner at the read's
 * block is not the wallet is dropped, and so is one whose NFT still reads
 * empty when asked once more.
 *
 * This is the one fetch in the app for this endpoint (tests/read.test.mjs
 * pins it). The rest of the module is pure and runs under node --test.
 */
import type { TokenDisplay } from './read/types'
import { EMPTY_REASK_MS, type Batch, type ChainPositionCard, type LookupFailure, type LookupResult } from './read/screens/positions'

export const OWNED_PATH = '/api/owned/v1/positions'
/** Rows read, and shown, at a time: the read service answers at most ten NFT ids per read. */
export const PAGE_SIZE = 10
/** The endpoint's own caps (functions/_lib/owned.ts MAX_IDS, RECENT_OPERATIONS): a reply beyond them is refused. */
const MAX_POSITIONS = 300
const MAX_DEPOSITS = 8

export type OwnedStatus = 'open' | 'closed'

export interface OwnedDeposit {
  operationId: string
  currency0: string
  currency1: string
  fee: number
  tickSpacing: number
  hooks: string
  balance0: string
  balance1: string
}

export interface OwnedList {
  owner: string
  /** The block every status in the answer is from. */
  block: number
  positions: { tokenId: string; status: OwnedStatus }[]
  /** The NFTs listed are all the wallet holds (their count matches balanceOf). */
  complete: boolean
  deposits: OwnedDeposit[]
}

const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const TOKEN_ID = /^[1-9]\d{0,77}$/
const UINT128 = /^(?:0|[1-9]\d{0,38})$/

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const hasKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).sort().join() === [...keys].sort().join()
const tokenIdOk = (value: unknown): value is string => typeof value === 'string' && TOKEN_ID.test(value) && BigInt(value) < 2n ** 256n
const uint128Ok = (value: unknown): value is string => typeof value === 'string' && UINT128.test(value) && BigInt(value) < 2n ** 128n
const integerIn = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

/**
 * The endpoint's answer, checked field by field, for `owner` only; null when
 * anything in it is not exactly what the endpoint sends.
 */
export function parseOwnedReply(value: unknown, owner: string): OwnedList | null {
  if (!isRecord(value) || !hasKeys(value, ['owner', 'block', 'positions', 'complete', 'deposits'])) return null
  if (value.owner !== owner.toLowerCase() || !integerIn(value.block, 0, Number.MAX_SAFE_INTEGER) || typeof value.complete !== 'boolean') return null
  if (!Array.isArray(value.positions) || value.positions.length > MAX_POSITIONS || !Array.isArray(value.deposits) || value.deposits.length > MAX_DEPOSITS) return null
  const seen = new Set<string>()
  const positions: OwnedList['positions'] = []
  for (const item of value.positions as unknown[]) {
    if (!isRecord(item) || !hasKeys(item, ['tokenId', 'status']) || !tokenIdOk(item.tokenId) || (item.status !== 'open' && item.status !== 'closed') || seen.has(item.tokenId)) return null
    seen.add(item.tokenId)
    positions.push({ tokenId: item.tokenId, status: item.status })
  }
  const deposits: OwnedDeposit[] = []
  for (const item of value.deposits as unknown[]) {
    if (!isRecord(item) || !hasKeys(item, ['operationId', 'currency0', 'currency1', 'fee', 'tickSpacing', 'hooks', 'balance0', 'balance1'])) return null
    const { operationId, currency0, currency1, fee, tickSpacing, hooks, balance0, balance1 } = item
    if (typeof operationId !== 'string' || !HASH.test(operationId)) return null
    if (typeof currency0 !== 'string' || !ADDRESS.test(currency0) || typeof currency1 !== 'string' || !ADDRESS.test(currency1) || typeof hooks !== 'string' || !ADDRESS.test(hooks)) return null
    if (!integerIn(fee, 0, 0xffffff) || !integerIn(tickSpacing, -(2 ** 23), 2 ** 23 - 1) || !uint128Ok(balance0) || !uint128Ok(balance1)) return null
    deposits.push({ operationId, currency0, currency1, fee, tickSpacing, hooks, balance0, balance1 })
  }
  return { owner: value.owner, block: value.block, positions, complete: value.complete, deposits }
}

export type OwnedRead = { ok: true; list: OwnedList } | { ok: false; reason: string }

/** The reasons worth asking again for, a little later: the chain or the page's connection was busy for the moment. */
export const passingOwnedFailure = (reason: string) => reason === 'chain_busy' || reason === 'chain_unavailable' || reason === 'unreachable' || /^http_5\d\d$/.test(reason)

/**
 * Asks the endpoint for `owner`'s list. `fresh` skips a kept answer older
 * than 5 seconds (the endpoint keeps answers 30 s and failures 12 s), for
 * the read right after an action changed the answer.
 */
export async function readOwnedPositions(owner: string, signal: AbortSignal, fresh = false): Promise<OwnedRead> {
  const body = JSON.stringify(fresh ? { owner, fresh: true } : { owner })
  let response: Response
  try {
    response = await fetch(OWNED_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, credentials: 'same-origin', cache: 'no-store', signal })
  } catch {
    return { ok: false, reason: signal.aborted ? 'aborted' : 'unreachable' }
  }
  let value: unknown = null
  try {
    value = await response.json()
  } catch {
    return { ok: false, reason: signal.aborted ? 'aborted' : response.ok ? 'invalid_reply' : `http_${response.status}` }
  }
  if (!response.ok) {
    const code = isRecord(value) && typeof value.error === 'string' && /^[a-z_]{1,40}$/.test(value.error) ? value.error : `http_${response.status}`
    return { ok: false, reason: code }
  }
  const list = parseOwnedReply(value, owner)
  return list ? { ok: true, list } : { ok: false, reason: 'invalid_reply' }
}

// ---------------------------------------------------------------------------
// The rows: which ids, in which tab, read how far
// ---------------------------------------------------------------------------

export interface OwnedIds {
  /** Every id to list, in order: the endpoint's (open first, newest first), with remembered ids it did not name in front. */
  order: string[]
  status: Map<string, OwnedStatus>
}

/**
 * The endpoint's ids, and the ones this browser remembers creating for this
 * wallet (lib/positionMemory.ts) that the endpoint did not name: just created
 * and not in its cached answer yet, or listed from memory alone when the
 * endpoint could not answer. A remembered id is taken to be open until its
 * own read says otherwise.
 */
export function mergeOwned(list: OwnedList | null, remembered: readonly string[]): OwnedIds {
  const status = new Map<string, OwnedStatus>()
  const extra = remembered.filter((id) => TOKEN_ID.test(id) && !list?.positions.some((p) => p.tokenId === id))
  for (const id of extra) status.set(id, 'open')
  for (const p of list?.positions ?? []) status.set(p.tokenId, p.status)
  return { order: [...status.keys()], status }
}

export type LiveCard = Extract<ChainPositionCard, { kind: 'live' }>

export type RowResult =
  | { kind: 'card'; card: LiveCard; batch: Batch }
  /** Its read failed: the row stays, with dashes, and the reason in its title. */
  | { kind: 'failed'; failure: LookupFailure }
  /**
   * Empty at the read's block, and asked once more: a position created a moment ago can be newer than the read
   * service's block. The row stays where the endpoint (or this browser's memory) put it, as a row still being read.
   */
  | { kind: 'empty'; block: number }
  /** Not the wallet's at the read's block, or the NFT no longer exists: not listed. */
  | { kind: 'gone' }

export type Rows = Readonly<Record<string, RowResult>>

/**
 * What one read of `ids` says about each row. A failure never replaces a row
 * already read: its figures stay, from their own block. An empty NFT the
 * reader asks again (`again`) stays, still being read; one it will not ask
 * again is dropped.
 */
export function rowResults(
  owner: string,
  ids: readonly string[],
  result: Exclude<LookupResult, { kind: 'aborted' }>,
  previous: Rows,
  again: readonly string[] = [],
): Record<string, RowResult> {
  const out: Record<string, RowResult> = {}
  if (result.kind === 'failed') {
    for (const id of ids) if (previous[id]?.kind !== 'card') out[id] = { kind: 'failed', failure: result.failure }
    return out
  }
  const wallet = owner.toLowerCase()
  for (const card of result.batch.cards) {
    if (card.kind === 'empty') out[card.tokenId] = again.includes(card.tokenId) ? { kind: 'empty', block: result.batch.block.number } : { kind: 'gone' }
    else out[card.tokenId] = card.owner.address === wallet ? { kind: 'card', card, batch: result.batch } : { kind: 'gone' }
  }
  return out
}

/**
 * The two tabs. A row that was read goes where its own read puts it (liquidity
 * above zero is open), which catches a position closed or topped up since the
 * endpoint's block; one not read yet goes where the endpoint put it.
 */
export function ownedTabs(ids: OwnedIds, rows: Rows): { open: string[]; closed: string[] } {
  const open: string[] = []
  const closed: string[] = []
  for (const id of ids.order) {
    const row = rows[id]
    if (row?.kind === 'gone') continue
    const status = row?.kind === 'card' ? (row.card.hasLiquidity ? 'open' : 'closed') : ids.status.get(id)
    ;(status === 'closed' ? closed : open).push(id)
  }
  return { open, closed }
}

export interface RowReader {
  /** Reads the ids not asked for yet, PAGE_SIZE at a time, one read after another. After a cancel, starts over. */
  want(ids: readonly string[]): void
  /** Stops: the read in flight is cancelled, and nothing is asked again until the next want(). */
  cancel(): void
}

/** One run of the reader, from its first want() to its cancel(): what it asked, its queue, and its own abort signal. */
interface ReaderRun {
  asked: Set<string>
  /** The empty NFTs already asked a second time. */
  rechecked: Set<string>
  queue: string[]
  attempts: Map<string, number>
  cancels: (() => void)[]
  controller: AbortController
  running: boolean
}

const newRun = (): ReaderRun => ({ asked: new Set(), rechecked: new Set(), queue: [], attempts: new Map(), cancels: [], controller: new AbortController(), running: false })

/** The wait before a row whose NFT read empty is asked the one more time, through `later`: the page's last empty re-ask. */
export const EMPTY_ROW_REASK_MS = EMPTY_REASK_MS[EMPTY_REASK_MS.length - 1]

/**
 * The rows' reads, outside React: one queue, one read at a time, each id asked
 * once. A read that failed only for the moment is asked again after
 * `retryIn(failure, attempt)` milliseconds (null: not again), through `later`.
 * An NFT that reads empty is asked once more, after EMPTY_ROW_REASK_MS, through
 * `later` too: a position created a moment ago can be newer than the read
 * service's block. `onResult` is told which empty ones will be asked again.
 *
 * A cancel ends the run: its read in flight is aborted and reports nothing.
 * The next want() starts a new run that asks every id again, because React
 * StrictMode (npm run dev) sets up, cleans up and sets up every effect on
 * mount while useMemo keeps this reader: a cancel for good would leave every
 * row a skeleton there.
 */
export function createRowReader(
  read: (ids: string[], signal: AbortSignal) => Promise<LookupResult>,
  onResult: (ids: string[], result: Exclude<LookupResult, { kind: 'aborted' }>, again: string[]) => void,
  retry: { retryIn: (failure: LookupFailure, attempt: number) => number | null; later: (ms: number, run: () => void) => () => void } | null = null,
): RowReader {
  let current = newRun()

  async function pump(run: ReaderRun) {
    if (run.running) return
    run.running = true
    const { signal } = run.controller
    const askLater = (wait: number, ids: string[]) =>
      retry?.later(wait, () => {
        if (signal.aborted) return
        run.queue.push(...ids)
        void pump(run)
      })
    while (run.queue.length > 0 && !signal.aborted) {
      const ids = run.queue.splice(0, PAGE_SIZE)
      const result = await read(ids, signal)
      if (signal.aborted || result.kind === 'aborted') break
      if (result.kind === 'ok') {
        const again = retry ? result.batch.cards.flatMap((card) => (card.kind === 'empty' && !run.rechecked.has(card.tokenId) ? [card.tokenId] : [])) : []
        onResult(ids, result, again)
        if (again.length === 0) continue
        for (const id of again) run.rechecked.add(id)
        const cancel = askLater(EMPTY_ROW_REASK_MS, again)
        if (cancel) run.cancels.push(cancel)
        continue
      }
      onResult(ids, result, [])
      if (!retry) continue
      const key = ids.join(',')
      const attempt = run.attempts.get(key) ?? 0
      const wait = retry.retryIn(result.failure, attempt)
      if (wait === null) continue
      run.attempts.set(key, attempt + 1)
      const cancel = askLater(wait, ids)
      if (cancel) run.cancels.push(cancel)
    }
    run.running = false
  }

  return {
    want(ids) {
      if (current.controller.signal.aborted) current = newRun()
      const run = current
      for (const id of ids) {
        if (run.asked.has(id)) continue
        run.asked.add(id)
        run.queue.push(id)
      }
      void pump(run)
    },
    cancel() {
      current.controller.abort()
      for (const cancel of current.cancels.splice(0)) cancel()
    },
  }
}

// ---------------------------------------------------------------------------
// Held deposits, as the HeldDeposits component takes them
// ---------------------------------------------------------------------------

/** A currency as the positions components name it: the read service's token data, or nulls where it was not read. */
export interface CurrencyView {
  address: string
  symbol: string | null
  decimals: number | null
}

export type HeldDepositView = OwnedDeposit & { currencies: readonly [CurrencyView, CurrencyView] }

export const currencyView = (address: string, token: TokenDisplay | undefined): CurrencyView => ({
  address: address.toLowerCase(),
  symbol: token?.symbol ?? null,
  decimals: token?.decimals ?? null,
})

/** The distinct currencies a list of deposits names, in order. */
export const depositCurrencies = (deposits: readonly OwnedDeposit[]) => [...new Set(deposits.flatMap((d) => [d.currency0, d.currency1]))]

export const heldDepositViews = (deposits: readonly OwnedDeposit[], tokens: ReadonlyMap<string, TokenDisplay>): HeldDepositView[] =>
  deposits.map((d) => ({ ...d, currencies: [currencyView(d.currency0, tokens.get(d.currency0)), currencyView(d.currency1, tokens.get(d.currency1))] as const }))
