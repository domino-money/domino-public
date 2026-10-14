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
 * 2026-09-25 to 2026-10-01: the page read it itself, from the chain's public RPC (and, from 2026-09-28, its public
 * fallbacks), with the scan the site's route ran, because that RPC answered 429 to every call from Cloudflare's edge.
 *
 * RPC-SPEC (2026-10-01, the owner's rule: nothing is read from a public RPC): the page asks the site's own fixed route
 * again, POST /api/owned/v2/positions (lib/edge/chainRoutes.ts), which runs that same scan at the edge against Domino's
 * own Robinhood Chain node, with the wallet's mint blocks from its cached SetupMinted walk and each position's feature in
 * the same answer. The answer still passes this module's parser, field by field. While the route cannot answer (no node
 * secret yet, or the node away), the list keeps this browser's copy and its calm line, and asks again after the wait the
 * route named (at most five minutes).
 *
 * This module holds the wire types, the parser, the read and the hooks.
 * Nothing is stored: an answer lives in React state for as long as the screen
 * shows it.
 */
import { useEffect, useRef, useState } from 'react'
import { postOwnedPositions, type MintedAt, type RouteOptions } from './edge/chainRoutes'
import type { RelayAnswer } from './fees/types'
import { noteAnswered, parseAutomationAnswer, type AutomationAnswer } from './automationState'
import { mintHints } from './fees/mintHints'
import { noteTokens } from './chainTokens'
import { madeCount, madeIds } from './create/createProgress'
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

export type WalletRead = { ok: true; answer: WalletAnswer } | { ok: false; reason: string; retryAt?: number }

/**
 * Whether a failed read is asked again: every failure of the chain or of the
 * page's connection to it; never a read the page dropped, nor an address the
 * scan cannot take.
 */
export const passingWalletFailure = (reason: string) => reason !== 'aborted' && reason !== 'invalid_owner'

const OWNER = /^0x[0-9a-fA-F]{40}$/
const ZERO_OWNER = /^0x0{40}$/

/**
 * 2026-09-28 (speed wave B, item 18: every way back to Positions showed its loading rows again for most of a second, and
 * a position's page scanned the wallet again only to decide its Automate): the last answer the page's own read got per
 * wallet, in this page's memory only (never the browser's storage), and when. For KEPT_MS it is drawn at once on the way
 * back (askWallet), a position's page draws its header from its row (keptPosition), and the page's Automate is decided
 * from it. An action that changes the list forgets it (forgetWallet: Close, Collect, a refund), and so does a position
 * Create position made since (madeCount).
 */
const answers = new Map<string, { answer: WalletAnswer; at: number; made: number }>()
export const KEPT_MS = 60_000
/** The answer kept for `owner` while it is at most KEPT_MS old and no position was created since. */
function keptWallet(owner: string): { answer: WalletAnswer; at: number } | null {
  const kept = answers.get(owner)
  return kept && Date.now() - kept.at < KEPT_MS && kept.made === madeCount() ? kept : null
}
/**
 * Added 2026-10-14 (the incident of 2026-10-13, package V1): when this page read an answer from the site's route (ms),
 * for as long as the answer itself is held; null for one it did not read (a copy). The answer names its block and no
 * time, and Your positions values its amounts as current only while it knows how old they are (v2in/lists).
 */
const readAt = new WeakMap<WalletAnswer, number>()
export const walletAnswerAt = (answer: WalletAnswer): number | null => readAt.get(answer) ?? null
/** Forgets the answers kept, and a first read shared since (it may be from before an action). */
export function forgetWallet(): void {
  answers.clear()
  warm = null
}

/**
 * 2026-10-02 (review of the RPC switch, findings 8 and 15): the route keeps a wallet's answer at the edge (owned.ts
 * CACHE_SECONDS), so forgetting this page's copies is not enough after the owner's action: the next read could still be
 * answered from before it. `acted` counts the actions that changed a wallet's list here (walletChanged: a Close, a
 * Collect), and a position Create position made counts too (madeCount); `settled` holds, per wallet, the counts its last
 * answer was read after (`baseline` for a wallet not read yet). A read made while either differs asks the route fresh.
 *
 * Changed on purpose 2026-10-02 (RPC fix round 2): an answer settles its wallet only when it is not behind (behindOf):
 * when its block is at or past the block the owner's last action was included in (`actedBlock`, the receipt's), and it
 * lists every position this wallet made here. A node still behind the receipt answers from before the action; until
 * one answers past it, every read of the wallet asks fresh, and askWallet asks again on CREATED_REASK_MS's ladder.
 */
