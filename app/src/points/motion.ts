import { stilled } from '../lib/motion/stilled'

/**
 * The Points page's motion (added 2026-11-08): direction C "Corrente" in movement, as the owner approved it on 7 Nov
 * (integ-logs/points/PROPOSAL.md §11, its timing table, and the living prototype integ-logs/points/prototype/src/proto.js).
 * Every moment is a Web Animations timeline on transform and opacity, built up front with its delays (no timers), on the
 * site's easings (styles/tokens.css). Each animation is named by its moment (`pt-entrance`, `pt-link`, ...), so tests and
 * recordings can tell them apart.
 *
 *   - Entrances fill backwards only: once over, nothing keeps a transform and the element is its own resting state.
 *     Content that leaves is kept in its place, hidden at rest (`.pt-left`), and shown only while it leaves, so two texts
 *     are never drawn one over the other and nothing around it moves.
 *   - Nothing runs while the tab is hidden: a moment started then waits, one under way pauses; the two loops (the slot's
 *     breath and the season's shimmer) also pause out of view.
 *   - Reduced motion (or `dm-still`): nothing moves; a change is a short opacity fade, and the loops, the stamps, the
 *     joint's light and the sweep are off. The stilling CSS cannot reach Web Animations, so each moment asks here.
 *
 * DOM in, DOM out: the screen (screens/Points.tsx) draws each state and calls the moment that leads into it.
 */

/** The site's easings (styles/tokens.css), as Web Animations take them. */
const E = {
  enter: 'cubic-bezier(0.16, 1, 0.3, 1)', // --ease-enter: arrivals
  std: 'cubic-bezier(0.4, 0, 0.2, 1)', // --ease-std: state changes, exits
  pop: 'cubic-bezier(0.34, 1.56, 0.64, 1)', // --ease-pop: contact clicks and stamps only
  fall: 'cubic-bezier(0.55, 0, 1, 0.45)', // --ease-fall: the double's drop
  fast: 'cubic-bezier(0.17, 0.67, 0.45, 1)', // --ease-fast: the landing's give, the joint's light
  breath: 'cubic-bezier(0.42, 0, 0.58, 1)', // ease-in-out, the prototype's breath
} as const

export type Moment = 'entrance' | 'wait' | 'link' | 'reset' | 'copy' | 'join' | 'later' | 'breathe' | 'shimmer'

type El = Element | null | undefined
type Options = { delay?: number; duration: number; easing?: string; iterations?: number; fill?: FillMode }

// ---- Held while hidden: the tab, or (a loop) the view. Only what this module paused is played again.
const held = new Map<Animation, { why: Set<string>; ours: boolean }>()
let listening = false

function hold(animation: Animation, why: string, on: boolean): void {
  const state = held.get(animation)
  if (!state) return
  if (on) state.why.add(why)
  else state.why.delete(why)
  if (state.why.size > 0 && animation.playState === 'running') {
    animation.pause()
    state.ours = true
  } else if (state.why.size === 0 && state.ours) {
    state.ours = false
    if (animation.playState === 'paused') animation.play()
  }
}

function onVisibility(): void {
  for (const animation of held.keys()) hold(animation, 'tab', document.hidden)
}

function run(el: El, moment: Moment, frames: Keyframe[], options: Options): Animation | null {
  if (!el || typeof (el as HTMLElement).animate !== 'function') return null
  const animation = el.animate(frames, { id: `pt-${moment}`, fill: 'backwards', easing: 'linear', ...options, delay: Math.max(0, options.delay ?? 0) })
  held.set(animation, { why: new Set(), ours: false })
  if (!listening) {
    listening = true
    document.addEventListener('visibilitychange', onVisibility)
  }
  if (document.hidden) hold(animation, 'tab', true)
  const done = () => held.delete(animation)
  animation.addEventListener('finish', done)
  animation.addEventListener('cancel', done)
  return animation
}

