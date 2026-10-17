import { useEffect } from 'react'
import { rootScale } from '../../lib/rootScale'
import { stilled } from '../../lib/motion/stilled'

/*
 * The stage tile's answer to the light (V4, the owner's approved site/automate.html; components/home/HomeLight.tsx is
 * Home's): the tile turns a little toward the pointer, its two glares and its floor shadow follow. Decoration only.
 *
 * Nothing here is React state: one passive pointermove on the window, at most one write pass per frame, straight onto the
 * tile's own nodes. Off for touch, reduced motion, `dm-still` and hidden tabs (no pointer moves there); the CSS rest
 * angle stays. The tile is drawn at half size inside a stage that is itself drawn at 1, .8 or .6, so the glares move in
 * the face's own, unscaled pixels. Lengths follow the prototype in design px, drawn at the root's scale.
 */

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
const FINE = '(hover: hover) and (pointer: fine)'

interface Nodes {
  box: HTMLElement | null
  tile: HTMLElement | null
  turn: HTMLElement | null
  glare: HTMLElement | null
  glare2: HTMLElement | null
  shadow: HTMLElement | null
}

function find(root: string): Nodes {
  const scope = document.querySelector(root)
  const one = (selector: string) => scope?.querySelector<HTMLElement>(`.dm-automate-stage ${selector}`) ?? null
  // The tile is measured by its place (.tpos: the same box as the half-size tile, never moved by the tile's own entrance).
  return { box: one('.sbox'), tile: one('.tpos'), turn: one('.dm-at-3d'), glare: one('.dm-at-glare'), glare2: one('.dm-at-glare2'), shadow: one('.tsh') }
}

/** One frame of light at viewport point (x, y). */
function paint(nodes: Nodes, x: number, y: number) {
  const tile = nodes.tile?.getBoundingClientRect()
  if (!tile || tile.width <= 0) return false
  const k = rootScale()
  const box = nodes.box
  const stage = box && box.offsetWidth > 0 ? box.getBoundingClientRect().width / box.offsetWidth : 1
  const half = 0.5 * stage
  const cx = tile.left + tile.width / 2
  const cy = tile.top + tile.height / 2
  const dxn = clamp((x - cx) / k / 620, -1, 1)
  const dyn = clamp((y - cy) / k / 480, -1, 1)
  nodes.turn?.style.setProperty('transform', `rotateX(${(6 - dyn * 9).toFixed(1)}deg) rotateY(${(-18 + dxn * 13).toFixed(1)}deg) rotateZ(-7deg)`)
  nodes.glare?.style.setProperty('background-position', `${((x - tile.left) / half - 210 * k).toFixed(1)}px ${((y - tile.top) / half - 210 * k).toFixed(1)}px`)
  nodes.glare2?.style.setProperty('background-position', `${((x - tile.left) / half - 120 * k).toFixed(1)}px ${((y - tile.top) / half - 120 * k).toFixed(1)}px`)
  const shift = clamp((-(x - cx) / k) * 0.035, -19, 19) * k
  nodes.shadow?.style.setProperty('transform', `translateX(${shift.toFixed(1)}px) scaleX(${(1 + Math.abs(dxn) * 0.18).toFixed(3)})`)
  return true
}

function clear(nodes: Nodes) {
  for (const node of [nodes.turn, nodes.glare, nodes.glare2, nodes.shadow]) {
    node?.style.removeProperty('transform')
    node?.style.removeProperty('background-position')
  }
}

/** The stage tile's light, for the stage inside `root` (Automate's main, or Set up automation's done card). */
export function useAutomateLight(root: string, on = true) {
  useEffect(() => {
    if (!on || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const fine = window.matchMedia(FINE)
    let nodes = find(root)
    let frame = 0
    let next: { x: number; y: number } | null = null
    let painted = false
    const live = () => fine.matches && !stilled()
    const unpaint = () => {
      if (painted) clear(nodes)
      painted = false
    }
    const light = (x: number, y: number) => {
      if (!nodes.tile?.isConnected) nodes = find(root)
      if (paint(nodes, x, y)) painted = true
    }
    // At rest the light parks just above-left of the tile (restX = tile left + 6, restY = tile top - 34).
    const rest = () => {
      if (!live()) return unpaint()
      if (!nodes.tile?.isConnected) nodes = find(root)
      const tile = nodes.tile?.getBoundingClientRect()
      const k = rootScale()
      if (tile && tile.width > 0) light(tile.left + 6 * k, tile.top - 34 * k)
    }
    const draw = () => {
      frame = 0
      if (!live()) return unpaint()
      if (next) light(next.x, next.y)
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
    const scroll = () => {
      if (next && !frame) frame = requestAnimationFrame(draw)
    }
    const refresh = () => {
      if (!live()) return unpaint()
      nodes = find(root)
      if (next) light(next.x, next.y)
      else rest()
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerout', leave, { passive: true })
    let resized: ReturnType<typeof setTimeout> | undefined
    const resize = () => {
      if (!painted && !live()) return
      clearTimeout(resized)
      resized = setTimeout(refresh, 200)
    }
    window.addEventListener('resize', resize, { passive: true })
    window.addEventListener('scroll', scroll, { passive: true })
    fine.addEventListener('change', refresh)
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
  }, [root, on])
}

/**
 * The ember rests just above the stage tile ([data-ember-rest] on the tile's place), but EmberLight looks for that
 * place only on its own draws (a pointer move, a route change, a resize), which can come before a lazily loaded screen
 * has mounted its stage. Once the stage is in the page, one resize notice lets the light find its resting place.
 */
export function useEmberRest(on = true) {
  useEffect(() => {
    if (!on || typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') return
    const frame = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    return () => cancelAnimationFrame(frame)
  }, [on])
}
