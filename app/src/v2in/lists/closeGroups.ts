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
