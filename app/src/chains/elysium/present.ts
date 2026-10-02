/**
 * The second chain's figures and states in a beginner's words (2026-10-01, the chain2 workstream; the owner's rule:
 * users know nothing about LP, so no jargon on the main screens, technical detail only in the collapsed Details).
 *
 * Amounts are exact token amounts (never a dollar figure: Elysium has no dollar rule and no price provider, so its
 * capabilities hide USD); a price is "1 BASE = X QUOTE", the quote chosen by the registry's ranks; a range is two
 * prices; every figure says where it was read and when. A token's symbol is the token contract's own text, written as
 * text and never trusted as an identity; one with no readable symbol is named by its address, shortened.
 *
 * Pure: strings in, strings out (tests/elysium-present.test.mjs).
 */
import type { ChainConfig } from '../../config/chainKit'
import { priceInvertedOn } from '../../config/chainKit'
import { shortAmount } from '../../lib/format/amount'
import { group, scaledText } from '../../lib/format/decimal'
import { tickPriceIn, usableTicks } from '../../lib/read/screens/poolRange'
import type { ActionsUnavailable, Provenance, TokenInfo } from '../types'
import { priceText } from '../v3math'
import type { FlowStop } from './flow'

/** An address at a glance: 0x1234…abcd. */
export const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`

/** A token's name on the page: its own symbol, or its address shortened when it has none readable. */
export const tokenLabel = (token: TokenInfo): string => token.symbol ?? shortAddress(token.address)

/** An exact amount (raw units) as a decimal, trailing zeros trimmed; null when the token's decimals are unknown. */
export function exactAmount(raw: bigint, decimals: number | null): string | null {
  if (decimals === null) return null
  const text = scaledText(raw, decimals)
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/** An amount as a page writes it: six significant digits at most, the whole part never cut; null without decimals. */
export function amountText(raw: bigint, decimals: number | null): string | null {
  const exact = exactAmount(raw, decimals)
  if (exact === null) return null
  // A dust amount is written as a bound, not as eighteen digits (the audit's E7).
  if (raw > 0n && /^0\.0{6,}/.test(exact)) return '<0.000001'
  const [whole, fraction] = exact.split('.')
  return shortAmount(fraction === undefined ? group(whole) : `${group(whole)}.${fraction}`).short
}

/**
 * A typed amount in a token's raw units: a plain non-negative decimal with at most the token's decimals, below 2^128
 * (his actions schema's bound); null for anything else (an exponent, a sign, grouping, too many digits).
 */
export function parseAmount(text: string, decimals: number | null): bigint | null {
  const value = text.trim()
  if (decimals === null || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$|^\.[0-9]+$/.test(value)) return null
  const [whole = '0', fraction = ''] = value.split('.')
  if (fraction.length > decimals) return null
  const raw = BigInt((whole || '0') + fraction.padEnd(decimals, '0'))
  return raw < 1n << 128n ? raw : null
}

/** The pool's fee tier, from millionths: 3000 → "0.3%", 500 → "0.05%", 10000 → "1%". */
export function feeTierText(fee: number): string {
  const text = scaledText(BigInt(fee), 4).replace(/0+$/, '').replace(/\.$/, '')
  return `${text}%`
}

export interface PriceLine {
  readonly base: TokenInfo
  readonly quote: TokenInfo
  /** The price of one `base` in `quote`, written short; null when a token's decimals are unknown. */
  readonly text: string | null
  /** The same, exact (18 fraction digits, truncated). */
  readonly exact: string | null
}

/** A v3 pool's price as the page writes it on this chain: "1 BASE = X QUOTE". */
export function priceLine(chain: ChainConfig, pool: { token0: TokenInfo; token1: TokenInfo; sqrtPriceX96: bigint }): PriceLine {
  const inverted = priceInvertedOn(chain, pool.token0.address, pool.token1.address)
  const exact = priceText(pool.sqrtPriceX96, pool.token0.decimals, pool.token1.decimals, inverted)
  const trimmed = exact === null ? null : exact.replace(/0+$/, '').replace(/\.$/, '')
  return {
    base: inverted ? pool.token1 : pool.token0,
    quote: inverted ? pool.token0 : pool.token1,
    exact: trimmed,
    text: trimmed === null ? null : shortAmount(trimmed).short,
  }
}

export interface RangeLine {
  /** The range's low and high prices of `base` in `quote` (0 and ∞ at the pool's limits); null when decimals are unknown. */
  readonly low: string | null
  readonly high: string | null
  readonly base: TokenInfo
  readonly quote: TokenInfo
}

/**
 * A position's range as two prices, as the page writes the pool's price: the low and high ends of `base` in `quote`.
 * The pool's ticks stay in the pool's order; for a pool written the other way round, its upper tick is the low price.
 */
export function rangeLine(chain: ChainConfig, position: { token0: TokenInfo; token1: TokenInfo; tickLower: number; tickUpper: number; tickSpacing: number }): RangeLine {
  const inverted = priceInvertedOn(chain, position.token0.address, position.token1.address)
  const decimals = position.token0.decimals === null || position.token1.decimals === null ? null : ([position.token0.decimals, position.token1.decimals] as const)
  const { min, max } = position.tickSpacing > 0 ? usableTicks(position.tickSpacing) : { min: -Infinity, max: Infinity }
  const at = (tick: number, edge: 'low' | 'high'): string | null => {
    // A bound at the pool's limit covers every price on its side.
    const limit = inverted ? (edge === 'low' ? tick >= max : tick <= min) : edge === 'low' ? tick <= min : tick >= max
    if (limit) return edge === 'low' ? '0' : '∞'
    if (!decimals) return null
    const text = tickPriceIn(tick, decimals, inverted)
    return text === null ? null : text.replace(/^≈/, '')
  }
  return {
    low: inverted ? at(position.tickUpper, 'low') : at(position.tickLower, 'low'),
    high: inverted ? at(position.tickLower, 'high') : at(position.tickUpper, 'high'),
    base: inverted ? position.token1 : position.token0,
    quote: inverted ? position.token0 : position.token1,
  }
}

/** How long ago a time (seconds) was, from `now` (milliseconds): "just now", "40 s ago", "3 min ago", "2 h ago", "4 days ago". */
export function agoText(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor(now / 1000 - timestamp))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds} s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`
  const days = Math.floor(seconds / 86_400)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

