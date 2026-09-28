/**
 * The connected wallet's positions created through Domino's own contracts,
 * read from the chain: no NFT id is ever typed and nothing is kept in the
 * browser's storage (the owner's rule, 2026-09-24).
 *
 * CONTRACT between the Positions engineer (who implements the read and this
 * hook) and the Automate engineer (whose position picker consumes it):
 *
 *   readWalletPositions(owner)  owner "0x…40 hex"
 *   → { owner, block, positions: WalletPosition[], deposits: WalletDeposit[] }
 *
 * Positions are the NFTs minted to `owner` by DominoSetupV1 (SetupMinted
 * events, owner indexed), plus later the successors of the owner's
 * sequences; each is classified open (liquidity > 0) or closed (0, the NFT
 * kept) at one block, with its pool, range, tokens and the pool's price read
 * from chain, so the list and the position page never depend on the read
 * service.
 *
 * 2026-09-25: the page reads it itself, from the chain's public RPC, with the
 * scan the site's route ran (functions/_lib/walletPositions.ts scanWallet,
 * through lib/chain/browser.ts): the RPC answers 429 to every call from
 * Cloudflare's edge, so POST /api/owned/v2/positions failed in production and
 * the list said it had nothing. The route stays, tested; the page never asks
 * it. The scan's answer still passes this module's parser, field by field.
 * The scan and its runtime are loaded on the first read (lib/chain/chainCode.ts),
 * so the screens that import this module do not carry them until they read.
 *
 * 2026-09-28: while the chain's own RPC cannot be reached (the DNS of Vivo, a large Brazilian ISP, answers NXDOMAIN for
 * chain.robinhood.com), the same read goes to the chain's public fallbacks (lib/chain/failover.ts), and the scan finds
 * the wallet's ids in DominoSetupV1's own state rather than its logs (functions/_lib/walletPositions.ts operationIds):
 * the same answer, through the same parser, and the same screens.
 *
 * This module holds the wire types, the parser, the read and the hooks.
 * Nothing is stored: an answer lives in React state for as long as the screen
 * shows it.
 */
import { useEffect, useRef, useState } from 'react'
import type { OwnedDeps } from '../../functions/_lib/owned'
import type { MintedMemory } from '../../functions/_lib/walletPositions'
// The read screens' own wait that holds while the page is hidden. 2026-09-27: this module's copy of it went; quietRead.ts
// is in the entry chunk every page loads, so the picker loads nothing more for it.
import { whenVisibleAfter } from './read/screens/quietRead'

export interface WalletToken {
  /** Lowercase address; the zero address is native ETH. */
  address: string
  symbol: string | null
  decimals: number | null
}

export interface WalletPosition {
  /** Canonical decimal NFT id. */
  tokenId: string
  status: 'open' | 'closed'
  poolId: string
  currencies: readonly [WalletToken, WalletToken]
  /** LP fee in pips (3000 = 0.30%). */
  fee: number
  tickSpacing: number
  /** Lowercase hooks address. */
  hooks: string
  tickLower: number
  tickUpper: number
  /** Raw liquidity, decimal string. */
  liquidity: string
  /** The pool's square-root price and tick at `block`, or null when not read. */
  sqrtPriceX96: string | null
  tick: number | null
  /** Unclaimed fees in raw units at `block`, or null when not read. */
  unclaimedFees: readonly [string, string] | null
  /** Principal in raw units at the pool's price at `block`, or null when not read. */
  principal: readonly [string, string] | null
}

/**
 * A deposit the wallet made into DominoSetupV1 that never became a position:
 * still held there under the wallet's own operation, refundable. Its tokens
 * travel with it, read at the same block (native ETH is 'ETH', 18).
 */
export interface WalletDeposit {
  operationId: string
  currency0: string
  currency1: string
  fee: number
  tickSpacing: number
  hooks: string
  balance0: string
  balance1: string
  currencies: readonly [WalletToken, WalletToken]
}

/** The scan's answer, as parseWalletAnswer accepts it. */
export interface WalletAnswer {
  owner: string
  block: number
  positions: readonly WalletPosition[]
  deposits: readonly WalletDeposit[]
}

export type WalletPositionsState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; block: number; positions: readonly WalletPosition[] }
  | { phase: 'failed'; reason: string }

