/** Types for elysium-switch.mjs, which vite.config.ts imports. */
export declare const ELYSIUM_V2_ID: 99901
export interface RecordPin {
  readonly path: string
  readonly sha256: string
}
export declare const ELYSIUM_RECORD_PIN: RecordPin | null
export declare const ELYSIUM_SLUG: 'elysium'
/** Elysium's pre-launch: the opening day, 'YYYY-MM-DD', or null (added 2026-11-07). */
export declare const ELYSIUM_OPENS_ON: string | null
/** The opening day (month from 1) and its two English forms, as the build writes them in. */
export interface ElysiumOpening {
  readonly at: readonly [number, number, number]
  readonly short: string
  readonly long: string
}
export declare function openingOf(opensOn: unknown): ElysiumOpening | null
export declare const OVERRIDE_PROFILE: 'DOMINO_TEST_ELYSIUM_PROFILE'
export declare const OVERRIDE_FUNDS_FROM: 'DOMINO_TEST_ELYSIUM_FUNDS_FROM'
export declare const OVERRIDE_FUNDS_TO: 'DOMINO_TEST_ELYSIUM_FUNDS_TO'
export declare const MARK_PATH: string
export type SwitchPiece = 'profile' | 'record' | 'pin' | 'readV6' | 'plan'
export declare const PIECES: readonly SwitchPiece[]
export declare function squarePngSide(bytes: unknown): number
export declare function isEnabledElysium(profile: unknown): boolean
export declare function enabledProfileIn(dir: string): { file: string; text: string; profile: Record<string, unknown> } | null
export declare function recordsIn(repoRoot: string, slug?: string | null): string[]
/** The pinned record a live build carries: its pin and its exact text. */
export interface PinnedRecord extends RecordPin {
  readonly text: string
}
export declare function pinnedRecord(repoRoot: string, records: readonly string[], pin: unknown): { record: PinnedRecord } | { reason: string }
export declare function readV6Names(chainIds: unknown): boolean
export declare function planNames(chains: unknown): boolean
export declare function originPinned(chains: unknown): boolean
export declare function destinationPinned(destinations: unknown): string[] | null
export declare function bridgeNamed(profile: unknown): boolean
export declare const V4_ONLY_CONTRACTS: readonly string[]
export declare const CONTRACT_NAMES: Readonly<Record<string, string>>
export declare function profileRefusal(profile: unknown): string | null
export declare function recordRefusal(record: unknown, profile: Record<string, unknown>): string | null
export interface SwitchRow {
  testHooks: boolean
  deployable: boolean
  site: boolean
}
export declare function isTestBuild(row: SwitchRow): boolean
export interface ElysiumSwitch {
  live: boolean
  fundsFrom: boolean
  fundsTo: boolean
  destinations: string[] | null
  forced: boolean
  outDirSuffix: '' | '-elysium' | '-elysium-funds'
  profileFile: string | null
  profile: string | null
  deployment: PinnedRecord | null
  uniswap: { positionManager: string | null; permit2: string | null } | null
  missing: { piece: SwitchPiece; detail: string }[]
  stage: 'off' | 'prelaunch' | 'live'
  opening: ElysiumOpening | null
}
export declare function elysiumSwitch(options: {
  row: SwitchRow
  env?: Readonly<Record<string, string | undefined>>
  appRoot: string
  pin?: unknown
  readV6Chains?: unknown
  planChains?: unknown
  chains?: unknown
  destinations?: unknown
  opensOn?: unknown
}): ElysiumSwitch
export declare function switchDiagnostic(result: ElysiumSwitch): string | null
