/**
 * The Wallet card's tokens on Base and Arbitrum One from read-v6's chain-balances (api-contracts/read-v6 README, "Chain
 * reads"), what is pure of it: which tokens to ask about, and the card's rows from the answer. No wallet, no React, no
 * clock; ./WalletNetworks.ts reads and hands the rows to the card (lib/walletNetworks.ts).
 *
 * Added 2026-11-06 (the owner's replica rule; R-07 of the comparison of 4 Nov: "all wallet tokens with USD and a total"):
 * Robinhood Chain's card lists every token the read service finds for the address; on Base and Arbitrum One nothing finds
 * them yet (a list of tokens by wallet is rugged97's to build), so the card asks chain-balances about the tokens Domino
 * already knows the wallet may hold there: each network's own currencies from its profile (ETH, WETH, USDC) and the
 * tokens of the wallet's positions there, as read-v6's portfolio names them. The app reads no listed pools on those
 * networks today (their Top pools are kept in shadow on the backend), so none add to it. Never a public RPC, never another
 * provider: the service's own read, its qualified dollars (`valueUsd`), at most 24 tokens a request.
 */
import type { ChainBalancesResponse, PortfolioResponse, TokenPrice } from 'api-contracts/read-v6/types'
import type { OtherChainId } from '../../lib/create/otherChains'
import { parseScaled } from '../../lib/format/decimal'
import { formatUsd } from '../../lib/format/usd'
import { networkName } from '../../lib/networkName'
import { unsafeSymbol } from '../../lib/symbolReading'
import type { NetworkHolding } from '../../lib/walletNetworks'
import { V2_CHAINS } from '../../v2/chains'
import { lookalikeOf } from '../journey/model/chainReads'
import { displayOf } from '../journey/model/networks'
import { cleanSymbol, profileTokens } from '../journey/tokens'

/** The networks the card reads this way: every V2 network but Robinhood Chain, whose card reads its own list. */
export const WALLET_NETWORK_CHAINS: readonly OtherChainId[] = Object.freeze(V2_CHAINS.map((chain) => chain.chainId).filter((chainId): chainId is OtherChainId => chainId !== 4663))

/** chain-balances takes at most 24 tokens a request (read-v6 README). */
export const BALANCE_TOKENS_AT_MOST = 24

/** A token the card asks about: its network and address (lowercase), and the symbol and decimals Domino knows it by. */
export interface AskedToken {
  chainId: OtherChainId
  address: string
  symbol: string | null
  decimals: number | null
}

const ADDRESS = /^0x[0-9a-f]{40}$/

/** A token that passes for one of its network's own currencies without being it, or whose name is unsafe to show. */
const misleading = (chainId: OtherChainId, address: string, symbol: string | null) => symbol !== null && (unsafeSymbol(symbol) || lookalikeOf(chainId, { address, symbol }) !== null)

/**
 * What to ask chain-balances about (pure): each network's own currencies first, network by network, then the tokens
 * read-v6's portfolio names on those networks (the wallet's positions there), in its order, each once; a look-alike of a
 * network's own currency is never asked (it would never be shown). At most BALANCE_TOKENS_AT_MOST.
 */
export function walletBalanceTokens(portfolio: Pick<PortfolioResponse, 'tokens'> | null): AskedToken[] {
  const asked: AskedToken[] = []
  const seen = new Set<string>()
  const add = (token: AskedToken) => {
    const key = `${token.chainId}:${token.address}`
    if (seen.has(key) || asked.length >= BALANCE_TOKENS_AT_MOST) return
    seen.add(key)
    asked.push(token)
  }
  for (const chainId of WALLET_NETWORK_CHAINS) for (const token of profileTokens(chainId)) add({ chainId, address: token.address.toLowerCase(), symbol: token.symbol, decimals: token.decimals })
  for (const token of portfolio?.tokens ?? []) {
    const chainId = token.chainId as OtherChainId
    const address = String(token.address).toLowerCase()
    if (!WALLET_NETWORK_CHAINS.includes(chainId) || !ADDRESS.test(address)) continue
    const symbol = cleanSymbol(token.symbol)
    if (misleading(chainId, address, symbol)) continue
    add({ chainId, address, symbol, decimals: Number.isInteger(token.decimals) && (token.decimals as number) >= 0 ? token.decimals : null })
  }
  return asked
}

/** The tokens asked, as the request names them (chain-balances' `tokens`). */
export const balanceRequest = (asked: readonly AskedToken[]) => asked.map(({ chainId, address }) => ({ chainId, address }))

