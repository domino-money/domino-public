import { useSyncExternalStore } from 'react'

/**
 * Changed on purpose 2026-10-03 (the owner: the site looks too big at 100%; at 80% it looks right): the site is drawn
 * in design pixels, 16 to the rem, and the root's font-size scales all of it (styles/tokens.css: 80 % of the browser's
 * text size from 1024 px wide, 90 % from 768 px, the browser's own on a phone). The stylesheets are written in rem
 * (scripts/rem-codemod.mjs); a length written in script follows the same scale in one of two ways:
 *
 *   - `rem(px)` where CSS takes the length (an inline style, an outer <svg>'s width and height): the browser scales it;
 *   - `useRootScale()` where the length is drawn in CSS pixels: a chart works in design pixels, sizes its SVG layers by
 *     the scale and draws through a viewBox in design pixels, and divides a pointer's position by the scale.
 *
 * Lengths inside an SVG drawing never need either: its viewBox already scales them with the box.
 */
export const DESIGN_PX_PER_REM = 16

/** The widths where the root's font-size steps (styles/tokens.css): one media query each, in CSS pixels; 0.8 also asks for a fine pointer. */
export const ROOT_SCALE_QUERIES = ['(min-width: 768px)', '(min-width: 1024px) and (pointer: fine)'] as const

/** A length in design pixels as rem, so the root's scale applies to it: `rem(24)` is `1.5rem`. */
export function rem(px: number): string {
  return `${Number((px / DESIGN_PX_PER_REM).toFixed(5))}rem`
}

const supported = () => typeof window !== 'undefined' && typeof document !== 'undefined' && typeof window.matchMedia === 'function'

let current: number | null = null
const listeners = new Set<() => void>()

/** CSS pixels per design pixel, as the root's font-size says now; 1 where there is no page (tests, a worker). */
function measure(): number {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return 1
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(size) && size > 0 ? size / DESIGN_PX_PER_REM : 1
}

let watching = false
/** Re-reads the scale whenever a breakpoint is crossed, and tells every chart that drew with the old one. */
function watch() {
  if (watching || !supported()) return
  watching = true
  const update = () => {
    const next = measure()
    if (next === current) return
    current = next
    for (const listener of listeners) listener()
  }
  for (const query of ROOT_SCALE_QUERIES) window.matchMedia(query).addEventListener('change', update)
  // The stylesheet blocks the app's script, so the first read already sees it; the page's load is a second look.
  if (document.readyState !== 'complete') window.addEventListener('load', update, { once: true })
}

/** CSS pixels per design pixel now: 0.8 on a laptop, 0.9 on a tablet, 1 on a phone (with the browser's default text size). */
export function rootScale(): number {
  if (current === null) current = measure()
  watch()
  return current
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  watch()
  return () => {
    listeners.delete(listener)
  }
}

/** `rootScale()`, kept in step with the viewport: a component that draws in CSS pixels re-renders when it changes. */
export function useRootScale(): number {
  return useSyncExternalStore(subscribe, rootScale, () => 1)
}
