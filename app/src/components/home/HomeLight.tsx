import { useEffect } from 'react'
import { rootScale } from '../../lib/rootScale'
import { stilled } from '../../lib/motion/stilled'

/*
 * Home's own answer to the light (V4 §4.2, §4.7): the hero tile turns a little toward the pointer, its two glares and
 * its floor shadow follow, and the warm copies over the serif titles are revealed where the light is. Decoration only.
 *
 * Nothing here is React state: one passive pointermove on the window, at most one write pass per frame, straight onto
 * the decorative nodes' own inline styles (never onto <main>, whose custom properties every Home node would inherit).
 * Off for touch, reduced motion, `dm-still` and hidden tabs (no pointer moves there); the CSS rest angle stays.
 * Lengths follow the prototype in design px, drawn at the root's scale (lib/rootScale.ts).
 */

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
const FINE = '(hover: hover) and (pointer: fine)'

interface Nodes {
  tile: HTMLElement | null
  turn: HTMLElement | null
  glare: HTMLElement | null
  glare2: HTMLElement | null
  shadow: HTMLElement | null
  sheens: HTMLElement[]
}

function find(): Nodes {
  const home = document.querySelector('main.dm-home')
  const one = (selector: string) => home?.querySelector<HTMLElement>(selector) ?? null
  return {
    tile: one('[data-home-tile]'),
    turn: one('.dm-tile-3d'),
    glare: one('.dm-tile-glare'),
    glare2: one('.dm-tile-glare2'),
    shadow: one('.dm-tile-shadow'),
    sheens: home ? Array.from(home.querySelectorAll<HTMLElement>('[data-home-sheen]')) : [],
  }
}

function place(element: HTMLElement, x: number, y: number) {
  const value = `${Math.round(x * 10) / 10}px ${Math.round(y * 10) / 10}px`
  element.style.setProperty('mask-position', value)
  element.style.setProperty('-webkit-mask-position', value)
}

/** Writes one frame of light at viewport point (x, y); `on` is false while the light rests by the tile. */
function paint(nodes: Nodes, x: number, y: number, on: boolean) {
  const k = rootScale()
  const tile = nodes.tile?.getBoundingClientRect()
  if (tile && tile.width > 0) {
    const cx = tile.left + tile.width / 2
    const cy = tile.top + tile.height / 2
    const dxn = clamp((x - cx) / k / 620, -1, 1)
    const dyn = clamp((y - cy) / k / 480, -1, 1)
    nodes.turn?.style.setProperty('transform', `rotateX(${(6 - dyn * 9).toFixed(1)}deg) rotateY(${(-18 + dxn * 13).toFixed(1)}deg) rotateZ(-7deg)`)
    nodes.glare?.style.setProperty('background-position', `${(x - tile.left - 210 * k).toFixed(1)}px ${(y - tile.top - 210 * k).toFixed(1)}px`)
    nodes.glare2?.style.setProperty('background-position', `${(x - tile.left - 120 * k).toFixed(1)}px ${(y - tile.top - 120 * k).toFixed(1)}px`)
    const shift = clamp((-(x - cx) / k) * 0.07, -38, 38) * k
    nodes.shadow?.style.setProperty('transform', `translateX(${shift.toFixed(1)}px) scaleX(${(1 + Math.abs(dxn) * 0.18).toFixed(3)})`)
  }
  for (const sheen of nodes.sheens) {
    const box = sheen.getBoundingClientRect()
    // The hero's copy is lit at rest too (the stop of "fees." catches the light); a chapter's only under the pointer.
    const half = (sheen.dataset.homeSheen === 'hero' ? 300 : 280) * k
    if (on || sheen.dataset.homeSheen === 'hero') place(sheen, x - box.left - half, y - box.top - half)
    else place(sheen, -9999, -9999)
  }
}

function clear(nodes: Nodes) {
  for (const node of [nodes.turn, nodes.glare, nodes.glare2, nodes.shadow]) {
    node?.style.removeProperty('transform')
    node?.style.removeProperty('background-position')
  }
  for (const sheen of nodes.sheens) {
    sheen.style.removeProperty('mask-position')
    sheen.style.removeProperty('-webkit-mask-position')
  }
}

/** Home's light: mount once on the landing. */
export function useHomeLight() {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const fine = window.matchMedia(FINE)
    let nodes = find()
    let frame = 0
    let next: { x: number; y: number } | null = null
    // Whether anything was written: with nothing to undo, a stilled or touch page is never touched at all.
    let painted = false
    const live = () => fine.matches && !stilled()
    const unpaint = () => {
      if (painted) clear(nodes)
      painted = false
    }
    const light = (x: number, y: number, on: boolean) => {
      paint(nodes, x, y, on)
      painted = true
    }
    // At rest the light parks just above-left of the tile (V4 §4.2: restX = tile left + 6, restY = tile top - 34).
    const rest = () => {
      if (!live()) return unpaint()
      const tile = nodes.tile?.getBoundingClientRect()
      const k = rootScale()
      if (tile && tile.width > 0) light(tile.left + 6 * k, tile.top - 34 * k, false)
    }
    const draw = () => {
      frame = 0
      if (!live()) return unpaint()
      if (next) light(next.x, next.y, true)
    }
    const move = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
      next = { x: event.clientX, y: event.clientY }
      if (!frame) frame = requestAnimationFrame(draw)
    }
    const leave = (event: PointerEvent) => {
      if (event.relatedTarget) return
      next = null
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      rest()
    }
    // A still pointer over a page that scrolls under it lights what is under it now.
    const scroll = () => {
      if (next && !frame) frame = requestAnimationFrame(draw)
    }
    const refresh = () => {
      if (!live()) return unpaint()
      nodes = find()
      if (next) light(next.x, next.y, true)
      else rest()
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerout', leave, { passive: true })
    // Measured once the window has settled, never inside a resize (the root's scale changes with the window).
    let resized: ReturnType<typeof setTimeout> | undefined
    const resize = () => {
      if (!painted && !live()) return
      clearTimeout(resized)
      resized = setTimeout(refresh, 200)
    }
    window.addEventListener('resize', resize, { passive: true })
    window.addEventListener('scroll', scroll, { passive: true })
    fine.addEventListener('change', refresh)
    // The page's decorative nodes are in place once it has painted.
    const first = requestAnimationFrame(refresh)
    return () => {
      cancelAnimationFrame(first)
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerout', leave)
      clearTimeout(resized)
      window.removeEventListener('resize', resize)
      window.removeEventListener('scroll', scroll)
      fine.removeEventListener('change', refresh)
    }
  }, [])
}
