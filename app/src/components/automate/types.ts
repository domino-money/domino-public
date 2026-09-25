/**
 * What the automation page hands the successor axis, by shape: the chosen
 * position's NFT id and its range in ticks, with its pool's tick spacing (from
 * lib/walletPositions.ts, passed as plain values). The kit never imports
 * finance/* or session/*.
 */
export interface AxisRoot {
  /** Canonical decimal NFT id. */
  tokenId: string
  lower: number
  upper: number
  spacing: number
}