/** A loop pauses while its element is out of view (and, like everything here, while the tab is hidden). */
function loop(animations: (Animation | null)[], el: El): Animation[] {
  const live = animations.filter((animation): animation is Animation => animation !== null)
  if (!el || !live.length || typeof IntersectionObserver === 'undefined') return live
  const observer = new IntersectionObserver(([entry]) => {
    for (const animation of live) hold(animation, 'view', !entry?.isIntersecting)
  })
  observer.observe(el)
  live[0]?.addEventListener('cancel', () => observer.disconnect())
  return live
}

/** Cancels what a moment left running (its loops); safe on null. */
export function stop(animations: readonly (Animation | null)[] | null | undefined): void {
  for (const animation of animations ?? []) animation?.cancel()
}

// ---- The small motions, shared by the moments.
// Arrivals start at 0, as the prototype's: a part that waits a second or two at the site's first-paint 0.01 (tokens.css
// dm-rise) shows as a ghost on a dark screen. The title, drawn at once, keeps 0.01, so the first paint is contentful.
const FIRST = 0.01
const q = <T extends Element = HTMLElement>(root: El, selector: string): T | null => root?.querySelector<T>(selector) ?? null
const qa = <T extends Element = HTMLElement>(root: El, selector: string): T[] => (root ? [...root.querySelectorAll<T>(selector)] : [])
const drop = (tile: El) => q(tile, '.pt-drop')
const solid = (tile: El): tile is HTMLElement => !!tile && tile.classList.contains('solid')

const fade = (el: El, moment: Moment, delay: number, duration: number, from = 0, to = 1) =>
  run(el, moment, [{ opacity: from }, { opacity: to }], { delay, duration, easing: E.std })
const rise = (el: El, moment: Moment, delay: number, duration: number, y: string, from = 0) =>
  run(el, moment, [{ opacity: from, transform: `translateY(${y})` }, { opacity: 1, transform: 'none' }], { delay, duration, easing: E.enter })
/** A layer that leaves: hidden at rest (`.pt-left`), shown while it fades out (and moves `y`, if any). */
const leave = (el: El, moment: Moment, delay: number, duration: number, y?: string) =>
  run(el, moment, y
    ? [{ opacity: 1, visibility: 'visible', transform: 'none' }, { opacity: 0, visibility: 'visible', transform: `translateY(${y})` }]
    : [{ opacity: 1, visibility: 'visible' }, { opacity: 0, visibility: 'visible' }], { delay, duration, easing: E.std })

/** A tile arriving from a side and meeting the line: a 2 px overshoot at contact (the click). Returns the contact time. */
function slideIn(tile: HTMLElement, moment: Moment, fromRem: number, delay: number, duration: number): number {
  const back = fromRem < 0 ? '0.2rem' : '-0.2rem'
  run(drop(tile), moment, [{ transform: `translateX(${fromRem}rem)`, easing: E.enter }, { transform: `translateX(${back})`, offset: 0.78, easing: E.std }, { transform: 'none' }], { delay, duration })
  // Opaque within 110 ms: a 3D tile half transparent shows its dark back slabs through its face.
  run(drop(tile), moment, [{ opacity: 0 }, { opacity: 1 }], { delay, duration: 110, easing: E.std })
  run(q(tile, '.pt-ground'), moment, [{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }], { delay, duration, easing: E.std })
  return delay + duration * 0.78
}

/** A place for a tile (a ghost) arrives quietly: it is not a tile, so it has no click. */
const place = (tile: HTMLElement, moment: Moment, delay: number) => fade(drop(tile), moment, delay, 280, 0)

/**
 * Where two tiles meet: a thin line of light at the joint (260 ms, once). Placed from the layout boxes (`.pt-tile`, never
 * transformed), in the chain's own layer for it.
 */
function flash(root: El, left: El, right: El, moment: Moment, delay: number): void {
  const joints = q(root, '.pt-joints')
  if (!joints || !left || !right) return
  const box = joints.getBoundingClientRect()
  const a = left.getBoundingClientRect()
  const b = right.getBoundingClientRect()
  const height = Math.min(a.height, b.height) * 0.86
  const line = document.createElement('span')
  line.className = 'pt-jflash'
  line.style.cssText = `left:${(a.right + b.left) / 2 - box.left - 1}px;top:${(b.top + b.bottom) / 2 - box.top - height / 2}px;height:${height}px`
  joints.appendChild(line)
  const animation = run(line, moment, [{ opacity: 0, transform: 'scaleY(0.3)' }, { opacity: 0.95, transform: 'scaleY(1)', offset: 0.35 }, { opacity: 0, transform: 'scaleY(0.7)' }], { delay, duration: 260, easing: E.fast })
  const gone = () => line.remove()
  if (animation) animation.finished.then(gone, gone)
  else gone()
}

