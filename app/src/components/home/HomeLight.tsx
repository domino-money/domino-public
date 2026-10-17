import { useEffect } from 'react'
import { rootScale } from '../../lib/rootScale'
import { stilled } from '../../lib/motion/stilled'
import { homeStory } from './homeStory'

/*
 * Home's own answer to the light (V4 §4.2, §4.7): the hero tile turns a little toward the pointer, its two glares and
 * its floor shadow follow, and the warm copies over the serif titles are revealed where the light is. The travelling
 * tile (HomeTraveller.tsx) turns the same way from wherever it stands, and below the fold the hero's dotted texture is
 * revealed around the light (a window that moves, its dots fixed to the page). Decoration only.
 *
 * Nothing here is React state: one passive pointermove on the window, at most one write pass per frame, straight onto
 * the decorative nodes' own inline styles (never onto <main>, whose custom properties every Home node would inherit).
 * Off for touch, reduced motion, `dm-still` and hidden tabs (no pointer moves there); the CSS rest angle stays.
 * Lengths follow the prototype in design px, drawn at the root's scale (lib/rootScale.ts).
 */

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
const FINE = '(hover: hover) and (pointer: fine)'

interface Nodes {
  home: HTMLElement | null
  tile: HTMLElement | null
  turn: HTMLElement | null
  glare: HTMLElement | null
  glare2: HTMLElement | null
  shadow: HTMLElement | null
  sheens: HTMLElement[]
  trav: HTMLElement | null
  travTurn: HTMLElement | null
  travGlare: HTMLElement | null
  travGlare2: HTMLElement | null
  travShadow: HTMLElement | null
  zdots: HTMLElement | null
  story: HTMLElement | null
  topics: HTMLElement | null
}

function find(): Nodes {
  const home = document.querySelector('main.dm-home')
  const one = (selector: string) => home?.querySelector<HTMLElement>(selector) ?? null
  return {
    home: home instanceof HTMLElement ? home : null,
    tile: one('[data-home-tile]'),
    turn: one('.dm-tile-3d'),
    glare: one('.dm-tile-glare'),
    glare2: one('.dm-tile-glare2'),
    shadow: one('.dm-tile-shadow'),
    sheens: home ? Array.from(home.querySelectorAll<HTMLElement>('[data-home-sheen]')) : [],
    trav: one('[data-home-traveller]'),
    travTurn: one('[data-home-traveller] .dm-tv-3d'),
    travGlare: one('[data-home-traveller] .dm-tv-glare'),
    travGlare2: one('[data-home-traveller] .dm-tv-glare2'),
    travShadow: one('[data-home-traveller] .dm-tv-shadow'),
    zdots: one('[data-home-zdots]'),
    story: one('#funding'),
    topics: one('.dm-limits-grid'),
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
  paintTraveller(nodes, x, y, on, k)
  paintTexture(nodes, x, y, on, k)
  // The calm topics' glint (V4 .rk-line::after): the light's x across the list, inherited by every topic.
  const topics = nodes.topics?.getBoundingClientRect()
  if (on && topics && topics.width > 0) nodes.topics?.style.setProperty('--gx', `${(x - topics.left).toFixed(1)}px`)
}

const TRAVELLER = ['travTurn', 'travGlare', 'travGlare2', 'travShadow'] as const

/**
 * The travelling tile (the prototype's tv-*): it turns from its own box, its glares follow the light, its shadow falls
 * away. Facing you for the "permissions" topic it keeps a softer turn and stands upright. Without the light it rests.
 */
function paintTraveller(nodes: Nodes, x: number, y: number, on: boolean, k: number) {
  const box = nodes.trav?.getBoundingClientRect()
  if (!on || !box || box.width === 0) {
    for (const name of TRAVELLER) {
      nodes[name]?.style.removeProperty('transform')
      nodes[name]?.style.removeProperty('background-position')
    }
    return
  }
  const cxn = clamp((x - (box.left + 52 * k)) / (620 * k), -1, 1)
  const cyn = clamp((y - (box.top + 91 * k)) / (480 * k), -1, 1)
  let rx = 6 - cyn * 9
  let ry = -18 + cxn * 13
  let rz = -7
  if (nodes.trav?.classList.contains('at-calm') && nodes.trav.classList.contains('cm-2')) {
    ry = (ry + 18) * 0.4
    rz = 0
    rx = 4
  }
  nodes.travTurn?.style.setProperty('transform', `rotateX(${rx.toFixed(1)}deg) rotateY(${ry.toFixed(1)}deg) rotateZ(${rz}deg)`)
  nodes.travGlare?.style.setProperty('background-position', `${(x - box.left - 116 * k).toFixed(1)}px ${(y - box.top - 116 * k).toFixed(1)}px`)
  nodes.travGlare2?.style.setProperty('background-position', `${(x - box.left - 66 * k).toFixed(1)}px ${(y - box.top - 66 * k).toFixed(1)}px`)
  const shift = clamp((-(x - (box.left + 52 * k)) / k) * 0.05, -20, 20) * k
  nodes.travShadow?.style.setProperty('transform', `translateX(${shift.toFixed(1)}px) scaleX(${(1 + Math.abs(cxn) * 0.15).toFixed(3)})`)
}

/**
 * The dotted texture below the fold (the prototype's .zdots): a 640px window around the light from the funding scene
 * down, moved by transform while its dots are shifted back, so the dots stay fixed to the page and only the window moves.
 */
function paintTexture(nodes: Nodes, x: number, y: number, on: boolean, k: number) {
  const dots = nodes.zdots
  const home = nodes.home?.getBoundingClientRect()
  if (!dots || !home) return
  const start = nodes.story?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY
  if (!on || y < start) {
    dots.style.setProperty('opacity', '0')
    return
  }
  const dx = x - home.left - 320 * k
  const dy = y - home.top - 320 * k
  dots.style.setProperty('transform', `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`)
  dots.style.setProperty('background-position', `${(-dx).toFixed(1)}px ${(-dy).toFixed(1)}px`)
  dots.style.setProperty('opacity', '1')
}

function clear(nodes: Nodes) {
  for (const node of [nodes.turn, nodes.glare, nodes.glare2, nodes.shadow, nodes.travTurn, nodes.travGlare, nodes.travGlare2, nodes.travShadow]) {
    node?.style.removeProperty('transform')
    node?.style.removeProperty('background-position')
  }
  for (const property of ['transform', 'background-position', 'opacity']) nodes.zdots?.style.removeProperty(property)
  nodes.topics?.style.removeProperty('--gx')
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
    // The travelling tile moves with the story: from its new place it turns toward the same light.
    const unsubscribe = homeStory.subscribe(() => {
      if (next && !frame) frame = requestAnimationFrame(draw)
    })
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
      unsubscribe()
    }
  }, [])
}
