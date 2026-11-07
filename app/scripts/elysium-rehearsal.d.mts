/** Types for elysium-rehearsal.mjs, which vite.config.ts imports. */
export interface SchemaData {
  SCHEMAS: Record<string, unknown>
  ERRORS: Record<string, unknown>
  CONSTANTS: Record<string, unknown>
}
export declare function rehearseReadV6(data: SchemaData, profile: Record<string, unknown>): SchemaData
export declare function rehearsePlan(data: SchemaData, profile: Record<string, unknown>): SchemaData
export declare function moduleSource(data: SchemaData): string
