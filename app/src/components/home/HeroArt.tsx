import { cx } from '../ui'

const SLABS = [8, 7, 6, 5, 4, 3, 2, 1] as const
const PIPS = [1, 2, 3, 4, 5] as const

/**
 * The brand's signature object (V4 §4.7): one Tangerine domino, 2|3 on a diagonal, standing in the light. Eight slabs
 * give it depth, the face carries the groove, the five pips and two glares that follow the pointer (HomeLight.tsx).
 * A domino, never a die, and nothing sits behind it. Decoration only: no price, return or state.
 *
 * `.dm-hero-art .dm-sculpture-front` keep their names: the float wrapper repeats a barely visible drift while the hero
 * is in view (render.test), on an inner wrapper so the one-off entrance (`dm-k-tile`) never fights it. It rests under
 * reduced motion and `dm-still`, and pauses out of view.
 */
export function HeroArt({ className, running }: { className?: string; running?: boolean }) {
  return (
    <div className={cx('dm-hero-art', running && 'is-running', className)} aria-hidden="true">
      <span className="dm-tile-shadow dm-k-shadow" />
      <div className="dm-tile-in dm-k-tile">
        <div className="dm-sculpture-front">
          {/* The ember rests where this tile's light does (EmberLight.tsx: just above its top left corner). */}
          <div className="dm-tile-persp" data-home-tile="" data-ember-rest="">
            <div className="dm-tile-3d">
              {SLABS.map((z) => <span key={z} className={`dm-tile-slab dm-tile-z${z}`} />)}
              <div className="dm-tile-face">
                <span className="dm-tile-groove" />
                {PIPS.map((p) => <span key={p} className={`dm-tile-pip dm-tile-p${p} dm-k-pip`} />)}
                <span className="dm-tile-glare" />
                <span className="dm-tile-glare2" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
