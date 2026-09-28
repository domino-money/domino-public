import { useEffect, useState, type CSSProperties } from 'react'
import { previewPosition } from 'core/position'
import { useStilled } from '../lib/motion/stilled'
import { SIM, UNIT, moved, simAt, simPrice } from '../lib/scenario'
import { useInView } from './home/Vignettes'
import { TokenIcon } from './TokenIcon'
import { Display, Pill } from './ui'

/**
 * Home's range simulator, redone for newcomers (the owner, round 6, 2026-09-27: "it is not beginner-friendly at
 * all"). One control, the price, and three answers beside it: whether the position earns, what it holds, and how
 * many trades have paid it. The goal is the five-second read: you choose a price range; while the price stays
 * inside, you earn fees; if it leaves, you stop earning and hold one token.
 *
 * The maths is the product's own (core/position) on the Closer range, drawn with ETH and USDG so the split has
 * names and faces. Nothing here is a market: the price is a move from the start, never a quote, and the trade
 * count is an illustration that runs while the card is in view and the price is in range, never an amount or a
 * return. Stilled motion (reduced motion, Pause motion) stops it and leaves it out.
 *
 * The control is one native range input laid over the picture, so pointer, touch, keyboard and screen readers all
 * work; the picture follows its value, and the input's invisible thumb is the knob's whole column (iOS drags a slider
 * only from inside its thumb). Looks are home.css's (`.dm-sim*`).
 */

/** How often a trade pays the position while the price is in its range, in the illustration. */
const TRADE_MS = 1500

const RANGE_LOW = simAt(SIM.lower)
const RANGE_HIGH = simAt(SIM.upper)

/** A point across the picture, 0 to 1 (home.css turns it into a left edge in line with the slider's own thumb). */
const across = (x: number) => ({ '--x': x }) as CSSProperties

const STATE = {
  inside: { pill: 'Earning fees', text: 'The price is inside your range, so every trade pays you a small fee.' },
  above: { pill: 'Not earning', text: 'The price is above your range. You now hold only USDG and earn nothing until it comes back.' },
  below: { pill: 'Not earning', text: 'The price is below your range. You now hold only ETH and earn nothing until it comes back.' },
} as const

/** The count in plain words. Outside the range it says the trades paid before the price left, so it never reads as
 *  earning under "Not earning". */
const trades = (n: number, earning: boolean) =>
  n === 0
    ? 'No trade has paid you yet'
    : earning
      ? `${n} ${n === 1 ? 'trade has' : 'trades have'} paid you a fee`
      : `${n} ${n === 1 ? 'trade' : 'trades'} paid you a fee before the price left`

