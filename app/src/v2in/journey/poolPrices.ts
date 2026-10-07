import type { ChainBalancesResponse } from 'api-contracts/read-v6/types'
import type { PayFacts, PoolPrices } from '../../lib/create/poolPrices'
import { readChainBalances } from '../../v2/read/v6'
import type { V2ChainId } from '../../v2/types'
import { balanceChainsRequest, balanceOn, balancesRequest, holdingArtwork, mergeBalances, nativeOn, payToken } from '../funds/model'
import { pricesOf, rereadOf } from './model/chainReads'
import { refOf } from './model/networks'
import { chainPoolsOn, patiently, servedOn, type LiveGate } from './served'
import type { JourneyGates } from './source'

/** Quiet re-asks of a prices read that failed for the moment (a busy reader: 429 read_capacity_busy), after the first. */
export const PRICE_REASKS = 3

/**
 * Robinhood Chain's pools valued in USD in the owner's New position (Added 2026-10-06, the owner, on production's step 3:
 * "USD estimate unavailable" for ETH/CASHCAT, AI/PONS and CASHCAT/AI; "when it is two coins that are not USD, USDG, ETH and
 * the like, the price isn't fetched"): the implementation of lib/create/poolPrices.ts, handed to today's journey by its
 * wrapper (./NewPositionV2.tsx) once the networks' S1 gates are read; each read goes by its network's gate, live.
 *
 * One read for the chosen pool: read-v6 chain-pools for its own pair (`token` its currency0, `pairedToken` its currency1),
 * whose answer names both with the qualified USD the owner decided (#22, F7 §6.3; api-contracts/read-v6 README "Qualified
 * USD": USDG at $1, ETH and WETH at Chainlink's ETH/USD, any other token through its deepest pool against those with at
 * least US$10K of depth within ±10%, else none with its reason), in pool order (./model/chainReads.ts pricesOf, as Base's
 * and Arbitrum One's rows take theirs). Asked exactly as every chain read of New position is (./served.ts): only while the
 * read route serves chain-pools; a failure that may pass (a busy reader, a dropped connection) is asked again quietly up
 * to PRICE_REASKS times (the read screens' waits); anything else is final, and the steps say "USD estimate unavailable" as
 * before. Nothing is kept between pools: each pool's prices are the chain's now. Changed on purpose 2026-10-06 (rugged's
 * answer of 6 Oct, §1: "don't repeat chain-pools of the same token before 15 s, which is the reader's cache"): a pair's
 * answer serves every ask within 20 s, choosing the pool again or opening New position again included (./served.ts
 * chainPoolsOn, as Base's and Arbitrum One's rows reuse theirs), and a busy reader is asked again no sooner than its
 * Retry-After.
 *
 * Added 2026-10-06 (the owner: AI/PONS and CASHCAT/AI short on Robinhood Chain, and no offer at all): `pay`, the one other
 * token the deposit may be paid with on the pool's network (../funds/model.ts payToken: none while a token of the pool is
 * one a deposit delivers, then nothing is read), with the wallet's balance of it there and its qualified price, from one
 * read-v6 chain-balances read of the tokens the offer asks about (../funds/model.ts balancesRequest: what is held here and
 * elsewhere decides between ETH and the stable). Asked as the other chain reads are, under the pool's network's live S1
 * gate, whatever S2's gate says (the review of 2026-10-06); when it cannot be read, ETH, with no balance said.
 * Changed on purpose 2026-10-06 (rugged97's #379, read-v6 1.1.0-rc.1, additive): what is held on Ethereum and OP Mainnet
 * counts too, read beside it in a request of their own (../funds/model.ts balanceChainsRequest), asked once, so a Worker
 * that still refuses them, or an answer that cannot be had, leaves this read as it was; theirs counts only beside it (the
 * comparison is about what is held here as well). Changed on purpose 2026-10-06 (the review: the token to pay with waited
 * for their read, and failed with it): each answer is used as it arrives. The offer comes from Domino's answer as soon as
 * it is in, with theirs beside it only if it is already back; theirs, back later, only adds what is held there, and the
 * offer is said again (`later`) when that changes the token to pay with. Domino's never waits for theirs.
 */
export function poolPricesFor(gates: JourneyGates | null): PoolPrices | null {
  if (!gates) return null
  const live = (chainId: number): LiveGate | null => {
    const gate = gates[chainId as V2ChainId]
    return gate?.mode === 'live' ? gate : null
  }
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
    async pay(pool, owner, signal, later, selected) {
      const chainId = pool.currencies[0].chainId
      const gate = live(chainId)
      const tokens = pool.currencies.map((currency) => currency.address)
      if (!gate || !payToken(chainId, tokens, null)) return null
      const ask = (request: readonly { chainId: number; address: string }[]) => servedOn<ChainBalancesResponse>(gate, 'chain-balances', (t) => readChainBalances(t.read, t.readRuntime, owner, request))
      // The offer from Domino's answer (null: not read), with Ethereum's and OP Mainnet's beside it (null: none, or not yet).
      const offer = (domino: ChainBalancesResponse | null, away: ChainBalancesResponse | null): PayFacts | null => {
        const answer = domino && mergeBalances(domino, away)
        // A recommendation may change; the token the person already chose must not.
        const token = selected?.chainId === chainId ? selected : payToken(chainId, tokens, answer)
        const held = token && answer && balanceOn(answer, chainId, token.address)
        return (
          token && {
            token: { origin: 'read', chainId, address: token.address, symbol: token.symbol, decimals: token.decimals, readStatus: 'available', artwork: holdingArtwork(chainId, token.address) },
            raw: held ? held.raw : null,
            nativeRaw: answer ? nativeOn(answer, chainId) : null,
            usd: held ? held.usd : null,
          }
        )
      }
      // Theirs asked beside Domino's three, in a request of its own, and never waited for: `away.body` once it is back.
      const elsewhere = selected ? [] : balanceChainsRequest(chainId)
      const away: { body?: ChainBalancesResponse | null } = {}
      const asked = elsewhere.length === 0 ? null : ask(elsewhere).then((said) => (away.body = said.kind === 'ok' ? said.body : null))
      const said = await patiently(() => ask(balancesRequest(chainId)), signal)
      const domino = said.kind === 'ok' ? said.body : null
      const first = offer(domino, away.body ?? null)
      if (signal.aborted) return null
      // Theirs back after Domino's (and only beside it): what is held there joins, said again when the token changes.
      if (domino && asked && away.body === undefined) {
        void asked.then((body) => {
          const next = body && !signal.aborted ? offer(domino, body) : null
          if (next && next.token.address !== first?.token.address) later(next)
        })
      }
      return first
    },
  }
}
