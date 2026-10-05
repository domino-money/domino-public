import type { ChainBalancesResponse, ChainPoolsResponse, ChainTokensResponse, ReadV6Route } from 'api-contracts/read-v6/types'
import { rawFromFact, type CurrencyBalance } from '../../lib/create/budgets'
import type { NetworkPools, NetworkResolved, NetworkSearch, NetworkToken, OtherChainId, OtherChains } from '../../lib/create/otherChains'
import { amountFact } from '../../lib/read/pagers'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import type { TokenDisplay } from '../../lib/read/types'
import { browserOriginWallet } from '../../finance/v2/crosschain'
import { readHoldingsReport } from '../../finance/v2/holdings'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import { readChainBalances, readChainPools, readChainTokens, type ReadV6Reply } from '../../v2/read/v6'
import { routeServes } from '../../v2/routes'
import type { Address, V2ChainId } from '../../v2/types'
import { v2Transports, type V2Transports } from '../transports'
import { JOURNEY } from './copy'
import { journeyError } from './errors'
import { balanceTokens, balancesOfAnswer, poolsOfAnswer, rereadOf, resolvedOf, rowsOfTokens, symbolRank } from './model/chainReads'
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
 *
 * Changed on purpose 2026-10-06 (rugged97's delta of 5 Oct, items 1-3: "no screen uses the routes yet, that is yours"):
 * Domino's service reads those networks now (read-v6's live chain reads, api-contracts/read-v6 README "Chain reads"), so
 * the wallet stays where it is until a step asks it to sign (§1.3; ./JourneyCreateV2.tsx moves it then):
 *
 *   - tokens: chain-tokens finds a network's known tokens by name, symbol or address (the profile's, the Uniswap Labs
 *     Default list's, the ones the V2 index or a pool read met), listed in place of the profile's own as the answers
 *     arrive; a hit that passes for ETH, WETH or USDC without being it is listed with a warning and never chosen;
 *   - a pasted address: chain-pools names its symbol and decimals, and its pools come in the same answer;
 *   - pools: chain-pools at the network's head (the pools this module reads through the wallet: the token against ETH,
 *     WETH and USDC, on v4's standard keys and the v3 tiers the factory enables);
 *   - balances: chain-balances, the pool's two currencies on its network.
 *
 * Each read goes to the service only while its route serves (the read Worker's capabilities). When it does not, or its
 * answer is not one (unavailable, or refused by the contract), the read goes through the wallet as before. What is pure
 * of it is ./model/chainReads.ts. A pool answer is reused for 20 seconds, so choosing a pasted address and listing its
 * pools is one read.
 */

type Live = Extract<V2Gate, { mode: 'live' }>

/** A pool answer is reused this long (a pasted address resolved, then its pools listed). */
const POOLS_REUSE_MS = 20_000
/** Search answers kept for the page, per network and text (today's search keeps its own, searchAnswers.ts). */
const SEARCH_KEPT = 200
/** Per network, at most this many hits: the list stays about one screen. */
const SEARCH_LIMIT = 8

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** The text a search asks the service about: two characters at least, or a whole address (lower case); null otherwise. */
function searchable(query: string): string | null {
  const text = query.trim()
  if (text.length < 2 || (/^0x/i.test(text) && !ADDRESS.test(text))) return null
  return /^0x/i.test(text) ? text.toLowerCase() : text
}

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

  /** One of the service's chain reads while its route serves: the answer, or null for the wallet's own read. */
  async function served<T>(chainId: OtherChainId, route: ReadV6Route, read: (transports: V2Transports) => Promise<ReadV6Reply<T>>): Promise<{ body: T; receivedAt: number } | null> {
    const gate = gateOf(chainId)
    const transports = gate ? v2Transports(gate) : null
    if (!transports) return null
    try {
      if (!routeServes(await transports.routeState('readV6'), route)) return null
      const reply = await read(transports)
      return reply.kind === 'ok' ? { body: reply.body, receivedAt: Date.now() } : null
    } catch {
      return null
    }
  }
  const poolAnswers = new Map<string, { at: number; answer: Promise<{ body: ChainPoolsResponse; receivedAt: number } | null> }>()
  const poolsKey = (chainId: OtherChainId, token: string, paired?: string) => `${chainId}|${token.toLowerCase()}|${paired?.toLowerCase() ?? ''}`
  /** chain-pools for a token (or a pair): one read for the asks within POOLS_REUSE_MS of each other; a failure is not kept. */
  function chainPools(chainId: OtherChainId, token: string, paired?: string) {
    const key = poolsKey(chainId, token, paired)
    const kept = poolAnswers.get(key)
    if (kept && Date.now() - kept.at < POOLS_REUSE_MS) return kept.answer
    const answer = served<ChainPoolsResponse>(chainId, 'chain-pools', (t) => readChainPools(t.read, t.readRuntime, chainId, token, paired))
    poolAnswers.set(key, { at: Date.now(), answer })
    void answer.then((said) => {
      if (said === null && poolAnswers.get(key)?.answer === answer) poolAnswers.delete(key)
    })
    return answer
  }

  // The search's reads (chain-tokens): kept per network and text; only the newest text is asked.
  const found = new Map<string, NetworkToken[]>()
  const listeners = new Set<() => void>()
  let version = 0
  let asking: { text: string; controller: AbortController } | null = null
  const foundKey = (chainId: OtherChainId, text: string) => `${chainId}|${text}`
  const search: NetworkSearch = {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    version: () => version,
    ask(query) {
      const text = searchable(query)
      if (text === null || asking?.text === text) return
      const missing = chains.filter((chainId) => !found.has(foundKey(chainId, text)))
      if (missing.length === 0) return
      asking?.controller.abort()
      const controller = new AbortController()
      asking = { text, controller }
      void Promise.all(
        missing.map(async (chainId) => {
          const said = await served<ChainTokensResponse>(chainId, 'chain-tokens', (t) => readChainTokens(t.read, t.readRuntime, chainId, text, SEARCH_LIMIT))
          if (said === null || controller.signal.aborted) return
          if (found.size >= SEARCH_KEPT) found.delete(found.keys().next().value as string)
          found.set(foundKey(chainId, text), rowsOfTokens(chainId, said.body))
          version += 1
          for (const listener of listeners) listener()
        }),
      ).finally(() => {
        if (asking?.controller === controller) asking = null
      })
    },
  }
  /** The hits for a text: per network the service's answer once it arrived, else the profile's own; the closest first. */
  function tokens(query: string): NetworkToken[] {
    const text = searchable(query)
    const rows = chains.flatMap((chainId, order) => {
      const answered = text === null ? undefined : found.get(foundKey(chainId, text))
      // A pasted address the service does not know is still offered on that network, to be read once chosen.
      const hits = answered === undefined || (answered.length === 0 && text !== null && ADDRESS.test(text)) ? networkTokens(query, [chainId]) : answered
      return hits.map((row, index) => ({ row, order, index }))
    })
    return rows
      .sort((a, b) => symbolRank(a.row.token.symbol, query) - symbolRank(b.row.token.symbol, query) || a.order - b.order || a.index - b.index)
      .map((entry) => entry.row)
  }

  return {
    home: v2Chain(4663).name,
    name: nameOf,
    tokens,
    search,
    async resolve(row, signal): Promise<NetworkResolved> {
      const gate = gateOf(row.chainId)
      if (!gate) return { ok: false, ...unavailable(row.chainId) }
      const said = await chainPools(row.chainId, row.token.address)
      if (signal.aborted) return { ok: false, code: 'aborted', reason: '' }
      if (said) return resolvedOf(row.chainId, row.token.address, said.body)
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
      const said = await chainPools(chainId, token.address)
      if (signal.aborted) return { kind: 'ok', options: [] }
      if (said) return { kind: 'ok', options: poolsOfAnswer(chainId, token, said.body, said.receivedAt) }
      try {
        const read = await inTurn(async () => (await connectJourney(chainId, gate.contracts)).zap.readPools(poolsToRead(chainId, token.address as Address)))
        if (signal.aborted) return { kind: 'ok', options: [] }
        return { kind: 'ok', options: listedPools(chainId, token, read, Date.now()) }
      } catch (error) {
        return { kind: 'failed', ...failure(error, chainId) }
      }
    },
    async reread(option, signal): Promise<PoolOption | null> {
      const chainId = option.currencies[0].chainId as OtherChainId
      const gate = gateOf(chainId)
      if (!gate) return null
      const ref = refOf(option)
      // A pool on screen that has aged wants the chain's price now, never a kept answer.
      poolAnswers.delete(poolsKey(chainId, ref.currency0, ref.currency1))
      const said = await chainPools(chainId, ref.currency0, ref.currency1)
      if (signal.aborted) return null
      if (said) return rereadOf(option, ref, said.body, said.receivedAt)
      const [read] = await inTurn(async () => (await connectJourney(chainId, gate.contracts)).zap.readPools([ref]))
      if (signal.aborted || !read || !read.initialized) return null
      return optionOf(read, option.currencies, Date.now())
    },
    async balances(option, owner, signal): Promise<readonly [CurrencyBalance, CurrencyBalance] | null> {
      const chainId = option.currencies[0].chainId as OtherChainId
      const gate = gateOf(chainId)
      if (!gate || option.currencies.some((currency) => currency.decimals === null)) return null
      const said = await served<ChainBalancesResponse>(chainId, 'chain-balances', (t) => readChainBalances(t.read, t.readRuntime, owner, balanceTokens(chainId, option.currencies)))
      if (signal.aborted) return null
      const pair = said ? balancesOfAnswer(chainId, option.currencies, said.body) : null
      if (pair) return pair
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