/** The tile that was hit gives a little, and is back in 160 ms (fill none: its hover keeps working after). */
const nudge = (tile: El, moment: Moment, px: number, delay: number) =>
  run(q(tile, '.pt-lift'), moment, [{ transform: 'translateX(0)' }, { transform: `translateX(${px}px)`, offset: 0.4 }, { transform: 'translateX(0)' }], { delay, duration: 160, easing: E.fast, fill: 'none' })

/** The light along the played line, left to right, 90 ms apart (solid tiles only). */
function sweep(tiles: El[], moment: Moment, delay: number): void {
  tiles.filter(solid).forEach((tile, k) =>
    run(q(tile, '.pt-sweep'), moment, [{ transform: 'translateX(-70%)', opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 1, offset: 0.7 }, { transform: 'translateX(70%)', opacity: 0 }], { delay: delay + k * 90, duration: 640, easing: E.std }))
}

/** The pips of a tile, stamped one by one. */
const stamp = (tile: El, moment: Moment, delay: number) =>
  qa(tile, '.pt-face > i').forEach((pip, i) => run(pip, moment, [{ transform: 'scale(1.9)', opacity: 0 }, { transform: 'none', opacity: 1 }], { delay: delay + i * 60, duration: 180, easing: E.pop }))

const tilesOf = (root: El) => ({
  you: q(root, '.pt-you .pt-tile'),
  prev: q(root, '.pt-prev .pt-tile:not(.pt-left)'),
  run: qa(root, '.pt-run .pt-tile:not(.pt-left)'),
})

// ---- The moments.

/** The title row (the page's first visit of the session): Points., then the wallet's chip. */
const title = (root: El, moment: Moment, R: boolean) => {
  if (R) return void fade(q(root, '.pt-title'), moment, 0, 150, FIRST)
  rise(q(root, '.pt-title h1'), moment, 0, 420, '0.6rem', FIRST)
  rise(q(root, '.pt-title .pt-chip'), moment, 60, 420, '0.6rem')
}

/**
 * The first visit of the session (2.95 s): the double drops with weight, the referrer's tile slides in from the left and
 * meets it, the wallets referred join from the right one by one, each with its click; the captions, then the total
 * rolls digit by digit; then the rule, the link and the rest. Under reduced motion each part fades in, 150 ms.
 */
