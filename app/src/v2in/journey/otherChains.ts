import type { ChainBalancesResponse, ChainPoolsResponse, ChainTokensResponse, ReadV6Route } from 'api-contracts/read-v6/types'
import { rawFromFact, type CurrencyBalance } from '../../lib/create/budgets'
import type { NetworkPools, NetworkResolved, NetworkToken, OtherChainId, OtherChains } from '../../lib/create/otherChains'
import { dexStore } from '../../lib/read/dexFigures'
import { amountFact } from '../../lib/read/pagers'
import { whenVisibleAfter } from '../../lib/read/screens/quietRead'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import { quietDelayMs } from '../../lib/read/screens/transient'
import type { TokenDisplay } from '../../lib/read/types'
import { browserOriginWallet } from '../../finance/v2/crosschain'
import { readHoldingsReport } from '../../finance/v2/holdings'
import { v2Chain } from '../../v2/chains'
import { readChainBalances, readChainTokens, type ReadV6Reply } from '../../v2/read/v6'
import type { Address, V2ChainId } from '../../v2/types'
import type { V2Transports } from '../transports'
import { JOURNEY } from './copy'
import { journeyError } from './errors'
import { READER_POOLS_CACHE_MS, balanceTokens, balancesOfAnswer, factsOfAnswer, lookalikeOf, passingAfter, pastedOf, poolsOfAnswer, rereadOf, resolvedOf, rowsOfTokens, symbolRank } from './model/chainReads'
import { createNetworkSearch, searchable, type SearchAnswer } from './model/networkSearch'
import { displayOf, factsOfFound, listedPools, networkTokens, offeredNetworks, optionOf, poolsToRead, refOf } from './model/networks'
import { chainPoolsOn, patiently, servedOn, type LiveGate, type Served } from './served'
import type { JourneyGates } from './source'
import { cleanSymbol, profileTokens } from './tokens'
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
 * pools is one read. Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §1: never chain-pools of the same token
 * again within the reader's own 15 s cache): the page's one reuse (./served.ts chainPoolsOn), shared with Robinhood
 * Chain's prices and kept when New position is opened again, and a price read again reuses an answer the reader would
 * only give again; a busy reader's name search is asked again no sooner than the Retry-After it named.
 *
 * Changed on purpose 2026-10-06 (the owner's point 3: on those networks the search "sometimes only brings Robinhood
 * Chain", a pasted contract came as unnamed rows, and the pools came "dry"):
 *
 *   - a read that failed for the moment is asked again: the search's quietly, a few times, while its list is open; a pool,
 *     a pasted address or the balances once, after a quiet wait, before the wallet is asked to move (the person should
 *     not have to switch networks to see pools);
 *   - the search asks only its newest text, one read at a time per network, ignores answers to older texts, and says when
 *     a network is still being searched (`pending`: the search's icon pulses); what is pure of it is
 *     ./model/networkSearch.ts;
 *   - a pasted address is looked up on every network at once through chain-pools, named where it is a token there and
 *     left out where it is not; that answer is the one choosing it then reuses;
 *   - each token's pools are listed with DEX Screener's figures, asked beside chain-pools (lib/read/dexFigures.ts; the
 *     rows take them as they arrive, lib/create/otherChains.ts networkRows), with what tells two rows of one pair and fee
 *     apart (`facts`). The comment above about TVL and APR is history: the owner asked for them "like Robinhood Chain".
 */

type Live = LiveGate

/** Per network, at most this many hits: the list stays about one screen. */
const SEARCH_LIMIT = 8
/** Quiet re-asks of a failed name search, per network and text, while the list stays open (2026-10-06). */
const SEARCH_REASKS = 3

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

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

  /**
   * One of the service's chain reads while its route serves. Changed on purpose 2026-10-06: a failure says whether it may
   * pass (a dropped connection, a busy reader, a capabilities read that failed for the moment), so it can be asked again
   * before the wallet's own read; a route that is off goes to the wallet's own read at once, as before. The rule itself
   * is ./served.ts's since 2026-10-06 (Robinhood Chain's pool prices ask the same way, ./poolPrices.ts).
   */
  function served<T>(chainId: OtherChainId, route: ReadV6Route, read: (transports: V2Transports) => Promise<ReadV6Reply<T>>): Promise<Served<T>> {
    return servedOn(gateOf(chainId), route, read)
  }
  // Asked once more after a quiet wait when it failed for the moment (2026-10-06): the wallet's own read comes only after
  // (./served.ts patiently, moved there on purpose 2026-10-06 and asked the same way here).

  /**
   * chain-pools for a token (or a pair): one read for the asks within 20 s of each other; a failure is not kept. Changed on
   * purpose 2026-10-06 (rugged's answer of 6 Oct, §1): the page's one reuse (./served.ts chainPoolsOn), where each list kept
   * its own; `maxAgeMs` asks for a younger answer, never one younger than the reader's own cache.
   */
  const chainPools = (chainId: OtherChainId, token: string, paired?: string, maxAgeMs?: number): Promise<Served<ChainPoolsResponse>> =>
    chainPoolsOn(gateOf(chainId), chainId, token, paired, maxAgeMs)

  /** One of the network's own currencies (ETH, WETH, USDC) at an address, as its profile names it. */
  const profileAt = (chainId: OtherChainId, address: string) => profileTokens(chainId).find((token) => token.address === address)
  // The search (2026-10-06): a name through chain-tokens, a pasted address through chain-pools (kept 20 s, so choosing it
  // reads nothing again), each network one read at a time for the newest text the open list asks (./model/networkSearch.ts).
  const search = createNetworkSearch({
    chains,
    async read(chainId, text): Promise<SearchAnswer> {
      if (ADDRESS.test(text)) {
        const said = await chainPools(chainId, text)
        return { kind: 'pasted', said: said.kind === 'ok' ? pastedOf(chainId, text, said.body) : { state: 'unread' } }
      }
      const said = await served<ChainTokensResponse>(chainId, 'chain-tokens', (t) => readChainTokens(t.read, t.readRuntime, chainId, text, SEARCH_LIMIT))
      if (said.kind === 'ok') return { kind: 'hits', rows: rowsOfTokens(chainId, said.body) }
      if (said.kind === 'off') return { kind: 'off' }
      return said.retryAfterS === undefined ? { kind: 'failed', passing: said.passing } : { kind: 'failed', passing: said.passing, retryAfterS: said.retryAfterS }
    },
    own: (chainId, address) => profileAt(chainId, address) !== undefined,
    // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §1): no sooner than a busy reader's Retry-After.
    delay: (attempt, retryAfterS) => (attempt < SEARCH_REASKS ? quietDelayMs(passingAfter(retryAfterS), attempt) : null),
    after: whenVisibleAfter,
  })
  /**
   * A pasted address's row on a network: its profile token, the token named there, the plain row where it was not read.
   * Changed on purpose 2026-10-06 (the review of the next update: the zero address pasted with Base offered highlighted
   * nothing, and Enter did nothing): the profile token's row says it is the network's own currency (`own`), as the name
   * search's rows do (model/networks.ts, model/chainReads.ts), so it never rivals Robinhood Chain's own ETH for Enter
   * (lib/create/otherChains.ts preselectOf).
   */
  function pastedRows(chainId: OtherChainId, address: string): NetworkToken[] {
    const network = v2Chain(chainId).name
    const own = profileAt(chainId, address)
    if (own) return [{ chainId, network, token: displayOf(chainId, own), unread: false, own: true }]
    const said = search.pasted(chainId, address)
    if (!said || said.state === 'none') return []
    if (said.state === 'unread') return networkTokens(address, [chainId])
    const main = lookalikeOf(chainId, said.token)
    return [{ chainId, network, token: said.token, unread: false, ...(main ? { warning: JOURNEY.pool.lookalike(main) } : {}) }]
  }
  /** The hits for a text: per network the service's answer once it arrived, else the profile's own; the closest first. */
  function tokens(query: string): NetworkToken[] {
    const text = searchable(query)
    if (text !== null && ADDRESS.test(text)) return chains.flatMap((chainId) => pastedRows(chainId, text))
    const rows = chains.flatMap((chainId, order) => {
      const answered = text === null ? undefined : search.found(chainId, text)
      return (answered ?? networkTokens(query, [chainId])).map((row, index) => ({ row, order, index }))
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
      const said = await patiently(() => chainPools(row.chainId, row.token.address), signal)
      if (signal.aborted) return { ok: false, code: 'aborted', reason: '' }
      if (said.kind === 'ok') return resolvedOf(row.chainId, row.token.address, said.body)
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
      const subject = token.address.toLowerCase()
      // DEX Screener's pairs for the token, beside its pools: the rows take their figures as they arrive (2026-10-06).
      dexStore.askOn(chainId, subject)
      const said = await patiently(() => chainPools(chainId, token.address), signal)
      if (signal.aborted) return { kind: 'ok', options: [] }
      if (said.kind === 'ok') return { kind: 'ok', options: poolsOfAnswer(chainId, token, said.body, said.receivedAt), facts: factsOfAnswer(said.body), subject }
      try {
        const read = await inTurn(async () => (await connectJourney(chainId, gate.contracts)).zap.readPools(poolsToRead(chainId, token.address as Address)))
        if (signal.aborted) return { kind: 'ok', options: [] }
        return { kind: 'ok', options: listedPools(chainId, token, read, Date.now()), facts: factsOfFound(read), subject }
      } catch (error) {
        return { kind: 'failed', ...failure(error, chainId) }
      }
    },
    async reread(option, signal): Promise<PoolOption | null> {
      const chainId = option.currencies[0].chainId as OtherChainId
      const gate = gateOf(chainId)
      if (!gate) return null
      const ref = refOf(option)
      // A pool on screen that has aged wants the chain's price now, never a kept answer. Changed on purpose 2026-10-06
      // (rugged's answer of 6 Oct, §1): save one the reader itself would give again, younger than its own cache.
      const said = await patiently(() => chainPools(chainId, ref.currency0, ref.currency1, READER_POOLS_CACHE_MS), signal)
      if (signal.aborted) return null
      if (said.kind === 'ok') return rereadOf(option, ref, said.body, said.receivedAt)
      const [read] = await inTurn(async () => (await connectJourney(chainId, gate.contracts)).zap.readPools([ref]))
      if (signal.aborted || !read || !read.initialized) return null
      // Its figures are about the pool, not its price: they stay (2026-10-06).
      return { ...optionOf(read, option.currencies, Date.now()), liquidity: option.liquidity, volume: option.volume, providerNote: option.providerNote }
    },
    async balances(option, owner, signal): Promise<readonly [CurrencyBalance, CurrencyBalance] | null> {
      const chainId = option.currencies[0].chainId as OtherChainId
      const gate = gateOf(chainId)
      if (!gate || option.currencies.some((currency) => currency.decimals === null)) return null
      const said = await patiently(() => served<ChainBalancesResponse>(chainId, 'chain-balances', (t) => readChainBalances(t.read, t.readRuntime, owner, balanceTokens(chainId, option.currencies))), signal)
      if (signal.aborted) return null
      const pair = said.kind === 'ok' ? balancesOfAnswer(chainId, option.currencies, said.body) : null
      if (pair) return pair
      const tokens = option.currencies.map((currency) => ({ address: currency.address, symbol: currency.address, decimals: currency.decimals as number }))
      const report = await inTurn(async () => {
        // Balance refresh is read-only. A service outage never moves the wallet to another network.
        await connectJourney(chainId, gate.contracts, false)
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
