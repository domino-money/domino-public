import type { TokenDisplay } from '../../lib/read/types'

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

/**
 * A token's name on screen.
 *
 * A read token's symbol is whatever its contract returned, so it is rendered
 * as text and nothing else: never markup, never an attribute, never a URL.
 * `<bdi>` keeps a right-to-left override inside it from reordering the text
 * around it, and the width cap stops a long symbol from pushing the row
 * apart; the full text stays in the element for assistive technology. A
 * token with no readable symbol is shown by its address, which is its
 * identity anyway. There are no curated names: every symbol comes from a read.
 */
export function TokenLabel({ token }: { token: TokenDisplay }) {
  if (token.symbol === null) return <span className="font-mono tracking-normal">{shortAddress(token.address)}</span>
  return <bdi className="inline-block max-w-[14ch] truncate align-bottom">{token.symbol}</bdi>
}