export function entrance(root: HTMLElement): void {
  const R = stilled()
  const moment = 'entrance'
  title(root, moment, R)
  if (R) {
    for (const part of qa(root, ':scope > :is(.pt-stage, .pt-invite, .pt-share, .pt-lower)')) fade(part, moment, 0, 150)
    return
  }
  const { you, prev, run: line } = tilesOf(root)
  // The double drops with weight: gravity in, a 1.5% squash as it lands, a 3 px give, then still; its shadow blooms.
  run(drop(you), moment, [
    { transform: 'translateY(-2.6rem) scale(1.03)', easing: E.fall },
    { transform: 'translateY(0) scale(1.012, 0.985)', offset: 0.6, easing: E.fast },
    { transform: 'translateY(-0.28rem) scale(1)', offset: 0.8, easing: E.std },
    { transform: 'none' },
  ], { delay: 160, duration: 640 })
  run(drop(you), moment, [{ opacity: 0 }, { opacity: 1 }], { delay: 160, duration: 120, easing: E.std })
  run(q(you, '.pt-ground'), moment, [{ transform: 'scaleX(0.5)', opacity: 0, easing: E.fall }, { transform: 'scaleX(1.14)', opacity: 1, offset: 0.6, easing: E.fast }, { transform: 'none', opacity: 1 }], { delay: 160, duration: 640 })
  // The referrer's tile slides in from the left; its 5 meets your 5.
  if (solid(prev)) {
    const contact = slideIn(prev, moment, -4.5, 720, 480)
    flash(root, prev, you, moment, contact - 20)
    nudge(you, moment, 2, contact)
  } else if (prev) place(prev, moment, 720)
  // The wallets referred join from the right, one by one, each meeting the tile before it.
  let left: El = you
  line.forEach((tile, i) => {
    if (!solid(tile)) return void place(tile, moment, 1060 + i * 110)
    const contact = slideIn(tile, moment, 4, 1060 + i * 110, 400)
    flash(root, left, tile, moment, contact - 20)
    nudge(left, moment, -1, contact)
    left = tile
  })
  qa(root, '.pt-chain figcaption').forEach((caption, i) => rise(caption, moment, 1500 + i * 60, 280, '0.35rem'))
  // The total rolls digit by digit: a short drum each, 45 ms apart, most of the travel early and a long settle.
  qa(root, '.pt-total .pt-dg').forEach((digit, i) => {
    const value = Number(digit.dataset.d)
    const line = parseFloat(getComputedStyle(digit).height) || digit.offsetHeight
    const delay = 1580 + i * 45
    run(q(digit, '.pt-strip'), moment, [{ transform: `translateY(${-(6 + value) * line}px)` }, { transform: `translateY(${-(10 + value) * line}px)` }], { delay, duration: 760, easing: E.enter })
    // The drum shows while it rolls; the digit itself, in the same place, once it has settled.
    run(q(digit, '.pt-drum'), moment, [{ opacity: 1, visibility: 'visible' }, { opacity: 1, visibility: 'visible' }], { delay, duration: 760 })
    run(q(digit, '.pt-dw'), moment, [{ opacity: 0 }, { opacity: 0 }], { delay, duration: 760 })
    fade(digit, moment, delay, 120)
  })
  for (const mark of qa(root, '.pt-total .pt-cm')) fade(mark, moment, 1700, 240)
  fade(q(root, '.pt-total .pt-unit'), moment, 2150, 300)
  // What the page says instead of a total rises where the total would roll.
  for (const lead of qa(root, '.pt-stage > :is(.pt-lead, .pt-invited)')) rise(lead, moment, 1580, 760, '0.4rem')
  for (const part of qa(root, '.pt-stage > :is(.pt-rule, .pt-note, .pt-actions)')) rise(part, moment, 2350, 380, '0.4rem')
  for (const part of qa(root, ':scope > :is(.pt-invite, .pt-share)')) rise(part, moment, 2450, 420, '0.6rem')
  rise(q(root, ':scope > .pt-lower'), moment, 2520, 420, '0.6rem')
}

/** The entrance's whole length, after which the slot may breathe and the season's words shimmer. */
export const ENTRANCE_MS = 2950

/** The dashed place for the referrer breathes while it asks: opacity only, a 3.2 s cycle. Off under reduced motion. */
export function breathe(root: El, delay: number): Animation[] {
  const slot = drop(q(root, '.pt-prev .pt-tile.dashed:not(.pt-left)'))
  if (!slot || stilled()) return []
  return loop([run(slot, 'breathe', [{ opacity: 1, easing: E.breath }, { opacity: 0.45, easing: E.breath }, { opacity: 1 }], { delay, duration: 3200, iterations: Infinity, fill: 'none' })], slot)
}

/** The breath stops: the place comes back to full from wherever the breath had it, in 200 ms. */
export function stopBreath(root: El, breath: Animation[]): void {
  const slot = drop(q(root, '.pt-prev .pt-tile.dashed:not(.pt-left)'))
  const now = slot ? Number(getComputedStyle(slot).opacity) : 1
  stop(breath)
  if (slot && now < 0.99) fade(slot, 'link', 0, 200, now, 1)
}

