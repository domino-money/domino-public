/**
 * The Robinhood v4 ChainAdapter (2026-10-01, the chain2 workstream, part B, audit item G7): Robinhood Chain behind the
 * interface the second chain's screens read through (chains/types.ts), over the very reads Robinhood Chain's own screens
 * make, unchanged. Nothing here reads anything those screens do not read, or reads it differently:
 *
 * - a wallet's positions: Positions' own read (lib/walletPositions.ts readWalletPositions: the scan of the wallet's
 *   DominoSetupV1 mints through the page's chain code, with its lanes, its memory and its parser), each row as a
 *   PositionSummary;
 * - one position: a position page's own state read (lib/fees/client.ts chainState: the position manager's record, the
 *   pool's price and the position's uncollected fees at one block, exactly as v4 computes them), with what the position
 *   holds from the scan's own arithmetic (functions/_lib/walletPositions.ts principalAt);
 * - capabilities: what the chain and this app offer, from the registry, with nothing asked.
 *
 * What it does not wrap, said by capabilities and refused with a NotWrapped error rather than answered from anything
 * else: Robinhood's pool lists and pool figures come from its read service through the read pipeline
 * (lib/read/*: validated contract reads, TVL, volume, the featured list), which answers per pool with the service's own
 * figures rather than one block's slot0, liquidity and balances; and its history is a position's fees ledger (since
 * 2026-10-02 the site's ledger route and lib/fees/ledger.ts, RPC-SPEC §11.4), a list of its own settlements rather than
 * a pool's events. Those screens keep reading them as they do; wrapping them is a change of what they read, which this
 * package does not make.
 *
 * Nothing here signs, stores or knows a URL: the reads are handed in (createRobinhoodAdapter's defaults are the page's
 * own), so tests/chain-adapters.test.mjs runs it over fakes. No screen reads through it yet: Robinhood's screens keep
 * their own reads, so nothing a visitor sees changes.
 */
import type { ChainConfig } from '../../config/chainKit'
import { hasContract } from '../../config/chainKit'
import type { RelayAnswer, StatePositionOk, StateResponse } from '../../lib/fees/types'
import type { WalletPosition, WalletRead } from '../../lib/walletPositions'
import type { ChainAdapter, ChainCapabilities, HistoryPage, PoolActivitySummary, PoolSummary, PositionRef, PositionState, PositionSummary, TokenInfo } from '../types'
import { poolRef, positionRef } from '../types'
import { inRange } from '../v3math'

/** A read this adapter does not wrap (see the module's comment): the screens that need it read it their own way. */
export class NotWrapped extends Error {
  constructor(readonly read: 'pools' | 'pool' | 'activity' | 'history') {
    super(`not_wrapped:${read}`)
    this.name = 'NotWrapped'
  }
}

/** A wrapped read that did not answer: its own reason (the scan's, the state read's, or the position's). */
export class ReadFailed extends Error {
  constructor(readonly reason: string, readonly retryAt: number = 0) {
    super(reason)
    this.name = 'ReadFailed'
  }
}

export interface RobinhoodReads {
  /** Positions' own read of a wallet (lib/walletPositions.ts readWalletPositions). */
  walletPositions(owner: string, signal: AbortSignal): Promise<WalletRead>
  /** A position page's own state read (lib/fees/client.ts chainState). */
  positionState(tokenIds: readonly string[], signal?: AbortSignal): Promise<RelayAnswer<StateResponse>>
  /** The scan's own arithmetic for what a position holds (functions/_lib/walletPositions.ts principalAt). */
  principal(sqrtPriceX96: bigint, tick: number, tickLower: number, tickUpper: number, liquidity: bigint): readonly [bigint, bigint]
}

export interface RobinhoodDeps {
  /** The registry's Robinhood record (config/chains.ts ROBINHOOD). */
  readonly chain: ChainConfig
  readonly reads: RobinhoodReads
}

const tokenOf = (currency: { address: string; symbol: string | null; decimals: number | null }): TokenInfo => ({ address: currency.address, symbol: currency.symbol, decimals: currency.decimals })

