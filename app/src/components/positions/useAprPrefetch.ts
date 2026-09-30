import { useEffect, useRef, useState } from 'react'
import { feesStore } from '../../lib/fees/spawn'
import { historyIsCurrent } from '../../lib/fees/freshness'
import { createAprPrefetchQueue, type AprPrefetchQueue } from './aprPrefetchQueue'

// Existing browser suites isolate their reads. Dedicated prefetch scenarios opt in before loading the page.
const PREFETCH = !__DOMINO_TEST_HOOKS__ || (window as { __dominoAprPrefetch?: boolean }).__dominoAprPrefetch === true

/** No layout or loading UI: the rows keep their dash until the existing verified/qualified history supplies an APR. */
export function useAprPrefetch(ids: readonly string[], enabled: boolean) {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const queueRef = useRef<AprPrefetchQueue | null>(null)
  const key = ids.join(',')

  useEffect(() => {
    if (!PREFETCH) return
    const queue = createAprPrefetchQueue({
      ready(id) {
        const view = feesStore.view(id)
        return historyIsCurrent(view)
      },
      start(id, done) {
        let began = false
        const inspect = (end?: 'failed' | 'yielded') => {
          if (end) { done(end); return }
          const view = feesStore.view(id)
          if (historyIsCurrent(view)) done('ready')
          else if (view.phase === 'unavailable' || view.phase === 'unclaimed-only') done('failed')
          // A store preemption resets an unfinished view to idle. Never re-ask behind the opened detail.
          else if (view.phase === 'idle' && began) done('yielded')
          else if (view.phase === 'loading') began = true
        }
        const cancel = feesStore.prefetchHistory(id, inspect, { revalidate: true })
        if (cancel) inspect()
        return cancel
      },
      later(ms, run) {
        const timer = setTimeout(run, ms)
        return () => clearTimeout(timer)
      },
    })
    queueRef.current = queue
    return () => {
      queue.dispose()
      queueRef.current = null
    }
  }, [])

  useEffect(() => {
    const queue = queueRef.current
    if (!queue) return
    queue.update([], false)
    if (!node || !enabled || !key || typeof IntersectionObserver === 'undefined') return
    const eligible = key.split(',')
    const rows = [...node.querySelectorAll<HTMLElement>('[data-position-row]')].filter((row) => eligible.includes(row.dataset.positionRow!))
    const visible = new Set<Element>()
    const update = () => {
      // The list is one row per line; document order is visual order, without repeated synchronous layout reads.
      const ordered = rows.filter((row) => visible.has(row)).map((row) => row.dataset.positionRow!)
      queue.update(ordered, !document.hidden && navigator.onLine)
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target)
        else visible.delete(entry.target)
      }
      update()
    })
    rows.forEach((row) => observer.observe(row))
    // Capture observes document visibility and row/badge clicks before the router handles them. One listener lifetime
    // covers all five events; pausing or replacing the list removes the same exact listeners.
    const events = ['click', 'hashchange', 'visibilitychange', 'online', 'offline']
    const react = (event: Event) => {
      if (event.type === 'hashchange') queue.dispose()
      else if (event.type === 'click') {
        const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
        if (anchor && anchor.hash !== location.hash && anchor.origin === location.origin) queue.dispose()
      } else update()
    }
    for (const event of events) window.addEventListener(event, react, true)
    return () => {
      observer.disconnect()
      for (const event of events) window.removeEventListener(event, react, true)
      queue.update([], false)
    }
  }, [node, key, enabled])

  return setNode
}
