/**
 * What the connected wallet holds on another network (spec F7 §3.3; the owner's decision #9, 2026-10-02: reads of other
 * chains come from the wallet's own provider, and the site reads no public RPC), read through that provider after the
 * wallet switched there. The crosschain-v1 origins listing is not wired yet (open point #17), so the networks and tokens
 * looked at are this module's own short list, CANDIDATE_ORIGINS: the spec's three chains (Robinhood Chain with its ETH,
 * WETH and USDG; Base and Arbitrum One with their ETH, WETH and USDC), Ethereum and OP Mainnet; never the destination
 * chain itself.
 *
 * Nothing here switches a network (the switch is wallet/port's, handed in), nothing is sent, nothing is guessed: a
 * balance that could not be read is absent, never zero, and only a balance above zero is a holding. No test data stands
 * in for a reading (the owner, 2026-10-02 night: real data only). Pure apart from the injected wallet: no React, no
 * wagmi, no storage; the node tests compile it (tests/v2/holdings.test.mjs). Like finance/routedReplacement.ts, a
 * read-only module admitted by tests/session.source-guard.test.mjs for the one read method it names.
 */

import { ELYSIUM_FUNDS_FROM, ELYSIUM_NAME, ELYSIUM_V2_ID } from '../../lib/elysiumIdentity'
import { v2Chain } from '../../v2/chains'

/** A network the scan looks at, with the tokens read there. Addresses lowercase; address(0) is the chain's ETH. */
export interface OriginCandidate {
  chainId: number
  /** Shown as written: "Ethereum", "Base", "Arbitrum One", "OP Mainnet". */
  name: string
  tokens: readonly { address: string; symbol: string; decimals: number }[]
}

