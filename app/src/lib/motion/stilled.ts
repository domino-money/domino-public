import { useSyncExternalStore } from 'react'

/**
 * Whether motion is stilled (DESIGN-V2 §5.4): the reader asked for reduced
 * motion, or something put `dm-still` on <html> (the footer's Pause motion did
 * until 2026-10-03, when the owner had it removed; the class still stills
 * everything). CSS motion is stilled by tokens.css already; JS that moves
 * anything asks here first.
 * Safe to import in Node: nothing is read until a function is called.
 */

const REDUCED = '(prefers-reduced-motion: reduce)'

export function stilled(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia(REDUCED).matches
  return reduced || document.documentElement.classList.contains('dm-still')
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined
  const query = typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED) : null
  query?.addEventListener('change', onChange)
  const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(onChange)
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => {
    query?.removeEventListener('change', onChange)
    observer?.disconnect()
  }
}

const serverSnapshot = () => false

/** `stilled()` as a hook: re-renders when reduced motion or Pause motion changes. */
export function useStilled(): boolean {
  return useSyncExternalStore(subscribe, stilled, serverSnapshot)
}