/** Before 9 Nov: a window of warm light crosses "Counting starts 9 Nov" (the outer and inner counter-translate). */
export function shimmer(root: El, delay: number): Animation[] {
  const words = q(root, '.pt-shimmer')
  const light = q(words, '.pt-hl')
  if (!words || !light || stilled()) return []
  const options: Options = { delay, duration: 3600, iterations: Infinity, easing: E.std, fill: 'none' }
  return loop([
    run(light, 'shimmer', [{ transform: 'translateX(-100%)' }, { transform: 'translateX(250%)' }], options),
    run(light.firstElementChild, 'shimmer', [{ transform: 'translateX(40%)' }, { transform: 'translateX(-100%)' }], options),
  ], words)
}

/** Link referrer, asked: the button says it waits (its labels cross), three pips light in turn while it does. */
export function asking(root: El): Animation[] {
  const button = q(root, '.pt-invite [data-points-action="link"]')
  const R = stilled()
  leave(q(button, '.pt-l-idle'), 'wait', 0, R ? 100 : 140)
  fade(q(button, '.pt-l-busy'), 'wait', R ? 0 : 60, R ? 100 : 160)
  if (R) return []
  return qa(button, '.pt-wait > i').map((pip, i) => run(pip, 'wait', [{ opacity: 0.25 }, { opacity: 1 }, { opacity: 0.25 }], { delay: i * 150, duration: 900, iterations: Infinity, easing: E.std, fill: 'none' }))
    .filter((animation): animation is Animation => animation !== null)
}

/** The wallet refused, the signature expired, or the service said no: the button is itself again, one plain line rises. */
export function reset(root: El): void {
  const R = stilled()
  const button = q(root, '.pt-invite [data-points-action="link"]')
  leave(q(button, '.pt-l-busy'), 'reset', 0, 140)
  fade(q(button, '.pt-l-idle'), 'reset', 40, 180)
  const line = q(root, '.pt-invite-status[data-points-line]')
  if (R) fade(line, 'reset', 60, 150)
  else rise(line, 'reset', 60, 260, '0.25rem')
}

/**
 * The referrer linked: the tile takes its place and fills Tangerine, its pips are stamped one by one, the joint clicks,
 * a light passes along the chain; the caption and the card change, the old words out before the new ones come in.
 */
