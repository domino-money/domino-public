import type {
  ActivityResponse, ChainStatus, IndexedToken, Mandate, PortfolioResponse, Position as V6Position, Tariff, Vault, VaultEvent,
} from 'api-contracts/read-v6/types'
import { amountText } from '../../components/positions/walletSteps'
import { feeFromPips } from '../../lib/read/screens/fee'
import { isV2ChainId, v2Chain } from '../../v2/chains'
import { formatUnitsText, groupDigits, shortAddress } from '../../v2/plan/present'
import { coverageNote } from '../../v2/read/v6'
import { ZERO_ADDRESS, type Address, type V2ChainId } from '../../v2/types'
import { USD_SHOWN } from '../position/constants'
import { protectionStanding, type ProtectionStanding } from '../autoexit/standing'
import { exitReceiptOutcome } from '../autoexit/receipt'
import { v2PositionHref } from '../route'
import { rawAmounts, usdOfPoolAmounts } from '../usd'
import { positionOfState } from '../../lib/walletCards'
import { minimumPositionBlock, positionBurn, positionKey, positionObservation } from './positionSync'
import { automationState, confirmedPositionAutomation } from '../automate/store'
import { POSITION_VALUATIONS } from './valuation'

/**
 * What the Positions screen's two lists take from read-v6 (spec F7 rev4 §6.2, §6.3, §2.11; the integration brief's data
 * rule): the wallet's positions on the three chains as rows of Your positions, and its receipts as rows of Receipts. Pure:
 * the screens hand in a body the package's validator already accepted (src/v2/read/v6.ts), and draw what comes out.
 *
 * Nothing is made up. Amounts are raw integers in the token's own units, written with the token's decimals when read-v6
 * read them and in raw units otherwise (never guessed). USD uses qualified prices, or an explicitly attributed mark at
 * the position's pool price into its one qualified currency. Neither method supplies personal APR or invents an
 * independent token quote. A position the index could not read is said so, never drawn as zeros.
 * Each chain's status comes before its values: a stale chain's rows carry the stale badge and the age of what is shown;
 * an unavailable chain is §6.3's partial sentence, and never empties the others. A token's symbol is untrusted text
 * (control and invisible characters dropped, bounded); its identity is its chain and address.
 *
 * Copied on purpose from the rejected #/v2 screens' logic (src/v2ui/s1/model.ts, src/v2ui/vault/{portfolio,tokens}.ts),
 * never imported: those files go.
 */

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** "Robinhood Chain", "Base", "Arbitrum One": the chain profiles' own names. */
export const chainName = (chainId: V2ChainId): string => v2Chain(chainId).name
/** "Uniswap v3" or "Uniswap v4". */
export const dexName = (dex: 3 | 4): string => `Uniswap v${dex}`

/** A symbol as untrusted text: control, bidirectional and invisible characters dropped, at most 24 characters; null for none. */
export function cleanSymbol(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const clean = Array.from(value).filter((ch) => {
    const c = ch.codePointAt(0) as number
    return !(c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff)
  }).join('').trim()
  if (!clean) return null
  const characters = Array.from(clean)
  return characters.length > 24 ? `${characters.slice(0, 24).join('')}…` : clean
}

export interface TokenName {
  chainId: V2ChainId
  address: Address
  /** A symbol (the chain profile's, or read-v6's as untrusted text), or the short address. */
  label: string
  /** True when `label` is a symbol, false when it is the short address. */
  symbol: boolean
  decimals: number | null
  /** Added 2026-10-06: its USD price per whole token as read-v6 gave it (18 decimals), while V2 shows USD; null: none. */
  usd: string | null
}

/**
 * How a list names a token on a chain: native ETH, the chain's charge currencies and WETH by the chain profile (the app's
 * own data); any other by read-v6's metadata (`symbol` untrusted, `decimals` null when unread); with neither, its short
 * address and unknown decimals.
 */
