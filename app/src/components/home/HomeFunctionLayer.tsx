import { useInView } from './Vignettes'
import type { HomeAutomationKind } from './HomeAutomationArt'

/*
 * One function's own parts of the functions stage (V4 "fx", the approved prototype's scene split by function). The
 * stage itself (FeatureCards) holds what the three share: the floor, your position's glass slab with its price line,
 * and the tile's place. Each row's layer lies exactly over the stage, so the three pictures are one: the row in use
 * shows its labels, arcs and objects, the others fade theirs out, and while the reader is in this place its story
 * plays once (fees fly as embers along the dotted arcs) and holds its last frame. Decoration only (aria-hidden).
 *
 * The root keeps the shared art contract (.dm-art + is-running while 30% of it is in view, paused otherwise, still under
 * reduced motion). .dm-fx-idle is an empty, unseen keeper whose loop marks a running scene for the art checks; it moves
 * nothing a reader can see.
 */

/** The small 3D tile that rises on the higher range (Domino-compound). */
function SmallTile() {
  return (
    <span className="dm-fx-tb">
      <span className="dm-fx-tb-in">
        <span className="dm-mt-persp">
          <span className="dm-mt-3d">
            {[5, 4, 3, 2, 1].map((z) => <span key={z} className={`dm-mt-slab dm-mt-w${z}`} />)}
            <span className="dm-mt-face">
              <span className="dm-mt-groove" />
              {[1, 2, 3, 4, 5].map((p) => <span key={p} className={`dm-mt-pip dm-mt-m${p}`} />)}
            </span>
          </span>
        </span>
      </span>
    </span>
  )
}

/** A range as a glass slab: depth, the glass, its lit fill (the slab's light). */
function Slab({ className }: { className: string }) {
  return (
    <span className={className}>
      <span className="dm-gl-depth" />
      <span className="dm-gl"><span className="dm-gl-fill" /></span>
    </span>
  )
}

export function HomeFunctionLayer({ kind }: { kind: HomeAutomationKind }) {
  const [ref, running] = useInView<HTMLDivElement>(0.3)
  return (
    <div ref={ref} className={`dm-art dm-automation-story-art as-${kind}${running ? ' is-running' : ''}`} aria-hidden="true">
      <span className="dm-fx-idle" />
      <div className="dm-fx-scene">
        {kind === 'compound' && <>
          <svg className="dm-fx-gd" viewBox="0 0 624 440" focusable="false">
            <path d="M196 330 Q 246 -106.6 296 190" />
            <path d="M428 330 Q 379 -82 330 196" />
          </svg>
          <span className="dm-fx-em dm-fx-c1" /><span className="dm-fx-em dm-fx-c2" /><span className="dm-fx-em dm-fx-c3" />
          <span className="dm-fx-lb dm-fx-acc dm-fx-lb-c1">Earned fees</span>
          <span className="dm-fx-lb dm-fx-lb-c2">Same position. Same range.</span>
        </>}
        {kind === 'domino' && <>
          <Slab className="dm-fx-bb" />
          <SmallTile />
          <svg className="dm-fx-gd" viewBox="0 0 624 440" focusable="false">
            <path d="M208 150 Q 350 -94.9 492 226" />
            <path className="dm-fx-ar" d="M492.6 219 L492 226 L486.4 221.7" />
          </svg>
          <span className="dm-fx-em dm-fx-d1" /><span className="dm-fx-em dm-fx-d2" /><span className="dm-fx-em dm-fx-d3" />
          <span className="dm-fx-lb dm-fx-acc dm-fx-lb-d1">Only earned fees move</span>
          <span className="dm-fx-lb dm-fx-lb-d2">Original stays</span>
          <span className="dm-fx-lb dm-fx-lb-d3">Higher range</span>
        </>}
        {kind === 'autoexit' && <>
          <span className="dm-fx-w">
            <span className="dm-fx-w-depth" />
            <span className="dm-fx-w-card" />
            <span className="dm-fx-w-body" />
            <span className="dm-fx-w-pocket"><span className="dm-fx-w-coin dm-fx-w-ca" /><span className="dm-fx-w-coin dm-fx-w-cb" /></span>
          </span>
          <svg className="dm-fx-gd" viewBox="0 0 624 440" focusable="false">
            <path d="M352 326 Q 451 106.1 550 318" />
            <path className="dm-fx-ar" d="M550.4 311 L550 318 L544.4 313.9" />
          </svg>
          <span className="dm-fx-em dm-fx-x1" /><span className="dm-fx-em dm-fx-x2" />
          <span className="dm-fx-lb dm-fx-acc dm-fx-lb-x1">Price reaches<br />your limit</span>
          <span className="dm-fx-lb dm-fx-lb-x2">Position closes</span>
          <span className="dm-fx-lb dm-fx-lb-x3">Your wallet</span>
        </>}
      </div>
    </div>
  )
}
