/**
 * Where the read screens plug into the app.
 *
 * Every export here is `null` in the default build: `__DOMINO_READ_MODE__` is
 * a constant, so each ternary folds, the lazy imports go with it, and dist
 * gets no screens chunk (tests/render.test.mjs checks there is one bundle and
 * none of the screens' words). In the fixture and bridge-test builds each slot
 * loads the screens chunk on first render, inside a boundary: if the chunk
 * cannot load (an expired beta cookie turns /assets/* into a 401, or a
 * redeploy removed it), the rest of the page keeps working and the slot says so.
 *
 * The slots take no data props. Nothing read from chain can flow back into
 * the rest of the app through them.
 */
import { Component, lazy, type ReactNode } from 'react'
import type { Market } from '../../markets'
import { COPY } from './copy'
import type { ChainSelectionSlotProps } from './pickerChrome'

// Every build reads now: F3 removed the sample mode, so the screens are part
// of what deploys. The constant stays so the chunk keeps its own boundary.
const READ_SCREENS = true

interface BoundaryProps {
  fallback: ReactNode
  onFail?: () => void
  children: ReactNode
}

export const SlotBoundary = READ_SCREENS
  ? class SlotBoundary extends Component<BoundaryProps, { failed: boolean }> {
      state = { failed: false }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      componentDidCatch() {
        this.props.onFail?.()
      }
      render() {
        return this.state.failed ? this.props.fallback : this.props.children
      }
    }
  : null

export const ChainPositionsSlot = READ_SCREENS ? lazy(() => import('../../../components/read/screens').then((m) => ({ default: m.ChainPositionsSection }))) : null

export const ChainSelectionSlot = READ_SCREENS
  ? lazy<(props: ChainSelectionSlotProps) => ReactNode>(() => import('../../../components/read/screens').then((m) => ({ default: m.ChainSelectionPanel })))
  : null

export const PoolFiguresSlot = READ_SCREENS
  ? lazy<(props: { market: Market; onClose: () => void }) => ReactNode>(() => import('../../../components/read/screens').then((m) => ({ default: m.PoolFiguresDialog })))
  : null

export const PoolFigureNotesSlot = READ_SCREENS
  ? lazy<(props: { markets: Market[] }) => ReactNode>(() => import('../../../components/read/screens').then((m) => ({ default: m.PoolFigureNotes })))
  : null

export const SlotFailed = READ_SCREENS
  ? function SlotFailed() {
      return (
        <p role="status" className="text-[13px] text-fg-muted" data-slot-failed="">
          {COPY.slotFailed}
        </p>
      )
    }
  : null
