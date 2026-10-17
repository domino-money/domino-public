import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { previewPosition } from 'core/position'
import { SIM, UNIT, moved, simAt, simPrice } from '../lib/scenario'
import { useStilled } from '../lib/motion/stilled'
import { TokenIcon } from './TokenIcon'
import { useInView } from './home/Vignettes'
import { homeStory, locOf, useHomeStoryState } from './home/homeStory'
import { Display, Pill, cx } from './ui'
import '../styles/range-simulator.css'

const RANGE_LOW = simAt(SIM.lower)
const RANGE_HIGH = simAt(SIM.upper)
const across = (x: number) => ({ '--x': x }) as CSSProperties
/** V4: the light rising inside the range while the price is in it (decoration only: left %, delay s). */
const GLINTS = [[8, 0], [22, 1.1], [37, 2.3], [51, 0.6], [64, 1.7], [78, 2.9], [90, 0.3]] as const
const STATE = {
  inside: { pill: 'Inside range', text: 'Trades can earn fees.' },
  above: { pill: 'Above range', text: 'No trading fees here.' },
  below: { pill: 'Below range', text: 'No trading fees here.' },
} as const

/** Slow movement with time to see both single-token states and the near-top mix. */
const JOURNEY = [[0, 0], [6500, 0], [10000, 0.5], [18500, 0.5], [21000, 0.85], [23000, 0.85], [26500, -0.8], [29000, -0.8], [32000, 0]] as const
function journeyAt(time: number): number {
  const i = JOURNEY.findIndex(([at]) => at > time)
  if (i < 1) return 0
  const [from, a] = JOURNEY[i - 1]
  const [to, b] = JOURNEY[i]
  const t = (time - from) / (to - from)
  return a + (b - a) * (t * t * (3 - 2 * t))
}

/** Rounded shares must never imply one token is gone while it still holds some. */
function shareText(share: number): string {
  if (share <= 0) return '0%'
  if (share >= 1) return '100%'
  const rounded = Math.round(share * 100)
  return rounded === 0 ? '<1%' : rounded === 100 ? '>99%' : `${rounded}%`
}

/** Home's compact range-only teaching scene. Automation examples live in its three separate cards.
 * The optional native scrubber takes priority while focused.
 * Only relative price changes: balances use core/position, and no fee amount is simulated. */
