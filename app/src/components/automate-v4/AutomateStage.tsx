import type { CSSProperties } from 'react'
import { useSvgId } from '../charts/series'
import { cx } from '../ui'

/*
 * Automate's stage (V4, the owner's approved site/automate.html .stage2): one scene per function drawn on near-black
 * plates, and the one sculptural tile that travels to the chosen function. A choice replays that function's
 * demonstration once (`run` swaps a/b so every keyframe restarts) and it rests on its final frame; nothing loops.
 * The set up card of Set up automation (site/sequence.html .dn-art) shows the same scene, without its labels.
 *
 * Decoration only: aria-hidden, no focus, no pointer. Its SVGs carry none of the classes art.css and automate.css style
 * (dm-art, dm-mode-art, dm-automation-story-art), which the tests count. The travelling fees are drawn inside each
 * scene's 560 x 540 drawing, so their motion paths share its units at every size. Styled by v4-automate.css.
 */

export type StageKey = 'compound' | 'domino' | 'autoexit'
export type StageRun = 'a' | 'b'

const SLABS = [8, 7, 6, 5, 4, 3, 2, 1] as const
const PIPS = [1, 2, 3, 4, 5] as const
const ALL: readonly StageKey[] = ['compound', 'domino', 'autoexit']

const path = (d: string) => ({ offsetPath: `path('${d}')` }) as CSSProperties
const FEE_C = path('M136 372 C136 128 424 128 424 372 L412 402')
const FEE_D = path('M232 392 C246 226 352 150 420 202 L420 236')
const TOKEN_A = path('M290 296 C304 176 424 176 432 292 L462 335')
const TOKEN_B = path('M290 296 C304 176 424 176 432 292 L475 335')

/** A fee: 8px of green with a 1px light lip (Domino's own coin, no halo). */
function Fee({ style, delay }: { style: CSSProperties; delay?: string }) {
  return (
    <g className={cx('dz an', delay)} style={style}>
      <circle r="4" fill="#5fd09a" />
      <path d="M-2.9 -2.75A4 4 0 0 1 2.9 -2.75" fill="none" stroke="rgb(255 255 255 / .35)" />
    </g>
  )
}

/** A token on its way to the wallet: 11px, with the same lip. */
function Token({ style, delay, fill }: { style: CSSProperties; delay: string; fill: string }) {
  return (
    <g className={cx('dz dz-x an', delay)} style={style}>
      <circle r="5.5" fill={fill} />
      <path d="M-4 -3.78A5.5 5.5 0 0 1 4 -3.78" fill="none" stroke="rgb(255 255 255 / .35)" />
    </g>
  )
}

