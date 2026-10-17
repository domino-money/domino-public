import { useEffect, useRef } from 'react'
import { rootScale } from '../../lib/rootScale'
import { cx } from '../ui'
import { homeStory, locOf, useHomeStoryState, type FxMode, type HomeLoc } from './homeStory'

/*
 * The one tile that travels (V4, the approved prototype's "trav"): the hero's object, smaller, standing in each scene
 * the reader is in: the funding step, the functions stage, your range, the calm topics. It moves by a 1 s drift with a
 * small carried hop, acts each place's story (a nod, a settle with its pips lit, a lean, a tip and a dim), and turns a
 * little toward the light (HomeLight.tsx). Decoration only: aria-hidden, no pointer, every place reads without it.
 *
 * It is a child of main (never an ancestor of #pools, nothing transformed above it) and is placed by its own inline
 * transform, measured at mount, on resize, after fonts load, when the page's height changes and when its place does.
 * Shown from 1280px; narrower, the functions stage stands a still tile in its place and the others rest (CSS).
 */

const SLABS = [8, 7, 6, 5, 4, 3, 2, 1] as const
const PIPS = [1, 2, 3, 4, 5] as const
const PLACES: Record<HomeLoc, string> = {
  fund: '#funding .dm-funding-scene',
  fn: '.dm-home-fx-stage .dm-fx-scene',
  range: '#ranges .dm-sim-stage',
  calm: '.dm-cm-scene',
}

/** The tile's top-left in viewport px for a place, from that place's scene box (the prototype's offsets, design px). */
function spot(loc: HomeLoc, mode: FxMode, box: DOMRect, k: number): [number, number] {
  if (loc === 'fund') {
    // The drawing is an 800 × 300 viewBox fitted into the scene (meet): stand on its step, at its scale, feet on its floor.
    const s = Math.min(box.width / 800, box.height / 300)
    const left = box.left + (box.width - 800 * s) / 2
    const top = box.top + (box.height - 300 * s) / 2
    return [left + 452 * s, top + 236 * s - 182 * k]
  }
  if (loc === 'fn') {
    const zf = box.width / (624 * k)
    return [box.left + (mode === 'compound' ? 260 : 156) * k * zf, box.top + (148 * zf + 182 * (zf - 1)) * k]
  }
  if (loc === 'range') return [box.left + 22 * k + 0.41604 * (box.width - 44 * k) - 52 * k, box.top + 68 * k]
  return [box.left + 148 * k, box.top + 64 * k]
}

export function HomeTraveller() {
  const story = useHomeStoryState()
  const root = useRef<HTMLDivElement>(null)
  const loc = locOf(story.act, story.rangeOpen)
  const live = story.act === loc
  const calm = story.calm >= 0 ? String(story.calm) : 'n'

  useEffect(() => {
    const node = root.current
    const home = node?.parentElement
    if (!node || !home) return
    let ready: ReturnType<typeof setTimeout> | undefined
    const place = () => {
      const { act, rangeOpen, mode } = homeStory.get()
      const where = locOf(act, rangeOpen)
      const box = home.querySelector(PLACES[where])?.getBoundingClientRect()
      if (!box || box.width === 0 || getComputedStyle(node).display === 'none') return
      const origin = home.getBoundingClientRect()
      const [x, y] = spot(where, mode, box, rootScale())
      node.style.transform = `translate3d(${(x - origin.left).toFixed(1)}px, ${(y - origin.top).toFixed(1)}px, 0)`
      if (!homeStory.get().ready && !ready) ready = setTimeout(() => homeStory.setReady(true), 40)
    }
    let frame = 0
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0
        place()
      })
    }
    const timers: Array<ReturnType<typeof setTimeout>> = [setTimeout(place, 60), setTimeout(place, 700)]
    let alive = true
    document.fonts?.ready.then(() => {
      if (alive) timers.push(setTimeout(place, 30))
    }).catch(() => undefined)
    let resized: ReturnType<typeof setTimeout> | undefined
    const resize = () => {
      clearTimeout(resized)
      resized = setTimeout(place, 120)
    }
    // A disclosure that opens or closes moves what is under it once it has settled.
    const toggled = () => timers.push(setTimeout(place, 460))
    // Figures arriving (the pools table) change the page's height, and everything below it moves.
    const grown = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(soon)
    grown?.observe(home)
    // The place changes with the story: the act, the range folding, the function on the stage.
    let last = ''
    const unsubscribe = homeStory.subscribe(() => {
      const { act, rangeOpen, mode } = homeStory.get()
      const key = `${locOf(act, rangeOpen)}:${mode}`
      if (key !== last) {
        last = key
        place()
      }
    })
    window.addEventListener('resize', resize, { passive: true })
    home.addEventListener('toggle', toggled, true)
    return () => {
      alive = false
      if (frame) cancelAnimationFrame(frame)
      for (const timer of timers) clearTimeout(timer)
      clearTimeout(resized)
      clearTimeout(ready)
      grown?.disconnect()
      unsubscribe()
      window.removeEventListener('resize', resize)
      home.removeEventListener('toggle', toggled, true)
    }
  }, [])

  return (
    <div
      ref={root}
      className={cx('dm-trav', `at-${loc}`, `m-${story.mode}`, `fp-${story.fundKey}`, `fk-${story.fnKey}`, `cm-${calm}`, live && 'live', story.ready && 'is-ready')}
      data-home-traveller=""
      aria-hidden="true"
    >
      <span className={`dm-tv-shadow hop-${story.hop}`} />
      <div className={`dm-tv-hop hop-${story.hop}`}>
        <div className="dm-tv-act">
          <div className="dm-tv-persp">
            <div className="dm-tv-3d">
              {SLABS.map((z) => <span key={z} className={`dm-tv-slab dm-tv-y${z}`} />)}
              <div className="dm-tv-face">
                <span className="dm-tv-groove" />
                {PIPS.map((p) => <span key={p} className={`dm-tv-pip dm-tv-q${p}`} />)}
                <span className="dm-tv-glare" />
                <span className="dm-tv-glare2" />
                <span className="dm-tv-shade" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