export function RangeSimulator({ title = 'Your price range' }: { title?: string }) {
  const [ref, seen] = useInView<HTMLDivElement>(0.2)
  const still = useStilled()
  const [focused, setFocused] = useState(false)
  // V4 (the approved prototype): a pointer over the scene holds the journey too, and so does a press; after the visitor
  // lets go (1.5 s after focus leaves, 2.5 s after a touch) the price glides home to the start and the journey begins
  // again. A look only: the native slider and its value stay the visitor's while it has focus.
  const [hovered, setHovered] = useState(false)
  const [pressed, setPressed] = useState(false)
  const [cooling, setCooling] = useState(false)
  const [glide, setGlide] = useState(false)
  const [notch, setNotch] = useState(0)
  const elapsed = useRef(0)
  const manual = useRef(false)
  const timers = useRef<{ cool?: ReturnType<typeof setTimeout>; glide?: ReturnType<typeof setTimeout> }>({})
  const story = useHomeStoryState()
  const tileAway = !(story.ready && locOf(story.act, story.rangeOpen) === 'range')
  const held = !seen || still || focused || hovered || pressed || cooling
  const cool = (ms: number) => {
    clearTimeout(timers.current.cool)
    setCooling(true)
    timers.current.cool = setTimeout(() => setCooling(false), ms)
  }
  useEffect(() => () => {
    clearTimeout(timers.current.cool)
    clearTimeout(timers.current.glide)
  }, [])
  useEffect(() => {
    if (held) return
    if (manual.current) {
      // Steered by the visitor: glide home, then the journey starts from its beginning.
      manual.current = false
      elapsed.current = 0
      setNotch(0)
      setGlide(true)
      clearTimeout(timers.current.glide)
      timers.current.glide = setTimeout(() => setGlide(false), 950)
    }
    let frame = 0
    let previous = 0
    let painted = 0
    const move = (now: number) => {
      if (!document.hidden) {
        if (previous) elapsed.current = (elapsed.current + Math.min(now - previous, 300)) % 32000
        // Short even steps; the light glides between them (CSS), as the prototype's 150 ms journey does.
        if (now - painted >= 150) {
          setNotch(Number(journeyAt(elapsed.current).toFixed(2)))
          painted = now
        }
      }
      previous = now
      frame = requestAnimationFrame(move)
    }
    const visible = () => { previous = 0 }
    document.addEventListener('visibilitychange', visible)
    frame = requestAnimationFrame(move)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [held])

  const price = simPrice(notch)
  const p = previewPosition({ amount: UNIT, lower: SIM.lower, upper: SIM.upper, startingPrice: 1, scenarioPrice: price })
  const inside = p.status === 'inside'
  const share = Math.max(0, Math.min(1, p.tokenShare))
  const eth = shareText(share)
  const usdg = shareText(1 - share)
  const move = moved(price)
  const start = move === '0%'
  const where = start ? 'ETH at its start price' : `ETH ${price > 1 ? 'up' : 'down'} ${move.slice(1)}`
  const spoken = `${where}. ${STATE[p.status].pill}. ${STATE[p.status].text} Example mix by value: ${eth} ETH and ${usdg} USDG.`

  return (
    <div ref={ref} className="dm-card dm-sim" data-sim-compact="" data-sim-example="" data-sim-state={p.status} data-sim-paid="0" data-sim-running={held ? 'no' : 'yes'} data-sim-glide={glide ? '' : undefined}>
      <div className="dm-sim-heading">
        <Display as="h2" className="dm-display-card dm-sim-title">{title}</Display>
        <p>Drag the price.</p>
      </div>
      <div className="dm-sim-grid">
        <div className="dm-sim-explore">
          <div className="dm-sim-readout" data-sim-earning={inside ? 'yes' : 'no'}>
            <span className="dm-sim-chip"><TokenIcon symbol="ETH" size={20} /><span>{start ? 'ETH at start price' : <>ETH price <span className="tnum">{move}</span></>}</span></span>
            <Pill tone={inside ? 'in' : 'neutral'} dot>{STATE[p.status].pill}</Pill>
          </div>
          <div className="dm-sim-stage" data-sim-stage={p.status}
            onPointerEnter={(event) => { if (event.pointerType !== 'touch') setHovered(true) }}
            onPointerLeave={(event) => { if (event.pointerType !== 'touch') setHovered(false) }}
            onPointerDown={() => { setPressed(true); homeStory.pick('range') }}
            onPointerUp={(event) => { setPressed(false); if (event.pointerType === 'touch') cool(2500) }}
            onPointerCancel={() => { setPressed(false); cool(2500) }}>
            <label htmlFor="sim-price" className="sr-only">ETH price, against the start</label>
            <input id="sim-price" type="range" className="dm-sim-input" min={-SIM.reach} max={SIM.reach} step={SIM.step} value={notch}
              onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); cool(1500) }}
              onChange={(event) => { manual.current = true; setNotch(Number(event.target.value)); homeStory.pick('range') }} aria-valuetext={spoken} />
            <div aria-hidden="true" className="dm-sim-art">
              {/* Where the travelling tile stands in your range (from 1280px): a warm pool while it is away. */}
              <span className={cx('dm-foot dm-rg-foot', tileAway && 'is-away')} />
              {/* V4: the dotted field is lit around the price (the same position as the knob's, drawn only). */}
              <span className="dm-sim-dots" style={across(simAt(price))} />
              <span className="dm-sim-band" style={{ '--a': RANGE_LOW, '--b': RANGE_HIGH } as CSSProperties}>
                {GLINTS.map(([left, delay]) => <span key={left} className="dm-sim-glint" style={{ left: `${left}%`, animationDelay: `${delay}s` }} />)}
                <span className="dm-sim-band-label">Your price range</span>
              </span>
              <span className="sr-only dm-sim-zone" data-here={p.status === 'below' ? '' : undefined}>Only ETH</span>
              <span className="sr-only dm-sim-zone" data-here={inside ? '' : undefined}>Your range</span>
              <span className="sr-only dm-sim-zone" data-here={p.status === 'above' ? '' : undefined}>Only USDG</span>
              <span className="dm-sim-axis" />
              <span className="dm-sim-tick tnum" data-sim-preset="lower" style={across(RANGE_LOW)}>{moved(SIM.lower)}</span>
              <span className="dm-sim-tick" data-sim-preset="start" data-start="" style={across(simAt(1))}>Start</span>
              <span className="dm-sim-tick tnum" data-sim-preset="higher" style={across(RANGE_HIGH)}>{moved(SIM.upper)}</span>
              <span className="dm-sim-now" style={across(simAt(price))}>
                <span className="dm-sim-knob"><svg viewBox="0 0 22 16"><path d="M8 3.5 3.5 8 8 12.5M14 3.5 18.5 8 14 12.5" /></svg></span>
              </span>
            </div>
          </div>
          <div className="dm-sim-result" data-sim-hold="">
            <div className="dm-sim-mix-track" data-tone="usdg" data-empty={share === 1 ? '' : undefined} aria-hidden="true"><span data-tone="eth" data-empty={share === 0 ? '' : undefined} style={{ width: `${share * 100}%` }} /></div>
            <div className="dm-sim-split">
              <span className="dm-sim-token" data-token="eth"><TokenIcon symbol="ETH" size={18} /><span>ETH</span><strong className="dm-sim-pct tnum">{eth}</strong></span>
              <span className="dm-sim-mix-label">Token mix · by value</span>
              <span className="dm-sim-token" data-token="usdg" data-end=""><strong className="dm-sim-pct tnum">{usdg}</strong><span>USDG</span><TokenIcon symbol="USDG" size={18} /></span>
            </div>
          </div>
        </div>
      </div>
      <details className="dm-sim-details">
        <summary>How it works<span aria-hidden="true">+</span></summary>
        <p>Inside your range, trades change your token mix and can earn fees. Outside it, you hold one token and stop earning trading fees. Your position can lose value even when it earns fees.</p>
      </details>
    </div>
  )
}
