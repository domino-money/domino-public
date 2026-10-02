/**
 * One Intl.NumberFormat per set of options, made once and kept (2026-10-01, platform workstream, F5).
 *
 * The helpers that write the site's figures made a new formatter on every call: plainAmount alone took 38.5 ms of
 * Home's start and 45.8 ms when Markets' figures arrived on a phone, about forty times what a kept formatter costs, and
 * New position's range slider paid it on every frame it drew. A formatter is the same for the same options, so each set
 * is made once, here, and its output is exactly what a new one gives.
 *
 * Always 'en-US': the site writes numbers one way, whatever the browser's language. The options are keyed by their
 * JSON, so callers pass the same literal shape for the same formatter; the sets the site uses are a handful, written in
 * its code, never derived from data, so the table stays that small.
 */
const formats = new Map<string, Intl.NumberFormat>()

export function numberFormat(options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = JSON.stringify(options)
  let format = formats.get(key)
  if (format === undefined) {
    format = new Intl.NumberFormat('en-US', options)
    formats.set(key, format)
  }
  return format
}

/** How many formatters are kept: for the tests. */
export const keptFormats = () => formats.size