let acted = 0
let actedBlock = 0
let baseline = { acted: 0, made: 0 }
const settled = new Map<string, { acted: number; made: number }>()

/**
 * The owner's action changed a wallet's list (a Close, a Collect, a setup step): its copies are forgotten, and its reads
 * ask fresh until one answers at or past `block`, the block the action was included in, when the receipt named it.
 */
export function walletChanged(block?: number | bigint | null): void {
  acted += 1
  if (block !== undefined && block !== null) actedBlock = Math.max(actedBlock, Number(block))
  forgetWallet()
}

/** Whether `owner`'s next read must ask past the route's answer cache: an action, or a position made here, since its last answer. */
export function wantsFresh(owner: string): boolean {
  const last = settled.get(owner) ?? baseline
  return last.acted !== acted || last.made !== madeCount()
}

/**
 * Whether `answer` is from before something this page knows happened to `owner`'s list (RPC fix round 2): its block is
 * below the block the owner's last action was included in, or it lacks a position this wallet made here (madeIds).
 */
export function behindOf(owner: string, answer: WalletAnswer): boolean {
  return answer.block < actedBlock || madeIds(owner).some((id) => !answer.positions.some((position) => position.tokenId === id))
}
/** `tokenId`'s row in a wallet answer kept this visit (keptWallet), with the wallet and the answer's block. */
export function keptPosition(tokenId: string): { position: WalletPosition; owner: string; block: number } | null {
  for (const owner of answers.keys()) {
    const answer = keptWallet(owner)?.answer
    const position = answer?.positions.find((one) => one.tokenId === tokenId)
    if (answer && position) return { position, owner, block: answer.block }
  }
  return null
}
/**
 * 2026-09-28 (speed wave B, item 18): a wallet's first read on a screen is shared by every screen that asks for the same
 * wallet while it is on its way, or WARM_MS after it answered, and no screen that leaves stops it: a position's page
 * opened from the list while the list's read is on its way takes its answer rather than scanning the wallet again.
 */
let warm: { owner: string; read: Promise<WalletRead>; settled: number; made: number; refused: Set<() => void> } | null = null
const WARM_MS = 5_000
function sharedRead(owner: string, hold = true, onRefused?: () => void, fresh = false): Promise<WalletRead> {
  if (warm?.owner === owner && Date.now() - warm.settled < WARM_MS && warm.made === madeCount()) {
    if (onRefused) warm.refused.add(onRefused)
    return warm.read
  }
  const refused = new Set<() => void>(onRefused ? [onRefused] : [])
  const started = { owner, read: readWalletPositions(owner, new AbortController().signal, undefined, { hold, fresh, onRefused: () => refused.forEach((heard) => heard()) }), settled: Infinity, made: madeCount(), refused }
  void started.read.then(() => void (started.settled = Date.now()))
  warm = started
  return started.read
}
/**
 * For tests: forget the answers kept and a read started early. RPC-SPEC: the page keeps no minted ids any more (the
 * route's own cache of the wallet's SetupMinted walk does), so this is forgetWallet under its older name.
 */
export function forgetMinted(): void {
  forgetWallet()
  settled.clear()
  actedBlock = 0
  baseline = { acted, made: madeCount() }
}

/** The longest wait a route's refusal may hold the list's next read for (lib/edge/chainRoutes.ts MAX_RETRY_MS). */
export const MAX_REASK_MS = 300_000
/** A refusal that names this long a wait or longer is the source away (no node secret, or the node away), not a busy one. */
const SOURCE_AWAY_MS = 60_000
const ENVELOPE_KEYS = ['v', 'answer', 'automation', 'mints', 'capped']
const MINT_TX = /^0x[0-9a-f]{64}$/

/** The route's mint blocks, each checked (id canonical and listed, block a safe integer above 0, tx a hash); the rest let go. */
function mintsOf(value: unknown, listed: ReadonlySet<string>): MintedAt[] | null {
  if (!Array.isArray(value) || value.length > MAX_POSITIONS) return null
  return (value as unknown[]).flatMap((item) => {
    if (!isRecord(item) || !hasKeys(item, ['id', 'block', 'tx'])) return []
    const { id, block, tx } = item
    return typeof id === 'string' && TOKEN_ID.test(id) && listed.has(id) && typeof block === 'number' && Number.isSafeInteger(block) && block > 0 && typeof tx === 'string' && MINT_TX.test(tx) ? [{ id, block, tx }] : []
  })
}