export function AutomateStage({ chosen, run, dd, lift = '', tilt = 'l', labels = true, scenes = ALL, enter = false, className }: {
  chosen: StageKey
  run: StageRun
  /** Seconds before the chosen demonstration starts (.75 on a page's load, .2 after a choice). */
  dd: number
  lift?: '' | StageRun
  tilt?: 'r' | 'l'
  labels?: boolean
  scenes?: readonly StageKey[]
  /** The set up card's own entrance: the tile settles out of a blur. */
  enter?: boolean
  className?: string
}) {
  const plate = useSvgId('dm-as-plate')
  const edge = useSvgId('dm-as-edge')
  const liq = useSvgId('dm-as-liq')
  const area = useSvgId('dm-as-area')
  const shadow = useSvgId('dm-as-shadow')
  const head = useSvgId('dm-as-head')
  const url = (id: string) => `url(#${id})`
  const on = (key: StageKey) => cx('sc', chosen === key && 'on')
  return (
    <div className={cx('dm-automate-stage', enter && 'enter', className)} aria-hidden="true">
      <div className={`sbox run-${run}`} style={{ '--dd': `${dd}s` } as CSSProperties}>
        <svg className="sdefs" width="0" height="0" focusable="false">
          <defs>
            <linearGradient id={plate} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#27231d" /><stop offset="1" stopColor="#1b1815" /></linearGradient>
            <linearGradient id={edge} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#141210" /><stop offset="1" stopColor="#0e0d0b" /></linearGradient>
            <linearGradient id={liq} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#433c33" /><stop offset="1" stopColor="#353029" /></linearGradient>
            <linearGradient id={area} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffecdc" stopOpacity=".16" /><stop offset="1" stopColor="#ffecdc" stopOpacity="0" /></linearGradient>
            <radialGradient id={shadow}><stop offset="0" stopColor="#000" stopOpacity=".7" /><stop offset=".6" stopColor="#000" stopOpacity=".28" /><stop offset="1" stopColor="#000" stopOpacity="0" /></radialGradient>
            <marker id={head} viewBox="0 0 10 10" refX="6" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path d="M2 1.5 7 5 2 8.5" fill="none" stroke="rgb(255 236 220 / .45)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></marker>
          </defs>
        </svg>

        {/* Auto-compound: fees leave the position and come back into the same one. */}
        {scenes.includes('compound') && (
          <div className={on('compound')} data-scene="compound">
            <svg width="100%" height="100%" viewBox="0 0 560 540" focusable="false">
              <ellipse cx="282" cy="446" rx="196" ry="16" fill={url(shadow)} />
              <rect x="114" y="388" width="340" height="48" rx="14" fill={url(edge)} />
              <rect x="110" y="380" width="340" height="48" rx="14" fill={url(plate)} />
              <rect className="rim" x="110.5" y="380.5" width="339" height="47" rx="13.5" />
              <path className="lipl" d="M126 381.5h308" />
              <rect x="124" y="395" width="312" height="18" rx="7" fill="#100e0c" />
              <rect x="128" y="399" width="258" height="10" rx="4" fill={url(liq)} />
              <rect className="grow an w100" x="389" y="399" width="43" height="10" rx="4" fill="#5fd09a" fillOpacity=".85" />
              <path className="arc" d="M136 372C136 128 424 128 424 372" markerEnd={url(head)} />
              {labels && <text className="lb hi" x="280" y="150">Earned fees</text>}
              {labels && <text className="lb" x="280" y="482">Same position. Same range.</text>}
              <Fee style={FEE_C} />
              <Fee style={FEE_C} delay="w016" />
              <Fee style={FEE_C} delay="w032" />
            </svg>
          </div>
        )}

        {/* Domino-compound: only earned fees move, into the next range; the original stays. */}
        {scenes.includes('domino') && (
          <div className={on('domino')} data-scene="domino">
            <svg width="100%" height="100%" viewBox="0 0 560 540" focusable="false">
              <ellipse cx="172" cy="458" rx="146" ry="14" fill={url(shadow)} />
              <rect x="54" y="408" width="240" height="40" rx="12" fill={url(edge)} />
              <rect x="50" y="400" width="240" height="40" rx="12" fill={url(plate)} />
              <rect className="rim" x="50.5" y="400.5" width="239" height="39" rx="11.5" />
              <path className="lipl" d="M64 401.5h212" />
              <rect x="62" y="413" width="216" height="14" rx="5" fill="#100e0c" />
              <rect x="65" y="416" width="210" height="8" rx="3.5" fill={url(liq)} />
              <rect x="334" y="280" width="180" height="36" rx="11" fill={url(edge)} />
              <rect x="330" y="272" width="180" height="36" rx="11" fill={url(plate)} />
              <rect className="rim" x="330.5" y="272.5" width="179" height="35" rx="10.5" />
              <path className="lipl" d="M343 273.5h154" />
              <rect x="342" y="284" width="156" height="12" rx="4.5" fill="#100e0c" />
              <rect className="grow an w120" x="345" y="287" width="150" height="6" rx="3" fill="#5fd09a" fillOpacity=".85" />
              <g className="fadein an w100">
                <rect x="403" y="210" width="34" height="60" rx="7" fill="rgb(255 157 98 / .14)" />
                <path d="M407 240h26" stroke="rgb(255 157 98 / .35)" strokeWidth="1.1" strokeLinecap="round" />
              </g>
              <rect className="g-ghost" x="403.6" y="210.6" width="32.8" height="58.8" rx="6.4" />
              <circle className="g-pip popc an w125" cx="413.5" cy="219" r="2.6" />
              <circle className="g-pip popc an w130" cx="426.5" cy="231" r="2.6" />
              <circle className="g-pip popc an w135" cx="412.5" cy="247" r="2.6" />
              <circle className="g-pip popc an w140" cx="420" cy="255" r="2.6" />
              <circle className="g-pip popc an w145" cx="427.5" cy="263" r="2.6" />
              <path className="arc" d="M232 392C246 226 352 150 418 199" markerEnd={url(head)} />
              {labels && <text className="lb hi" x="318" y="148">Only earned fees move</text>}
              {labels && <text className="lb" x="170" y="486">Original stays</text>}
              {labels && <text className="lb" x="420" y="340">Higher range</text>}
              <Fee style={FEE_D} />
              <Fee style={FEE_D} delay="w018" />
            </svg>
          </div>
        )}

        {/* Auto-exit: the price reaches the end of the range, the position closes, the tokens go to your wallet. Changed on
            purpose 2026-10-30 (QA round 2, N12): the label names the range's end, the app's one word for the trigger, as the
            card says; it said "your limit", read as a price to type. Position, class and animation unchanged. */}
        {scenes.includes('autoexit') && (
          <div className={on('autoexit')} data-scene="autoexit">
            <svg width="100%" height="100%" viewBox="0 0 560 540" focusable="false">
              <ellipse cx="174" cy="418" rx="146" ry="14" fill={url(shadow)} />
              <ellipse cx="436" cy="384" rx="70" ry="10" fill={url(shadow)} />
              <rect x="44" y="298" width="260" height="110" rx="16" fill={url(edge)} />
              <rect x="40" y="290" width="260" height="110" rx="16" fill={url(plate)} />
              <rect className="rim" x="40.5" y="290.5" width="259" height="109" rx="15.5" />
              <path className="lipl" d="M56 291.5h228" />
              <rect x="52" y="302" width="236" height="88" rx="9" fill="#100e0c" />
              <path className="x-area an w135" d="M60 386 86 372 108 378 134 360 158 366 184 344 208 350 236 328 258 334 282 306V388H60Z" fill={url(area)} />
              <path className="x-lim an w110" d="M56 306h228" />
              <path className="x-line an" pathLength="1" d="M60 386 86 372 108 378 134 360 158 366 184 344 208 350 236 328 258 334 282 306" />
              <circle className="x-halo popc an w115" cx="282" cy="306" r="10" />
              <circle className="x-end popc an w110" cx="282" cy="306" r="4" />
              <rect x="396" y="288" width="64" height="22" rx="6" fill="#2d2923" />
              <rect className="rim" x="396.5" y="288.5" width="63" height="21" rx="5.5" />
              <rect x="389" y="307" width="100" height="70" rx="16" fill={url(edge)} />
              <rect x="384" y="300" width="100" height="70" rx="16" fill={url(plate)} />
              <rect className="rim" x="384.5" y="300.5" width="99" height="69" rx="15.5" />
              <path d="M484 322h-26a13 13 0 0 0 0 26h26Z" fill="#12100e" />
              <path className="lipl" d="M484 322h-26a13 13 0 0 0 0 26h26" />
              <circle className="popc an w235" cx="462" cy="335" r="5.5" fill="#d8d4c8" />
              <circle className="popc an w250" cx="475" cy="335" r="5.5" fill="#7aa85a" />
              <path className="arc" d="M290 296C304 176 424 176 432 282" markerEnd={url(head)} />
              {labels && <text className="lb hi" x="362" y="162">Price reaches range end</text>}
              {labels && <text className="lb" x="170" y="446">Position closes</text>}
              {labels && <text className="lb" x="434" y="410">Your wallet</text>}
              <Token style={TOKEN_A} delay="w135" fill="#d8d4c8" />
              <Token style={TOKEN_B} delay="w150" fill="#7aa85a" />
            </svg>
          </div>
        )}

        {/* The one tile, travelling to the chosen function: the outer box glides, the inner one lifts and leans. The light
            rests just above its top left corner (EmberLight reads [data-ember-rest]). */}
        <div className={cx('tpos', `at-${chosen}`, lift && `lift-${lift} tilt-${tilt}`)} data-ember-rest="">
          <div className="tsh" />
          <div className="tlift">
            <div className="tsc">
              <div className="tin">
                <div className="dm-at-persp" data-automate-tile="">
                  <div className="dm-at-3d">
                    {SLABS.map((z) => <span key={z} className={`dm-at-slab dm-at-z${z}`} />)}
                    <div className="dm-at-face">
                      <span className="dm-at-groove" />
                      {PIPS.map((p) => <span key={p} className={`dm-at-pip dm-at-p${p}`} />)}
                      <span className="dm-at-glare" />
                      <span className="dm-at-glare2" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
