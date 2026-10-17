import { useEffect, useRef } from 'react'
import { rootScale } from '../lib/rootScale'

/** What the light reaches beyond its own layer: lit card edges, a screen's own ember consumers, the page title's sheen and
 * the footer's hairline and wordmark. Looked up again on a route change and at most every 500 ms while the pointer moves. */
const REACHED = '.dm-lit, [data-ember], h1.dm-display-h1, h1.dm-display-title, .dm-footer'

const px = (value: number) => `${Math.round(value * 10) / 10}px`

/**
 * The ember (V4 §4.2): a warm light under the whole page that trails the pointer. Decorative only: it takes no pointer, no
 * focus and no room, says nothing to assistive technology, and never re-renders. One passive pointermove listener feeds
 * one animation frame at a time, which writes custom properties through the CSSOM (CSP-safe): --lx/--ly (layer px) on the
 * layer, and --ex/--ey (viewport px) with --ember-on on the few elements the light reaches; never on html, body or main.
 * Without the pointer (it left the window, or a touch screen) the light rests top right, or where a screen puts
 * [data-ember-rest] (just above its top left corner). Reduced motion keeps it, without the glide (tokens.css). Data that
 * refreshes never moves it.
 */
export function EmberLight() {
  const layer = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const light = layer.current
    if (!light || typeof window.matchMedia !== 'function' || typeof requestAnimationFrame !== 'function') return
    const touch = window.matchMedia('(hover: none)').matches
    let on = false
    let x = 0
    let y = 0
    let frame = 0
    let reached: HTMLElement[] = []
    let foundAt = -Infinity

    const draw = () => {
      frame = 0
      if (document.visibilityState === 'hidden') return
      const now = performance.now()
      if (now - foundAt > 500) {
        reached = Array.from(document.querySelectorAll<HTMLElement>(REACHED))
        foundAt = now
      }
      const box = light.getBoundingClientRect()
      let lx = x
      let ly = y
      if (!on) {
        const scale = rootScale()
        const rest = document.querySelector('[data-ember-rest]')?.getBoundingClientRect()
        if (rest && rest.width > 0) {
          lx = rest.left + 6 * scale
          ly = rest.top - 34 * scale
        } else {
          lx = box.left + box.width * 0.72
          ly = box.top + 60 * scale
        }
      }
      light.style.setProperty('--lx', px(lx - box.left))
      light.style.setProperty('--ly', px(ly - box.top))
      for (const element of reached) {
        element.style.setProperty('--ex', px(lx))
        element.style.setProperty('--ey', px(ly))
        element.style.setProperty('--ember-on', on ? '1' : '0')
      }
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw)
    }
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      on = true
      x = event.clientX
      y = event.clientY
      schedule()
    }
    // The pointer left the window: nothing is under it any more.
    const out = (event: PointerEvent) => {
      if (event.relatedTarget !== null || event.pointerType === 'touch') return
      on = false
      schedule()
    }
    const routed = () => {
      foundAt = -Infinity
      schedule()
    }

    if (!touch) {
      window.addEventListener('pointermove', move, { passive: true })
      document.addEventListener('pointerout', out, { passive: true })
    }
    window.addEventListener('hashchange', routed)
    window.addEventListener('resize', schedule, { passive: true })
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      document.removeEventListener('pointerout', out)
      window.removeEventListener('hashchange', routed)
      window.removeEventListener('resize', schedule)
    }
  }, [])

  return (
    <div ref={layer} className="dm-ember dm-k-glow" aria-hidden="true">
      <div className="dm-ember-glow" />
      <div className="dm-ember-dots" />
      <div className="dm-ember-grain" />
    </div>
  )
}
