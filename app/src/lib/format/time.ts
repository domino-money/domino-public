/**
 * Dates and times in the app's existing caption style (DESIGN-V2 §6.3):
 * `09-24 13:00 UTC`. No month words (they would be new text), no `Intl`, no
 * locale: built from `getUTC*` with zero-padding, so Node and every browser
 * print the same characters.
 */

const HOUR = 3600
const DAY = 86_400

const pad = (n: number) => String(n).padStart(2, '0')
const at = (sec: number) => new Date(sec * 1000)

/** `09-23` (month-day, UTC). */
export function shortDate(sec: number): string {
  const d = at(sec)
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** `13:00` (hour:minute, UTC), without the zone. */
function clock(sec: number): string {
  const d = at(sec)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** `13:00 UTC`. */
export function shortTime(sec: number): string {
  return `${clock(sec)} UTC`
}

/**
 * A bucket `[start, end)` as a caption: `09-23 06:00–12:00 UTC` inside one
 * day, `09-23` for exactly one whole day, `09-23 – 09-29` for whole days, and
 * `09-23 18:00 – 09-24 06:00 UTC` for a span that crosses midnight.
 */
export function bucketLabel(start: number, end: number): string {
  const whole = start % DAY === 0 && end % DAY === 0 && end > start
  if (whole) return end - start === DAY ? shortDate(start) : `${shortDate(start)} – ${shortDate(end - DAY)}`
  if (shortDate(start) === shortDate(Math.max(start, end - 1))) return `${shortDate(start)} ${clock(start)}–${clock(end)} UTC`
  return `${shortDate(start)} ${clock(start)} – ${shortDate(end)} ${clock(end)} UTC`
}

/** An axis tick: the time of day when the chart spans two days or less, else the date. */
export function axisLabel(sec: number, span: number): string {
  return span <= 2 * DAY + HOUR ? clock(sec) : shortDate(sec)
}
