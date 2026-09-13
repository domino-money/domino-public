import { shortAddress } from '../../../lib/read/screens/identity'

/**
 * An address, pool id or NFT id as identity: monospace, never translated,
 * free to break anywhere so a 66-character id never pushes a card sideways.
 * The short form keeps the full value in the DOM for assistive technology.
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
    <span className="break-all font-mono text-[12px] leading-[18px] tracking-normal" translate="no" data-address="">
      {value}
    </span>
  )
}
