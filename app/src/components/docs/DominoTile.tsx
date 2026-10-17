import { useEffect, useRef } from 'react'
import { rootScale } from '../../lib/rootScale'

/** The tile's depth: eight slabs, back to front (styles/v4-system.css colours them by position). */
const SLABS = [8, 7, 6, 5, 4, 3, 2, 1].map((n) => <span key={n} />)

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
const round = (value: number) => Math.round(value * 10) / 10
/** Design px as rem, so the glares and the shadow's travel scale with the page as the tile does. */
const rem = (px: number) => `${round(px) / 16}rem`

/**
 * The prototype's light on the tile (V4, site/docs.html and site/404.html): with the pointer anywhere on the page the tile
 * turns a little toward it, its two glares slide to where the light falls on its face and its shadow leans away, all
 * gliding in 1s (styles/v4-system.css); without one (it left the window) everything returns to the resting pose, the one
 * the CSS draws by default. Positions in design px: the tile's box, its centre and the pointer, as the prototype measured
 * them. Fine pointers only; one animation frame at a time; it writes custom properties on the tile and its shadow alone.
 */
function useTileLight(tile: { current: HTMLDivElement | null }, shadow: { current: HTMLSpanElement | null }, fallen: boolean) {
  useEffect(() => {
    const element = tile.current
    const floor = shadow.current
    if (!element || !floor || typeof window.matchMedia !== 'function' || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return
    let frame = 0
    let x = 0
    let y = 0
    let on = false
    const draw = () => {
      frame = 0
      if (!on) {
        for (const name of ['--rx', '--ry', '--glx', '--gly', '--g2x', '--g2y']) element.style.removeProperty(name)
        floor.style.removeProperty('--shx')
        floor.style.removeProperty('--shs')
        return
      }
      const scale = rootScale()
      const box = element.getBoundingClientRect()
      const left = box.left / scale
      const top = box.top / scale
      const px = x / scale
      const py = y / scale
      let values: number[]
      let shx: number
      let shs: number
      if (fallen) {
        const cx = left + 353
        const cy = top + 236
        const dxn = clamp((px - cx) / 620, -1, 1)
        const dyn = clamp((py - cy) / 480, -1, 1)
        const lx = py - top - 142
        const ly = 518 - (px - left)
        values = [dxn * 7, 12 - dyn * 6, lx - 210, ly - 210, lx - 120, ly - 120]
        shx = clamp(-(px - cx) * 0.06, -34, 34)
        shs = 1 + Math.abs(dxn) * 0.12
      } else {
        const width = box.width / scale
        const height = box.height / scale
        const cx = left + width / 2
        const cy = top + height / 2
        const dxn = clamp((px - cx) / 520, -1, 1)
        const dyn = clamp((py - cy) / 420, -1, 1)
        // The glares sit on the face at the tile's own size: the stage draws it at half size.
        const k = width > 0 ? width / 188 : 0.5
        values = [6 - dyn * 9, -18 + dxn * 13, (px - left) / k - 210, (py - top) / k - 210, (px - left) / k - 120, (py - top) / k - 120]
        shx = clamp(-(px - cx) * 0.05, -22, 22)
        shs = 1 + Math.abs(dxn) * 0.18
      }
      element.style.setProperty('--rx', `${round(values[0])}deg`)
      element.style.setProperty('--ry', `${round(values[1])}deg`)
      element.style.setProperty('--glx', rem(values[2]))
      element.style.setProperty('--gly', rem(values[3]))
      element.style.setProperty('--g2x', rem(values[4]))
      element.style.setProperty('--g2y', rem(values[5]))
      floor.style.setProperty('--shx', rem(shx))
      floor.style.setProperty('--shs', String(Math.round(shs * 1000) / 1000))
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
    const out = (event: PointerEvent) => {
      if (event.relatedTarget !== null || event.pointerType === 'touch') return
      on = false
      schedule()
    }
    window.addEventListener('pointermove', move, { passive: true })
    document.addEventListener('pointerout', out, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      document.removeEventListener('pointerout', out)
    }
  }, [tile, shadow, fallen])
}

/**
 * The brand's tile (V4 §4.7, 2026-10-16): a domino, never a die, its face a 2|3 with the groove between, drawn in CSS
 * (styles/v4-system.css .dm-tile, eager, as Not found is part of the entry). Its shadow on the floor comes first, for
 * the stage it stands on to place. Decoration only: the caller's stage is aria-hidden and holds no link. `fallen` lays
 * it on its side, tipped over its right foot (Not found); otherwise it stands at its resting angle (the Docs index).
 * Either way it follows the pointer's light (useTileLight).
 */
export function DominoTile({ fallen = false }: { fallen?: boolean }) {
  const tileRef = useRef<HTMLDivElement>(null)
  const shadowRef = useRef<HTMLSpanElement>(null)
  useTileLight(tileRef, shadowRef, fallen)
  const tile = (
    <div className="dm-tile-3d">
      {SLABS}
      <div>
        <b />
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
    </div>
  )
  return (
    <>
      <span ref={shadowRef} className="dm-tile-shadow" />
      <div ref={tileRef} className="dm-tile">
        {fallen ? <div className="dm-tile-fall">{tile}</div> : tile}
      </div>
    </>
  )
}
