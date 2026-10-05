import { rawFromFact, type CurrencyBalance } from '../../lib/create/budgets'
import type { NetworkPools, NetworkResolved, OtherChainId, OtherChains } from '../../lib/create/otherChains'
import { amountFact } from '../../lib/read/pagers'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import type { TokenDisplay } from '../../lib/read/types'
import { browserOriginWallet } from '../../finance/v2/crosschain'
import { readHoldingsReport } from '../../finance/v2/holdings'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import type { Address, V2ChainId } from '../../v2/types'
import { JOURNEY } from './copy'
import { journeyError } from './errors'
import { displayOf, listedPools, networkTokens, offeredNetworks, optionOf, poolsToRead, refOf } from './model/networks'
import type { JourneyGates } from './source'
import { cleanSymbol } from './tokens'
import { connectJourney, inTurn } from './wallet'

/**
 * Base and Arbitrum One in the owner's New position (2026-10-05, the owner: "the search on the screen, across the three
 * networks; the results get the network's tag", and creating there through Domino V2): the implementation the V1 journey
 * declares (lib/create/otherChains.ts), handed to it by its wrapper (./NewPositionV2.tsx) for the networks whose S1 gate
 * is live, so a token there can only lead to a position Domino V2 can create.
 *
 * Those networks have no pool list yet (spec F7 rev4 §6.2 "O que o read-v6 ainda não tem": pools per chain) and no public
 * RPC may be asked (§6.1), so, as the spec says for the meantime, everything of them is read through the wallet's own
 * provider on that network (the wallet is asked once to switch there, §1.3):
 *
 *   - tokens: the network's profile tokens (ETH, WETH, USDC: trusted, never a lookup) whose symbol matches the text, and
 *     a pasted address on each network, read once chosen (its own decimals() and symbol(), the symbol untrusted text);
 *   - pools: every pool of the chosen token with each of the profile's tokens, at every fee tier the network offers (v4's
 *     four, v3's table with Base's 0.02%, 0.03% and 0.04%; §1.4), read at one block in two reads (finance/v2/zap.ts
 *     readPools). Listed: the hookless pools with a price and liquidity in range, the ones a position can open in now.
 *     Native ETH is v4's alone (v3 pools hold WETH: choose WETH for those);
 *   - the wallet's balances of a pool's two currencies (finance/v2/holdings.ts, the deposit-from-another-network scan's
 *     reader), so the amount step's Max and Review's funding work as on Robinhood Chain.
 *
 * No USD, TVL, volume or APR: nothing qualified exists for them here (§6.3), so the rows say a dash. Nothing is cached
 * between choices: each read is the chain's now. What is pure of it is ./model/networks.ts.
 */

type Live = Extract<V2Gate, { mode: 'live' }>

/** Base and Arbitrum One for today's journey, on the gates read: null when neither is live. */
export function otherChainsFor(gates: JourneyGates | null): OtherChains | null {
  const chains = offeredNetworks(gates)
  if (!gates || chains.length === 0) return null
  const gateOf = (chainId: number): Live | null => {
    const gate = chains.includes(chainId as OtherChainId) ? gates[chainId as V2ChainId] : null
    return gate && gate.mode === 'live' ? gate : null
  }
  const nameOf = (chainId: number): string | null => (chainId === 4663 || chains.includes(chainId as OtherChainId) ? v2Chain(chainId as V2ChainId).name : null)
  /** A failure in the wallet's words; no wallet at all said for this network. */
  const failure = (error: unknown, chainId: OtherChainId): { code: string; reason: string } => {
    if (error instanceof Error && error.message === 'connect_wallet') return { code: 'connect_wallet', reason: JOURNEY.pool.connectFor(v2Chain(chainId).name) }
    const said = journeyError(error, chainId)
    return { code: said.code, reason: said.copy }
  }
  const unavailable = (chainId: number) => ({ code: 'network_unavailable', reason: JOURNEY.pool.networkClosed(nameOf(chainId) ?? 'this network') })
  return {
    home: v2Chain(4663).name,
    name: nameOf,
    tokens: (query) => networkTokens(query, chains),
    async resolve(row, signal): Promise<NetworkResolved> {
      const gate = gateOf(row.chainId)
      if (!gate) return { ok: false, ...unavailable(row.chainId) }
      try {
        const [read] = await inTurn(async () => (await connectJourney(row.chainId, gate.contracts)).zap.readTokens([row.token.address as Address]))
        if (signal.aborted) return { ok: false, code: 'aborted', reason: '' }
        if (!read || read.decimals === null) return { ok: false, code: 'token_decimals_unknown', reason: JOURNEY.pool.decimalsUnknown }
        return { ok: true, token: displayOf(row.chainId, { address: read.address, symbol: cleanSymbol(read.symbol), decimals: read.decimals }) }
      } catch (error) {
        return { ok: false, ...failure(error, row.chainId) }
      }
    },
    async pools(token, signal): Promise<NetworkPools> {
      const chainId = token.chainId as OtherChainId
      const gate = gateOf(chainId)
      if (!gate) return { kind: 'failed', ...unavailable(chainId) }
      if (token.decimals === null) return { kind: 'failed', code: 'token_decimals_unknown', reason: JOURNEY.pool.decimalsUnknown }
      try {
        const found = await inTurn(async () => (await connectJourney(chainId, gate.contracts)).zap.readPools(poolsToRead(chainId, token.address as Address)))
        if (signal.aborted) return { kind: 'ok', options: [] }
        return { kind: 'ok', options: listedPools(chainId, token, found, Date.now()) }
      } catch (error) {
        return { kind: 'failed', ...failure(error, chainId) }
      }
    },
    async reread(option, signal): Promise<PoolOption | null> {
      const chainId = option.currencies[0].chainId as OtherChainId
      const gate = gateOf(chainId)
      if (!gate) return null
      const [found] = await inTurn(async () => (await connectJourney(chainId, gate.contracts)).zap.readPools([refOf(option)]))
      if (signal.aborted || !found || !found.initialized) return null
      return optionOf(found, option.currencies, Date.now())
    },
    async balances(option, owner, signal): Promise<readonly [CurrencyBalance, CurrencyBalance] | null> {
      const chainId = option.currencies[0].chainId as OtherChainId
      const gate = gateOf(chainId)
      if (!gate || option.currencies.some((currency) => currency.decimals === null)) return null
      const tokens = option.currencies.map((currency) => ({ address: currency.address, symbol: currency.address, decimals: currency.decimals as number }))
      const report = await inTurn(async () => {
        await connectJourney(chainId, gate.contracts)
        const wallet = await browserOriginWallet()
        if (wallet.owner.toLowerCase() !== owner.toLowerCase()) return null
        return readHoldingsReport(wallet, { chainId, name: v2Chain(chainId).name, tokens })
      })
      if (signal.aborted || !report) return null
      const of = (token: TokenDisplay): CurrencyBalance => {
        if (report.unread.includes(token.address)) return { token, fact: null, raw: null }
        const raw = report.holdings.find((holding) => holding.token === token.address)?.raw ?? 0n
        const fact = amountFact({ amountRaw: raw.toString(), decimals: token.decimals })
        return { token, fact, raw: rawFromFact(fact, token.decimals) }
      }
      return [of(option.currencies[0]), of(option.currencies[1])]
    },
  }
}
