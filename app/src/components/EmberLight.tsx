import { useEffect, useRef } from 'react'
import { rootScale } from '../lib/rootScale'

/** What the light reaches beyond its own layer: lit card edges, a screen's own ember consumers, the page title's sheen and
 * the footer's hairline and wordmark. Looked up again on a route change and at most every 500 ms while the pointer moves. */
const REACHED = '.dm-lit, [data-ember], h1.dm-display-h1, h1.dm-display-title, .dm-footer'

const px = (value: number) => `${Math.round(value * 10) / 10}px`

/** Where a screen parks the light at rest (viewport px), from the first rendered [data-ember-rest]; null without one. */
function restPoint(scale: number): [number, number] | null {
  for (const element of document.querySelectorAll<HTMLElement>('[data-ember-rest]')) {
    if (element.getClientRects().length === 0) continue
    const box = element.getBoundingClientRect()
    const at = (element.dataset.emberRest ?? '').split(',').map(Number)
    if (at.length === 2 && at.every(Number.isFinite)) return [box.left + box.width / 2 + at[0] * scale, box.top + box.height / 2 + at[1] * scale]
    if (box.width <= 0) continue
    const dx = Number(element.dataset.emberRestX ?? 6)
    const dy = Number(element.dataset.emberRestY ?? -34)
    return [box.left + (Number.isFinite(dx) ? dx : 6) * scale, box.top + (Number.isFinite(dy) ? dy : -34) * scale]
  }
  return null
}

/**
 * The ember (V4 §4.2): a warm light under the whole page that trails the pointer. Decorative only: it takes no pointer, no
 * focus and no room, says nothing to assistive technology, and never re-renders. One passive pointermove listener feeds
 * one animation frame at a time, which writes custom properties through the CSSOM (CSP-safe): --lx/--ly (layer px) on the
 * layer, and --ex/--ey (viewport px) with --ember-on on the few elements the light reaches; never on html, body or main.
 * Without the pointer (it left the window, or a touch screen) the light rests top right, or where a screen puts
 * [data-ember-rest]: just above its top left corner (6 right, 34 up, in design px), or at the offsets it gives,
 * data-ember-rest-x / -y from that corner, or a value "x,y" from its centre. The rest is looked up again whenever the
 * screen's elements change (a lazily loaded screen mounts after the layer), and the page's first rest is taken at once,
 * without the glide, as the prototype's light starts where its page puts it. Data that refreshes never moves it.
 * Changed on purpose 2026-10-30 (QA round 2, N90): under reduced motion (or html.dm-still) the light no longer follows the
 * pointer, which made the glow jump on every frame without its glide; it rests where the screen puts it, as Home's own
 * lights do. Everyone else sees no change.
 */
export function EmberLight() {
  const layer = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const light = layer.current
    if (!light || typeof window.matchMedia !== 'function' || typeof requestAnimationFrame !== 'function') return
    const touch = window.matchMedia('(hover: none)').matches
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const still = () => reduced.matches || document.documentElement.classList.contains('dm-still')
    let on = false
    let x = 0
    let y = 0
    let frame = 0
    let reached: HTMLElement[] = []
    let foundAt = -Infinity
    // The page's first rest is placed at once; later ones (the pointer leaving, a route change) glide.
    let firstFrame = true
    let firstRest = true
    const written = new WeakMap<HTMLElement, string>()

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
      // The very first frame, and the first rest a screen gives on the page's first load, are placed without the glide.
      let jump = firstFrame
      firstFrame = false
      if (!on) {
        const scale = rootScale()
        const rest = restPoint(scale)
        if (rest) {
          lx = rest[0]
          ly = rest[1]
          jump ||= firstRest
          firstRest = false
        } else {
          lx = box.left + box.width * 0.72
          ly = box.top + 60 * scale
        }
      }
      if (jump) light.setAttribute('data-jump', '')
      light.style.setProperty('--lx', px(lx - box.left))
      light.style.setProperty('--ly', px(ly - box.top))
      if (jump) {
        void light.offsetWidth
        light.removeAttribute('data-jump')
      }
      for (const element of reached) {
        // The footer's hairline lights fully while the pointer is within 260 design px above or below it (V4 .ft-rule).
        const near = element.classList.contains('dm-footer') ? (on && Math.abs(ly - element.getBoundingClientRect().top) < 260 * rootScale() ? '1' : '0') : ''
        // A card's rim lights only while the pointer is near that card: 180 design px around it, 120 below (V4 cardLight).
        let lit = on
        if (on && element.classList.contains('dm-lit')) {
          const r = element.getBoundingClientRect(), k = rootScale()
          lit = lx > r.left - 180 * k && lx < r.right + 180 * k && ly > r.top - 180 * k && ly < r.bottom + 120 * k
        }
        const key = `${px(lx)} ${px(ly)} ${lit ? 1 : 0} ${near}`
        if (written.get(element) === key) continue
        written.set(element, key)
        element.style.setProperty('--ex', px(lx))
        element.style.setProperty('--ey', px(ly))
        element.style.setProperty('--ember-on', lit ? '1' : '0')
        if (near) element.style.setProperty('--ember-near', near)
      }
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw)
    }
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || still()) return
      on = true
      firstRest = false
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
    // Once a screen's load moment has played (1.5 s), its rest is measured again where it settled.
    let settle = window.setTimeout(schedule, 1600)
    const routed = () => {
      foundAt = -Infinity
      firstRest = false
      schedule()
      window.clearTimeout(settle)
      settle = window.setTimeout(schedule, 1600)
    }

    if (!touch) {
      window.addEventListener('pointermove', move, { passive: true })
      document.addEventListener('pointerout', out, { passive: true })
    }
    // Reduced motion turned on while the page is open: the light goes back to its rest at once.
    const calm = () => {
      if (!still()) return
      on = false
      schedule()
    }
    reduced.addEventListener?.('change', calm)
    window.addEventListener('hashchange', routed)
    window.addEventListener('resize', schedule, { passive: true })
    // The glow stays under a still pointer while the page scrolls under it.
    window.addEventListener('scroll', schedule, { passive: true })
    // At rest, a screen that mounts or grows moves the rest point: look again (one frame at a time). Only the tree's
    // shape is watched, never the custom properties written here.
    const grown = typeof MutationObserver === 'function' ? new MutationObserver(() => { if (!on) schedule() }) : null
    grown?.observe(light.parentElement ?? document.body, { childList: true, subtree: true })
    document.fonts?.ready.then(schedule, () => {})
    schedule()
    return () => {
      grown?.disconnect()
      window.clearTimeout(settle)
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      document.removeEventListener('pointerout', out)
      reduced.removeEventListener?.('change', calm)
      window.removeEventListener('hashchange', routed)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule)
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