const grouped = (n: number) => n.toLocaleString('en-US')

/** Where a figure was read and when, in one line. */
export function provenanceText(at: Provenance, chain: ChainConfig, now: number): string {
  const where = at.source === 'chain' ? `Read from ${chain.name}` : `From the ${chain.name} service`
  return `${where} at block ${grouped(at.block)}, ${agoText(at.timestamp, now)}`
}

/** Why a position cannot be created or changed here now, for a beginner. */
export function actionsReasonText(reason: ActionsUnavailable, chain: ChainConfig): string {
  switch (reason) {
    case 'section-off':
      return `${chain.name} isn't open on this site yet.`
    case 'service-off':
      return `Creating positions on ${chain.name} isn't connected to this site yet. You can explore pools and look up positions.`
    case 'deployment-unqualified':
      return `Domino on ${chain.name} is still being tested. Creating positions opens once it is ready.`
    case 'service-says-no':
      return `The ${chain.name} service isn't taking new positions right now.`
    case 'no-signer':
      return 'Signing with your wallet on this network opens in the next release.'
  }
}

/** Why the New position flow stopped, for a beginner, and what happens next. */
export function stopText(reason: FlowStop): string {
  switch (reason) {
    case 'service':
      return "The service couldn't prepare this step. Nothing was sent."
    case 'draft_changed':
      return 'The prepared step did not match what you asked for, so it was not used. Nothing was sent.'
    case 'state_changed':
      return 'Your vault changed since this step was prepared. Nothing was sent; start again to see the new state.'
    case 'expired':
      return 'This step expired before it was signed. Nothing was sent; start again for a fresh one.'
    case 'wallet':
      return "Your wallet couldn't send this step (another network, another account, or something changed). Nothing was sent."
    case 'reverted':
      return 'The network refused this transaction. Its network fee was spent; nothing else happened, and no next step was sent.'
    case 'replaced':
      return 'The transaction was replaced in your wallet, so this flow stopped. Check your wallet before doing anything else.'
  }
}

/** One step of a vault's sequence, as a person reads it. */
export function stepText(step: string, token0: TokenInfo, token1: TokenInfo): string {
  switch (step) {
    case 'approve-reset':
      return 'Reset an old allowance first'
    case 'approve-token0':
      return `Allow your vault to use ${tokenLabel(token0)}`
    case 'approve-token1':
      return `Allow your vault to use ${tokenLabel(token1)}`
    case 'open':
      return 'Create the position'
    case 'set-policy':
      return 'Change automation settings'
    case 'pause':
      return 'Pause or resume automation'
    case 'reduce':
      return 'Remove part of the position'
    case 'release':
      return 'Move the position to your wallet'
    case 'withdraw-fees':
      return 'Withdraw fees'
    case 'withdraw-capital':
      return 'Withdraw funds'
    default:
      return 'Vault step'
  }
}

/** A vault's event, as a person reads it (his service's kinds and the chain's event names are the same words). */
export function historyText(kind: string): string {
  const words: Record<string, string> = {
    PositionOpened: 'Position opened',
    FeesCollected: 'Fees collected',
    FeesConsumed: 'Fees used to grow the position',
    Converted: 'Fees balanced between the two tokens',
    Compounded: 'Fees added back',
    PositionReleased: 'Position moved to your wallet',
    CapitalReduced: 'Part of the position removed',
    PolicyChanged: 'Automation settings changed',
    Paused: 'Automation paused or resumed',
    ReserveWithdrawn: 'Fees withdrawn',
    CapitalWithdrawn: 'Funds withdrawn',
    SurplusRecovered: 'Extra tokens recovered',
    UnmanagedNFTRecovered: 'Position NFT recovered',
  }
  return words[kind] ?? 'Vault activity'
}

/**
 * The most a transaction's network fee can be, in the chain's native currency: its gas limit times its fee cap, exact,
 * then written short (the fee actually paid is usually lower).
 */
export function maxNetworkFee(chain: ChainConfig, transaction: { gasLimitRaw: string; maxFeePerGasWeiRaw: string }): string | null {
  if (!/^\d+$/.test(transaction.gasLimitRaw) || !/^\d+$/.test(transaction.maxFeePerGasWeiRaw)) return null
  const wei = BigInt(transaction.gasLimitRaw) * BigInt(transaction.maxFeePerGasWeiRaw)
  const text = amountText(wei, chain.native.decimals)
  return text === null ? null : `${text} ${chain.native.symbol}`
}
