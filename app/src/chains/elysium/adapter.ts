/**
 * The Elysium v3 ChainAdapter (2026-10-01, the chain2 workstream, audit items G7 and G8): what the second chain's
 * screens read, from the chain itself in the browser and from rugged97's read service where this site reaches it.
 *
 * - Pools: the factory's PoolCreated logs (read once a visit, window by window) plus the pools the source names, each
 *   pool's state, balances and tokens in one block's Multicall3 read. His service has no pool list, so the chain is
 *   the list.
 * - A wallet's positions: the vaults it owns (owner() of every vault known, from the source and from his actions
 *   service's capabilities where it answers, in one Multicall3 read), each vault's positions, and the position NFTs the
 *   wallet holds itself.
 * - One position: the position manager's record, the pool's price and fee growth and both range ticks at one block,
 *   and from them, exactly, what it holds and the fees it earned and has not collected (chains/v3math.ts).
 * - Activity: a pool's swaps over the last hours, from its Swap logs, paced; a vault's history from his read service
 *   where it answers (anchored, with its coverage), else from the vault's own events on the chain.
 * - Capabilities: what the chain, the source and his services allow, so the screens hide what is not there (USD, APR,
 *   actions) and show amounts instead.
 *
 * Nothing here signs, stores or knows a URL: the chain reader and the service client are handed in.
 */
import type { ChainConfig } from '../../config/chainKit'
import { priceInvertedOn } from '../../config/chainKit'
import { untilAborted } from '../../lib/chain/client'
import type { ChainReader, PoolRead, PositionRead, Stamp, TokenMeta, VaultRead } from '../../../functions/_lib/uniswap-v3/reads'
import { discoverPools, poolActivity, readPools, readPosition, readVault, vaultEvents, vaultsOwnedBy, walletTokenIds } from '../../../functions/_lib/uniswap-v3/reads'
import type { CapabilitiesRequest, HistoryResponse } from '../../../functions/_lib/uniswap-v3/contracts/uniswap-v3-read-v1/types'
import type { ChainAdapter, ChainCapabilities, HistoryItem, HistoryPage, Holder, PoolActivitySummary, PoolRef, PoolSummary, PositionRef, PositionState, PositionSummary, Provenance, ServiceState, TokenInfo } from '../types'
import { poolRef, positionRef } from '../types'
import { amountsForLiquidity, feeGrowthInside, inRange, providerFees, uncollectedFees } from '../v3math'
import { ServiceError, type Identity, type V3Api } from './api'
import type { SectionMode, SectionSource } from './flag'

/** The most pools read for the list (a factory's pools on a testnet are few; past this, the newest are read). */
export const MAX_POOLS = 48
/** Pools per state read (9 sub-calls each in one aggregate3, plus the stamp's two). */
const POOLS_PER_READ = 12
/** The most hours of a pool's swaps read for its activity. */
export const MAX_ACTIVITY_HOURS = 24 * 7
/** The most history rows asked of his service at once (his limit is 1 to 100). */
export const HISTORY_LIMIT = 50

/**
 * Whether a version of his actions contract offers this public site a wallet lane, by contract version; a version not
 * named here offers none. rc.2 offers none: its publicFinancialExecutionAvailable and walletAuthenticationAvailable are
 * always false, and its only wallet lanes are his local fixture (localWalletActionsAvailable) and his privately admitted
 * testnet rehearsal (rehearsalWalletActionsAvailable), both refused outright by api.ts. A later version that names a
 * public lane is added here once it is reviewed.
 */
export const PUBLIC_WALLET_LANE: Readonly<Record<string, boolean>> = Object.freeze({ '1.0.0-rc.2': false })

export interface ElysiumDeps {
  readonly chain: ChainConfig
  readonly mode: SectionMode
  readonly source: SectionSource
  readonly reader: ChainReader & { head(signal?: AbortSignal): Promise<{ number: number; timestamp: number; hash: string }> }
  /** His services through this site's route; null where this build has no transport for them. */
  readonly api: V3Api | null
  /** Whether a wallet signer is wired into this build (part B). */
  readonly signer: boolean
}

export interface ElysiumAdapter extends ChainAdapter {
  /** The deployment identity his services answered with, once capabilities asked; null where none. */
  identity(): Identity | null
  /** The vault a wallet owns for a pool, if any (a vault is one owner's and one pool's). */
  vaultFor(owner: string, pool: PoolRef, signal?: AbortSignal): Promise<VaultRead | null>
  /** A vault, read now. */
  vault(address: string, signal?: AbortSignal): Promise<VaultRead>
}

