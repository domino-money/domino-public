import type { Candle, HistoryData, PoolMarketResponse } from 'api-contracts/read-v1/types'
import { parseDecimal } from './decimal'

/** Bind the displayed currency by address as well as the response's side.
 * A provider orientation change during the read must not silently switch assets. */
export function chartMatches(data: PoolMarketResponse, expectedCurrency: string, selected: 'base' | 'quote') {
  const h = data.priceHistory.data
  const m = data.market.data
  return !!h && !!m && h.selectedToken === selected && h.currency.toLowerCase() === expectedCurrency.toLowerCase() &&
    h.currency === m[selected === 'base' ? 'baseToken' : 'quoteToken'] && h.baseToken === m.baseToken && h.quoteToken === m.quoteToken
}

/** Only SVG coordinates become Numbers. Monetary strings remain exact; no
 * reciprocal, interpolation, gap filling or synthetic candle is performed. */
export function candleGeometry(history: HistoryData) {
  if (!history.candles.length) return []
  const entries = history.candles.map((candle) => ({ candle, prices: [candle.openUsd, candle.highUsd, candle.lowUsd, candle.closeUsd].map((v) => parseDecimal(v)!) }))
  const scale = Math.max(...entries.flatMap((e) => e.prices.map((v) => v.scale)))
  const numbers = entries.map((e) => e.prices.map((v) => v.coefficient * 10n ** BigInt(scale - v.scale)))
  const all = numbers.flat()
  const low = all.reduce((a, b) => a < b ? a : b)
  const high = all.reduce((a, b) => a > b ? a : b)
  const first = Math.min(...history.candles.map((c) => c.startTimestamp))
  const last = Math.max(...history.candles.map((c) => c.startTimestamp)) + history.intervalSeconds
  const y = (v: bigint) => high === low ? 95 : 180 - Number((v - low) * 170n / (high - low))
  return entries.map(({ candle }, i) => ({
    candle, x: 12 + (candle.startTimestamp - first + history.intervalSeconds / 2) * 416 / (last - first),
    open: y(numbers[i][0]), high: y(numbers[i][1]), low: y(numbers[i][2]), close: y(numbers[i][3]),
    width: Math.min(14, history.intervalSeconds * 250 / (last - first)),
  }))
}

export const candleDescription = (c: Candle) => `${new Date(c.startTimestamp * 1000).toISOString()}; USD open ${c.openUsd}, high ${c.highUsd}, low ${c.lowUsd}, close ${c.closeUsd}; volume ${c.volumeUsd}; ${c.closed ? 'closed' : 'open interval'}`
