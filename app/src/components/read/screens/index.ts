/**
 * The read screens chunk: what issues #3 and #13 add on screen (#2's lookup by
 * typed NFT ids was removed on 2026-09-24: Positions lists the wallet's own).
 * Loaded only through src/lib/read/screens/slots.tsx, which the default
 * build folds to nothing.
 */
export { ChainSelectionPanel } from './ChainSelectionPanel'
export { PoolFiguresDialog } from './PoolFiguresDialog'
