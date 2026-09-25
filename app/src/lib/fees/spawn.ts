/**
 * The page's one fees store, and the one place the replay worker is created
 * (DESIGN-V2 §15.4): a classic same-origin worker that Vite bundles as its own
 * file from feesReplay.worker.ts (script-src 'self'; no blob, no module
 * worker). The store creates it on the first history run, not when this module
 * loads.
 *
 * No unit-tested module imports this file: `import.meta` does not compile
 * under the tests' CommonJS config. The store's logic is tested through
 * createFeesStore with a fake worker.
 */
import { chainState } from './client'
import { createFeesStore, type WorkerLike } from './store'
import { whenVisibleAfter } from '../read/screens/quietRead'

export const feesStore = createFeesStore({
  spawn: () => new Worker(new URL('./feesReplay.worker.ts', import.meta.url)) as unknown as WorkerLike,
  postState: (tokenIds) => chainState(tokenIds),
  later: whenVisibleAfter,
  timer: (ms, run) => {
    const id = setTimeout(run, ms)
    return () => clearTimeout(id)
  },
})
