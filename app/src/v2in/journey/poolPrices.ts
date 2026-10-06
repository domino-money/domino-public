import type { ChainBalancesResponse, ChainPoolsResponse } from 'api-contracts/read-v6/types'
import type { PoolPrices } from '../../lib/create/poolPrices'
import { readChainBalances, readChainPools } from '../../v2/read/v6'
import type { V2ChainId } from '../../v2/types'
import { balanceOn, balancesRequest, holdingArtwork, payToken } from '../funds/model'
import { pricesOf } from './model/chainReads'
import { patiently, servedOn, type LiveGate } from './served'
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
 * before. Nothing is kept between pools: each pool's prices are the chain's now.
 *
 * Added 2026-10-06 (the owner: AI/PONS and CASHCAT/AI short on Robinhood Chain, and no offer at all): `pay`, the one other
 * token the deposit may be paid with on the pool's network (../funds/model.ts payToken: none while a token of the pool is
 * one a deposit delivers, then nothing is read), with the wallet's balance of it there and its qualified price, from one
 * read-v6 chain-balances read of the tokens the offer asks about (../funds/model.ts balancesRequest: what is held here and
 * elsewhere decides between ETH and the stable). Asked as the other chain reads are, under the pool's network's live S1
 * gate, whatever S2's gate says (the review of 2026-10-06); when it cannot be read, ETH, with no balance said.
 */
export function poolPricesFor(gates: JourneyGates | null): PoolPrices | null {
  if (!gates) return null
  const live = (chainId: number): LiveGate | null => {
    const gate = gates[chainId as V2ChainId]
    return gate?.mode === 'live' ? gate : null
  }
  return {
    async read(pool, signal) {
      const gate = live(4663)
      if (!gate || pool.currencies[0].chainId !== 4663 || pool.currencies[1].chainId !== 4663) return null
      const pair = { currency0: pool.currencies[0].address.toLowerCase(), currency1: pool.currencies[1].address.toLowerCase() }
      const said = await patiently(() => servedOn<ChainPoolsResponse>(gate, 'chain-pools', (t) => readChainPools(t.read, t.readRuntime, 4663, pair.currency0, pair.currency1)), signal, PRICE_REASKS)
      return said.kind === 'ok' && !signal.aborted ? (pricesOf(said.body, pair) ?? null) : null
    },
    async pay(pool, owner, signal) {
      const chainId = pool.currencies[0].chainId
      const gate = live(chainId)
      const tokens = pool.currencies.map((currency) => currency.address)
      if (!gate || !payToken(chainId, tokens, null)) return null
      const said = await patiently(() => servedOn<ChainBalancesResponse>(gate, 'chain-balances', (t) => readChainBalances(t.read, t.readRuntime, owner, balancesRequest(chainId))), signal)
      const answer = said.kind === 'ok' ? said.body : null
      const token = payToken(chainId, tokens, answer)
      if (signal.aborted || !token) return null
      const held = answer && balanceOn(answer, chainId, token.address)
      return {
        token: { origin: 'read', chainId, address: token.address, symbol: token.symbol, decimals: token.decimals, readStatus: 'available', artwork: holdingArtwork(chainId, token.address) },
        raw: held ? held.raw : null,
        usd: held ? held.usd : null,
      }
    },
  }
}
