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
 * This module holds the wire types, the parser, the read and the hooks.
 * Nothing is stored: an answer lives in React state for as long as the screen
 * shows it.
 */
import { useEffect, useState } from 'react'
import type { OwnedDeps } from '../../functions/_lib/owned'
import type { MintedMemory } from '../../functions/_lib/walletPositions'

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

/** The waits before a failed read is asked again, while the page is visible (the owner's rule, 2026-09-25). */
export const REASK_MS = [2_000, 5_000, 10_000] as const
/** After those, the read is still asked again on its own, this often, while the page is visible. */
export const LATER_MS = 30_000

/**
 * `run` after `ms`, or, when the page is hidden by then, once it is shown
 * again (lib/read/screens/quietRead.ts's rule, kept here so the Automate
 * screens' picker does not load the read screens' words). Returns a cancel.
 */
function whenVisibleAfter(ms: number, run: () => void): () => void {
  let cancelled = false
  const whenVisible = () => {
    if (document.hidden) return
    document.removeEventListener('visibilitychange', whenVisible)
    if (!cancelled) run()
  }
  const timer = setTimeout(() => {
    if (cancelled) return
    if (document.hidden) document.addEventListener('visibilitychange', whenVisible)
    else run()
  }, ms)
  return () => {
    cancelled = true
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', whenVisible)
  }
}

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
 * The connected wallet's answer: asked whenever `owner` is set (a lowercase
 * address, the wallet connected on Robinhood Chain), and again each time
 * `asked` grows (after an action changed it). A read that failed is asked
 * again on its own while the page is visible, after 2, 5 and 10 seconds and
 * then every 30; an answer already on screen stays there when a later one
 * fails.
 */
export function useWalletAnswer(owner: string | null, asked = 0): WalletAnswerState {
  const [state, setState] = useState<{ owner: string; value: WalletAnswerState } | null>(null)
  useEffect(() => {
    if (!owner) return
    const controller = new AbortController()
    let attempts = 0
    let cancel: (() => void) | null = null
    const ask = () => {
      void readWalletPositions(owner, controller.signal).then((result) => {
        if (controller.signal.aborted) return
        if (result.ok) {
          setState({ owner, value: { phase: 'ready', answer: result.answer } })
          return
        }
        const again = passingWalletFailure(result.reason)
        const value: WalletAnswerState = again && attempts < REASK_MS.length ? { phase: 'retrying', reason: result.reason } : { phase: 'failed', reason: result.reason }
        setState((before) => (before?.owner === owner && before.value.phase === 'ready' ? before : { owner, value }))
        if (!again) return
        cancel = whenVisibleAfter(attempts < REASK_MS.length ? REASK_MS[attempts] : LATER_MS, () => {
          cancel = null
          attempts += 1
          ask()
        })
      })
    }
    ask()
    return () => {
      controller.abort()
      cancel?.()
    }
  }, [owner, asked])
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