export function RangeSimulator() {
  const [notch, setNotch] = useState(0)
  const [paid, setPaid] = useState(0)
  const [card, inView] = useInView<HTMLDivElement>(0.3)
  const still = useStilled()

  const price = simPrice(notch)
  const p = previewPosition({ amount: UNIT, lower: SIM.lower, upper: SIM.upper, startingPrice: 1, scenarioPrice: price })
  const earning = p.status === 'inside'
  const eth = Math.round(p.tokenShare * 100)
  const move = moved(price)

  // Trades keep coming while the price sits in the range and the card is in view; stilled motion stops them.
  useEffect(() => {
    if (!earning || !inView || still) return
    const timer = window.setInterval(() => setPaid((n) => n + 1), TRADE_MS)
    return () => window.clearInterval(timer)
  }, [earning, inView, still])

  const start = move === '0%'
  const where = start ? 'ETH at its start price' : `ETH ${move.startsWith('+') ? 'up' : 'down'} ${move.slice(1)}`
  const spoken = `${where}. ${STATE[p.status].pill}. You hold ${eth}% ETH and ${100 - eth}% USDG.`

  return (
    <div ref={card} className="dm-card dm-sim">
      <Display as="h2" className="dm-display-card dm-sim-title">
        Move the price. Watch what you own.
      </Display>
      <p className="dm-sim-lede">You choose a price range. While the price stays inside it, you earn fees. If it leaves, you stop earning and hold just one of the two tokens.</p>

      <div className="dm-sim-grid">
        <div className="dm-sim-stage" data-sim-stage={p.status}>
          <label htmlFor="sim-price" className="sr-only">
            ETH price, against the start
          </label>
          <input
            id="sim-price"
            type="range"
            className="dm-sim-input"
            min={-SIM.reach}
            max={SIM.reach}
            step={SIM.step}
            value={notch}
            onChange={(event) => setNotch(Number(event.target.value))}
            aria-valuetext={spoken}
          />
          {/* The picture: the three zones, the range, the price and its chip. The input says all of it. */}
          <div aria-hidden="true" className="dm-sim-art">
            <span className="dm-sim-dots" />
            <span className="dm-sim-glow" style={{ '--a': RANGE_LOW, '--b': RANGE_HIGH } as CSSProperties} />
            <span className="dm-sim-band" style={{ '--a': RANGE_LOW, '--b': RANGE_HIGH } as CSSProperties} />
            <span className="dm-sim-zone" data-here={p.status === 'below' ? '' : undefined} style={across(RANGE_LOW / 2)}>
              Only ETH
            </span>
            <span className="dm-sim-zone" data-here={earning ? '' : undefined} style={across((RANGE_LOW + RANGE_HIGH) / 2)}>
              Your range
            </span>
            <span className="dm-sim-zone" data-here={p.status === 'above' ? '' : undefined} style={across((RANGE_HIGH + 1) / 2)}>
              Only USDG
            </span>
            <span className="dm-sim-axis" />
            <span className="tnum dm-sim-tick" style={across(RANGE_LOW)}>
              {moved(SIM.lower)}
            </span>
            <span className="dm-sim-tick" data-start="" style={across(simAt(1))}>
              Start
            </span>
            <span className="tnum dm-sim-tick" style={across(RANGE_HIGH)}>
              {moved(SIM.upper)}
            </span>
            <span className="dm-sim-now" style={across(simAt(price))}>
              {/* One fee rises from the price with each trade that pays it (remounted, so it plays once). */}
              {earning && paid > 0 && <span key={paid} className="dm-sim-fee" />}
              <span className="dm-sim-knob">
                <svg viewBox="0 0 22 22" width="22" height="22">
                  <path d="M9 7.5 5.5 11 9 14.5M13 7.5l3.5 3.5-3.5 3.5" />
                </svg>
              </span>
            </span>
            {/* At the start the chip says so in words: "ETH price 0%" can read as a price of zero (review, 2026-09-28). */}
            <span className="dm-sim-chip" style={across(simAt(price))}>
              <TokenIcon symbol="ETH" size={16} />
              {start ? (
                <span>ETH at start price</span>
              ) : (
                <span>
                  ETH price <span className="tnum">{move}</span>
                </span>
              )}
            </span>
          </div>
        </div>

        <div className="dm-sim-side">
          <div className="dm-inset dm-sim-tile" data-sim-earning={earning ? 'yes' : 'no'}>
            <Pill tone={earning ? 'in' : 'neutral'} dot>
              {STATE[p.status].pill}
            </Pill>
            <p className="dm-sim-text">{STATE[p.status].text}</p>
            {!still && (
              <p className="dm-sim-paid" data-sim-paid={paid}>
                <span aria-hidden="true" className="dm-sim-coin" />
                <span className="tnum">{trades(paid, earning)}</span>
              </p>
            )}
          </div>

          <div className="dm-inset dm-sim-tile" data-sim-hold="">
            <p className="dm-sim-label">What you hold</p>
            <div className="dm-sim-split">
              <p className="dm-sim-token">
                <TokenIcon symbol="ETH" size={28} />
                <span className="tnum dm-sim-pct">{eth}%</span>
                <span className="dm-sim-sym">ETH</span>
              </p>
              <p className="dm-sim-token" data-end="">
                <span className="tnum dm-sim-pct">{100 - eth}%</span>
                <span className="dm-sim-sym">USDG</span>
                <TokenIcon symbol="USDG" size={28} />
              </p>
            </div>
            <div aria-hidden="true" className="dm-sim-bar">
              <span data-tone="eth" data-empty={eth === 0 ? '' : undefined} style={{ flexGrow: eth }} />
              <span data-tone="usdg" data-empty={eth === 100 ? '' : undefined} style={{ flexGrow: 100 - eth }} />
            </div>
          </div>
        </div>
      </div>

      <p className="dm-sim-auto">
        With Domino, your fees can keep working: <b>Auto-compound</b> adds them back into your position, and <b>Domino-compound</b> uses them to open your next
        range a step higher.
      </p>
    </div>
  )
}