const ZERO = '0x0000000000000000000000000000000000000000'
const ETH = Object.freeze({ address: ZERO, symbol: 'ETH', decimals: 18 })
const weth = (address: string) => Object.freeze({ address, symbol: 'WETH', decimals: 18 })
const usdc = (address: string) => Object.freeze({ address, symbol: 'USDC', decimals: 6 })
const USDG = Object.freeze({ address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', decimals: 6 })

/**
 * Elysium as an origin (added 2026-11-07, Elysium's screens): only where funds can come from it (lib/elysiumIdentity.ts
 * ELYSIUM_FUNDS_FROM: Elysium is live and crosschain-v1 pins Relay or Across for chain 99901; false on 6 Nov 2026), last,
 * with its HYPE, WHYPE and dollar token from its own profile (src/v2/chains.ts). None anywhere else, so no build where
 * funds cannot come from it ever looks there.
 */
function elysiumOrigin(): OriginCandidate[] {
  if (!ELYSIUM_FUNDS_FROM) return []
  const chain = v2Chain(ELYSIUM_V2_ID)
  const stable = chain.chargeCurrencies.find((currency) => currency.rank === 1 && currency.address !== ZERO)
  const own = (address: string, symbol: string, decimals: number) => Object.freeze({ address: address.toLowerCase(), symbol, decimals })
  return [{ chainId: ELYSIUM_V2_ID, name: ELYSIUM_NAME, tokens: [own(ZERO, chain.nativeSymbol, 18), own(chain.wrappedNative.address, chain.wrappedNative.symbol, chain.wrappedNative.decimals), ...(stable ? [own(stable.address, stable.symbol, stable.decimals)] : [])] }]
}

/**
 * The networks looked at while the origins listing cannot be asked: the spec's three (spec F7 §3.1: a deposit arrives on
 * Robinhood Chain, Base or Arbitrum One, from any other), their WETH, USDC and USDG the chain profiles' own
 * (api-contracts/v2/chains/*.json), then Ethereum and OP Mainnet, every one ETH-native. The destination itself is never
 * looked at (Holdings.tsx). Changed on purpose 2026-10-05 (the owner: a position on Base or Arbitrum One funded from the
 * other two networks too): Robinhood Chain is an origin as well, for a deposit that arrives on Base or Arbitrum One.
 * Changed on purpose 2026-11-07 (Elysium's screens): and Elysium, last, only where funds can come from it (elysiumOrigin).
 */
export const CANDIDATE_ORIGINS: readonly OriginCandidate[] = Object.freeze([
  { chainId: 4663, name: 'Robinhood Chain', tokens: [ETH, weth('0x0bd7d308f8e1639fab988df18a8011f41eacad73'), USDG] },
  { chainId: 1, name: 'Ethereum', tokens: [ETH, weth('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'), usdc('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')] },
  { chainId: 8453, name: 'Base', tokens: [ETH, weth('0x4200000000000000000000000000000000000006'), usdc('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')] },
  { chainId: 42161, name: 'Arbitrum One', tokens: [ETH, weth('0x82af49447d8a07e3bd95bd0d56f35241523fbab1'), usdc('0xaf88d065e77c8cc2239327c5edb3a432268e5831')] },
  { chainId: 10, name: 'OP Mainnet', tokens: [ETH, weth('0x4200000000000000000000000000000000000006'), usdc('0x0b2c639c533813f4aa9d7837caf62653d097ff85')] },
  ...elysiumOrigin(),
])

/** The connected wallet as this module takes it: the owner whose balances are read, and the wallet's own provider. */
export interface HoldingsWallet {
  owner: string
  /** The account and connector are still the ones whose balances were requested. */
  current?(): boolean
  chainId?(): number | null
  request(method: string, params: unknown[]): Promise<unknown>
}

/** A balance above zero on another network. */
export interface Holding {
  chainId: number
  chainName: string
  /** The token's address (lowercase); address(0) is the chain's ETH. */
  token: string
  symbol: string
  decimals: number
  raw: bigint
}

/** How wallet/port's switch ended, as the scan takes it (switchToOrigin's outcomes). */
export type HoldingsSwitchOutcome = 'switched' | 'unknown_chain' | 'user_rejected' | 'pending' | 'error'

export interface HoldingsScan {
  /** Only what is there: raw above zero. */
  holdings: Holding[]
  /** The chains whose balances were read. */
  read: number[]
  /** The chains not read, and why: the wallet does not know the chain, the person declined the switch, a request already waits in the wallet, or the switch or the read failed. */
  skipped: { chainId: number; reason: 'unknown_chain' | 'user_rejected' | 'pending' | 'error' }[]
  /** The person declined a switch: the scan stopped there, asking nothing more. */
  stoppedBy: 'user_rejected' | 'wallet_changed' | null
  /** Whether the wallet is back on the home chain. */
  returned: boolean
}

/** ERC-20 balanceOf(address). */
const BALANCE_OF = '0x70a08231'
const lower = (value: string) => value.toLowerCase()
const word = (address: string) => lower(address).replace(/^0x/, '').padStart(64, '0')
/** A JSON-RPC quantity (the chain id, a native balance): no leading zeros. Null for anything else. */
const quantity = (value: unknown): bigint | null => (typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value) ? BigInt(value) : null)
/** One ABI word, exactly: a uint256 answer. Null for anything else. */
const uintWord = (value: unknown): bigint | null => (typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) ? BigInt(value) : null)
/** A silent balance read cannot leave the amount step loading indefinitely. */
const bounded = <T>(work: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('wallet_read_timeout')), 8_000)
  void work.then((value) => { clearTimeout(timer); resolve(value) }, (error: unknown) => { clearTimeout(timer); reject(error) })
})

/**
 * The owner's holdings on `candidate`, read on the chain the wallet is on NOW: the chain is confirmed first (another one
 * is `wallet_wrong_chain`: the caller switches, this module never does), then the native balance and each token's
 * balanceOf. A token whose read throws or answers anything but one uint256 word is left out, never written down as zero.
 */
export interface HoldingsReport {
  holdings: Holding[]
  /** Unread token symbols, never represented as a zero balance. */
  unread: string[]
}

export async function readHoldingsReport(wallet: HoldingsWallet, candidate: OriginCandidate): Promise<HoldingsReport> {
  const identity = () => {
    if (wallet.current?.() === false) throw new Error('wallet_identity_changed')
    if (wallet.chainId && wallet.chainId() !== candidate.chainId) throw new Error('wallet_wrong_chain')
  }
  identity()
  if (quantity(await bounded(wallet.request('eth_chainId', []))) !== BigInt(candidate.chainId)) throw new Error('wallet_wrong_chain')
  const owner = lower(wallet.owner)
  const holdings: Holding[] = []
  const unread: string[] = []
  for (const token of candidate.tokens) {
    identity()
    const address = lower(token.address)
    let raw: bigint | null
    try {
      raw =
        address === ZERO
          ? quantity(await bounded(wallet.request('eth_getBalance', [owner, 'latest'])))
          : uintWord(await bounded(wallet.request('eth_call', [{ to: address, data: `${BALANCE_OF}${word(owner)}` }, 'latest'])))
    } catch {
      // Unread: absent, never zero.
      raw = null
    }
    identity()
    if (raw === null) unread.push(token.symbol)
    else if (raw > 0n) holdings.push({ chainId: candidate.chainId, chainName: candidate.name, token: address, symbol: token.symbol, decimals: token.decimals, raw })
  }
  return { holdings, unread }
}

