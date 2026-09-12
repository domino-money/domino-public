/** Types for deploy-markers.mjs, which vite.config.ts imports. */
export interface Forbidden {
  name: string
  pattern: RegExp
}
export declare const FORBIDDEN: ReadonlyArray<Forbidden>
export declare const TEXT_FILE: RegExp
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
