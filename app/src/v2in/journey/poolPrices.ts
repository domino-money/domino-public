import type { ChainBalancesResponse } from 'api-contracts/read-v6/types'
import type { PayFacts, PayOption, PoolPrices } from '../../lib/create/poolPrices'
import { readChainBalances } from '../../v2/read/v6'
import type { V2ChainId } from '../../v2/types'
import { balanceChainsRequest, balanceOn, balancesRequest, holdingArtwork, mergeBalances, nativeOn, payCandidates } from '../funds/model'
import { readFundingBalanceGroup } from '../funds/balanceCache'
import { pricesOf, rereadOf } from './model/chainReads'
import { refOf } from './model/networks'
import { chainPoolsOn, patiently, servedOn, type LiveGate } from './served'
import type { JourneyGates } from './source'

/** Quiet re-asks of a prices read that failed for the moment (a busy reader: 429 read_capacity_busy), after the first. */
export const PRICE_REASKS = 3

/** Qualified pool prices and observed payment alternatives, through existing S1 reads.
 * Balance groups are shared with bridge discovery. Local funds win over remote wealth; an explicitly selected
 * payment asset never changes after later answers arrive. No price, balance, or route is fabricated. */
export function poolPricesFor(gates: JourneyGates | null): PoolPrices | null {
  if (!gates) return null
  const live = (chainId: number): LiveGate | null => {
    const gate = gates[chainId as V2ChainId]
    return gate?.mode === 'live' ? gate : null
  }
  // Added 2026-10-30 (launch capacity, item 9a): Ethereum's and OP Mainnet's holdings as last read for this visit, by
  // wallet and pool network, reused only by Amount's background tick (`background`). A first read and every deliberate
  // read again (funds arrived, Review's re-reads) ask them again, so balances from before a bridge are never merged.
  const awayKept = new Map<string, ChainBalancesResponse>()
  return {
    async refresh(pool, signal) {
      const chainId = pool.currencies[0].chainId
      const gate = live(chainId)
      if (!gate || signal.aborted) return null
      const ref = refOf(pool)
      const said = await patiently(() => chainPoolsOn(gate, chainId, ref.currency0, ref.currency1), signal, PRICE_REASKS)
      if (said.kind !== 'ok' || signal.aborted) return null
      const fresh = rereadOf(pool, ref, said.body, said.receivedAt)
      return fresh?.key === pool.key ? fresh : null
    },
    async read(pool, signal) {
      const gate = live(4663)
      if (!gate || pool.currencies[0].chainId !== 4663 || pool.currencies[1].chainId !== 4663) return null
      const pair = { currency0: pool.currencies[0].address.toLowerCase(), currency1: pool.currencies[1].address.toLowerCase() }
      const said = await patiently(() => chainPoolsOn(gate, 4663, pair.currency0, pair.currency1), signal, PRICE_REASKS)
      return said.kind === 'ok' && !signal.aborted ? (pricesOf(said.body, pair) ?? null) : null
    },
    async pay(pool, owner, signal, later, selected, background) {
      const chainId = pool.currencies[0].chainId
      const gate = live(chainId)
      const tokens = pool.currencies.map((currency) => currency.address)
      if (!gate || signal.aborted) return null
      const ask = (request: readonly { chainId: number; address: string }[]) => readFundingBalanceGroup(owner, request, () => servedOn<ChainBalancesResponse>(gate, 'chain-balances', (t) => readChainBalances(t.read, t.readRuntime, owner, request)))
      const requested = balancesRequest(chainId)
      // The offer from Domino's answer (null: not read), with Ethereum's and OP Mainnet's beside it (null: none, or not yet).
      const offer = (domino: ChainBalancesResponse | null, away: ChainBalancesResponse | null): PayFacts | null => {
        const answer = mergeBalances(domino, away)
        const candidates = payCandidates(chainId, tokens, answer)
        const observedTokens = answer ? requested.filter((token) => token.chainId === chainId && balanceOn(answer, chainId, token.address) !== null).map((token) => token.address) : []
        const facts = (token: { address: string; symbol: string | null; decimals: number | null; origins?: readonly number[] }): PayOption => {
          const held = answer && balanceOn(answer, chainId, token.address)
          return {
            token: { origin: 'read', chainId, address: token.address, symbol: token.symbol, decimals: token.decimals, readStatus: 'available', artwork: holdingArtwork(chainId, token.address) },
            raw: held ? held.raw : null, nativeRaw: answer ? nativeOn(answer, chainId) : null, usd: held ? held.usd : null, origins: token.origins ?? [],
          }
        }
        // Once selected, neither a price refresh nor a newly found remote balance can change the payment asset.
        const token = selected?.chainId === chainId ? selected : candidates[0]
        return token ? { ...facts(token), observedTokens, alternatives: candidates.filter((candidate) => candidate.address !== token.address).map(facts) } : null
      }
      // Theirs asked beside Domino's three, in a request of its own, and never waited for: `away.body` once it is back.
      const elsewhere = selected ? [] : balanceChainsRequest(chainId)
      const awayKey = `${owner.toLowerCase()}|${chainId}`
      // A deliberate read forgets what was kept before it asks, so a tick while its answer is still out asks too (and
      // joins that request) instead of reusing balances from before a bridge.
      if (background !== true && elsewhere.length > 0) awayKept.delete(awayKey)
      const kept = background === true && elsewhere.length > 0 ? awayKept.get(awayKey) : undefined
      const away: { body?: ChainBalancesResponse | null } = kept ? { body: kept } : {}
      const asked = elsewhere.length === 0 || kept ? null : ask(elsewhere).then((said) => {
        if (said.kind === 'ok') awayKept.set(awayKey, said.body)
        else awayKept.delete(awayKey)
        return (away.body = said.kind === 'ok' ? said.body : null)
      }, () => {
        awayKept.delete(awayKey)
        return (away.body = null)
      })
      const said = await patiently(() => ask(requested), signal)
      const domino = said.kind === 'ok' ? said.body : null
      const first = offer(domino, away.body ?? null)
      if (signal.aborted) return null
      // Theirs back after Domino's (and only beside it): what is held there joins, said again when the token changes.
      if (asked && away.body === undefined) {
        void asked.then((body) => {
          const next = body && !signal.aborted ? offer(domino, body) : null
          if (next) later(next)
        })
      }
      // Unknown is not an empty wallet. A failed refresh keeps the same-key offer until a real read supersedes it.
      if (!first && (!domino || requested.some((token) => token.chainId === chainId && balanceOn(domino, chainId, token.address) === null))) throw new Error('Payment balances are temporarily unavailable')
      return first
    },
  }
}