/**
 * POST /api/owned/v2/positions's answer (RPC-SPEC §2.5.1), checked field by field for `owner`: the wallet's answer, each
 * listed position's feature (one per listed position, in the scan's order, or null), and the listed positions' mint blocks.
 * Null when anything is not exactly what the route sends.
 */
export function parseOwnedEnvelope(value: unknown, owner: string): { answer: WalletAnswer; automation: AutomationAnswer | null; mints: MintedAt[] } | null {
  if (!isRecord(value) || !hasKeys(value, ENVELOPE_KEYS) || value.v !== 1 || typeof value.capped !== 'boolean') return null
  const answer = parseWalletAnswer(value.answer, owner)
  if (!answer) return null
  const ids = answer.positions.map((position) => position.tokenId)
  let automation: AutomationAnswer | null = null
  if (value.automation !== null) {
    // One feature per listed position, in the scan's own order (its ids' order, not the list's open-first one): exactly
    // the listed ids, each once.
    const order = featureOrder(value.automation)
    if (!order || order.length !== ids.length || new Set(order).size !== order.length || !ids.every((id) => order.includes(id))) return null
    automation = parseAutomationAnswer(value.automation, order)
    if (!automation) return null
  }
  const mints = mintsOf(value.mints, new Set(ids))
  return mints ? { answer, automation, mints } : null
}
/** The ids an automation answer names, in its order; null when it names something that is not an id. */
function featureOrder(value: unknown): string[] | null {
  if (!isRecord(value) || !Array.isArray(value.positions)) return null
  const ids = (value.positions as unknown[]).map((entry) => (isRecord(entry) && typeof entry.tokenId === 'string' ? entry.tokenId : null))
  return ids.every((id): id is string => id !== null) ? ids : null
}

/**
 * `owner`'s positions and held deposits, as the site's route read them from Domino's own node (RPC-SPEC §2.5.1): the
 * answer through the parser, or why there is none: chain_busy while the route or the node rate-limits (with the wait it
 * named), chain_unavailable for any other failure (with the wait, when the route said the source is away). A read
 * `signal` drops is `aborted`. `post` is the route's client (lib/edge/chainRoutes.ts); tests hand in their own.
 *
 * `fresh` (RPC-SPEC P1): the first read after an action that changed the list, asked past the route's answer cache.
 * `hold`, `background` and `onRefused` were the public RPC's pacing (2026-09-28 to 2026-10-01): kept in the signature for
 * the callers that pass them, they do nothing now (RPC-SPEC §3.5).
 */
export async function readWalletPositions(
  owner: string,
  signal: AbortSignal,
  post: (owner: string, fresh: boolean, options: RouteOptions) => Promise<RelayAnswer<unknown>> = postOwnedPositions,
  { fresh = false }: { hold?: boolean; background?: boolean; onRefused?: () => void; fresh?: boolean } = {},
): Promise<WalletRead> {
  if (!OWNER.test(owner) || ZERO_OWNER.test(owner)) return { ok: false, reason: 'invalid_owner' }
  if (signal.aborted) return { ok: false, reason: 'aborted' }
  const lower = owner.toLowerCase()
  // 2026-10-02 (review findings 8 and 15): fresh too when an action or a new position came since this wallet's last answer.
  const asked = { acted, made: madeCount() }
  const askFresh = fresh || wantsFresh(lower)
  let reply: RelayAnswer<unknown>
  try {
    reply = await post(lower, askFresh, { signal })
  } catch {
    reply = { ok: false, failure: 'unavailable', retryAfterMs: 0 }
  }
  if (signal.aborted) return { ok: false, reason: 'aborted' }
  if (!reply.ok) {
    const wait = Math.min(MAX_REASK_MS, reply.retryAfterMs)
    if (reply.failure === 'rate_limited') return { ok: false, reason: 'chain_busy', ...(wait > 0 ? { retryAt: Date.now() + wait } : {}) }
    return { ok: false, reason: 'chain_unavailable', ...(wait >= SOURCE_AWAY_MS ? { retryAt: Date.now() + wait } : {}) }
  }
  const envelope = parseOwnedEnvelope(reply.value, lower)
  if (!envelope) return { ok: false, reason: 'invalid_reply' }
  const { answer } = envelope
  // RPC fix round 2: an answer from before the owner's action (a node behind its receipt) leaves the wallet unsettled.
  if (!behindOf(lower, answer)) settled.set(lower, asked)
  // 2026-09-28 (speed wave B, item 17): each listed position's feature comes with the list, for its badges. 2026-10-02
  // (review findings 7 and 15): with the answer's block, never over the owner's own action (automationState.ts).
  if (envelope.automation) noteAnswered(envelope.automation.positions, envelope.automation.block)
  // 2026-10-01 (fees item A1): each NFT's mint block, from its own SetupMinted log, a hint for its history.
  if (envelope.mints.length > 0) mintHints.note(envelope.mints)
  const at = Date.now()
  answers.set(lower, { answer, at, made: madeCount() })
  readAt.set(answer, at)
  noteTokens(rows(answer).flatMap((row) => row.currencies))
  return { ok: true, answer }
}

