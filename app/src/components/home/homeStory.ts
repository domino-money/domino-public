import { useEffect, useSyncExternalStore } from 'react'
import { rootScale } from '../../lib/rootScale'

/*
 * Home's story (V4, the approved prototype's scroll acts): where the reader is, which function the stage shows, and the
 * a/b keys that restart a one-shot story. Decoration only: nothing here reads data or changes what a control does.
 *
 * The act is the LAST of the four scenes (funding, functions, range, calm) whose middle has passed 75% of the window's
 * height. It is measured on scroll (one frame), at mount (+60 ms, +700 ms, fonts ready), and 120 ms after a resize;
 * a pick (a function row, a source chip, the range control, a calm topic) sets it at once, until the next scroll.
 * It changes a few times per page, so the components that draw it subscribe (useSyncExternalStore), never per frame.
 */

export type HomeAct = 'none' | 'fund' | 'fn' | 'range' | 'calm'
export type HomeLoc = Exclude<HomeAct, 'none'>
export type FxMode = 'compound' | 'domino' | 'exit'
export type StoryKey = 'a' | 'b'

export interface HomeStory {
  act: HomeAct
  /** Flips on every change of the tile's place: the travelling tile's hop restarts. */
  hop: StoryKey
  mode: FxMode
  /** The functions' story key: a mode change or a replay flips it. */
  fnKey: StoryKey
  /** The funding story key: a source pick or a switch press flips it. */
  fundKey: StoryKey
  /** The last calm topic opened and still open, else -1. */
  calm: number
  rangeOpen: boolean
  /** The travelling tile has been placed once (it fades in; the rest pools wait for it). */
  ready: boolean
}

const INITIAL: HomeStory = { act: 'none', hop: 'a', mode: 'compound', fnKey: 'a', fundKey: 'a', calm: -1, rangeOpen: true, ready: false }

let state: HomeStory = INITIAL
const listeners = new Set<() => void>()
const flippedAt: Partial<Record<'fnKey' | 'fundKey', number>> = {}

function set(next: Partial<HomeStory>) {
  let changed = false
  for (const key of Object.keys(next) as Array<keyof HomeStory>) if (next[key] !== state[key]) changed = true
  if (!changed) return
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

const other = (key: StoryKey): StoryKey => (key === 'b' ? 'a' : 'b')

/** Where the tile stands for an act: with the reader; above the story, or at a folded range, it waits in the functions. */
export function locOf(act: HomeAct, rangeOpen: boolean): HomeLoc {
  if (act === 'none' || (act === 'range' && !rangeOpen)) return 'fn'
  return act
}

function withAct(next: Partial<HomeStory>, act: HomeAct): Partial<HomeStory> {
  if (act !== state.act) {
    next.act = act
    if (locOf(act, state.rangeOpen) !== locOf(state.act, state.rangeOpen)) next.hop = other(state.hop)
  }
  return next
}

function flip(key: 'fnKey' | 'fundKey'): StoryKey {
  flippedAt[key] = Date.now()
  return other(state[key])
}

export const homeStory = {
  get: (): HomeStory => state,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  /** The reader acted in a place (a pick): the place becomes the act at once. */
  pick(act: HomeAct) {
    set(withAct({}, act))
  },
  /** A function row was chosen; `act` when it was picked (click or focus), not only hovered. */
  setMode(mode: FxMode, act?: HomeAct) {
    const next: Partial<HomeStory> = {}
    if (mode !== state.mode) {
      next.mode = mode
      next.fnKey = flip('fnKey')
    }
    set(act ? withAct(next, act) : next)
  },
  /** Hovering the stage replays the story once the last one has finished. */
  replayFunctions() {
    if (state.act !== 'fn') return
    const since = Date.now() - (flippedAt.fnKey ?? 0)
    if (since > (state.mode === 'exit' ? 3800 : 3400)) set({ fnKey: flip('fnKey') })
  },
  /** A source pick or a switch press: the funding story starts again, here. */
  restartFunding() {
    set(withAct({ fundKey: flip('fundKey') }, 'fund'))
  },
  setCalm(index: number) {
    set(withAct({ calm: index }, 'calm'))
  },
  setRangeOpen(open: boolean) {
    const next: Partial<HomeStory> = { rangeOpen: open }
    if (state.act === 'range') next.hop = other(state.hop)
    set(next)
  },
  setReady(ready: boolean) {
    set({ ready })
  },
}

/** The story as React sees it: re-renders only when it changes. */
export function useHomeStoryState(): HomeStory {
  return useSyncExternalStore(homeStory.subscribe, homeStory.get, homeStory.get)
}

/** The scenes the acts follow, in page order. */
const SCENES: ReadonlyArray<[HomeLoc, string]> = [
  ['fund', '#funding .dm-funding-scene'],
  ['fn', '.dm-home-fx-stage .dm-fx-scene'],
  ['range', '#ranges .dm-sim-stage'],
  ['calm', '.dm-cm-scene'],
]

/** A scene's vertical middle in the viewport, or null when it has no box (hidden at this width). */
function middleOf(home: Element, loc: HomeLoc, selector: string): number | null {
  const box = home.querySelector(selector)?.getBoundingClientRect()
  if (box && box.height > 0) return box.top + box.height / 2
  if (loc === 'range') {
    // A folded lesson keeps its place under its title, as the prototype's collapsed panel does (its scene sits about
    // 307 design px under the title: the card's gap, padding and head, then half the scene).
    const ranges = home.querySelector<HTMLDetailsElement>('#ranges')
    const title = ranges && !ranges.open ? ranges.querySelector(':scope > summary')?.getBoundingClientRect() : null
    if (title && title.height > 0) return title.bottom + 307 * rootScale()
  }
  return null
}

/** The act the scroll position says. */
export function scrollAct(): HomeAct {
  if (typeof document === 'undefined') return 'none'
  const home = document.querySelector('main.dm-home')
  if (!home) return 'none'
  const line = window.innerHeight * 0.75
  let act: HomeAct = 'none'
  for (const [loc, selector] of SCENES) {
    const middle = middleOf(home, loc, selector)
    if (middle !== null && middle <= line) act = loc
  }
  return act
}

/** Home's acts follow the reader: mount once on the landing. Leaving Home resets the story. */
export function useHomeStory() {
  useEffect(() => {
    if (typeof window === 'undefined') return
    state = INITIAL
    const update = () => {
      const act = scrollAct()
      if (act !== state.act) set(withAct({}, act))
    }
    let frame = 0
    const scroll = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0
        update()
      })
    }
    const timers: Array<ReturnType<typeof setTimeout>> = [setTimeout(update, 60), setTimeout(update, 700)]
    let alive = true
    document.fonts?.ready.then(() => {
      if (alive) timers.push(setTimeout(update, 30))
    }).catch(() => undefined)
    let resized: ReturnType<typeof setTimeout> | undefined
    const resize = () => {
      clearTimeout(resized)
      resized = setTimeout(update, 120)
    }
    window.addEventListener('scroll', scroll, { passive: true })
    window.addEventListener('resize', resize, { passive: true })
    return () => {
      alive = false
      if (frame) cancelAnimationFrame(frame)
      for (const timer of timers) clearTimeout(timer)
      clearTimeout(resized)
      window.removeEventListener('scroll', scroll)
      window.removeEventListener('resize', resize)
      state = INITIAL
      for (const key of Object.keys(flippedAt) as Array<keyof typeof flippedAt>) delete flippedAt[key]
    }
  }, [])
}
