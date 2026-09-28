import { Skeleton } from '../../ui'
import { FeesSkeleton } from './FeesSkeleton'

/**
 * A position's page before its read answers (DESIGN-V2 §12.2): the title's
 * bubbles, the key figures' four tiles of bubbles (2026-09-27: the value, the
 * fees, Your APR and the price), the fees module's skeleton and the Price range
 * card. Rows the height of the loaded layout; nothing here carries a
 * data-position-* attribute but the wrapper's own.
 */
export function PositionSkeleton() {
  return (
    <>
      <div className="dm-pos-title" aria-hidden="true">
        <div className="dm-pos-name">
          <Skeleton className="dm-pos-skel-mark" />
          <div className="grid gap-2">
            <Skeleton className="dm-pos-skel-h1" />
            <Skeleton className="dm-pos-skel-chips" />
          </div>
        </div>
      </div>
      <div className="dm-stats dm-stats--4 dm-stats--tiles dm-pos-stats" aria-hidden="true">
        {(['principal', 'fees', 'apr', 'price'] as const).map((cell) => (
          <div key={cell} className="dm-pos-stat dm-pos-skel-cell" data-cell={cell}>
            <Skeleton className="dm-pos-skel-label" />
            <Skeleton className="dm-pos-skel-hero" />
            <Skeleton className="dm-pos-skel-line" />
          </div>
        ))}
      </div>
      <div className="dm-card dm-fees" aria-hidden="true">
        <div className="dm-fees-head">
          <Skeleton className="dm-pos-skel-title" />
        </div>
        <FeesSkeleton />
      </div>
      <div className="dm-pos-grid" aria-hidden="true">
        <div className="dm-card dm-pos-card dm-pos-skel-card">
          <Skeleton className="dm-pos-skel-title" />
        </div>
      </div>
    </>
  )
}
