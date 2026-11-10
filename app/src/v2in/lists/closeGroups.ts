import { MAX_CLOSE_POSITIONS } from '../../finance/v2/direct'
import { positionManagerOrNull, v2Chain } from '../../v2/chains'
import type { PositionRowView } from './model'

/** Inventory suggests choices; the direct client proves ownership and custody again at review and send. */
export function canCloseTogether(row: PositionRowView): boolean {
  const chain = v2Chain(row.chainId)
  // A row of a version the chain lacks (v3 on a chain with v4 alone) names no manager of it: never offered.
  const manager = positionManagerOrNull(chain, row.dex)
  return manager !== null && row.status === 'live' && row.tab === 'open' && !row.hooked && row.vault?.role !== 'successor' && row.positionManager.toLowerCase() === manager
}

/** Each group is one official manager's atomic call. Different managers/networks require separate confirmations. */
export function closeGroups(rows: readonly PositionRowView[]): PositionRowView[][] {
  const groups = new Map<string, PositionRowView[]>()
  const seen = new Set<string>()
  for (const row of rows) {
    if (!canCloseTogether(row) || seen.has(row.key)) continue
    seen.add(row.key)
    const key = `${row.chainId}:${row.positionManager.toLowerCase()}`
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  return [...groups.values()].flatMap((group) => {
    const chunks: PositionRowView[][] = []
    for (let index = 0; index < group.length; index += MAX_CLOSE_POSITIONS) chunks.push(group.slice(index, index + MAX_CLOSE_POSITIONS))
    return chunks
  })
}

/**
 * Added 2026-11-09 (the core-flows fix; the owner: closing positions with automation must be totally easy): what closing
 * this group does to the automation on its positions, in one plain line, named as the list names it ("Auto-compound",
 * "Domino-compound", "Auto-exit"). Closing turns it off by itself (the vault never refuses its owner's exit), so there
 * is no tick box any more.
 */
export function bulkTurnsOffCopy(rows: readonly PositionRowView[]): string {
  const names = [...new Set(rows.flatMap((row) => (row.vault?.role === 'root' && row.vault.name ? [row.vault.name] : [])))]
  const which = names.length ? names.join(' and ') : 'their automation'
  return `Closing also turns off ${which} for ${rows.length === 1 ? 'this position' : 'these positions'}.`
}
