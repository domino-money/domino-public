/**
 * The connected wallet's positions created through Domino's own contracts,
 * read from chain by our same-origin endpoint: no NFT id is ever typed and
 * nothing is kept in the browser's storage (the owner's rule, 2026-09-24).
 *
 * CONTRACT between the Positions engineer (who implements the endpoint and
 * this hook) and the Automate engineer (whose position picker consumes it):
 *
 *   POST /api/owned/v2/positions  body {"owner":"0x…40 hex, lowercase"}
 *   → 200 { owner, block, positions: WalletPosition[], deposits: WalletDeposit[] }
 *
 * Positions are the NFTs minted to `owner` by DominoSetupV1 (SetupMinted
 * events, owner indexed), plus later the successors of the owner's
 * sequences; each is classified open (liquidity > 0) or closed (0) at one
 * block, with its pool, range, tokens and the pool's price read from chain,
 * so the list and the position page never depend on the read service.
 * functions/_lib/walletPositions.ts is the endpoint.
 *
 * This module holds the wire types, the answer's parser (every field checked,
 * the owner's own answer only), the one fetch of the endpoint
 * (tests/read.test.mjs pins it) and the hooks. Nothing is stored: an answer
 * lives in React state for as long as the screen shows it.
 */
import { useEffect, useState } from 'react'

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

/** The endpoint's answer, as parseWalletAnswer accepts it. */
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

export const WALLET_POSITIONS_PATH = '/api/owned/v2/positions'
/** The endpoint's own caps (functions/_lib/walletPositions.ts MAX_POSITIONS, owned.ts RECENT_OPERATIONS): a reply beyond them is refused. */
const MAX_POSITIONS = 100
const MAX_DEPOSITS = 8

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
 * The endpoint's answer, checked field by field, for `owner` only; null when
 * anything in it is not exactly what the endpoint sends.
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

/** The reasons worth asking again for, a little later: the chain or the page's connection was busy for the moment. */
export const passingWalletFailure = (reason: string) => reason === 'chain_busy' || reason === 'chain_unavailable' || reason === 'unreachable' || /^http_5\d\d$/.test(reason)

/**
 * Asks the endpoint for `owner`'s positions and held deposits. `fresh` skips
 * a kept answer older than 5 seconds (the endpoint keeps answers 30 s and
 * failures 12 s), for the read right after an action changed the answer.
 */
export async function readWalletPositions(owner: string, signal: AbortSignal, fresh = false): Promise<WalletRead> {
  const body = JSON.stringify(fresh ? { owner, fresh: true } : { owner })
  let response: Response
  try {
    response = await fetch(WALLET_POSITIONS_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, credentials: 'same-origin', cache: 'no-store', signal })
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
  const answer = parseWalletAnswer(value, owner)
  return answer ? { ok: true, answer } : { ok: false, reason: 'invalid_reply' }
}

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

/** The whole answer for one wallet, as the Positions list draws it (its held deposits included). */
export type WalletAnswerState = { phase: 'idle' } | { phase: 'loading' } | { phase: 'ready'; answer: WalletAnswer } | { phase: 'failed'; reason: string }

/**
 * The connected wallet's answer: asked whenever `owner` is set (a lowercase
 * address, the wallet connected on Robinhood Chain), and again, fresh, each
 * time `asked` grows (after an action changed it). A chain that was busy for
 * the moment is asked again on its own, twice at most, while the page is
 * visible; an answer already on screen stays there when a later one fails.
 */
export function useWalletAnswer(owner: string | null, asked = 0): WalletAnswerState {
  const [state, setState] = useState<{ owner: string; value: WalletAnswerState } | null>(null)
  useEffect(() => {
    if (!owner) return
    const controller = new AbortController()
    let attempts = 0
    let cancel: (() => void) | null = null
    const ask = () => {
      void readWalletPositions(owner, controller.signal, asked > 0).then((result) => {
        if (controller.signal.aborted) return
        if (result.ok) {
          setState({ owner, value: { phase: 'ready', answer: result.answer } })
          return
        }
        setState((before) => (before?.owner === owner && before.value.phase === 'ready' ? before : { owner, value: { phase: 'failed', reason: result.reason } }))
        if (!passingWalletFailure(result.reason) || attempts >= 2) return
        cancel = whenVisibleAfter(attempts === 0 ? 3_000 : 12_000, () => {
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

/** The connected wallet's Domino positions (see the contract above). `owner` null: idle. */
export function useWalletPositions(owner: string | null): WalletPositionsState {
  const state = useWalletAnswer(owner ? owner.toLowerCase() : null)
  if (state.phase === 'ready') return { phase: 'ready', block: state.answer.block, positions: state.answer.positions }
  return state
}