/** Compatibility reader for callers that only need the positive balances. */
export async function readHoldingsOn(wallet: HoldingsWallet, candidate: OriginCandidate): Promise<Holding[]> {
  return (await readHoldingsReport(wallet, candidate)).holdings
}

/** Short-lived, account/connector-scoped reads. Concurrent mounts share work; never stored on disk. */
export function createHoldingsCache(now: () => number = Date.now) {
  const entries = new Map<string, { until: number; work: Promise<HoldingsReport> }>()
  return (key: string, read: () => Promise<HoldingsReport>, fresh = false): Promise<HoldingsReport> => {
    const previous = entries.get(key)
    if (!fresh && previous && previous.until > now()) return previous.work
    const entry = { until: Infinity, work: Promise.resolve().then(read) }
    entries.set(key, entry)
    if (entries.size > 12) entries.delete(entries.keys().next().value as string)
    void entry.work.then(
      (report) => { entry.until = now() + (report.unread.length > 0 ? 10_000 : 30_000) },
      () => { entry.until = now() + 10_000 },
    )
    return entry.work
  }
}

/**
 * Every candidate but the home chain, one at a time: the wallet is asked to switch there, the balances are read, and at
 * the end the wallet is asked back home. A chain the wallet does not know, a request already waiting in it, or a failed
 * switch or read is skipped and the scan goes on; a switch the person declines stops it (nothing more is asked of the
 * wallet) and is said so. Never throws.
 */
export async function scanHoldings({
  wallet,
  switchTo,
  homeChainId,
  candidates = CANDIDATE_ORIGINS,
  onProgress,
}: {
  wallet: HoldingsWallet
  /** wallet/port's switch as the caller binds it: switchToOrigin for an origin, switchToChain for the way home. */
  switchTo: (chainId: number) => Promise<HoldingsSwitchOutcome>
  /** The position's chain: never looked at, and where the wallet is taken back at the end. */
  homeChainId: number
  candidates?: readonly OriginCandidate[]
  onProgress?: (state: { chainId: number; name: string; phase: 'switching' | 'reading' }) => void
}): Promise<HoldingsScan> {
  const holdings: Holding[] = []
  const read: number[] = []
  const skipped: HoldingsScan['skipped'] = []
  let stoppedBy: HoldingsScan['stoppedBy'] = null
  const attempt = async (chainId: number): Promise<HoldingsSwitchOutcome> => {
    try {
      return await switchTo(chainId)
    } catch {
      return 'error'
    }
  }
  for (const candidate of candidates) {
    if (wallet.current?.() === false) { stoppedBy = 'wallet_changed'; break }
    if (candidate.chainId === homeChainId) continue
    onProgress?.({ chainId: candidate.chainId, name: candidate.name, phase: 'switching' })
    const switched = await attempt(candidate.chainId)
    if (switched === 'user_rejected') {
      skipped.push({ chainId: candidate.chainId, reason: 'user_rejected' })
      stoppedBy = 'user_rejected'
      break
    }
    if (switched !== 'switched') {
      skipped.push({ chainId: candidate.chainId, reason: switched })
      continue
    }
    onProgress?.({ chainId: candidate.chainId, name: candidate.name, phase: 'reading' })
    try {
      const report = await readHoldingsReport(wallet, candidate)
      holdings.push(...report.holdings)
      if (report.unread.length === 0) read.push(candidate.chainId)
      else skipped.push({ chainId: candidate.chainId, reason: 'error' })
    } catch {
      if (wallet.current?.() === false) { stoppedBy = 'wallet_changed'; break }
      skipped.push({ chainId: candidate.chainId, reason: 'error' })
    }
  }
  if (stoppedBy === 'wallet_changed' || wallet.current?.() === false) return { holdings: [], read: [], skipped: [], stoppedBy: 'wallet_changed', returned: false }
  const returned = (await attempt(homeChainId)) === 'switched'
  return { holdings, read, skipped, stoppedBy, returned }
}
