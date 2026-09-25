/** Stored pool ratios retain exact decimal values; only SVG positions are numbers. */
import type { HistoryResponse, RatioCandle } from 'api-contracts/read-v3/types'
import { parseDecimal, toFixed } from './decimal'

export function ratioText(value: string): string {
  const number = parseDecimal(value)
  if (!number || number.coefficient <= 0n) return '—'
  const digits = number.coefficient.toString().length
  const exponent = digits - number.scale - 1
  // Extreme token denominations remain legible without becoming zero or Infinity.
  if (exponent < -8 || exponent > 12) {
    const significant = number.coefficient.toString().slice(0, 7).replace(/0+$/, '')
    return `${significant[0]}${significant.length > 1 ? `.${significant.slice(1)}` : ''} × 10^${exponent}`
  }
  const text = toFixed(value, Math.max(0, 5 - exponent)) ?? value
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/** A close as a Markets card writes it, in its price row and its tooltip alike: ratioText, its whole part grouped in thousands ("2,656.07"). */
export function groupedRatioText(value: string): string {
  return ratioText(value).replace(/^\d+/, (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','))
}

/** Room around the plotted line: the pool chart keeps 100 on the right for its labels. */
export interface RatioPad { left: number; right: number; top: number; bottom: number }
const CHART_PAD: RatioPad = { left: 12, right: 100, top: 16, bottom: 32 }

export function ratioGeometry(history: HistoryResponse, width = 720, height = 240, pad: RatioPad = CHART_PAD) {
  const candles = history.candles
  if (!candles.length || width <= 120 || height <= 80) return null
  const decimals = candles.map(candle => parseDecimal(candle.close))
  if (decimals.some(value => !value || value.coefficient <= 0n)) return null
  const scale = Math.max(...decimals.map(value => value!.scale))
  const values = decimals.map(value => value!.coefficient * 10n ** BigInt(scale - value!.scale))
  let high = 0, low = 0
  values.forEach((value, index) => { if (value > values[high]) high = index; if (value < values[low]) low = index })
  const left = pad.left, right = width - pad.right, top = pad.top, bottom = height - pad.bottom
  const { startTimestamp: start, endTimestamp: end } = history.requestedWindow
  const x = (timestamp: number) => left + Math.max(0, Math.min(1, (timestamp - start) / Math.max(1, end - start))) * (right - left)
  const rise = BigInt(Math.round((bottom - top) * 1000))
  const points = candles.map((candle, index) => ({ candle, x: x(candle.startTimestamp),
    y: values[high] === values[low] ? (top + bottom) / 2 : bottom - Number((values[index] - values[low]) * rise / (values[high] - values[low])) / 1000 }))
  const paths: string[] = []
  let path = ''
  for (const [index, point] of points.entries()) {
    const previous = points[index - 1]
    const joined = previous && point.candle.complete && previous.candle.complete &&
      point.candle.startTimestamp - previous.candle.startTimestamp === history.resolutionSeconds &&
      !history.gaps.some(gap => gap.startTimestamp < point.candle.startTimestamp && gap.endTimestamp > previous.candle.startTimestamp)
    if (!joined) { if (path) paths.push(path); path = 'M' } else path += ' L'
    path += `${point.x.toFixed(2)} ${point.y.toFixed(2)}`
  }
  if (path) paths.push(path)
  return { width, height, left, right, top, bottom, points, paths,
    labels: values[high] === values[low] ? [{ y: (top + bottom) / 2, text: ratioText(candles[high].close) }] :
      [{ y: top, text: ratioText(candles[high].close) }, { y: bottom, text: ratioText(candles[low].close) }],
    gaps: history.gaps.map(gap => ({ x: x(gap.startTimestamp), width: x(gap.endTimestamp) - x(gap.startTimestamp) })) }
}

export const ratioCandleText = (candle: RatioCandle) =>
  `${new Date(candle.startTimestamp * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}: open ${candle.open}, high ${candle.high}, low ${candle.low}, close ${candle.close}; ${candle.swapCount} swaps; ${candle.complete ? 'complete interval' : 'partial interval'}.`
