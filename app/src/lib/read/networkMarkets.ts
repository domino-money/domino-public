/**
 * Base's and Arbitrum One's pools as Markets rows (added 2026-11-06, the owner's replica rule: "Base and Arbitrum are an
 * exact copy of Robinhood Chain's screens; only the network changes"). Robinhood Chain's token page lists the pools the
 * read service verified for a token as Markets rows with DEX Screener's figures beside them (tokenPools.ts discoveryRows);
 * these are the same rows for a network whose pools read-v6's chain-pools reads (src/v2in/journey/otherChains.ts), so the
 * same table (components/MarketsTable.tsx), the same pool page (components/read/screens/PoolWorkspace.tsx) and the same
 * figures dialog draw them.
 *
 *   - names, decimals, price and fee are the chain-pools answer's own (the pool row New position lists, PoolOption);
 *   - TVL and 24h volume are DEX Screener's, as the row carries them once lib/create/otherChains.ts networkRows put them
 *     on (dated, and a dash past its ten minutes), attributed to DEX Screener exactly as a Robinhood Chain row's
 *     discovered figures are (`fallback: 'discovered'`);
 *   - the APR is the read service's estimate method worked out on those two figures (rowApr.ts, a v3 pool's protocol
 *     share included), labelled an estimate ("est.") as Markets labels every such figure;
 *   - every key names the chain: a pool id or an address can repeat across chains.
 *
 * No history exists for these networks yet (no stored figures, no Domino 24h history, no price history): those figures
 * stay unavailable, and the screens leave their blocks out. Pure: nothing here reads anything.
 */
import { isOtherV2ChainId } from '../../config/chainIdentity'
import type { Market, Metric } from '../markets'
import type { AttributedFigure } from './screens/figures'
import type { PoolOption } from './screens/poolsList'
import { DYNAMIC_FEE_PIPS } from './screens/fee'
import { rowApr } from './screens/rowApr'
import { tokenText } from './project'

/** A DEX Screener figure a network's pool row carries, as a Markets row's metric: attributed and dated, or unavailable. */
function reported(figure: AttributedFigure): Metric {
  if (figure.state === 'attributed') return { value: figure.raw, state: 'provider', asOf: figure.retrievedAt, source: 'DexScreener', fallback: 'discovered' }
  if (figure.state === 'attributed_stale') return { value: figure.raw, state: 'stale', asOf: figure.retrievedAt, source: 'DexScreener', fallback: 'discovered' }
  return { value: null, state: 'unavailable', reason: figure.state === 'not_reported' ? 'no_provider_figures' : figure.reason }
}

/** The DEX Screener time of a row's figures, when it carries one. */
const retrievedAt = (option: PoolOption): number | null => {
  for (const figure of [option.liquidity, option.volume]) if (figure.state === 'attributed' || figure.state === 'attributed_stale') return figure.retrievedAt
  return null
}

/**
 * Whether a pool row is on another V2 network rather than Robinhood Chain: Base, Arbitrum One, and Elysium where the build
 * serves it (config/chainIdentity.ts OTHER_V2_CHAIN_IDS; Changed on purpose 2026-11-07, Elysium's screens).
 */
export const onNetwork = (market: Pick<Market, 'tokens'>): boolean => isOtherV2ChainId(market.tokens.base.chainId)

/**
 * One of a network's pool rows as a Markets row (see the header). `option` as the network's list draws it: DEX Screener's
 * figures on, aged at the screen's clock (lib/create/otherChains.ts networkRows, networkFiguresAt).
 */
export function networkMarketRow(option: PoolOption): Market {
  const [first, second] = option.currencies
  const chainId = first.chainId
  const at = retrievedAt(option)
  const feePips = option.feePips === DYNAMIC_FEE_PIPS ? null : option.feePips
  const estimate = feePips === null ? null : rowApr({
    integration: option.integration,
    currentLpFeePips: feePips,
    protocolFeeRaw: option.protocolFeeRaw,
    ...(option.v3FeeProtocol !== undefined ? { v3FeeProtocol: option.v3FeeProtocol } : {}),
    liquidity: option.liquidity,
    volume: option.volume,
  })
  const poolId = option.key.toLowerCase()
  return {
    key: `${chainId}:${poolId}`,
    poolId,
    base: tokenText(first),
    quote: tokenText(second),
    tokens: { base: first, quote: second },
    feePips,
    protocol: 'v4',
    integration: option.integration,
    hooks: option.hooks.toLowerCase(),
    ...(option.protocolFeeRaw !== undefined ? { protocolFeeRaw: option.protocolFeeRaw } : {}),
    tvlUsd: reported(option.liquidity),
    volume24hUsd: reported(option.volume),
    feeAprPercent: { value: null, state: 'unavailable', reason: 'fee_apr_not_provided' },
    ...(estimate?.kind === 'estimate' && at !== null ? { aprFallback: { percent: estimate.text, asOf: at, basis: 'discovered' as const } } : {}),
    poolState: {
      sqrtPriceX96: option.sqrtPriceX96,
      tick: option.tick,
      tickSpacing: option.tickSpacing,
      block: option.block,
      currency0: first.address.toLowerCase(),
      currency1: second.address.toLowerCase(),
    },
    provenance: {
      block: option.block,
      market: { status: 'unavailable', reason: 'not_collected', cacheAgeSeconds: null, freshForSeconds: 60, receivedAt: option.readAt ?? 0 },
      metrics: 'not_requested',
      fixtures: [],
      origin: 'pool-market',
    },
  }
}

/** A network's pool rows as Markets rows, in the list's own order. */
export const networkMarketRows = (options: readonly PoolOption[]): Market[] => options.map(networkMarketRow)