/** The scan's own caps (functions/_lib/walletPositions.ts MAX_POSITIONS, owned.ts RECENT_OPERATIONS): an answer beyond them is refused. */
const MAX_POSITIONS = 100
/** Every held deposit among the owner's 128 most recent setup operations (8 before 2026-09-25). */
const MAX_DEPOSITS = 128

const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const TOKEN_ID = /^[1-9]\d{0,77}$/
const DECIMAL = /^(?:0|[1-9]\d{0,77})$/

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const hasKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).sort().join() === [...keys].sort().join()
const integerIn = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
const decimalBelow = (value: unknown, bits: bigint): value is string => typeof value === 'string' && DECIMAL.test(value) && BigInt(value) < 1n << bits
const int24 = (value: unknown): value is number => integerIn(value, -(2 ** 23), 2 ** 23 - 1)
const isAddress = (value: unknown): value is string => typeof value === 'string' && ADDRESS.test(value)

function token(value: unknown): WalletToken | null {
  if (!isRecord(value) || !hasKeys(value, ['address', 'symbol', 'decimals']) || !isAddress(value.address)) return null
  if (value.symbol !== null && (typeof value.symbol !== 'string' || value.symbol.length === 0 || value.symbol.length > 64)) return null
  if (value.decimals !== null && !integerIn(value.decimals, 0, 255)) return null
  return { address: value.address, symbol: value.symbol, decimals: value.decimals }
}

/** Two raw amounts, or null; undefined when the value is neither. */
function amounts(value: unknown): readonly [string, string] | null | undefined {
  if (value === null) return null
  if (!Array.isArray(value) || value.length !== 2 || !decimalBelow(value[0], 256n) || !decimalBelow(value[1], 256n)) return undefined
  return [value[0], value[1]]
}

function currencyPair(value: unknown): readonly [WalletToken, WalletToken] | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const first = token(value[0])
  const second = token(value[1])
  return first && second ? [first, second] : null
}

const POSITION_KEYS = ['tokenId', 'status', 'poolId', 'currencies', 'fee', 'tickSpacing', 'hooks', 'tickLower', 'tickUpper', 'liquidity', 'sqrtPriceX96', 'tick', 'unclaimedFees', 'principal']

function position(value: unknown): WalletPosition | null {
  if (!isRecord(value) || !hasKeys(value, POSITION_KEYS)) return null
  const { tokenId, status, poolId, fee, tickSpacing, hooks, tickLower, tickUpper, liquidity, sqrtPriceX96, tick } = value
  if (typeof tokenId !== 'string' || !TOKEN_ID.test(tokenId) || BigInt(tokenId) >= 1n << 256n) return null
  if (status !== 'open' && status !== 'closed') return null
  if (typeof poolId !== 'string' || !HASH.test(poolId) || !isAddress(hooks) || !integerIn(fee, 0, 0xffffff) || !int24(tickSpacing)) return null
  if (!int24(tickLower) || !int24(tickUpper) || tickLower >= tickUpper) return null
  if (!decimalBelow(liquidity, 128n) || (status === 'open') !== (liquidity !== '0')) return null
  // The price is read or not as a whole: its square root and its tick together.
  let price: { sqrtPriceX96: string; tick: number } | null = null
  if (sqrtPriceX96 !== null || tick !== null) {
    if (!decimalBelow(sqrtPriceX96, 160n) || sqrtPriceX96 === '0' || !int24(tick)) return null
    price = { sqrtPriceX96, tick }
  }
  const currencies = currencyPair(value.currencies)
  const unclaimedFees = amounts(value.unclaimedFees)
  const principal = amounts(value.principal)
  if (!currencies || unclaimedFees === undefined || principal === undefined) return null
  return {
    tokenId,
    status,
    poolId,
    currencies,
    fee,
    tickSpacing,
    hooks,
    tickLower,
    tickUpper,
    liquidity,
    sqrtPriceX96: price ? price.sqrtPriceX96 : null,
    tick: price ? price.tick : null,
    unclaimedFees,
    principal,
  }
}

const DEPOSIT_KEYS = ['operationId', 'currency0', 'currency1', 'fee', 'tickSpacing', 'hooks', 'balance0', 'balance1', 'currencies']

