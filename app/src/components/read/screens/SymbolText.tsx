import type { TokenDisplay } from '../../../lib/read/types'
import { COPY } from '../../../lib/read/screens/copy'

/**
 * A read token's symbol, which is whatever its contract returned: text only,
 * isolated in <bdi> so a right-to-left override cannot reorder what is around
 * it, cut at 24 characters with the full text still in the element. A token
 * with no readable symbol says so; its address is always shown beside it.
 */
export function SymbolText({ token }: { token: TokenDisplay }) {
  if (token.symbol === null) return <span className="text-fg-subtle">{COPY.selection.unknownSymbol}</span>
  return <bdi className="inline-block max-w-[24ch] truncate align-bottom">{token.symbol}</bdi>
}
