/**
 * A markets provider whose implementation arrives in a separate chunk, for
 * the fixture and bridge-test builds (buildMode.ts). It renders a loading
 * state until the chunk is there.
 *
 * It holds the inner provider's subscription only while someone is looking.
 * The last viewer to leave releases it, so the inner provider sees its own
 * last viewer go and cancels the read it has running. A viewer who comes back
 * subscribes again and asks it to load, and one who leaves before the chunk
 * arrives starts nothing at all.
 */
import type { MarketsProvider, MarketsState } from './marketsProvider'

const LOADING: MarketsState = { phase: 'loading', previous: null, retrying: null }

export function deferredMarkets(kind: 'fixture' | 'bridge', load: () => Promise<MarketsProvider>): MarketsProvider {
  let inner: MarketsProvider | null = null
  let loading: Promise<void> | null = null
  /** The inner subscription's disposer, held while this provider has viewers. */
  let release: (() => void) | null = null
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const attach = () => {
    if (inner && !release && listeners.size > 0) release = inner.subscribe(notify)
  }
  const connect = () => {
    loading ??= load().then((provider) => {
      inner = provider
      // Everyone left while the chunk was loading: nothing starts until someone is back.
      if (listeners.size === 0) return
      attach()
      provider.ensure()
      notify()
    })
  }
  return {
    kind,
    getSnapshot: () => inner?.getSnapshot() ?? LOADING,
    subscribe(listener) {
      listeners.add(listener)
      attach()
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0 || !release) return
        const done = release
        release = null
        done()
      }
    },
    ensure() {
      if (inner) inner.ensure()
      else connect()
    },
    refresh() {
      if (inner) inner.refresh()
      else connect()
    },
    // Held by Home and Markets. Before the chunk arrives there is nothing to recover, so nothing to release.
    recoverQuietly() {
      return inner?.recoverQuietly?.() ?? (() => undefined)
    },
  }
}