function deposit(value: unknown): WalletDeposit | null {
  if (!isRecord(value) || !hasKeys(value, DEPOSIT_KEYS)) return null
  const { operationId, currency0, currency1, fee, tickSpacing, hooks, balance0, balance1 } = value
  if (typeof operationId !== 'string' || !HASH.test(operationId) || !isAddress(currency0) || !isAddress(currency1) || !isAddress(hooks)) return null
  if (!integerIn(fee, 0, 0xffffff) || !int24(tickSpacing) || !decimalBelow(balance0, 128n) || !decimalBelow(balance1, 128n)) return null
  const currencies = currencyPair(value.currencies)
  if (!currencies || currencies[0].address !== currency0 || currencies[1].address !== currency1) return null
  return { operationId, currency0, currency1, fee, tickSpacing, hooks, balance0, balance1, currencies }
}

/**
 * The scan's answer, checked field by field, for `owner` only; null when
 * anything in it is not exactly what the scan gives.
 */
export function parseWalletAnswer(value: unknown, owner: string): WalletAnswer | null {
  if (!isRecord(value) || !hasKeys(value, ['owner', 'block', 'positions', 'deposits'])) return null
  if (value.owner !== owner.toLowerCase() || !integerIn(value.block, 0, Number.MAX_SAFE_INTEGER)) return null
  if (!Array.isArray(value.positions) || value.positions.length > MAX_POSITIONS || !Array.isArray(value.deposits) || value.deposits.length > MAX_DEPOSITS) return null
  const positions: WalletPosition[] = []
  const seen = new Set<string>()
  for (const item of value.positions as unknown[]) {
    const parsed = position(item)
    if (!parsed || seen.has(parsed.tokenId)) return null
    seen.add(parsed.tokenId)
    positions.push(parsed)
  }
  const deposits: WalletDeposit[] = []
  for (const item of value.deposits as unknown[]) {
    const parsed = deposit(item)
    if (!parsed) return null
    deposits.push(parsed)
  }
  return { owner: value.owner, block: value.block, positions, deposits }
}

export type WalletRead = { ok: true; answer: WalletAnswer } | { ok: false; reason: string }

/**
 * Whether a failed read is asked again: every failure of the chain or of the
 * page's connection to it; never a read the page dropped, nor an address the
 * scan cannot take.
 */
export const passingWalletFailure = (reason: string) => reason !== 'aborted' && reason !== 'invalid_owner'

const OWNER = /^0x[0-9a-fA-F]{40}$/
const ZERO_OWNER = /^0x0{40}$/

/**
 * Per wallet, the ids DominoSetupV1 minted to it and the block the page's last scan read them at (2026-09-25), in this
 * page's memory only, for the visit: the logs are history that only grows, so a later read of the same wallet (Positions
 * again, a position's page, the automation page) reads them from shortly before that block, and every position's state
 * fresh at its own head. Only the page's own runtime keeps it; a read handed its runtime (the tests) scans in full.
 */
const minted = new Map<string, MintedMemory>()
/** For tests: forget what earlier scans found. */
export function forgetMinted(): void {
  minted.clear()
}

/**
 * `owner`'s positions and held deposits, read from the chain by the page:
 * the scan's answer through the parser, or why there is none (chain_busy
 * while the RPC rate-limits, chain_unavailable for any other failure of it,
 * as the route named them). A read `signal` drops makes no further call.
 * `deps` is the page's own runtime (lib/chain/browser.ts); tests hand in fakes.
 */
export async function readWalletPositions(owner: string, signal: AbortSignal, deps?: OwnedDeps): Promise<WalletRead> {
  if (!OWNER.test(owner) || ZERO_OWNER.test(owner)) return { ok: false, reason: 'invalid_owner' }
  const lower = owner.toLowerCase()
  let body: WalletAnswer
  try {
    const code = await import('./chain/chainCode')
    // 2026-09-28 (the owner's phone): the list goes first. Its read holds every tab's fees lane for the whole of it, its
    // waits between refused calls included.
    const release = deps ? null : code.holdReads()
    try {
      const scan = await code.scanWallet(deps ?? code.chainDeps(signal), lower, deps ? null : (minted.get(lower) ?? null))
      body = scan.body
      if (!deps) {
        if (scan.minted) minted.set(lower, scan.minted)
        else minted.delete(lower)
      }
    } catch (error) {
      if (signal.aborted) return { ok: false, reason: 'aborted' }
      return { ok: false, reason: error instanceof code.ChainError && error.kind === 'rate' ? 'chain_busy' : 'chain_unavailable' }
    } finally {
      release?.()
    }
  } catch {
    // The chain code's chunk could not be loaded (a file of an earlier deploy): as a read that failed, asked again.
    return { ok: false, reason: signal.aborted ? 'aborted' : 'chain_unavailable' }
  }
  if (signal.aborted) return { ok: false, reason: 'aborted' }
  // The scan's answer as a route would have sent it, taken only when every field is what the parser expects.
  const answer = parseWalletAnswer(JSON.parse(JSON.stringify(body)), lower)
  return answer ? { ok: true, answer } : { ok: false, reason: 'invalid_reply' }
}

