/**
 * Tokens that pass for one of the site's main tokens, or carry unsafe text, wherever a pool or a token is opened by a
 * link or a search (audit I1, I2, V3; 2026-10-01).
 *
 * Anyone can deploy a token called "USDG", make a pool of it against WETH, and send a link to it on domino.money. The
 * rule the featured list and the Wallet card already apply (config/mainTokens.ts `readsAsMainToken`, featuredList.ts
 * `unsafeSymbol`) now runs on the two tokens of any pool a page opens, on a token a search finds, and on a token's
 * Markets page: a token that reads as USDG, WETH or ETH but is not at that token's address is a look-alike, and the
 * page says so plainly and offers no way to put money in. Nothing here is money code: it decides what a page shows.
 */
import { MAIN_TOKENS, readsAsMainToken } from '../../../config/mainTokens'
import { mixesInto, symbolReading } from '../../symbolReading'
import { unsafeSymbol } from '../featuredList'

type Named = { symbol: string | null; address: string }

export type TokenWarning =
  /** Reads as a main token (`main`) but lives at another address. */
  | { kind: 'lookalike'; address: string; main: string }
  /** Its symbol holds text of a web address or a claim, or a format character that can reorder text. */
  | { kind: 'unsafe'; address: string }

/** What is wrong with a token's symbol, or null. A token with no readable symbol has nothing to pass for. */
export function tokenWarning(token: Named): TokenWarning | null {
  if (token.symbol === null) return null
  const address = token.address.toLowerCase()
  if (readsAsMainToken(token.symbol, address)) {
    const reading = symbolReading(token.symbol)
    const main = MAIN_TOKENS.find((candidate) => symbolReading(candidate.symbol) === reading || mixesInto(token.symbol as string, candidate.symbol))
    return { kind: 'lookalike', address, main: main?.symbol ?? 'token' }
  }
  return unsafeSymbol(token.symbol) ? { kind: 'unsafe', address } : null
}

/** The first warning among a pool's tokens, look-alikes first. */
export function poolWarning(tokens: readonly Named[]): TokenWarning | null {
  const warnings = tokens.map(tokenWarning).filter((warning): warning is TokenWarning => warning !== null)
  return warnings.find((warning) => warning.kind === 'lookalike') ?? warnings[0] ?? null
}

/** The warning in the words a page shows it with: about a pool (its page), or about a token (its page, the search). */
export function warningText(warning: TokenWarning, subject: 'pool' | 'token' = 'pool'): string {
  const lose = subject === 'pool' ? 'Adding money to this pool can lose it.' : 'Adding money to its pools can lose it.'
  return warning.kind === 'lookalike'
    ? `This isn’t the ${warning.main} Domino uses. ${lose}`
    : `${subject === 'pool' ? 'One of this pool’s tokens has' : 'This token has'} a name made to mislead. ${lose}`
}
