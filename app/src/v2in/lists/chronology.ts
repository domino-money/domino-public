export interface Chronology {
  id: string
  at: number | null
  chainId?: number
  block?: number | string
  logIndex?: number | string
}

const descending = (a: number | string | undefined, b: number | string | undefined): number => {
  const left = a === undefined ? -1n : BigInt(a), right = b === undefined ? -1n : BigInt(b)
  return left === right ? 0 : left > right ? -1 : 1
}

/** Dates come from confirmed block headers. IDs only break ties after the numeric chain/block/log keys. */
export function compareChronology(a: Chronology, b: Chronology): number {
  if (a.at === null || b.at === null) {
    if (a.at !== b.at) return a.at === null ? 1 : -1
  } else if (a.at !== b.at) return b.at - a.at
  return descending(a.chainId, b.chainId) || descending(a.block, b.block) || descending(a.logIndex, b.logIndex) || a.id.localeCompare(b.id)
}

export const logIndexOf = (id: string): string | undefined => {
  const part = id.split(':').at(-1)
  return part && /^\d+$/.test(part) ? part : undefined
}
