/**
 * The page's one featured pools list (featuredList.ts): what Home's ticker and
 * table, Markets' cards, table and filter, a pool's page and New position's
 * link all name, from one store.
 *
 * Only the deployable builds read it (`__DOMINO_POOL_SET__ === 'selected'`):
 * the fixture and test builds, whose rows are the package's fixture pool, get
 * the embedded list, settled, and never ask. The deployable build reads it
 * through the app's one scheduled source (screens/appSourceBridge.ts), which
 * sends the list's route to read-v5 as one POST.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { ReadV5ContractVersion } from 'api-contracts/read-v5/runtime.mjs'
import { answerOf, bundledStore, createFeaturedStore, readFeaturedList, type FeaturedSnapshot, type FeaturedStore } from './featuredList'
import type { READ_V5_PIN } from './pin'
import { appBridgeSource } from './screens/appSourceBridge'
import { followFeaturedList } from './screens/featuredPools'

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
// Fails typecheck as soon as the pinned version and the runtime's types disagree.
void (true satisfies Same<ReadV5ContractVersion, (typeof READ_V5_PIN)['version']>)

let store: FeaturedStore | null = null

/** The page's one store, made on first use. */
export function featuredStore(): FeaturedStore {
  if (store) return store
  if (__DOMINO_POOL_SET__ !== 'selected') return (store = bundledStore())
  const made = createFeaturedStore({ read: (signal) => readFeaturedList(appBridgeSource(), { signal }).then(answerOf) })
  // New position names the pools of the list on screen (screens/featuredPools.ts).
  followFeaturedList(() => made.getSnapshot().entries)
  return (store = made)
}

/**
 * The list on screen, for a component that shows it. Mounting one asks the
 * list (once a page) and gives a list waiting for its turn the chance to take
 * it (FeaturedStore.remount).
 */
export function useFeatured(): FeaturedSnapshot {
  const featured = featuredStore()
  const snapshot = useSyncExternalStore(featured.subscribe, featured.getSnapshot)
  useEffect(() => {
    void featured.ensure()
    featured.remount()
  }, [featured])
  return snapshot
}
