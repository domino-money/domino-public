/**
 * Review's final control in builds with the wallet, in a chunk of its own
 * (StageReview.tsx loads it lazily), so the entry never carries the wallet or
 * the setup client. The chunk keeps its name for the guards that measure it.
 */
export { default as CreatePosition } from './CreatePosition'
