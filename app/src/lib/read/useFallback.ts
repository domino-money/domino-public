/**
 * The rows a screen shows, with the read service's refused figures stood in for (audit V1, 2026-10-01;
 * figureFallback.ts has the rules): this browser's memory of the last good figures, DEX Screener's, and today's
 * selection's. Every screen that draws a pool's figures from the read service goes through here: Home's table and
 * ticker, Markets' cards and table, a token's pools and a pool's page, so they never disagree about a pool.
 *
 * It also keeps what the read service gave, for the next refusal and the next visit (figureMemory.ts), and asks DEX
 * Screener about a pool's token where a stand-in is wanted and none is in hand (dexFigures.ts: one GET per token at
 * most a minute, through our own edge). Nothing is shown from a stand-in it does not have.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { PoolCatalogueEntry } from '../../config/selectedPoolCatalogue'
import type { Instant, Market } from '../markets'
import { dexStore, subjectOf, type DexPool } from './dexFigures'
import { catalogueFallback, needsFallback, withFallback, type FallbackInputs } from './figureFallback'
import { figureMemory, goodFigures } from './figureMemory'
import { DYNAMIC_FEE_PIPS } from './screens/fee'
import type { PoolOption } from './screens/poolsList'

/** The stand-ins at hand for a pool, now. */
export function fallbackInputs(poolId: string, entries: readonly PoolCatalogueEntry[] | null, now: Instant): FallbackInputs {
  const id = poolId.toLowerCase()
  const entry = entries?.find((candidate) => candidate.poolId === id)
  return { kept: figureMemory.recall(id), dex: dexStore.pool(id, now.wall), selection: entry?.selection ?? null, now }
}

/** Keeps what the read service gave for these rows (figureMemory.ts). */
function useRemembered(rows: readonly Market[]) {
  useEffect(() => {
    for (const row of rows) {
      const good = goodFigures(row)
      if (good) figureMemory.remember(row.poolId, good)
    }
  }, [rows])
}

/** Asks DEX Screener about each of `tokens` (joined with commas), once per change of the set. */
function useAsked(tokens: string) {
  useEffect(() => {
    for (const token of tokens ? tokens.split(',') : []) dexStore.ask(token)
  }, [tokens])
}

/** The rows as they are shown: refused figures stood in for where there is something to stand in with. */
export function useFallbackRows(rows: readonly Market[], entries: readonly PoolCatalogueEntry[] | null, now: Instant): Market[] {
  useSyncExternalStore(dexStore.subscribe, dexStore.version, dexStore.version)
  useRemembered(rows)
  const wanting = rows.filter((row) => needsFallback(row, now))
  const out = wanting.length === 0 ? (rows as Market[]) : rows.map((row) => (wanting.includes(row) ? withFallback(row, fallbackInputs(row.poolId, entries, now)) : row))
  const ask = [...new Set(wanting.filter((row) => !dexStore.pool(row.poolId, now.wall)).map((row) => subjectOf([row.tokens.base.address, row.tokens.quote.address])))].sort().join()
  useAsked(ask)
  return out
}

/** One row (a pool's page): the same as useFallbackRows. */
export function useFallbackRow(row: Market | null, now: Instant): Market | null {
  const rows = useFallbackRows(row ? [row] : NONE, null, now)
  return row ? rows[0] : null
}

const NONE: readonly Market[] = []

/** The currencies a catalogue entry names, lowercase, when it names them. */
const currenciesOf = (entry: PoolCatalogueEntry): [string, string] | null =>
  entry.poolKey ? [entry.poolKey.currency0, entry.poolKey.currency1] : entry.addresses ? [entry.addresses[0].toLowerCase(), entry.addresses[1].toLowerCase()] : null

/**
 * Stand-in figures for the list's pools that have no row (still being collected, or the read service refused them
 * all): the same stand-ins, by pool id, for their catalogue rows.
 */
export function useCatalogueFallback(entries: readonly PoolCatalogueEntry[], rowless: readonly string[], now: Instant) {
  useSyncExternalStore(dexStore.subscribe, dexStore.version, dexStore.version)
  const wanted = entries.filter((entry) => rowless.includes(entry.poolId))
  // No estimate is worked out for a pool with no row: its protocol fee was never read. The last one seen, or today's
  // selection's, stands in.
  const figures = new Map(wanted.map((entry) => [entry.poolId, catalogueFallback(fallbackInputs(entry.poolId, entries, now), { feePips: entry.poolKey?.fee_pips ?? null, integration: undefined, protocolFeeRaw: undefined })] as const))
  const ask = [...new Set(wanted.flatMap((entry) => {
    const currencies = currenciesOf(entry)
    return currencies && !dexStore.pool(entry.poolId, now.wall) ? [subjectOf(currencies)] : []
  }))].sort().join()
  useAsked(ask)
  return figures
}

/**
 * Stand-ins for one pool with no stored figures at all, on its own page (audit V1 and A12): this browser's last ones,
 * DEX Screener's (the page asks for them; or the ones the pools route carried, when it verified the pool), or none.
 * Null when not `wanted` or when there is nothing to stand in with.
 */
export function usePoolStandIns(option: Pick<PoolOption, 'key' | 'currencies' | 'feePips' | 'integration' | 'protocolFeeRaw' | 'liquidity' | 'volume'>, wanted: boolean, now: Instant) {
  useSyncExternalStore(dexStore.subscribe, dexStore.version, dexStore.version)
  const asked = wanted && dexStore.pool(option.key, now.wall) === null ? subjectOf([option.currencies[0].address, option.currencies[1].address]) : ''
  useAsked(asked)
  if (!wanted) return null
  const inputs = fallbackInputs(option.key, null, now)
  const carried = carriedDex(option)
  const figures = catalogueFallback(inputs.dex || !carried ? inputs : { ...inputs, dex: carried }, {
    feePips: option.feePips === DYNAMIC_FEE_PIPS ? null : option.feePips,
    integration: option.integration,
    protocolFeeRaw: option.protocolFeeRaw,
  })
  return figures.tvl || figures.volume || figures.apr ? figures : null
}

/** DEX Screener's figures as the pools route carried them on a verified pool (read-v1 providerMetrics), when it did. */
function carriedDex(option: Pick<PoolOption, 'key' | 'currencies' | 'liquidity' | 'volume'>): DexPool | null {
  const raw = (figure: PoolOption['liquidity']) => (figure.provider === 'dexscreener' && (figure.state === 'attributed' || figure.state === 'attributed_stale') ? figure : null)
  const liquidity = raw(option.liquidity)
  const volume = raw(option.volume)
  const at = liquidity?.retrievedAt ?? volume?.retrievedAt
  if (at === undefined) return null
  return { poolId: option.key, base: option.currencies[0].address, quote: option.currencies[1].address, liquidityUsd: liquidity?.raw ?? null, volume24hUsd: volume?.raw ?? null, retrievedAt: at }
}
