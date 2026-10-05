import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { previewPosition } from 'core/position'
import { SIM, UNIT, moved, simAt, simPrice } from '../lib/scenario'
import { useStilled } from '../lib/motion/stilled'
import { TokenIcon } from './TokenIcon'
import { FeeFlowDemo } from './FeeFlowDemo'
import { useInView } from './home/Vignettes'
import { Display, Pill } from './ui'
import '../styles/range-simulator.css'

const RANGE_LOW = simAt(SIM.lower)
const RANGE_HIGH = simAt(SIM.upper)
const across = (x: number) => ({ '--x': x }) as CSSProperties
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

/** One automatic teaching scene. The optional native scrubber takes priority while focused.
 * Only relative price changes: balances use core/position, and no fee amount is simulated. */
export function RangeSimulator() {
  const [ref, seen] = useInView<HTMLDivElement>(0.2)
  const still = useStilled()
  const [focused, setFocused] = useState(false)
  const [notch, setNotch] = useState(0)
  const elapsed = useRef(0)
  useEffect(() => {
    if (!seen || still || focused) return
    let frame = 0
    let previous = 0
    let painted = 0
    const move = (now: number) => {
      if (!document.hidden) {
        if (previous) elapsed.current = (elapsed.current + now - previous) % 32000
        if (now - painted >= 50) {
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
  }, [seen, still, focused])

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
    <div ref={ref} className="dm-card dm-sim" data-sim-example="" data-sim-state={p.status} data-sim-paid="0" data-sim-running={seen && !still && !focused ? 'yes' : 'no'}>
      <div className="dm-sim-heading">
        <Display as="h2" className="dm-display-card dm-sim-title">Price moves. Your position adapts.</Display>
        <p>One position. Two ways to put its fees to work.</p>
      </div>
      <div className="dm-sim-grid">
        <div className="dm-sim-explore">
          <div className="dm-sim-readout" data-sim-earning={inside ? 'yes' : 'no'}>
            <span className="dm-sim-chip"><TokenIcon symbol="ETH" size={20} /><span>{start ? 'ETH at start price' : <>ETH price <span className="tnum">{move}</span></>}</span></span>
            <Pill tone={inside ? 'in' : 'neutral'} dot>{STATE[p.status].pill}</Pill>
          </div>
          <div className="dm-sim-stage" data-sim-stage={p.status}>
            <label htmlFor="sim-price" className="sr-only">ETH price, against the start</label>
            <input id="sim-price" type="range" className="dm-sim-input" min={-SIM.reach} max={SIM.reach} step={SIM.step} value={notch}
              onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
              onChange={(event) => setNotch(Number(event.target.value))} aria-valuetext={spoken} />
            <div aria-hidden="true" className="dm-sim-art">
              <span className="dm-sim-dots" />
              <span className="dm-sim-band" style={{ '--a': RANGE_LOW, '--b': RANGE_HIGH } as CSSProperties}>
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
                <span className="dm-sim-knob"><svg viewBox="0 0 22 22"><path d="M9 7.5 5.5 11 9 14.5M13 7.5l3.5 3.5-3.5 3.5" /></svg></span>
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
        <FeeFlowDemo running={seen && !still} phase={!inside ? 'outside' : notch >= 0.4 ? 'domino' : 'compound'} />
      </div>
      <details className="dm-sim-details">
        <summary>How it works<span aria-hidden="true">+</span></summary>
        <p>Inside your range, trades change your token mix and can earn fees. Outside it, you hold one token and stop earning trading fees. Auto-compound can reinvest fees in the same position. Near the top of the range, Domino-compound can use them to open a higher range in the same pool, when your settings allow. Your position can lose value even when it earns fees.</p>
      </details>
    </div>
  )
}
