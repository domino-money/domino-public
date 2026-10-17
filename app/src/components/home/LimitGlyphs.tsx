/*
 * The four calm topics' glyphs (V4 "zg"): 28px strokes that act their topic out when the topic opens (the dot leaves
 * its range, the line falls, the key turns, the loop goes round). Decoration only, beside each topic's own words.
 */

export function GlyphRange() {
  return <svg className="dm-zg" viewBox="0 0 36 36" aria-hidden="true" focusable="false"><rect className="dm-zg-band" x="3" y="11" width="20" height="14" rx="4" /><circle className="dm-zg-dot dm-zg-f" cx="13" cy="18" r="3" /></svg>
}

export function GlyphValue() {
  return <svg className="dm-zg" viewBox="0 0 36 36" aria-hidden="true" focusable="false"><path className="dm-zg-line" pathLength={100} d="M3 10 L11 17 L17 14 L28 25" /><path className="dm-zg-head" d="M21.5 25.5 H28.5 V18.5" /></svg>
}

export function GlyphKey() {
  return <svg className="dm-zg" viewBox="0 0 36 36" aria-hidden="true" focusable="false"><g className="dm-zg-key"><circle cx="11" cy="18" r="6" /><path d="M17 18 H32 M27 18 V23 M31 18 V22" /></g></svg>
}

export function GlyphLoop() {
  return <svg className="dm-zg" viewBox="0 0 36 36" aria-hidden="true" focusable="false"><g className="dm-zg-loop"><path d="M27.5 12.5 A11 11 0 1 0 29 21" /><path d="M28.5 6 V12.8 H21.7" /></g><circle className="dm-zg-f" cx="18" cy="18" r="2.6" /></svg>
}
