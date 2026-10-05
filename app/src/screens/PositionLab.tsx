// The screens' own styles (styles/screens.css, F8): loaded with the first screen that needs them, never on Home's first paint.
import '../styles/screens.css'
import { lazy, Suspense, useMemo, useState } from 'react'
import type { PositionActionsProps } from '../components/positions/PositionActions'
import type { HeldDepositsProps } from '../components/positions/HeldDeposits'
import type { RangeLabSpec } from './PositionDetail'

/**
 * Test builds only (App.tsx routes `#/position-lab/<spec>` behind
 * __DOMINO_TEST_HOOKS__, so no deployable build carries it): the owner's
 * position actions and held-deposit refunds mounted alone, with the props a
 * Positions screen would pass, for tests/position-actions.browser.test.mjs.
 * The spec is the URI-encoded JSON of those props, less `onChanged`, which
 * here counts the page's re-reads in `data-changes`.
 *
 * The two components are opened exactly as the Positions screens open them:
 * lazily, behind the wallet flag.
 */
const couldNotLoad = () => ({ default: () => <p role="alert">This section couldn’t load. Reload to try again.</p> })
const PositionActions = __DOMINO_WALLET_SESSION__ ? lazy(() => import('../components/positions/PositionActions').catch(couldNotLoad)) : null
const HeldDeposits = __DOMINO_WALLET_SESSION__ ? lazy(() => import('../components/positions/HeldDeposits').catch(couldNotLoad)) : null

/**
 * Added 2026-10-03 (the owner's point 10, the Price range chart): `range`, a position's Price range card alone, as a
 * position's page draws it (screens/PositionDetail.tsx RangeLab, from that page's own chunk), from a position as the page
 * reads one, for tests/price-range.browser.test.mjs's extreme prices and ranges. The pool's square-root price is its
 * tick's own (v4-core's TickMath, computed by the suite), so the page's own checks pass as they do on chain.
 */
const noRangeLab = (_props: { spec: RangeLabSpec }) => null
const RangeLab = lazy(() => import('./PositionDetail').then((module) => ({ default: module.RangeLab ?? noRangeLab })))

interface LabSpec { position?: Omit<PositionActionsProps, 'onChanged'>; held?: Omit<HeldDepositsProps, 'onChanged'>; range?: RangeLabSpec }

function labSpec(text: string): LabSpec | null {
  try {
    const value: unknown = JSON.parse(decodeURIComponent(text))
    return value && typeof value === 'object' ? (value as LabSpec) : null
  } catch {
    return null
  }
}

export default function PositionLab({ spec }: { spec: string }) {
  const [changes, setChanges] = useState(0)
  const parsed = useMemo(() => labSpec(spec), [spec])
  const count = () => setChanges((n) => n + 1)
  return (
    <main className="dm-page grid content-start gap-6" data-position-lab={parsed ? 'ready' : 'invalid'} data-changes={changes}>
      {PositionActions && parsed?.position && (
        <Suspense fallback={null}>
          <PositionActions {...parsed.position} onChanged={count} />
        </Suspense>
      )}
      {HeldDeposits && parsed?.held && (
        <Suspense fallback={null}>
          <HeldDeposits {...parsed.held} onChanged={count} />
        </Suspense>
      )}
      {parsed?.range && (
        <Suspense fallback={null}>
          <RangeLab spec={parsed.range} />
        </Suspense>
      )}
    </main>
  )
}