/**
 * The waits before a failed read is asked again, while the page is visible (the owner's rule, 2026-09-25). 2026-09-28
 * (the owner's phone: the list stayed on its loading rows): a read the RPC refused (chain_busy) is asked again after the
 * first wait twice (it held every other read of this browser then, until 2026-10-01), then after the ladder's 10 s
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
  /** `reading` (2026-10-01, fees items A8 and A9): a read is on its way, or due within the quick waits (else a rest is waited out). */
  | { phase: 'retrying'; reason: string; reading?: boolean }
  | { phase: 'failed'; reason: string }

/**
 * The list's own refresh (the owner's OK of 2026-09-27, "pode fazer", on the study made at 7074cbd): the answer on
 * screen is read again every 30 s while the tab is visible, never sooner than 15 s after the last read settled. A
 * refresh that fails, or that reads fewer figures than the answer on screen, keeps that answer and is asked again after
 * 60 s, then every 120 s (or after the wait the route named, when longer). RPC-SPEC: every wallet is refreshed; the
 * route keeps the wallet's SetupMinted walk itself (until then, only a wallet whose scan was incremental was).
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
 *
 * `fresh` (RPC-SPEC P1): the first read is one after an action that changed the list, asked past the route's cache once.
 * A failure that names its wait (a rate refusal's Retry-After, or the source away: no node secret yet, or the node
 * away) is asked again when that wait is over, at most MAX_REASK_MS later, not on the quick ladder; the source away is
 * said at once with the calm line (`failed`), over this browser's copy when there is one.
 */
