import { shortAddress } from '../../../lib/read/screens/identity'

/**
 * An address, pool id or NFT id as identity: monospace, never translated.
 * The full form is one line (`.dm-hex`, DESIGN-V2 §3.14): it ellipsises where
 * it runs out of room and never wraps, with the whole value still in the DOM
 * and in its title. The short form keeps the full value in the DOM for
 * assistive technology.
 */
export function Address({ value, short = false }: { value: string; short?: boolean }) {
  if (short) {
    return (
      <span className="font-mono tracking-normal" translate="no">
        <span aria-hidden="true">{shortAddress(value)}</span>
        <span className="sr-only">{value}</span>
      </span>
    )
  }
  return (
    <span className="dm-hex" translate="no" title={value} data-address="">
      {value}
    </span>
  )
}