/**
 * The waits before a failed read is asked again, while the page is visible (the owner's rule, 2026-09-25). 2026-09-28
 * (the owner's phone: the list stayed on its loading rows): a read the RPC refused (chain_busy) is asked again after the
 * first wait twice, since it held every other read of this browser meanwhile (holdReads), then after the ladder's 10 s
 * and every 30 s: as many reads as the ladder, none later. Bounded (review, 2026-09-28): 2 s every time never let the
 * list in past a limiter that lengthens its refusal at each refused call (the harness: 6 s a call kept it out for good).
 */
export const REASK_MS = [2_000, 5_000, 10_000] as const
/** After those, the read is still asked again on its own, this often, while the page is visible. */
export const LATER_MS = 30_000

/**
 * The whole answer for one wallet, as the Positions list draws it (its held
 * deposits included). `retrying`: a read failed and is asked again on its own
 * (REASK_MS), so nothing is said about the list yet; `failed`: those failed
 * too, and it is still asked now and then (LATER_MS). Neither is ever an empty
 * list: only `ready` with no positions is.
 */
export type WalletAnswerState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; answer: WalletAnswer }
  | { phase: 'retrying'; reason: string }
  | { phase: 'failed'; reason: string }

/**
 * The list's own refresh (the owner's OK of 2026-09-27, "pode fazer", on the study made at 7074cbd): the answer on
 * screen is read again every 30 s while the tab is visible, never sooner than 15 s after the last read settled, and only
 * for a wallet whose next scan is incremental (its minted ids in this page's memory, `minted` above): a wallet at the
 * scan's cap would scan from the contract's deployment each time. A refresh that fails, or that reads fewer figures
 * than the answer on screen, keeps that answer and is asked again after 60 s, then every 120 s.
 */
export const REFRESH_MS = 30_000
export const REFRESH_FLOOR_MS = 15_000
export const REFRESH_FAILED_MS = [60_000, 120_000] as const

/** A row of an answer, a position or a held deposit, as the refresh compares them. */
interface Row {
  tokenId?: string
  operationId?: string
  currencies: readonly [WalletToken, WalletToken]
  sqrtPriceX96?: string | null
  unclaimedFees?: readonly [string, string] | null
  principal?: readonly [string, string] | null
}
const rows = (answer: WalletAnswer): Row[] => [...answer.positions, ...answer.deposits]
/** What of a row the chain may leave unread (null): the pool's price, the unclaimed fees, the principal, its tokens' names. */
const figures = (row: Row) => [row.sqrtPriceX96, row.unclaimedFees, row.principal, ...row.currencies.flatMap((token) => [token.symbol, token.decimals])]

/**
 * Whether `next` read fewer figures than `shown`: a price, fees, a principal or a token's name that `shown` had for a
 * row (the same NFT or held deposit) is null in `next`. Such an answer is a refresh that failed, never drawn over `shown`.
 */
export function poorer(shown: WalletAnswer, next: WalletAnswer): boolean {
  const had = new Map(rows(shown).map((row) => [row.tokenId ?? row.operationId, figures(row)]))
  return rows(next).some((row) => figures(row).some((value, i) => value === null && had.get(row.tokenId ?? row.operationId)?.[i] != null))
}

/** Whether two answers show the same rows with the same figures, whatever their blocks. */
export const sameRows = (a: WalletAnswer, b: WalletAnswer) => JSON.stringify(rows(a)) === JSON.stringify(rows(b))

