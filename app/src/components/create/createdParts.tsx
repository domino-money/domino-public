import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CREATE } from '../../lib/create/copy'
import { stilled } from '../../lib/motion/stilled'
import { rootScale } from '../../lib/rootScale'
import { DominoTile } from '../docs/DominoTile'

/*
 * The created view's look (V4, site/new.html .made, 2026-10-17), shared by today's created view (CreatedNext.tsx) and
 * Domino V2's (src/v2in/journey/ReviewStage.tsx Created). Presentation only: nothing here reads, links or says anything
 * of its own; every word, link and data attribute stays where the views write them.
 */

const findSlot = (): HTMLElement | null => (typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('[data-created-slot]'))

/**
 * Draws `children` at the top of Review's body (the review stack's empty [data-created-slot], StageReview.tsx and
 * ReviewStage.tsx), where the approved page opens the created block above Your position, instead of in the narrow
 * column of Create position, where the control renders it. Rendered in place while no slot is there.
 */
export function InCreatedSlot({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(findSlot)
  // Found again if the review stack is drawn anew (or only after this view mounted).
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(() => setSlot((was) => (was?.isConnected && was === findSlot() ? was : findSlot())))
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  return slot ? createPortal(children, slot) : <>{children}</>
}

/**
 * The position, now a tile you hold (new.html .made-st): the brand's sculptural domino at a third of its size, landing
 * once on its floor shadow (styles/v4-newposition.css), then turning a little toward the pointer (rx = 6 - dy * 9,
 * ry = -18 + dx * 13, dx and dy the pointer's distance from the tile over 620 and 480 design pixels, clamped). Never
 * with a touch, never while motion is stilled. Decoration only: aria-hidden, no text.
 */
export function CreatedTile() {
  const stage = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = stage.current
    if (!node || typeof window === 'undefined') return
    let frame = 0
    let x = 0
    let y = 0
    const clamp = (n: number) => Math.max(-1, Math.min(1, n))
    const turn = () => {
      frame = 0
      const tile = node.querySelector<HTMLElement>('.dm-tile-3d')
      if (!tile || stilled()) return
      const box = node.getBoundingClientRect()
      const scale = rootScale()
      const dx = clamp((x - (box.left + box.width / 2)) / (620 * scale))
      const dy = clamp((y - (box.top + box.height / 2)) / (480 * scale))
      tile.style.setProperty('--rx', `${(6 - dy * 9).toFixed(1)}deg`)
      tile.style.setProperty('--ry', `${(-18 + dx * 13).toFixed(1)}deg`)
    }
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      x = event.clientX
      y = event.clientY
      if (!frame) frame = requestAnimationFrame(turn)
    }
    window.addEventListener('pointermove', move, { passive: true })
    return () => {
      window.removeEventListener('pointermove', move)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])
  return (
    <div ref={stage} className="dm-created-st" aria-hidden="true">
      <span className="dm-created-shadow" />
      <div className="dm-created-land">
        <DominoTile />
      </div>
    </div>
  )
}

export type CreatedArtKind = 'plain' | 'compound' | 'domino' | 'autoexit'

/**
 * The four ways on as line drawings (new.html .cx-art, 44 × 44, currentColor): a tile (plain), a tile in a turning
 * arrow (Auto-compound), two tiles with a dashed hop (Domino-compound), a tile, its range's end and an arrow out
 * (Auto-exit). The moving part of each is its .ca-* group (it turns or steps on the row's hover, in CSS).
 */
export function CreatedArt({ kind }: { kind: CreatedArtKind }) {
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" fill="none" aria-hidden="true" focusable="false">
      {kind === 'plain' && (
        <g className="ca-t">
          <rect x="14.5" y="5.5" width="15" height="33" rx="4" stroke="currentColor" strokeWidth="1.4" />
          <path d="M17.5 22h9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <circle cx="18.7" cy="11" r="1.4" fill="currentColor" />
          <circle cx="25.3" cy="16" r="1.4" fill="currentColor" />
          <circle cx="18.5" cy="27.4" r="1.4" fill="currentColor" />
          <circle cx="22" cy="30.9" r="1.4" fill="currentColor" />
          <circle cx="25.5" cy="34.4" r="1.4" fill="currentColor" />
        </g>
      )}
      {kind === 'compound' && (
        <>
          <rect x="16.5" y="11.5" width="11" height="21" rx="3" stroke="currentColor" strokeWidth="1.4" />
          <path d="M18.6 22h6.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
          <circle cx="19.7" cy="15.2" r="1.1" fill="currentColor" />
          <circle cx="24.3" cy="18.6" r="1.1" fill="currentColor" />
          <circle cx="19.5" cy="25.6" r="1.1" fill="currentColor" />
          <circle cx="22" cy="27.8" r="1.1" fill="currentColor" />
          <circle cx="24.5" cy="30" r="1.1" fill="currentColor" />
          <g className="ca-r">
            <path d="M37.4 16.6A16.5 16.5 0 1 1 29.8 7.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <path d="M26.6 5.6l3.4 1.7-1.6 3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </g>
        </>
      )}
      {kind === 'domino' && (
        <>
          <rect x="7.5" y="17.5" width="11" height="21" rx="3" stroke="currentColor" strokeWidth="1.4" />
          <path d="M9.6 28h6.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
          <circle cx="13" cy="22.6" r="1.1" fill="currentColor" />
          <circle cx="13" cy="33.4" r="1.1" fill="currentColor" />
          <path d="M13 13.5c0-4.2 3.2-7 9-7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeDasharray="1.6 2.6" />
          <g className="ca-u">
            <rect x="25.5" y="5.5" width="11" height="21" rx="3" stroke="currentColor" strokeWidth="1.4" />
            <path d="M27.6 16h6.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
            <circle cx="31" cy="10.6" r="1.1" fill="currentColor" />
            <circle cx="29" cy="20.4" r="1.1" fill="currentColor" />
            <circle cx="33" cy="22.4" r="1.1" fill="currentColor" />
          </g>
        </>
      )}
      {kind === 'autoexit' && (
        <>
          <rect x="9.5" y="11.5" width="11" height="21" rx="3" stroke="currentColor" strokeWidth="1.4" />
          <path d="M11.6 22h6.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
          <circle cx="15" cy="16.4" r="1.1" fill="currentColor" />
          <circle cx="13" cy="26" r="1.1" fill="currentColor" />
          <circle cx="17" cy="28.4" r="1.1" fill="currentColor" />
          <path d="M28.5 6v32" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeDasharray="2 3" />
          <g className="ca-x">
            <path d="M24 22h14M34.5 18.5 38 22l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </g>
        </>
      )}
    </svg>
  )
}

/**
 * The quiet line button under "Position created" (new.html .btn-line.alt): New position, which starts a fresh flow
 * (screens/NewPosition.tsx restarts the flow on a link to the page it is on, or on any hash change).
 */
export function NewPositionAgain() {
  return (
    <a href="#/new" className="dm-np-again">
      {CREATE.page.title}
    </a>
  )
}
