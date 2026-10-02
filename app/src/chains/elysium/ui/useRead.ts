/**
 * One read for a screen of the second chain (2026-10-01, the chain2 workstream): asked when the screen shows it, asked
 * again by itself every `everyMs` while the tab is visible, and, after a failure, asked again by itself (5, 10, 20, then
 * every 60 s): the owner's rule, no Retry button for a transient state. What was read last stays on screen while the
 * next read is on its way; a read nobody wants any more is aborted.
 */
import { useEffect, useRef, useState } from 'react'

export type ReadState<T> =
  | { readonly phase: 'loading'; readonly value: null; readonly problem: null }
  | { readonly phase: 'ready'; readonly value: T; readonly problem: null }
  /** A read failed; `value` is the last good one, if any, and the next try is on its way. */
  | { readonly phase: 'waiting'; readonly value: T | null; readonly problem: string }
  /** What was asked for is not there, for good (goneError): nothing is asked again, and the screen says so. */
  | { readonly phase: 'gone'; readonly value: null; readonly problem: string }

const RETRY_MS = [5_000, 10_000, 20_000, 60_000]
const LOADING = { phase: 'loading', value: null, problem: null } as const

const problemOf = (error: unknown): string => (error instanceof Error ? error.message : 'unavailable')

/**
 * A failure waiting never changes (fix round 1, 2026-10-01): a well-formed link that names no pool or position of this
 * deployment (the adapter's `*_not_in_deployment`), or an address or id the chain answers as none (the reads' own
 * `invalid_pool`, `invalid_position`, `invalid_position_pool`). It used to be asked again forever behind a skeleton.
 */
export const goneError = (error: unknown): boolean => error instanceof Error && /^(?:pool|position)_not_in_deployment$|^invalid_(?:pool|position|position_pool)$/.test(error.message)

/**
 * `read` under `key`: a new key starts again from loading. `everyMs` 0 reads once (and again only after a failure).
 * `enabled` false holds the read (a screen still missing what it needs, such as a wallet).
 */
export function useRead<T>(key: string, read: (signal: AbortSignal) => Promise<T>, everyMs = 0, enabled = true): ReadState<T> {
  const [state, setState] = useState<{ key: string; read: ReadState<T> }>({ key, read: LOADING })
  // The caller's read is an inline function: the latest one is used, and the key says when it means something else.
  const latest = useRef(read)
  useEffect(() => {
    latest.current = read
  })

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let shown: (() => void) | null = null
    const run = () => {
      latest.current(controller.signal).then(
        (value) => {
          if (controller.signal.aborted) return
          failures = 0
          setState({ key, read: { phase: 'ready', value, problem: null } })
          if (everyMs > 0) timer = setTimeout(again, everyMs)
        },
        (error: unknown) => {
          if (controller.signal.aborted) return
          if (goneError(error)) {
            setState({ key, read: { phase: 'gone', value: null, problem: problemOf(error) } })
            return
          }
          setState((old) => ({ key, read: { phase: 'waiting', value: old.key === key ? old.read.value : null, problem: problemOf(error) } }))
          timer = setTimeout(again, RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)])
        },
      )
    }
    // A hidden tab is not read: the next read waits until it is shown again.
    const again = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        shown = () => {
          if (document.hidden) return
          document.removeEventListener('visibilitychange', shown as () => void)
          shown = null
          if (!controller.signal.aborted) run()
        }
        document.addEventListener('visibilitychange', shown)
        return
      }
      run()
    }
    run()
    return () => {
      controller.abort()
      if (timer !== null) clearTimeout(timer)
      if (shown) document.removeEventListener('visibilitychange', shown)
    }
  }, [key, everyMs, enabled])

  if (!enabled || state.key !== key) return LOADING
  return state.read
}
