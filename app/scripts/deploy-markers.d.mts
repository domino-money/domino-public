/** Types for deploy-markers.mjs, which vite.config.ts imports. */
export interface Forbidden {
  name: string
  pattern: RegExp
}
export declare const FORBIDDEN: ReadonlyArray<Forbidden>
export declare const TEXT_FILE: RegExp
/** Changed on purpose (data) 2026-10-02 (Domino V2 integration): the markers a published, never released site may not carry. */
export declare const PREVIEW_SITE_FORBIDDEN: ReadonlySet<string>
export interface ForbiddenHit {
  marker: string
  match: string
  at: number
  context: string
}
export declare function findForbidden(text: string, limit?: number): ForbiddenHit[]
export interface ModeRow {
  read: string
  pools: string
  deployable: boolean
  outDir: string
  lab: boolean
  [flag: string]: unknown
}
export declare function assertDeployable(mode: string, row: ModeRow): void