export function tokenNamer(tokens: readonly IndexedToken[]): (chainId: V2ChainId, address: string) => TokenName {
  return (chainId, address) => {
    const token = address.toLowerCase() as Address
    const chain = v2Chain(chainId)
    const read = tokens.find((t) => t.chainId === chainId && t.address.toLowerCase() === token)
    // Changed on purpose 2026-10-06 (read-v6 1.1.0-rc.1's qualified USD): its price, whichever names it.
    const usd = USD_SHOWN && read?.price ? read.price.usd : null
    if (token === ZERO_ADDRESS) return { chainId, address: token, label: chain.nativeSymbol, symbol: true, decimals: 18, usd }
    const charge = chain.chargeCurrencies.find((c) => c.address === token)
    if (charge) return { chainId, address: token, label: charge.symbol, symbol: true, decimals: charge.decimals, usd }
    if (chain.wrappedNative.address === token) return { chainId, address: token, label: chain.wrappedNative.symbol, symbol: true, decimals: chain.wrappedNative.decimals, usd }
    const symbol = read ? cleanSymbol(read.symbol) : null
    return { chainId, address: token, label: symbol ?? shortAddress(token), symbol: symbol !== null, decimals: read ? read.decimals : null, usd }
  }
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/**
 * An amount as a row shows it (V1's own four kinds, components/positions/PositionFigures.tsx Amount): `units` in the
 * token's units to six significant digits, every digit in `exact`; `zero`, a measured zero; `raw`, the token's decimals
 * unknown (a dash, the raw integer in its title); `unread`, no figure at all (a dash).
 */
export interface AmountShown {
  kind: 'units' | 'zero' | 'raw' | 'unread'
  text: string
  exact: string | null
  raw: string
  token: TokenName
}

export function amountShown(raw: string | bigint | null, token: TokenName): AmountShown {
  if (raw === null) return { kind: 'unread', text: '—', exact: null, raw: '', token }
  const value = String(raw)
  if (!/^-?(0|[1-9][0-9]*)$/.test(value)) return { kind: 'unread', text: '—', exact: null, raw: '', token }
  if (/^-?0$/.test(value)) return { kind: 'zero', text: '0', exact: '0', raw: '0', token }
  const shown = token.decimals === null ? null : amountText(value.replace(/^-/, ''), token.decimals)
  if (!shown) return { kind: 'raw', text: '—', exact: null, raw: value, token }
  return { kind: 'units', text: shown.text, exact: shown.exact, raw: value, token }
}

/** An amount in words: "1.5 USDG", or "1,500,000 raw units of MANY" when the token's decimals are unknown. */
export function amountWords(raw: string | bigint, token: TokenName): string {
  const value = BigInt(raw)
  const magnitude = value < 0n ? -value : value
  if (token.decimals === null) return `${groupDigits(magnitude.toString(10))} raw units of ${token.label}`
  const shown = amountText(magnitude, token.decimals)
  return `${shown ? shown.text : formatUnitsText(magnitude, token.decimals)} ${token.label}`
}

/** Wei as ETH with every digit kept ("0.00000000015 ETH"): a receipt's own figure, never rounded. */
export function weiWords(wei: string | bigint): string {
  const value = BigInt(wei)
  return `${formatUnitsText(value, 18, 18)} ETH`
}

/** A gas price in gwei with every digit kept ("0.02 gwei"). */
export function gweiWords(wei: string | bigint): string {
  return `${formatUnitsText(BigInt(wei), 9, 9)} gwei`
}

/** A rate in basis points as a percent: 65 -> "0.65%", 20 -> "0.2%", 200 -> "2%". */
export function rateWords(bps: number): string {
  return `${Number((bps / 100).toFixed(2)).toString()}%`
}

// ---------------------------------------------------------------------------
// Ages
// ---------------------------------------------------------------------------

/** How old something is, in V1's units (lib/markets.ts): "40 s ago", "6 min ago", "3 h ago", "4 days ago"; never negative. */
export function agoWords(seconds: number): string {
  const ago = Math.max(0, Math.floor(seconds))
  if (ago < 120) return `${ago} s ago`
  if (ago < 7_200) return `${Math.floor(ago / 60)} min ago`
  if (ago < 172_800) return `${Math.floor(ago / 3_600)} h ago`
  return `${Math.floor(ago / 86_400)} days ago`
}

// ---------------------------------------------------------------------------
// Chains (§6.2 `chains`, §6.3)
// ---------------------------------------------------------------------------

export interface ChainNote {
  chainId: V2ChainId
  name: string
  state: 'current' | 'stale' | 'unavailable'
  reason: ChainStatus['reason']
  /** For a stale chain: how old what the index shows is ("updated 6 min ago"), from its last indexed block; else null. */
  age: string | null
}

/** Each chain's status in an answer (the three, in id order), the stale ones with the age of what they show. */
export function chainNotes(answer: { chains: readonly ChainStatus[]; servedAt: number }): ChainNote[] {
  return answer.chains.flatMap((chain) => {
    if (!isV2ChainId(chain.chainId)) return []
    const seen = chain.indexedThrough?.timestamp ?? chain.head?.timestamp ?? null
    const age = chain.status === 'stale' ? (seen !== null ? `updated ${agoWords(answer.servedAt - seen)}` : chain.lagSeconds !== null ? `updated ${agoWords(chain.lagSeconds)}` : null) : null
    return [{ chainId: chain.chainId, name: chainName(chain.chainId), state: chain.status, reason: chain.reason, age }]
  })
}

/** §6.3's partial sentence ("Showing Robinhood Chain and Base. Arbitrum is unavailable right now."), or null when no chain is out. */
export const partialSentence = (chains: readonly ChainStatus[]): string | null => coverageNote(chains)

// ---------------------------------------------------------------------------
// Positions (§6.2 `portfolio.positions`)
// ---------------------------------------------------------------------------

export type RowState = 'in-range' | 'out-of-range' | 'closed' | 'unread'

export interface VaultBadge {
  role: 'root' | 'successor'
  /** The automation's name, when the vault's state was read: "Auto-compound" or "Domino-compound". */
  name: string | null
  /** Under the name when it does not run: "Paused", "Automation off"; null while it runs. */
  word: string | null
  running: boolean
}

export interface PositionRowView {
  /** Network, position manager and NFT. Numeric ids alone are not globally unique. */
  key: string
  positionManager: string
  block: number | null
  chainId: V2ChainId
  chain: string
  dex: 3 | 4
  dexName: string
  tokenId: string
  href: string
  status: 'live' | 'unavailable' | 'not_read'
  /** Unknown liquidity is pending, never counted as an open position. */
  tab: 'open' | 'closed' | 'pending'
  tokens: readonly [TokenName, TokenName] | null
  /** The pool's fee tier as V1's rows write it ("0.30%", lib/read/screens/fee.ts), when read. */
  fee: string | null
  state: RowState
  /** Why the figures are dashes, for a position the index could not read. */
  unread: string | null
  value: readonly [AmountShown, AmountShown] | null
  fees: readonly [AmountShown, AmountShown] | null
  /**
   * Added 2026-10-06 (read-v6 1.1.0-rc.1's qualified USD): the value and the fees in USD (decimal strings), from a fresh
   * read using qualified prices or the same one-currency pool mark as New position; null without either valid basis.
   */
  valueUsd: string | null
  feesUsd: string | null
  valueUsdBasis?: 'qualified-prices' | 'pool-price'
  feesUsdBasis?: 'qualified-prices' | 'pool-price'
  usdPoolTitle?: string
  /** An unchanged complete USD snapshot while the qualified source is temporarily unread. */
  usdSavedAt?: number
  usdReason?: string
  /** The stale badge's age ("updated 6 min ago"): the chain's when it is behind, else the position's own read's. */
  stale: string | null
  vault: VaultBadge | null
  /** A v4 pool with a hook: shown, but nothing is offered on it (decision #6). */
  hooked: boolean
  family: { successors: number; reserves: 'available' | 'unknown' | null } | null
}

/** A proved burn ends the NFT; its old token amounts are not presented as the wallet's present balance. */
export function withTerminalEvidence(row: PositionRowView): PositionRowView {
  const burn = positionBurn(row)
  if (burn && burn.block >= (row.block ?? 0)) return { ...row, block: burn.block, status: 'live', tab: 'closed', state: 'closed', value: null, fees: null, valueUsd: null, feesUsd: null, stale: null, unread: 'This position was closed and its NFT was burned.' }
  // Retain known amounts while the index catches up, but never classify a pre-confirmation
  // snapshot as a currently open NFT (including an older inventory merged into read-v6).
  if ((row.block ?? 0) < minimumPositionBlock(row)) return { ...row, tab: 'pending', state: 'unread', stale: 'Updating', unread: 'Updating after your transaction.' }
  return row
}

const UNREADABLE = 'This position can’t be read right now.'
const NOT_READ = 'This position hasn’t been read yet.'

/** What the badge of Auto-exit's own vault adds to its name, by where its Auto-exit stands (nothing while it is on). */
const EXIT_WORD: Readonly<Record<ProtectionStanding, string | null>> = { on: null, paused: 'Paused', off: 'Off', closed: 'Completed' }

/**
 * A vault's automation as a row's badge (§5.1, §5.3, §5.4; decision #25: a paused vault with auto-exit on is the
 * protection-only one). Changed on purpose 2026-10-06 (the owner's point 5): it is Auto-exit's, and named so. Changed on
 * purpose 2026-10-06 (the review of point 5): said by its root's orders (../autoexit/standing.ts), before its custody,
 * which an exit disarms: "Auto-exit" while one is on, else "Auto-exit · Off", "· Paused" or "· Completed",
 * never a compounding name (it records Auto-compound's mode with one position). Changed on purpose 2026-10-06 (the
 * integration review, rugged-literal #1 and #2): "Paused" only when its order is blocked (§4.5's `blockedBy`), never for a
 * root a Collect fees or an Add liquidity disarmed while the exit can still fire; and still Auto-exit's after Leave
 * automation turned its module off ("Auto-exit · Paused"), never "Auto-compound · Automation off".
 */
function vaultBadge(position: V6Position, vaults: readonly Vault[], mandates: readonly Mandate[], wallet: string | undefined, halted: boolean, automation: ReturnType<typeof automationState>): VaultBadge | null {
  const vault = position.vault ? vaults.find((v) => v.chainId === position.chainId && v.address.toLowerCase() === position.vault!.address.toLowerCase()) ?? null : null
  const orders = mandates.filter(order => order.chainId === position.chainId && order.vault.toLowerCase() === vault?.address.toLowerCase() && order.tokenId === position.tokenId)
  const proof = confirmedPositionAutomation(automation, {
    chainId: position.chainId, positionManager: position.positionManager, tokenId: position.tokenId, dex: position.dex, wallet, vault: position.vault?.address, halted,
    listedBlock: vault?.state.status === 'read' ? vault.state.snapshot.number : null,
    listedNonce: vault?.state.status === 'read' ? BigInt(vault.state.stateNonce) : null,
  }, vault?.state.status === 'read' ? {
    mode: vault.state.policy.mode, paused: vault.state.paused, armed: vault.custody.armed, module: vault.state.exitModule, hasExit: orders.length > 0,
    activeExitIds: orders.filter(order => order.status === 'active' && !order.expired).map(order => order.mandateHash),
    blockedExitIds: orders.filter(order => order.blockedBy.some(reason => !['expired', 'module_disabled', 'custody_unread'].includes(reason))).map(order => order.mandateHash),
  } : undefined)
  const role = position.vault?.role ?? 'root'
  if (proof) return { role, name: proof.name, word: proof.word, running: proof.running }
  if (!position.vault) return null
  if (!vault) return { role, name: null, word: null, running: false }
  if (vault.state.status !== 'read' || vault.custody.armed === null || vault.state.snapshot.number < minimumPositionBlock(position)) return { role, name: null, word: 'Updating', running: false }
  const exit = protectionStanding(vault, mandates)
  if (exit !== null) return { role, name: 'Auto-exit', word: EXIT_WORD[exit], running: exit === 'on' }
  const name = vault.state.status === 'read' ? (vault.state.policy.mode === 'domino' ? 'Domino-compound' : 'Auto-compound') : null
  const paused = vault.state.status === 'read' ? vault.state.paused : vault.pausedBy !== null
  if (role === 'root' && vault.custody.armed === false) return { role, name, word: 'Automation off', running: false }
  if (paused) return { role, name, word: vault.pausedBy === 'owner' ? 'Paused by you' : vault.pausedBy === 'operator' ? 'Paused by Domino' : 'Paused', running: false }
  return { role, name, word: null, running: name !== null }
}

function rowOf(position: V6Position, answer: Pick<PortfolioResponse, 'chains' | 'tokens' | 'vaults' | 'servedAt'> & Partial<Pick<PortfolioResponse, 'mandates' | 'wallet'>>, name: ReturnType<typeof tokenNamer>, automation: ReturnType<typeof automationState>): PositionRowView | null {
  if (!isV2ChainId(position.chainId)) return null
  const chainId = position.chainId
  const chain = answer.chains.find((c) => c.chainId === chainId)
  const chainStale = chain?.status === 'stale' ? (chainNotes({ chains: [chain], servedAt: answer.servedAt })[0]?.age ?? 'stale') : null
  const tokenId = position.tokenId
  const observed = positionObservation(position)
  const live = position.state.status === 'live' ? position.state : null
  const ownRead = observed && (!live || observed.block >= live.snapshot.number) ? observed : null
  const families = answer.vaults.filter((vault) => vault.chainId === chainId && vault.dex === position.dex && vault.rootTokenId === tokenId)
  const successors = new Set(families.flatMap((vault) => vault.members.filter((member) => member.role === 'successor' && member.status === 'active').map((member) => member.tokenId))).size
  const reserves = families.some((vault) => vault.state.status === 'read' && vault.state.reserves.some((reserve) => BigInt(reserve.total) > 0n)) ? 'available' as const : families.some((vault) => vault.state.status !== 'read') ? 'unknown' as const : null
  const base = {
    key: positionKey(position),
    positionManager: position.positionManager.toLowerCase(),
    block: ownRead?.block ?? live?.snapshot.number ?? null,
    chainId,
    chain: chainName(chainId),
    dex: position.dex,
    dexName: dexName(position.dex),
    tokenId,
    href: v2PositionHref({ chainId, dex: position.dex, tokenId: BigInt(tokenId) }),
    vault: vaultBadge(position, answer.vaults, answer.mandates ?? [], answer.wallet, chain?.automationHalted === true, automation),
    family: families.length ? { successors, reserves } : null,
  }
  // /state has no block hash. Use its validated amounts as a frontend observation, never forge a read-v6 snapshot.
  const wallet = ownRead ? positionOfState(ownRead.position) : null
  const state = ownRead && wallet ? {
    status: 'live' as const,
    pool: { ...ownRead.position.poolKey, dex: 4 as const },
    liquidity: wallet.liquidity,
    sqrtPriceX96: ownRead.position.sqrtPriceX96,
    inRange: ownRead.position.tick >= ownRead.position.tickLower && ownRead.position.tick < ownRead.position.tickUpper,
    principalAtSpot: wallet.principal ?? [],
    feesOwed: [ownRead.position.unclaimed0, ownRead.position.unclaimed1],
    freshness: { status: answer.servedAt - ownRead.timestamp > 60 ? 'stale' as const : 'fresh' as const, ageSeconds: Math.max(0, answer.servedAt - ownRead.timestamp) },
  } : position.state
  if (state.status !== 'live') {
    const own = state.status === 'unavailable' && state.freshness.status === 'stale' ? `updated ${agoWords(state.freshness.ageSeconds)}` : null
    return {
      ...base,
      status: state.status,
      tab: 'pending',
      tokens: null,
      fee: null,
      state: 'unread',
      unread: state.status === 'unavailable' ? UNREADABLE : NOT_READ,
      value: null,
      fees: null,
      valueUsd: null,
      feesUsd: null,
      stale: chainStale ?? own,
      hooked: false,
    }
  }
  const tokens = [name(chainId, state.pool.currency0), name(chainId, state.pool.currency1)] as const
  const liquidity = BigInt(state.liquidity)
  const pair = (values: readonly string[]) => (values.length === 2 ? ([amountShown(values[0], tokens[0]), amountShown(values[1], tokens[1])] as const) : null)
  const pending = (base.block ?? 0) < minimumPositionBlock(position)
  const fresh = state.freshness.status === 'fresh' && chain?.status === 'current' && !pending
  const valuationOf = (values: readonly string[]) => {
    const raws = fresh && values.length === 2 ? rawAmounts(values) : null
    return raws ? usdOfPoolAmounts({
      amounts: [raws[0], raws[1]], decimals: [tokens[0].decimals, tokens[1].decimals],
      prices: [tokens[0].usd, tokens[1].usd], sqrtPriceX96: state.sqrtPriceX96,
      allowPoolMark: state.pool.dex !== 4 || state.pool.hooks.toLowerCase() === ZERO_ADDRESS,
    }) : null
  }
  const valueMark = valuationOf(state.principalAtSpot), feesMark = valuationOf(state.feesOwed)
  const valueUsd = valueMark?.value ?? null, feesUsd = feesMark?.value ?? null
  const poolMark = valueMark?.basis === 'pool-price' ? valueMark : feesMark?.basis === 'pool-price' ? feesMark : null
  // A newer direct observation is a separate set of amounts; it cannot borrow the index's complete USD snapshot.
  const saved = fresh && !ownRead && (valueUsd === null || feesUsd === null) && answer.wallet
    ? POSITION_VALUATIONS.get({ ...answer, wallet: answer.wallet, positions: [position] }, position) : null
  const usdReason = valueUsd === null || feesUsd === null
    ? !fresh ? pending ? 'awaiting_receipt_block' : 'stale_position_or_chain'
      : [...new Set(tokens.flatMap(token => token.usd !== null ? [] : answer.tokens.find(item => item.chainId === chainId && item.address === token.address)?.priceReason ?? 'token_price_unavailable'))].join(',') || 'amount_unavailable'
    : undefined
  return {
    ...base,
    status: 'live',
    tab: liquidity > 0n ? 'open' : 'closed',
    tokens,
    fee: feeFromPips(state.pool.fee),
    state: liquidity === 0n ? 'closed' : state.inRange ? 'in-range' : 'out-of-range',
    unread: null,
    value: pair(state.principalAtSpot),
    fees: pair(state.feesOwed),
    valueUsd: saved?.value ?? valueUsd,
    feesUsd: saved?.fees ?? feesUsd,
    valueUsdBasis: valueMark?.basis,
    feesUsdBasis: feesMark?.basis,
    ...(poolMark ? { usdPoolTitle: `Estimated from the pool price at block ${base.block}, converted with ${tokens[poolMark.anchor].label}’s qualified USD price. This is not a sale quote.` } : {}),
    ...(saved ? { usdSavedAt: saved.at } : {}),
    ...(usdReason ? { usdReason } : {}),
    stale: pending ? 'Updating' : chainStale ?? (state.freshness.status === 'stale' ? `updated ${agoWords(state.freshness.ageSeconds)}` : null),
    hooked: state.pool.dex === 4 && state.pool.hooks.toLowerCase() !== ZERO_ADDRESS,
  }
}

/** The Robinhood Chain Uniswap v4 position manager: V1's positions are its NFTs. */
const ROBINHOOD_V4_MANAGER = (): string => v2Chain(4663).uniswap.v4.positionManager

/**
 * The rows of an answer's positions, in the order listed, on the chains `open` admits (the gate). `v1Ids`: the NFT ids
 * V1's own list shows; a read-v6 Robinhood Chain v4 position with one of them is the same NFT, shown once, as V1's row.
 */
export function positionRows(answer: Pick<PortfolioResponse, 'chains' | 'tokens' | 'vaults' | 'positions' | 'servedAt'> & Partial<Pick<PortfolioResponse, 'mandates' | 'wallet'>>, open: (chainId: V2ChainId) => boolean, v1Ids: readonly string[] = [], automation: ReturnType<typeof automationState> = automationState()): PositionRowView[] {
  const name = tokenNamer(answer.tokens)
  const v1 = new Set(v1Ids)
  const manager = ROBINHOOD_V4_MANAGER()
  const out: PositionRowView[] = []
  const seen = new Set<string>()
  for (const position of answer.positions) {
    if (!isV2ChainId(position.chainId) || !open(position.chainId)) continue
    if (position.chainId === 4663 && position.dex === 4 && position.positionManager.toLowerCase() === manager && v1.has(position.tokenId)) continue
    const row = rowOf(position, answer, name, automation)
    if (!row || seen.has(row.key)) continue
    seen.add(row.key)
    out.push(withTerminalEvidence(row))
  }
  return out
}

// ---------------------------------------------------------------------------
// Receipts (§6.2 `activity`, §2.11, rev4 §2.13)
// ---------------------------------------------------------------------------

export interface ReceiptLine {
  label: string
  value: string
  /** A data attribute's value for the line (its kind), for tests. */
  data: string
  /** A technical figure (a liquidity amount): drawn with the receipt's technical details, small and last. */
  tech?: true
}

export interface ReceiptFee {
  /** "Domino fee (0.65% of the amount swapped)", "Automation fee (4%)", "Auto-exit fee (0.2%)". */
  label: string
  kind: Tariff['kind']
  rate: string | null
  /** The fee in its token. */
  value: string
  /** The part still owed to Domino's fee recipient (its push failed): part of the fee, never the owner's, never charged again. */
  deferred: string | null
}

export interface ReceiptGas {
  sender: string
  gasUsed: string
  gasPrice: string
  /** The L1 data fee the receipt states (OP Stack); null when the receipt states none. */
  l1Fee: string | null
}

export interface ReceiptView {
  id: string
  chainId: V2ChainId
  chain: string
  kind: ActivityResponse['items'][number]['kind']
  /** What happened, in plain words. */
  what: string
  /** The one figure the row's summary shows, when the receipt has one. */
  amount: string | null
  lines: readonly ReceiptLine[]
  fees: readonly ReceiptFee[]
  /** The receipt's gas fields as stated; null when it states none. No total is claimed (§6.2). */
  gas: ReceiptGas | null
  hash: string
  block: number
  /** The block's time (Unix seconds). */
  at: number
  /**
   * Display only. Added 2026-10-14 (incident C1; the owner's decision D0): in a block of the chain with success, which
   * is when the row carries its check (./receiptParts.tsx). `finalized` beside it keeps its meaning, at or below the
   * chain's finalized block: it is one line of the opened receipt now, no longer what the check waits for.
   */
  confirmed: boolean
  finalized: boolean
}

type Item = ActivityResponse['items'][number]

/** The fee line's label for a tariff kind and rate (§1.6, §2.11, §4.6, §5.7). */
function feeLabel(kind: Tariff['kind'], rateBps: number | null): string {
  if (kind === 'assisted_swap') return 'Domino fee (0.65% of the amount swapped)'
  if (kind === 'auto_exit') return 'Auto-exit fee (0.2%)'
  return rateBps === null ? 'Automation fee' : `Automation fee (${rateWords(rateBps)})`
}

function feesOf(tariffs: readonly Tariff[], token: (address: string) => TokenName): ReceiptFee[] {
  return tariffs.map((tariff) => ({
    label: feeLabel(tariff.kind, tariff.rateBps),
    kind: tariff.kind,
    rate: tariff.rateBps === null ? null : rateWords(tariff.rateBps),
    value: amountWords(tariff.amount, token(tariff.token)),
    deferred: BigInt(tariff.deferred) > 0n ? amountWords(tariff.deferred, token(tariff.token)) : null,
  }))
}

const S1_WHAT: Readonly<Record<'create' | 'increase' | 'change_range' | 'exit', (id: string) => string>> = {
  create: (id) => `Created position #${id}`,
  increase: (id) => `Added to position #${id}`,
  change_range: (id) => `Changed the range: position #${id}`,
  exit: (id) => `Withdrew from position #${id}`,
}

/** §5.4's words for a disarm reason (rev3 §2.13). */
const DISARM_TEXT: Readonly<Record<string, string>> = {
  unsubscribed_or_transferred: 'This position left your wallet or Domino was unsubscribed.',
  changed_outside_domino: 'This position was changed outside Domino.',
  burned: 'This position was closed. Its automation has ended.',
  custody_lost: 'Domino no longer has permission on this position, or it left your wallet.',
  v3_checkpoint_mismatch: 'This position changed outside Domino.',
  auto_exit: 'Auto-exit executed.',
  exit_all: 'You ended your automation.',
}

/**
 * One vault event in words, or null for one a person need not read (the v3 checkpoint). rev4 §2.13 (#311): a
 * `ReservesWithdrawn` the owner did not send is the automation's `returnReserves()`: "Returned to your wallet", never the
 * owner's own withdrawal.
 */
function vaultEventWords(event: VaultEvent['events'][number], owner: string, sender: string | null, token: (address: string) => TokenName): string | null {
  switch (event.event) {
    case 'PolicyChanged': return `Automation settings saved: ${event.policy.mode === 'domino' ? 'Domino-compound' : 'Auto-compound'}`
    case 'LimitsChanged': return 'Limits saved'
    case 'AutomationPaused': return event.actor.toLowerCase() === owner ? 'Paused by you' : 'Paused by Domino'
    case 'AutomationResumed': return 'Automation resumed'
    case 'RootDisarmed': return DISARM_TEXT[event.reason] ?? 'Automation stopped for this position.'
    case 'RootRearmed': return sender !== null && sender !== owner ? 'Turned back on by Domino after someone added liquidity to your position.' : 'Turned back on'
    case 'RootCheckpointed': return null
    // A receipt that names no sender says neither: the money went to the owner's wallet either way.
    case 'ReservesWithdrawn': return sender === null
      ? `Sent to your wallet from your automation: ${amountWords(event.amount, token(event.token))}`
      : sender !== owner
        ? `Returned to your wallet: ${amountWords(event.amount, token(event.token))}`
        : `Withdrawn to your wallet: ${amountWords(event.amount, token(event.token))}`
    case 'ChildWithdrawn': return `Position #${event.tokenId} withdrawn to your wallet`
    case 'TokenRecovered': return `Recovered: ${amountWords(event.amount, token(event.token))}`
    case 'PositionRecovered': return `Position #${event.tokenId} recovered to your wallet`
    case 'ExitModuleSet': return event.module === null || event.module.toLowerCase() === ZERO_ADDRESS ? 'Auto-exit turned off' : 'Auto-exit turned on'
  }
  return null
}

/** A pair of a pool's amounts ([amount0, amount1]) in words, the zeros left out; the raw integers when the pool is unknown. */
function pairWords(amounts: readonly string[], tokens: readonly [TokenName, TokenName] | null): string {
  const parts = amounts.flatMap((raw, i) => (BigInt(raw) === 0n ? [] : [tokens ? amountWords(raw, tokens[i as 0 | 1]) : `${groupDigits(raw.replace(/^-/, ''))} raw units`]))
  return parts.length ? parts.join(' + ') : '0'
}

export type ReceiptFinality = (chainId: number, hash: string, blockHash: string) => 'included' | 'finalized' | 'reorged' | null
function receiptOf(item: Item, owner: string, name: ReturnType<typeof tokenNamer>, pools: ReadonlyMap<string, readonly [string, string]>, finality?: ReceiptFinality): ReceiptView | null {
  if (!isV2ChainId(item.chainId)) return null
  const proved = finality?.(item.chainId, item.tx.hash, item.tx.snapshot.hash)
  if (proved === 'reorged') return null
  const chainId = item.chainId
  const token = (address: string) => name(chainId, address)
  const gas = item.tx.gas
  const base = {
    id: item.id,
    chainId,
    chain: chainName(chainId),
    kind: item.kind,
    hash: item.tx.hash,
    block: item.tx.snapshot.number,
    at: item.tx.snapshot.timestamp,
    // Added 2026-10-14 (incident C1; the owner's decision D0): read-v6 lists only what a block's logs prove, so an item
    // it serves is in a block with success, whatever its finality; a reorganised one was withdrawn above.
    confirmed: true,
    finalized: proved === 'finalized' || item.tx.finality === 'finalized',
    gas: gas ? { sender: gas.sender.toLowerCase(), gasUsed: groupDigits(gas.gasUsed), gasPrice: gweiWords(gas.effectiveGasPriceWei), l1Fee: gas.l1FeeWei === null ? null : weiWords(gas.l1FeeWei) } : null,
  }
  const sender = gas ? gas.sender.toLowerCase() : null
  const vaultTokens = (vault: string): readonly [TokenName, TokenName] | null => {
    const pool = pools.get(`${chainId}:${vault.toLowerCase()}`)
    return pool ? [token(pool[0]), token(pool[1])] : null
  }
  switch (item.kind) {
    case 's1_action': {
      const lines: ReceiptLine[] = []
      for (const input of item.inputs) lines.push({ label: 'Paid in', value: amountWords(input.amount, token(input.token)), data: 'paid-in' })
      for (const leg of item.legs) lines.push({ label: 'Swapped', value: `${amountWords(leg.amountIn, token(leg.tokenIn))} → ${amountWords(leg.amountOut, token(leg.tokenOut))}`, data: 'swapped' })
      for (const step of item.steps) {
        const delta = BigInt(step.liquidityDelta)
        const pool = [token(step.pool.currency0), token(step.pool.currency1)] as const
        // Signed: negative went into the pool, positive came out of it (§2.11).
        const amounts = [step.amount0, step.amount1].map((raw, i) => ({ raw: BigInt(raw), token: pool[i as 0 | 1] })).filter((a) => a.raw !== 0n)
        const words = amounts.map((a) => amountWords(a.raw < 0n ? -a.raw : a.raw, a.token)).join(' + ') || '0'
        const label = delta > 0n ? 'Added to the position' : delta < 0n ? 'Taken out of the position' : 'Fees collected'
        lines.push({ label, value: `${words} · position #${step.tokenId}`, data: delta > 0n ? 'added' : delta < 0n ? 'removed' : 'collected' })
      }
      for (const refund of item.refunds) {
        if (BigInt(refund.amount) === 0n) continue
        lines.push({ label: 'Returned to your wallet', value: amountWords(refund.amount, token(refund.token)), data: 'returned' })
      }
      if (item.previousTokenId !== null && item.previousTokenId !== item.tokenId) lines.push({ label: 'Previous position', value: `#${item.previousTokenId}`, data: 'previous' })
      const fees = feesOf(item.tariffs, token)
      if (fees.length === 0) lines.push({ label: 'Domino fee', value: 'No Domino fee', data: 'no-fee' })
      const first = item.action === 'exit' ? item.refunds.find((r) => BigInt(r.amount) > 0n) : item.inputs[0]
      return { ...base, what: S1_WHAT[item.action](item.tokenId), amount: first ? amountWords(first.amount, token(first.token)) : null, lines, fees }
    }
    case 'vault_execution': {
      const tokens = vaultTokens(item.vault)
      const lines: ReceiptLine[] = [
        { label: 'Fees used', value: pairWords([item.compounded.fees0, item.compounded.fees1], tokens), data: 'fees-used' },
        { label: 'Liquidity added', value: groupDigits(item.compounded.liquidityAdded), data: 'added', tech: true },
      ]
      if (item.successor) lines.push({ label: 'New position', value: `#${item.successor.tokenId}`, data: 'successor' })
      const what = item.successor ? `Automated run: position #${item.successor.tokenId} opened` : `Automated run on position #${item.compounded.tokenId}`
      return { ...base, what, amount: pairWords([item.compounded.fees0, item.compounded.fees1], tokens), lines, fees: feesOf(item.tariffs, token) }
    }
    case 'auto_exit': {
      const tokens = vaultTokens(item.vault)
      const outcome = exitReceiptOutcome(item)
      const lines: ReceiptLine[] = outcome.empty ? [
        { label: 'Result', value: 'No tokens were withdrawn or sent to your wallet.', data: 'empty-exit' },
      ] : [
        { label: 'Withdrawn from the position', value: pairWords(item.withdrawn, tokens), data: 'withdrawn' },
        { label: 'Sent to your wallet', value: pairWords(item.delivered, tokens), data: 'delivered' },
      ]
      for (const leg of item.legs) lines.push({ label: 'Converted', value: `${amountWords(leg.amountIn, token(leg.tokenIn))} → ${amountWords(leg.amountOut, token(leg.tokenOut))}`, data: 'converted' })
      if (item.deferred.length) lines.push({ label: 'Waiting for you to claim', value: item.deferred.map((d) => amountWords(d.amount, token(d.token))).join(' + '), data: 'deferred' })
      if (item.reservesReturned.length) lines.push({ label: 'Returned from your automation, no fee', value: item.reservesReturned.map((d) => amountWords(d.amount, token(d.token))).join(' + '), data: 'reserves-returned' })
      return { ...base, what: outcome.title, amount: item.delivered.some((amount) => BigInt(amount) > 0n) ? pairWords(item.delivered, tokens) : null, lines, fees: feesOf(item.tariffs, token) }
    }
    case 'vault_created':
      return {
        ...base,
        what: `Automation set up for position #${item.rootTokenId}`,
        amount: null,
        lines: [{ label: 'Automation', value: item.policy.mode === 'domino' ? 'Domino-compound' : 'Auto-compound', data: 'mode' }],
        fees: [],
      }
    case 'vault_event': {
      const said = item.events.map((event) => vaultEventWords(event, owner, sender, token)).filter((line): line is string => line !== null)
      if (said.length === 0) return null
      return { ...base, what: said[0], amount: null, lines: said.slice(1).map((value) => ({ label: 'Also', value, data: 'event' })), fees: [] }
    }
    // read-v6's own kind for a returnReserves() the owner did not send (0xdecimal's item 8): the words a vault_event
    // with such a ReservesWithdrawn had before.
    case 'reserves_returned': {
      const said = item.reservesReturned.map((line) => `Returned to your wallet: ${amountWords(line.amount, token(line.token))}`)
      return { ...base, what: said[0], amount: null, lines: said.slice(1).map((value) => ({ label: 'Also', value, data: 'event' })), fees: [] }
    }
    case 'auto_exit_event': {
      // Changed on purpose 2026-10-06 (the owner's point 5; the review): Auto-exit's own words, never an "order", as
      // Automate's history says them (../automate/portfolio.ts historyWords).
      if (item.event === 'MandateRegistered') return { ...base, what: `Auto-exit turned on${item.tokenId ? ` for position #${item.tokenId}` : ''}`, amount: null, lines: [], fees: [] }
      if (item.event === 'MandateRevoked') return { ...base, what: 'Auto-exit turned off', amount: null, lines: [], fees: [] }
      if (item.event === 'NonceCancelled') return { ...base, what: 'Auto-exit signature cancelled', amount: null, lines: [], fees: [] }
      const claimed = item.token && item.amount ? amountWords(item.amount, token(item.token)) : null
      return { ...base, what: 'Claimed', amount: claimed, lines: item.recipient ? [{ label: 'Sent to', value: shortAddress(item.recipient), data: 'recipient' }] : [], fees: [] }
    }
    case 'zap_event':
      return { ...base, what: 'Unused signatures cancelled', amount: null, lines: [], fees: [] }
  }
  return null
}

/**
 * An activity page's items as receipts, newest first as served, on the chains `open` admits. `owner`: the wallet the
 * answer is about (who "you" is in an event). `portfolio`: the same wallet's portfolio, when read, for the pool tokens a
 * vault's [amount0, amount1] figures are in (without it they are said in raw units).
 */
export function receiptViews(answer: Pick<ActivityResponse, 'items' | 'tokens' | 'wallet'>, open: (chainId: V2ChainId) => boolean, portfolio: Pick<PortfolioResponse, 'vaults' | 'tokens'> | null = null, finality?: ReceiptFinality): ReceiptView[] {
  const name = tokenNamer([...answer.tokens, ...(portfolio?.tokens ?? [])])
  const pools = new Map<string, readonly [string, string]>()
  for (const vault of portfolio?.vaults ?? []) {
    if (vault.state.status === 'read') pools.set(`${vault.chainId}:${vault.address.toLowerCase()}`, [vault.state.pool.currency0, vault.state.pool.currency1])
  }
  const owner = answer.wallet.toLowerCase()
  const out: ReceiptView[] = []
  for (const item of answer.items) {
    if (!isV2ChainId(item.chainId) || !open(item.chainId)) continue
    const view = receiptOf(item, owner, name, pools, finality)
    if (view) out.push(view)
  }
  return out
}
