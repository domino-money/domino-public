import { useCallback, useEffect, useRef, useState } from 'react'
import type { StageKey, StageRun } from './AutomateStage'

/*
 * Which function Automate's stage performs (V4, the owner's approved site/automate.html, pick() and settle()). Presentational
 * state only: the chosen row is Auto-compound at first and stays chosen after the pointer leaves.
 *
 *   - Pointing at a row chooses it once the pointer has settled: 200 ms in, and not still sweeping past it (two samples
 *     under 70 ms apart moving faster than .45 px/ms try again 90 ms later). Leaving a row only cancels that.
 *   - A click chooses at once; clicking the chosen row again replays its demonstration, unless the last one started under
 *     400 ms ago. Focus inside a row chooses it too (no replay).
 *
 * The rows are the existing [data-automation-card] articles: native listeners on them (no handler props on an <article>),
 * nothing about their links, buttons or words changes.
 */

const AT: Record<StageKey, number> = { compound: 233, domino: 123, autoexit: 64 }
const flip = (run: StageRun): StageRun => (run === 'a' ? 'b' : 'a')

export interface AutomateChoice {
  chosen: StageKey
  run: StageRun
  dd: number
  lift: '' | StageRun
  tilt: 'r' | 'l'
}

const keyOf = (card: string | undefined): StageKey | null =>
  card === 'compound' ? 'compound' : card === 'domino' ? 'domino' : card === 'protection' ? 'autoexit' : null

export function useAutomateChoice() {
  const gridRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<AutomateChoice>({ chosen: 'compound', run: 'a', dd: 0.75, lift: '', tilt: 'l' })
  // The latest choice, read by the listeners (they are attached once); written only with the state itself.
  const latestChoice = useRef(state)
  const ranAt = useRef(0)

  const pick = useCallback((key: StageKey, force: boolean) => {
    const current = latestChoice.current
    const same = key === current.chosen
    if (same && !force) return
    const now = Date.now()
    const recent = now - ranAt.current < 400
    if (same && recent) return
    ranAt.current = now
    const next: AutomateChoice = { ...current, chosen: key, dd: 0.2, run: recent ? current.run : flip(current.run) }
    if (!same) {
      next.lift = current.lift === 'a' ? 'b' : 'a'
      next.tilt = AT[key] > AT[current.chosen] ? 'r' : 'l'
    }
    latestChoice.current = next
    setState(next)
  }, [])

  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let previous: { y: number; t: number } | null = null
    let latest: { y: number; t: number } | null = null
    const track = (event: MouseEvent) => {
      previous = latest
      latest = { y: event.clientY, t: Date.now() }
    }
    const settle = (key: StageKey) => {
      const now = Date.now()
      const sweeping = !!(previous && latest && now - latest.t < 70 && Math.abs(latest.y - previous.y) / Math.max(1, latest.t - previous.t) > 0.45)
      if (sweeping) {
        timer = setTimeout(() => settle(key), 90)
        return
      }
      pick(key, false)
    }
    const offs: Array<() => void> = []
    for (const card of Array.from(grid.querySelectorAll<HTMLElement>(':scope > [data-automation-card]'))) {
      const key = keyOf(card.dataset.automationCard)
      if (!key) continue
      const enter = () => {
        clearTimeout(timer)
        timer = setTimeout(() => settle(key), 200)
      }
      const leave = () => clearTimeout(timer)
      const click = () => {
        clearTimeout(timer)
        pick(key, true)
      }
      const focus = () => pick(key, false)
      card.addEventListener('mouseenter', enter)
      card.addEventListener('mouseleave', leave)
      card.addEventListener('click', click)
      card.addEventListener('focusin', focus)
      offs.push(() => {
        card.removeEventListener('mouseenter', enter)
        card.removeEventListener('mouseleave', leave)
        card.removeEventListener('click', click)
        card.removeEventListener('focusin', focus)
      })
    }
    window.addEventListener('mousemove', track, { passive: true })
    return () => {
      clearTimeout(timer)
      window.removeEventListener('mousemove', track)
      for (const off of offs) off()
    }
  }, [pick])

  return { gridRef, ...state }
}