export function linked(root: El): void {
  const R = stilled()
  const moment = 'link'
  const { you, prev, run: line } = tilesOf(root)
  leave(q(root, '.pt-prev .pt-tile.pt-left'), moment, 0, 180)
  if (R) {
    fade(drop(prev), moment, 0, 150, 0)
    fade(q(prev, '.pt-ground'), moment, 0, 150, 0)
  } else {
    run(drop(prev), moment, [{ transform: 'translateX(-1.5rem) scale(0.96)', easing: E.enter }, { transform: 'translateX(0.15rem) scale(1.01)', offset: 0.8, easing: E.std }, { transform: 'none' }], { duration: 420 })
    run(drop(prev), moment, [{ opacity: 0 }, { opacity: 1 }], { duration: 110, easing: E.std })
    fade(q(prev, '.pt-ground'), moment, 120, 300, 0)
    stamp(prev, moment, 380)
    flash(root, prev, you, moment, 320)
    nudge(you, moment, 2, 336)
    sweep([prev, you, ...line], moment, 900)
  }
  const caption = q(root, '.pt-prev figcaption')
  leave(q(caption, '.pt-capl.pt-left'), moment, 200, R ? 150 : 200)
  if (R) fade(q(caption, '.pt-capl:not(.pt-left)'), moment, 260, 150)
  else rise(q(caption, '.pt-capl:not(.pt-left)'), moment, 260, 260, '0.25rem')
  // The card: the ask leaves first; the answer comes after it, never two texts on top of each other.
  leave(q(root, '.pt-invite .pt-ask'), moment, 100, R ? 150 : 200, R ? undefined : '-0.25rem')
  if (R) return void fade(q(root, '.pt-invite .pt-done'), moment, 300, 150)
  rise(q(root, '.pt-invite .pt-done'), moment, 300, 320, '0.35rem')
  run(q(root, '.pt-invite .pt-check'), moment, [{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], { delay: 420, duration: 260, easing: E.pop })
}

/** Not now: the card fades out, then goes (`done`). */
export function later(card: El, done: () => void): void {
  const animation = run(card, 'later', [{ opacity: 1 }, { opacity: 0 }], { duration: stilled() ? 150 : 180, easing: E.std, fill: 'forwards' })
  if (animation) animation.finished.then(done, done)
  else done()
}

/** Copy link: the button's own answer. Icon to a check, label to Copied; and back (`back`). Nothing else moves. */
export function copied(button: El, back: boolean): void {
  const R = stilled()
  const [goes, comes] = back ? ['.pt-i-check', '.pt-i-copy'] : ['.pt-i-copy', '.pt-i-check']
  const [label, next] = back ? ['.pt-l-copied', '.pt-l-copy'] : ['.pt-l-copy', '.pt-l-copied']
  if (R) {
    leave(q(button, goes), 'copy', 0, 140)
    fade(q(button, comes), 'copy', 60, 140)
  } else {
    run(q(button, goes), 'copy', [{ transform: 'none', opacity: 1, visibility: 'visible' }, { transform: 'scale(0.6)', opacity: 0, visibility: 'visible' }], { duration: 140, easing: E.std })
    run(q(button, comes), 'copy', [{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], { delay: 60, duration: 220, easing: E.pop })
  }
  leave(q(button, label), 'copy', 0, back ? 140 : 120)
  if (R || back) fade(q(button, next), 'copy', 60, R ? 140 : 200)
  else run(q(button, next), 'copy', [{ opacity: 0, transform: 'translateY(0.2rem)' }, { opacity: 1, transform: 'none' }], { delay: 60, duration: 200, easing: E.enter })
}

/** Where each part of the line was (before a wallet joins), by element: the FLIP's first frame. */
export type Places = Map<Element, number>
export function places(root: El): Places {
  return new Map(qa(root, '.pt-chain :is(.pt-node > .pt-slot, .pt-node > .pt-tile, .pt-run > .pt-slot, figcaption)').map((el) => [el, el.getBoundingClientRect().left]))
}

/**
 * A wallet referred joined since the last visit: its tile comes in at the end of the line with its click; the line
 * re-centres (FLIP: transforms only), and the count changes, the old words out first. `from`: the tiles there before.
 */
export function joined(root: El, before: Places, from: number): void {
  const R = stilled()
  const moment = 'join'
  const slots = qa(root, '.pt-run > .pt-slot')
  const arriving = slots.slice(from).map((slot) => q(slot, '.pt-tile.solid')).filter(solid)
  const meets = arriving.map((tile) => {
    const index = slots.findIndex((slot) => slot.contains(tile))
    return index > 0 ? q(slots[index - 1], '.pt-tile.solid') : q(root, '.pt-you .pt-tile')
  })
  if (!R) {
    // The line re-centres: each part from where it was. The joint's light is placed first, from the final layout.
    const contacts = arriving.map((_, k) => 120 + k * 110 + 440 * 0.78)
    arriving.forEach((tile, k) => flash(root, meets[k], tile, moment, (contacts[k] ?? 0) - 20))
    for (const [el, left] of before) {
      const dx = left - el.getBoundingClientRect().left
      if (el.isConnected && Math.abs(dx) > 0.5) run(el, moment, [{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 360, easing: E.std })
    }
    arriving.forEach((tile, k) => {
      slideIn(tile, moment, 4, 120 + k * 110, 440)
      nudge(meets[k], moment, -1, contacts[k] ?? 0)
    })
  } else for (const tile of arriving) fade(drop(tile), moment, 0, 150, 0)
  // A place that waited for this wallet goes as its tile arrives.
  for (const ghost of qa(root, '.pt-run .pt-tile.pt-left')) leave(ghost, moment, R ? 0 : 120, R ? 150 : 180)
  const caption = q(root, '.pt-next figcaption')
  leave(q(caption, '.pt-capl.pt-left'), moment, R ? 0 : 480, R ? 150 : 180)
  if (R) fade(q(caption, '.pt-capl:not(.pt-left)'), moment, 0, 150)
  else rise(q(caption, '.pt-capl:not(.pt-left)'), moment, 520, 260, '0.25rem')
}
