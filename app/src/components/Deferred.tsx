import { createElement, useEffect, useState, type ComponentType, type ReactNode } from 'react'

/**
 * A lazily loaded component, drawn as soon as its chunk is in (2026-09-28, speed wave B, item 24). React 19 holds back the
 * content of a Suspense boundary until 300 ms after its fallback showed (its fallback throttle), however soon the chunk
 * arrives, and whatever that content reads waits with it: Positions' list and a position's page started their chain reads
 * 0.2 to 0.27 s late, and the header's wallet, which says who is connected, as late. This one draws `fallback` until the
 * chunk is in and then the component, through a state change rather than a suspended render, which nothing throttles.
 * A chunk that fails to load throws where the component would be, to the nearest error boundary (or is its loader's own
 * stand-in, as `lazy`'s callers catch it).
 */
export function deferred<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  let loaded: ComponentType<P> | null = null
  let failed: { error: unknown } | null = null
  let loading: Promise<void> | null = null
  const start = () =>
    (loading ??= load().then(
      (module) => void (loaded = module.default),
      (error: unknown) => void (failed = { error }),
    ))
  return function Deferred({ fallback = null, ...props }: P & { fallback?: ReactNode }) {
    const [, settled] = useState(false)
    // Asked as the component first draws (the chunk once), and drawn again once it is in, also when it came in between a
    // draw of the fallback and this effect: the effect goes by what that draw saw, not by the module now (a chunk in by
    // then would have left the fallback on screen for good).
    const waiting = !loaded && !failed
    if (waiting) void start()
    useEffect(() => {
      if (!waiting) return
      let shown = true
      void start().then(() => shown && settled(true))
      return () => {
        shown = false
      }
    }, [waiting])
    if (failed) throw failed.error
    return loaded ? createElement(loaded, props as P) : fallback
  }
}