const chainAt = (stamp: Stamp): Provenance => ({ source: 'chain', block: stamp.block, timestamp: stamp.timestamp })
const tokenOf = (meta: TokenMeta): TokenInfo => ({ address: meta.address, symbol: meta.symbol, decimals: meta.decimals })

/** A service's state from what asking it did. */
function stateOf(error: unknown): ServiceState {
  return error instanceof ServiceError && error.kind === 'not-enabled' ? 'not-enabled' : 'unreachable'
}

export function createElysiumAdapter(deps: ElysiumDeps): ElysiumAdapter {
  const { chain, source, reader, api } = deps
  const protocol = chain.deployment.protocol
  let identity: Identity | null = null
  let knownVaults: readonly string[] = source.vaults
  /** The factory's pools, read once a visit; the scan's promise is shared. */
  let discovered: Promise<string[]> | null = null

  function summary(pool: PoolRead): PoolSummary {
    const ref = poolRef(chain, pool.address)
    if (!ref) throw new Error('invalid_pool')
    return {
      ref,
      token0: tokenOf(pool.token0),
      token1: tokenOf(pool.token1),
      fee: pool.fee,
      tickSpacing: pool.tickSpacing,
      sqrtPriceX96: pool.slot0.sqrtPriceX96,
      tick: pool.slot0.tick,
      liquidity: pool.liquidity,
      balances: [pool.balance0, pool.balance1],
      feeProtocol: pool.slot0.feeProtocol,
      at: chainAt(pool.stamp),
    }
  }

  async function capabilities(signal?: AbortSignal): Promise<ChainCapabilities> {
    let read: ServiceState = 'not-enabled'
    let actions: ServiceState = 'not-enabled'
    let actionsSayYes = false
    if (api) {
      // His generated types name the chain id as a literal; the value is the registry's, and his runtime checks it.
      const asked = { chainId: chain.id, protocol } as unknown as CapabilitiesRequest
      const [readAnswer, actionsAnswer] = await Promise.allSettled([api.read('capabilities', asked, undefined, signal), api.actions('capabilities', asked, undefined, signal)])
      if (readAnswer.status === 'fulfilled') {
        read = 'connected'
        identity = readAnswer.value.deployment
      } else read = stateOf(readAnswer.reason)
      if (actionsAnswer.status === 'fulfilled') {
        actions = 'connected'
        identity ??= actionsAnswer.value.deployment
        // The vaults his service admits join the ones the source names: a wallet's are found among all of them.
        knownVaults = [...new Set([...source.vaults, ...actionsAnswer.value.vaults])]
        // Not a flag of his answer but his contract version's (PUBLIC_WALLET_LANE above): rc.2 is a no, whatever it says.
        const version: string = actionsAnswer.value.contractVersion
        actionsSayYes = Object.hasOwn(PUBLIC_WALLET_LANE, version) && PUBLIC_WALLET_LANE[version] === true
      } else actions = stateOf(actionsAnswer.reason)
    }
    const qualified = chain.deployment.status === 'qualified'
    const reason =
      deps.mode === 'off' ? 'section-off'
      : actions !== 'connected' ? 'service-off'
      : !qualified ? 'deployment-unqualified'
      : !actionsSayYes ? 'service-says-no'
      : !deps.signer ? 'no-signer'
      : null
    return {
      chain,
      pools: 'chain',
      usd: chain.dollarTokens.length > 0 || chain.priceProvider !== null,
      apr: false,
      positions: 'vaults-and-wallet',
      history: read === 'connected' && identity ? 'service' : 'chain',
      actions: { available: reason === null, reason },
      service: { read, actions },
    }
  }

  async function poolAddresses(signal?: AbortSignal): Promise<string[]> {
    // The scan is the visit's, not one screen's: it runs under no caller's signal, so a screen that leaves does not fail
    // the one that comes next; each caller stops waiting on its own signal.
    discovered ??= discoverPools(reader, source.factory, source.fromBlock)
      .then((created) => created.map((pool) => pool.pool))
      .catch((error: unknown) => {
        discovered = null
        throw error
      })
    const found = await untilAborted(discovered, signal)
    return [...new Set([...source.pools, ...found])].slice(-MAX_POOLS)
  }

  /** `addresses` read in groups, each group at one block; a pool another factory registered is left out. */
  async function pools(addresses: readonly string[], signal?: AbortSignal): Promise<PoolRead[]> {
    const out: PoolRead[] = []
    for (let at = 0; at < addresses.length; at += POOLS_PER_READ) {
      const read = await readPools(reader, chain, addresses.slice(at, at + POOLS_PER_READ), signal)
      out.push(...read.filter((pool) => pool.factory === source.factory))
    }
    return out
  }

  async function listPools(signal?: AbortSignal): Promise<PoolSummary[]> {
    return (await pools(await poolAddresses(signal), signal)).map(summary)
  }

  async function poolState(ref: PoolRef, signal?: AbortSignal): Promise<PoolSummary> {
    if (ref.chainId !== chain.id) throw new Error('pool_not_in_deployment')
    const [pool] = await pools([ref.id], signal)
    if (!pool) throw new Error('pool_not_in_deployment')
    return summary(pool)
  }

  async function activity(ref: PoolRef, hours: number, signal?: AbortSignal): Promise<PoolActivitySummary> {
    const span = Math.min(MAX_ACTIVITY_HOURS, Math.max(1, Math.floor(hours)))
    const pool = await poolState(ref, signal)
    const toBlock = pool.at.block
    const fromBlock = Math.max(0, toBlock - Math.ceil(span * 3600 * chain.blocksPerSecond))
    const read = await poolActivity(reader, ref.id, fromBlock, toBlock, signal)
    return {
      ref,
      swaps: read.swaps,
      paidIn: [read.in0, read.in1],
      providerFees: providerFees([read.in0, read.in1], pool.fee, pool.feeProtocol),
      fromBlock,
      toBlock,
      hours: span,
      at: pool.at,
    }
  }

  const vault = (address: string, signal?: AbortSignal): Promise<VaultRead> => readVault(reader, chain, address, signal)

  /** The vault `address` is, when it is one of this deployment that holds `tokenId`; null for anything else (a wallet). */
  async function holdingVault(address: string, tokenId: bigint, signal?: AbortSignal): Promise<VaultRead | null> {
    try {
      const read = await vault(address, signal)
      return read.deployment.manager === source.positionManager && read.positions.some((entry) => entry.tokenId === tokenId) ? read : null
    } catch (error) {
      if (signal?.aborted) throw error
      return null
    }
  }

  async function listPositions(owner: string, signal?: AbortSignal): Promise<PositionSummary[]> {
    const who = owner.toLowerCase()
    const vaults: VaultRead[] = []
    for (const address of await vaultsOwnedBy(reader, chain, knownVaults, who, signal)) {
      const read = await vault(address, signal)
      // A vault on another position manager is not this deployment's.
      if (read.deployment.manager === source.positionManager) vaults.push(read)
    }
    const walletIds = await walletTokenIds(reader, chain, source.positionManager, who, signal)
    const held: Array<{ tokenId: bigint; holder: Holder; active: boolean | null; spacing: number | null }> = [
      ...vaults.flatMap((read) => read.positions.map(({ tokenId, state }) => ({ tokenId, holder: { kind: 'vault', vault: read.address, owner: read.owner } as const, active: state.active, spacing: read.tickSpacing }))),
      ...walletIds.map((tokenId) => ({ tokenId, holder: { kind: 'wallet', owner: who } as const, active: null, spacing: null })),
    ]
    const positions = new Map<string, PositionRead>()
    for (const { tokenId } of held) {
      const key = tokenId.toString()
      if (!positions.has(key)) positions.set(key, await readPosition(reader, chain, source.positionManager, tokenId, signal))
    }
    // Each position's pool, read once: its tokens and its tick spacing.
    const byPool = new Map((await pools([...new Set([...positions.values()].map((read) => read.pool))], signal)).map((pool) => [pool.address, pool]))
    const out: PositionSummary[] = []
    for (const { tokenId, holder, active } of held) {
      const read = positions.get(tokenId.toString())
      const pool = read && byPool.get(read.pool)
      const ref = read && positionRef(chain, source.positionManager, tokenId.toString())
      const poolReference = read && poolRef(chain, read.pool)
      if (!read || !pool || !ref || !poolReference) continue
      const p = read.position
      out.push({
        ref,
        pool: poolReference,
        holder,
        token0: tokenOf(pool.token0),
        token1: tokenOf(pool.token1),
        fee: p.fee,
        tickSpacing: pool.tickSpacing,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        liquidity: p.liquidity,
        active: active ?? p.liquidity > 0n,
      })
    }
    return out
  }

  async function position(ref: PositionRef, signal?: AbortSignal): Promise<PositionState> {
    if (ref.chainId !== chain.id || ref.positionManager !== source.positionManager) throw new Error('position_not_in_deployment')
    const read = await readPosition(reader, chain, ref.positionManager, BigInt(ref.tokenId), signal)
    const [pool] = await pools([read.pool], signal)
    const poolReference = poolRef(chain, read.pool)
    if (!pool || !poolReference) throw new Error('pool_not_in_deployment')
    const p = read.position
    const inside = feeGrowthInside(read.slot0.tick, p.tickLower, p.tickUpper, read.lower, read.upper, read.feeGrowthGlobal0X128, read.feeGrowthGlobal1X128)
    // The NFT's owner is a vault of this deployment holding it: the position is that vault's, and so its owner's.
    const custodian = read.owner ? await holdingVault(read.owner, read.tokenId, signal) : null
    const holder: Holder = custodian ? { kind: 'vault', vault: custodian.address, owner: custodian.owner } : { kind: 'wallet', owner: read.owner ?? '' }
    const active = custodian?.positions.find((entry) => entry.tokenId === read.tokenId)?.state.active ?? p.liquidity > 0n
    return {
      ref,
      pool: poolReference,
      holder,
      token0: tokenOf(pool.token0),
      token1: tokenOf(pool.token1),
      fee: p.fee,
      tickSpacing: pool.tickSpacing,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      liquidity: p.liquidity,
      active,
      tick: read.slot0.tick,
      sqrtPriceX96: read.slot0.sqrtPriceX96,
      inRange: inRange(read.slot0.tick, p.tickLower, p.tickUpper),
      amounts: amountsForLiquidity(read.slot0.sqrtPriceX96, p.tickLower, p.tickUpper, p.liquidity),
      fees: uncollectedFees(p, inside),
      at: chainAt(read.stamp),
    }
  }

  /** His read service's history of a vault, as the screens show it: one row per event, in the pool's token order. */
  function fromService(answer: HistoryResponse, tokens: readonly [string, string]): HistoryPage {
    const raw = (value: string | null) => (value === null ? null : BigInt(value))
    const items: HistoryItem[] = answer.items.map((item) => ({
      kind: item.kind,
      source: 'service',
      block: item.blockNumber,
      timestamp: item.timestamp,
      transactionHash: item.transactionHash,
      tokenId: item.tokenId,
      // An event about one currency (a fee balance) names it; the pool's token order decides its side.
      amounts: item.currency ? (item.currency === tokens[0] ? [raw(item.originalRaw), null] : [null, raw(item.originalRaw)]) : [raw(item.amount0Raw), raw(item.amount1Raw)],
    }))
    return { items, complete: answer.coverage.complete, at: { source: 'service', block: answer.anchor.number, timestamp: answer.anchor.timestamp } }
  }

  async function history(ref: PositionRef, signal?: AbortSignal): Promise<HistoryPage | null> {
    const state = await position(ref, signal)
    if (state.holder.kind !== 'vault') return null
    const vaultAddress = state.holder.vault
    if (api && identity) {
      try {
        const answer = await api.read('history', { ...identity, vault: vaultAddress, limit: HISTORY_LIMIT }, identity, signal)
        return fromService(answer, [state.token0.address, state.token1.address])
      } catch (error) {
        if (error instanceof ServiceError && error.kind === 'aborted') throw error
      }
    }
    // The chain's own record: the vault's events since the source's first block, oldest first. Their blocks are
    // known; their times are not read (a header per event), and none is invented.
    const events = await vaultEvents(reader, vaultAddress, source.fromBlock, 'latest', signal)
    const head = await reader.head(signal)
    return {
      items: events
        .filter((event) => event.tokenId === null || event.tokenId.toString() === ref.tokenId)
        .map((event) => ({ kind: event.kind, source: 'chain', block: event.block, timestamp: null, transactionHash: event.transactionHash, tokenId: event.tokenId?.toString() ?? null, amounts: [null, null] })),
      complete: true,
      at: { source: 'chain', block: head.number, timestamp: head.timestamp },
    }
  }

  async function vaultFor(owner: string, pool: PoolRef, signal?: AbortSignal): Promise<VaultRead | null> {
    for (const address of await vaultsOwnedBy(reader, chain, knownVaults, owner, signal)) {
      const read = await vault(address, signal)
      if (read.pool === pool.id && read.deployment.manager === source.positionManager) return read
    }
    return null
  }

  return {
    chain,
    capabilities,
    listPools,
    poolState,
    poolActivity: activity,
    listPositions,
    position,
    history,
    identity: () => identity,
    vaultFor,
    vault,
  }
}

/** Whether a pool's price is written the other way round on this chain (its first token is the quote). */
export const invertedFor = (chain: ChainConfig, pool: Pick<PoolSummary, 'token0' | 'token1'>): boolean => priceInvertedOn(chain, pool.token0.address, pool.token1.address)
