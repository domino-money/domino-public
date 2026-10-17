/** The tile's depth: eight slabs, back to front (styles/v4-system.css colours them by position). */
const SLABS = [8, 7, 6, 5, 4, 3, 2, 1].map((n) => <span key={n} />)

/**
 * The brand's tile (V4 §4.7, 2026-10-16): a domino, never a die, its face a 2|3 with the groove between, drawn in CSS
 * (styles/v4-system.css .dm-tile, eager, as Not found is part of the entry). Its shadow on the floor comes first, for
 * the stage it stands on to place. Decoration only: the caller's stage is aria-hidden and holds no link. `fallen` lays
 * it on its side, tipped over its right foot (Not found); otherwise it stands at its resting angle (the Docs index).
 */
export function DominoTile({ fallen = false }: { fallen?: boolean }) {
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
      <span className="dm-tile-shadow" />
      <div className="dm-tile">{fallen ? <div className="dm-tile-fall">{tile}</div> : tile}</div>
    </>
  )
}