/**
 * One wallet's reads, for useWalletAnswer (exported for its tests): the first at once, each later one only after the
 * one before it settled. `shown` is the answer on screen, kept across the hook's runs; `put` draws a new state; `every`
 * turns the refresh on; `paused` holds it back while it is true. Returns the cancel.
 *
 * With the refresh on, an answer is drawn unless (a) its block is older than the one on screen (a node behind the
 * head), (b) it read fewer figures (poorer: taken as a failed read) or (c) it shows the same rows and figures: then the
 * answer on screen stays, the very object, so nothing renders again. (d) A read that fails while an answer is on screen
 * draws nothing over it; the refreshing list asks again after REFRESH_FAILED_MS, never after REASK_MS's quick waits.
 * With it off, every answer read is drawn and ends the reads, as it did before the refresh (2026-09-27 review).
 */
export function askWallet(owner: string, shown: { current: WalletAnswer | null }, put: (value: WalletAnswerState) => void, every: number | null = null, paused?: { readonly current: boolean }, read = readWalletPositions): () => void {
  const controller = new AbortController()
  let attempts = 0
  let cancel: (() => void) | null = null
  // One wait at a time; cancelling one that already ran does nothing.
  const after = (ms: number, run: () => void) => {
    cancel = whenVisibleAfter(ms, run)
  }
  const pace = every && Math.max(every, REFRESH_FLOOR_MS)
  // A read the refresh asks on its own, held back while `paused` (a held deposit's refund on its way, which a new list
  // could unmount mid-refund).
  const later = (ms: number): void => after(ms, () => (paused?.current ? later(pace!) : ask()))
  const ask = () => {
    void read(owner, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      const before = shown.current?.owner === owner ? shown.current : null
      // (a)-(c) only with the refresh on: a reader without it (the picker, the automation page) draws each answer it
      // read and asks no more, as before the refresh.
      const kept = pace && before
      if (result.ok && !(kept && poorer(kept, result.answer))) {
        const { answer } = result
        attempts = 0
        if (!kept || (answer.block >= kept.block && !sameRows(kept, answer))) put({ phase: 'ready', answer: (shown.current = answer) })
        if (pace && minted.has(owner)) later(pace)
        return
      }
      const reason = result.ok ? 'poorer' : result.reason
      const again = passingWalletFailure(reason)
      if (!before) {
        shown.current = null
        put({ phase: again && attempts < REASK_MS.length ? 'retrying' : 'failed', reason })
      }
      if (!again) return
      if (before && pace) later(REFRESH_FAILED_MS[attempts ? 1 : 0])
      else after(attempts < REASK_MS.length ? REASK_MS[reason === 'chain_busy' && attempts === 1 ? 0 : attempts] : LATER_MS, ask)
      attempts += 1
    })
  }
  ask()
  return () => {
    controller.abort()
    cancel?.()
  }
}

/**
 * The connected wallet's answer: asked whenever `owner` is set (a lowercase
 * address, the wallet connected on Robinhood Chain), and again each time
 * `asked` grows (after an action changed it). A read that failed is asked
 * again on its own while the page is visible, after 2, 5 (2 for a read the
 * RPC refused) and 10 seconds and then every 30; an answer already on screen stays there when a later one
 * fails. `every` (Your positions only, REFRESH_MS) reads it again on its own
 * while the tab is visible, held back while `paused` is true (askWallet).
 */
export function useWalletAnswer(owner: string | null, asked = 0, every: number | null = null, paused?: { readonly current: boolean }): WalletAnswerState {
  const [state, setState] = useState<{ owner: string; value: WalletAnswerState } | null>(null)
  // The answer on screen, which each later one is measured against.
  const shown = useRef<WalletAnswer | null>(null)
  useEffect(() => {
    if (!owner) return
    return askWallet(owner, shown, (value) => setState({ owner, value }), every, paused)
  }, [owner, asked, every, paused])
  if (!owner) return { phase: 'idle' }
  // Another wallet's answer is never shown for this one: loading until this one's arrives.
  return state && state.owner === owner ? state.value : { phase: 'loading' }
}

/**
 * The connected wallet's Domino positions (see the contract above). `owner`
 * null: idle. A read being asked again is still loading; `failed` only once
 * the quick re-asks failed too.
 */
export function useWalletPositions(owner: string | null): WalletPositionsState {
  const state = useWalletAnswer(owner ? owner.toLowerCase() : null)
  if (state.phase === 'ready') return { phase: 'ready', block: state.answer.block, positions: state.answer.positions }
  if (state.phase === 'retrying') return { phase: 'loading' }
  return state
}
