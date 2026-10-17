/**
 * V4's empty-state tile (the approved Positions pages, positions-empty.html / positions-guest.html): the brand's 3D domino
 * scaled down, a double blank whose five pips fill in when you reach for the action beside it. `dark` is the same tile
 * unlit, where there is nothing to do. Decoration only: no text, hidden from assistive technology; its look is
 * styles/v4-positions.css (.dm-etile), and it never sits behind content.
 */
export function EmptyDomino({ dark = false }: { dark?: boolean }) {
  return (
    <span className={dark ? 'dm-etile dm-etile--dark' : 'dm-etile'} aria-hidden="true">
      <span className="dm-etile-sh" />
      <span className="dm-etile-tin">
        <span className="dm-etile-3d">
          <span className="dm-etile-slab dm-etile-z8" />
          <span className="dm-etile-slab dm-etile-z7" />
          <span className="dm-etile-slab dm-etile-z6" />
          <span className="dm-etile-slab dm-etile-z5" />
          <span className="dm-etile-slab dm-etile-z4" />
          <span className="dm-etile-slab dm-etile-z3" />
          <span className="dm-etile-slab dm-etile-z2" />
          <span className="dm-etile-slab dm-etile-z1" />
          <span className="dm-etile-face">
            <span className="dm-etile-groove" />
            <span className="dm-etile-pip dm-etile-p1" />
            <span className="dm-etile-pip dm-etile-p2" />
            <span className="dm-etile-pip dm-etile-p3" />
            <span className="dm-etile-pip dm-etile-p4" />
            <span className="dm-etile-pip dm-etile-p5" />
          </span>
        </span>
      </span>
    </span>
  )
}