function summaryOf(chain: ChainConfig, positionManager: string, owner: string, row: WalletPosition): PositionSummary | null {
  const ref = positionRef(chain, positionManager, row.tokenId)
  const pool = poolRef(chain, row.poolId)
  if (!ref || !pool) return null
  return {
    ref,
    pool,
    holder: { kind: 'wallet', owner },
    token0: tokenOf(row.currencies[0]),
    token1: tokenOf(row.currencies[1]),
    fee: row.fee,
    tickSpacing: row.tickSpacing,
    tickLower: row.tickLower,
    tickUpper: row.tickUpper,
    liquidity: BigInt(row.liquidity),
    active: row.status === 'open',
  }
}

export function createRobinhoodAdapter(deps: RobinhoodDeps): ChainAdapter {
  const { chain, reads } = deps
  if (chain.deployment.protocol !== 'uniswap-v4' || !hasContract(chain, 'positionManager')) throw new RangeError('not a Uniswap v4 chain of the registry')
  const positionManager = chain.deployment.contracts.positionManager as string
  const ours = (ref: PositionRef) => ref.chainId === chain.id && ref.positionManager === positionManager

  const capabilities: ChainCapabilities = Object.freeze({
    chain,
    // Robinhood's pools are listed by its read service, which its own screens read (not through this adapter).
    pools: 'service',
    // USDG is $1 by definition and the price provider names the rest (config/chains.ts dollarTokens, priceProvider).
    usd: chain.dollarTokens.length > 0 || chain.priceProvider !== null,
    apr: true,
    positions: 'wallet',
    history: 'chain',
    // Create position and the owner's actions are this app's own money code (src/finance), never this adapter.
    actions: Object.freeze({ available: true, reason: null }),
    // No v3-style read or actions service stands behind this adapter: the chain is read directly.
    service: Object.freeze({ read: 'none', actions: 'none' }),
  })

  return {
    chain,
    async capabilities() {
      return capabilities
    },
    async listPools(): Promise<PoolSummary[]> {
      throw new NotWrapped('pools')
    },
    async poolState(): Promise<PoolSummary> {
      throw new NotWrapped('pool')
    },
    async poolActivity(): Promise<PoolActivitySummary> {
      throw new NotWrapped('activity')
    },
    async history(): Promise<HistoryPage | null> {
      throw new NotWrapped('history')
    },

    async listPositions(owner, signal) {
      const read = await reads.walletPositions(owner, signal ?? new AbortController().signal)
      if (!read.ok) throw new ReadFailed(read.reason, read.retryAt ?? 0)
      const lower = read.answer.owner.toLowerCase()
      return read.answer.positions.map((row) => summaryOf(chain, positionManager, lower, row)).filter((row): row is PositionSummary => row !== null)
    },

    async position(ref, signal) {
      if (!ours(ref)) throw new RangeError('not this chain\'s position')
      const answer = await reads.positionState([ref.tokenId], signal)
      if (!answer.ok) throw new ReadFailed(answer.failure, answer.retryAfterMs > 0 ? Date.now() + answer.retryAfterMs : 0)
      const state = answer.value.positions.find((one) => one.tokenId === ref.tokenId)
      if (!state) throw new ReadFailed('not_found')
      if (!state.ok) throw new ReadFailed(state.reason)
      const ok: StatePositionOk = state
      const pool = poolRef(chain, ok.poolId)
      if (!pool) throw new ReadFailed('invalid_reply')
      const sqrtPriceX96 = BigInt(ok.sqrtPriceX96)
      const liquidity = BigInt(ok.liquidity)
      return {
        ref,
        pool,
        holder: { kind: 'wallet', owner: ok.owner.toLowerCase() },
        token0: tokenOf(ok.currencies[0]),
        token1: tokenOf(ok.currencies[1]),
        fee: ok.poolKey.fee,
        tickSpacing: ok.poolKey.tickSpacing,
        tickLower: ok.tickLower,
        tickUpper: ok.tickUpper,
        liquidity,
        active: liquidity > 0n,
        tick: ok.tick,
        sqrtPriceX96,
        inRange: inRange(ok.tick, ok.tickLower, ok.tickUpper),
        amounts: reads.principal(sqrtPriceX96, ok.tick, ok.tickLower, ok.tickUpper, liquidity),
        fees: [BigInt(ok.unclaimed0), BigInt(ok.unclaimed1)],
        at: { source: 'chain', block: answer.value.block, timestamp: answer.value.timestamp },
      } satisfies PositionState
    },
  }
}
