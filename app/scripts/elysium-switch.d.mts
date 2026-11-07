/** Types for elysium-switch.mjs, which vite.config.ts imports. */
export declare const ELYSIUM_V2_ID: 99901
export interface RecordPin {
  readonly path: string
  readonly sha256: string
}
export declare const ELYSIUM_RECORD_PIN: RecordPin | null
export declare const OVERRIDE_PROFILE: 'DOMINO_TEST_ELYSIUM_PROFILE'
export declare const OVERRIDE_FUNDS_FROM: 'DOMINO_TEST_ELYSIUM_FUNDS_FROM'
export declare const MARK_PATH: string
export type SwitchPiece = 'profile' | 'record' | 'pin' | 'readV6' | 'plan'
export declare const PIECES: readonly SwitchPiece[]
export declare function squarePngSide(bytes: unknown): number
export declare function isEnabledElysium(profile: unknown): boolean
export declare function enabledProfileIn(dir: string): { file: string; text: string; profile: Record<string, unknown> } | null
export declare function recordsIn(repoRoot: string): string[]
/** The pinned record a live build carries: its pin and its exact text. */
export interface PinnedRecord extends RecordPin {
  readonly text: string
}
export declare function pinnedRecord(repoRoot: string, records: readonly string[], pin: unknown): { record: PinnedRecord } | { reason: string }
export declare function readV6Names(chainIds: unknown): boolean
export declare function planNames(chains: unknown): boolean
export declare function originPinned(chains: unknown): boolean
export interface SwitchRow {
  testHooks: boolean
  deployable: boolean
  site: boolean
}
export declare function isTestBuild(row: SwitchRow): boolean
export interface ElysiumSwitch {
  live: boolean
  fundsFrom: boolean
  forced: boolean
  outDirSuffix: '' | '-elysium' | '-elysium-funds'
  profileFile: string | null
  profile: string | null
  deployment: PinnedRecord | null
  uniswap: { positionManager: string | null; permit2: string | null } | null
  missing: { piece: SwitchPiece; detail: string }[]
}
export declare function elysiumSwitch(options: {
  row: SwitchRow
  env?: Readonly<Record<string, string | undefined>>
  appRoot: string
  pin?: unknown
  readV6Chains?: unknown
  planChains?: unknown
  chains?: unknown
}): ElysiumSwitch
export declare function switchDiagnostic(result: ElysiumSwitch): string | null