export function askWallet(owner: string, shown: { current: WalletAnswer | null }, put: (value: WalletAnswerState) => void, every: number | null = null, paused?: { readonly current: boolean }, read = readWalletPositions, hold = true, fresh = false): () => void {
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
  const later = (ms: number): void => after(ms, () => (paused?.current ? later(pace!) : ask(true)))
  // The first read of the page's own: the one other screens share (sharedRead).
  let first = read === readWalletPositions
  // 2026-10-01 (fees items A8 and A9): with nothing on screen, the RPC's refusal of a call of the read on its way says
  // "reading again" at once; after a failure it is said while the page asks again within the quick waits (REASK_MS: a
  // read on its way, or one due in at most 10 s), not over a longer wait (a rest's deadline), when nothing is read.
  let failed: string | null = null
  // The read after an action goes past the route's answer cache, once.
  let freshOnce = fresh
  // RPC fix round 2: an answer from before what this page knows happened to the list (behindOf: a node behind the owner's
  // action, or one that lacks a position made here) is asked again, fresh, on CREATED_REASK_MS's ladder; each wait counts
  // from the answer before it, so each is past the route's fresh window. Then the usual reads, or none.
  let reasks = 0
  const reask = (ms: number): void =>
    after(ms, () => {
      if (paused?.current) return reask(ms)
      freshOnce = true
      ask(true)
    })
  const refused = () => {
    if (!shown.current && !controller.signal.aborted) put({ phase: 'retrying', reason: failed ?? 'chain_busy', reading: true })
  }
  const ask = (background = false) => {
    // Within the quick waits only: once they are spent, the calm line stays through the reads asked every 30 s.
    if (failed && !shown.current && attempts < REASK_MS.length) put({ phase: 'retrying', reason: failed, reading: true })
    const asked = first ? sharedRead(owner, hold, refused, freshOnce) : read(owner, controller.signal, undefined, { hold, background, onRefused: refused, fresh: freshOnce })
    first = false
    freshOnce = false
    void asked.then((result) => {
      if (controller.signal.aborted) return
      const before = shown.current?.owner === owner ? shown.current : null
      // (a)-(c) only with the refresh on: a reader without it (the picker, the automation page) draws each answer it
      // read and asks no more, as before the refresh.
      const kept = pace && before
      if (result.ok && !(kept && poorer(kept, result.answer))) {
        const { answer } = result
        attempts = 0
        if (!kept || (answer.block >= kept.block && !sameRows(kept, answer))) put({ phase: 'ready', answer: (shown.current = answer) })
        if (reasks < CREATED_REASK_MS.length && behindOf(owner, answer)) reask(CREATED_REASK_MS[reasks++])
        else if (pace) later(pace)
        return
      }
      const reason = result.ok ? 'poorer' : result.reason
      const again = passingWalletFailure(reason)
      failed = reason
      // A route's named wait is an absolute gate, not another failed read to poll through. Its deadline comes from the
      // route's own answer (Retry-After, bounded), never from wallet/provider metadata, and must not restart when
      // sharedRead returns a failure kept a few seconds earlier. Wake at that deadline (with the usual two-second
      // minimum, and at most MAX_REASK_MS) instead of exhausting retries locally and then sleeping past it.
      const retryAt = !result.ok ? result.retryAt ?? 0 : 0
      const named = Number.isFinite(retryAt) && retryAt > 0
      const wait = named
        ? Math.min(MAX_REASK_MS, Math.max(REASK_MS[0], retryAt - Date.now()))
        : attempts < REASK_MS.length ? REASK_MS[reason === 'chain_busy' && attempts === 1 ? 0 : attempts] : LATER_MS
      // RPC-SPEC §3.4: the source away (chain_unavailable with a wait of its own) is said at once, with the calm line.
      const away = named && reason === 'chain_unavailable'
      if (!before) {
        shown.current = null
        put(again && attempts < REASK_MS.length && !away ? { phase: 'retrying', reason, reading: wait <= REASK_MS[REASK_MS.length - 1] } : { phase: 'failed', reason })
      }
      if (!again) return
      if (before && pace) later(named ? Math.max(REFRESH_FAILED_MS[attempts ? 1 : 0], wait) : REFRESH_FAILED_MS[attempts ? 1 : 0])
      else after(wait, () => ask())
      attempts += 1
    })
  }
  // The answer this page's own read got for the wallet a moment ago (item 18 above), drawn at once when nothing is on
  // screen: then read again only as the refresh would have (none without it), a read of its own, never one shared; at
  // once when it is from before what this page knows happened to the list (behindOf, RPC fix round 2).
  const memory = first && shown.current?.owner !== owner ? keptWallet(owner) : null
  if (memory) {
    first = false
    put({ phase: 'ready', answer: (shown.current = memory.answer) })
    if (behindOf(owner, memory.answer)) ask(true)
    else if (pace) later(Math.max(0, pace - (Date.now() - memory.at)))
  } else ask()
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
export function useWalletAnswer(owner: string | null, asked = 0, every: number | null = null, paused?: { readonly current: boolean }, hold = true): WalletAnswerState {
  const [state, setState] = useState<{ owner: string; value: WalletAnswerState } | null>(null)
  // The answer on screen, which each later one is measured against.
  const shown = useRef<WalletAnswer | null>(null)
  useEffect(() => {
    if (!owner) return
    // Asked again after an action changed the list: never the answer kept from before it.
    if (asked) forgetWallet()
    // RPC-SPEC P1: a read after an action asks past the route's answer cache, once.
    return askWallet(owner, shown, (value) => setState({ owner, value }), every, paused, readWalletPositions, hold, asked > 0)
  }, [owner, asked, every, paused, hold])
  if (!owner) return { phase: 'idle' }
  // Another wallet's answer is never shown for this one: loading until this one's arrives.
  return state && state.owner === owner ? state.value : { phase: 'loading' }
}

/**
 * 2026-10-02 (review of the RPC switch, findings 8 and 10): the waits before a list that lacks a position this visit's
 * Create position made is asked again, fresh. Each is past the route's fresh window (functions/_lib/owned.ts
 * FRESH_AFTER_MS, 5 s), so each reaches Domino's node again rather than taking the answer the route kept a moment before
 * (a node still behind the mint lacks it for a moment); after the last, no more. Until then the list was asked once more
 * at once, which the route answered from that same kept answer.
 *
 * Changed on purpose 2026-10-02 (RPC fix round 2): askWallet runs the ladder itself, for every screen, and for a list
 * from before the owner's own action too (behindOf); each wait counts from the answer before it, where the screens'
 * useCreatedReask counted from the ask, so a slow scan's answer could leave the next ask inside the fresh window.
 */
export const CREATED_REASK_MS = [6_000, 12_000, 24_000] as const

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