/** A dollar amount as read-v6 writes it ("1357.143250") in 10^-18 dollars, or null. */
export function usdUnits(text: string | null | undefined): bigint | null {
  if (typeof text !== 'string') return null
  const parsed = parseScaled(text)
  if (!parsed || parsed.units < 0n) return null
  return parsed.scale <= 18 ? parsed.units * 10n ** BigInt(18 - parsed.scale) : parsed.units / 10n ** BigInt(parsed.scale - 18)
}

/**
 * How a value is priced, for its title, in the words of Robinhood Chain's card (components/portfolio/PortfolioTokens.tsx
 * valueTitle: "USDG counted at $1.", "At $… per token, … Indicative, not a quote."): the network's stable at $1, Chainlink's
 * ETH/USD feed, or the token's own Uniswap pool on its network.
 */
export function priceTitle(price: TokenPrice | null, symbol: string | null, network: string): string {
  if (price === null) return 'Indicative, not a quote.'
  if (price.source === 'chain_stable') return `${symbol ?? 'This token'} counted at $1.`
  const per = formatUsd(price.usd)
  return price.source === 'chainlink_eth_usd' ? `At ${per} per token, from Chainlink’s ETH/USD price. Indicative, not a quote.` : `At ${per} per token, from its Uniswap pool on ${network}. Indicative, not a quote.`
}

/** The card's rows from one answer, and whether that answer is whole: every network asked read, every balance asked read. */
export interface NetworkHoldingsRead {
  whole: boolean
  holdings: NetworkHolding[]
  /** The priced holdings' sum, in 10^-18 dollars. */
  total: bigint
  /** Held tokens with no price. */
  unpriced: number
}

/**
 * The held tokens of `asked` in `answer` (pure), largest value first, then the ones with no price in the order asked
 * (each network's ETH, WETH and USDC first). Only a balance above zero is a holding; a balance that could not be read is
 * never a zero, it makes the read not `whole`, as does a network that could not be read. The symbol and decimals are
 * Domino's where it knows them (a network's profile, the portfolio), else the answer's; a look-alike is left out.
 */
export function networkHoldingsOf(answer: ChainBalancesResponse, asked: readonly AskedToken[]): NetworkHoldingsRead {
  let whole = true
  const found: { holding: NetworkHolding; at: number }[] = []
  asked.forEach((token, at) => {
    const chain = answer.chains.find((entry) => entry.chainId === token.chainId)
    if (!chain || chain.status !== 'current') {
      whole = false
      return
    }
    const read = chain.balances.find((entry) => String(entry.address).toLowerCase() === token.address)
    if (!read || read.status !== 'read' || read.balanceRaw === null || !/^\d+$/.test(read.balanceRaw)) {
      whole = false
      return
    }
    if (BigInt(read.balanceRaw) === 0n) return
    const symbol = token.symbol ?? cleanSymbol(read.symbol)
    if (misleading(token.chainId, token.address, symbol)) return
    const decimals = token.decimals ?? (Number.isInteger(read.decimals) && (read.decimals as number) >= 0 ? read.decimals : null)
    const display = displayOf(token.chainId, { address: token.address as `0x${string}`, symbol, decimals })
    const network = networkName(token.chainId)
    const value = usdUnits(read.valueUsd)
    found.push({
      at,
      holding: { key: `${token.chainId}:${token.address}`, chainId: token.chainId, network, token: display, raw: read.balanceRaw, value, priceTitle: value === null ? null : priceTitle(read.price, symbol, network) },
    })
  })
  found.sort((a, b) => {
    const x = a.holding.value
    const y = b.holding.value
    if (x !== null && y !== null && x !== y) return x > y ? -1 : 1
    if ((x === null) !== (y === null)) return x === null ? 1 : -1
    return a.at - b.at
  })
  const holdings = found.map((entry) => entry.holding)
  return { whole, holdings, total: holdings.reduce((sum, holding) => sum + (holding.value ?? 0n), 0n), unpriced: holdings.filter((holding) => holding.value === null).length }
}

/**
 * Whether an answer is older than an action this page saw confirmed on one of its networks (`barrier`: the newest
 * confirmed block per network for this wallet): such an answer may not show it yet, so it is not taken and is asked
 * again, as Robinhood Chain's card does with its own reads (lib/positionEvidence.ts createWalletReadGuard).
 */
export function behindBarrier(answer: ChainBalancesResponse, barrier: ReadonlyMap<number, number>): boolean {
  for (const [chainId, block] of barrier) {
    const chain = answer.chains.find((entry) => entry.chainId === chainId)
    if (chain?.status === 'current' && chain.snapshot !== null && chain.snapshot.number < block) return true
  }
  return false
}
