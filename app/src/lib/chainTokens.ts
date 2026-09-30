/**
 * Token details this page read from the chain this visit (2026-09-28, speed wave B, item 25): each token's symbol and
 * decimals as the wallet's list and a position's state read them (lib/walletPositions.ts, lib/fees/client.ts), in this
 * page's memory only. Receipts names its tokens from here before it asks anything (screens/Execution.tsx). Public data;
 * a token whose decimals were not read is not noted.
 */
export interface ChainToken {
  address: string
  symbol: string | null
  decimals: number | null
}

const tokens = new Map<string, ChainToken>()

export function noteTokens(list: readonly ChainToken[]): void {
  for (const token of list) if (token.decimals !== null) tokens.set(token.address.toLowerCase(), token)
}

export const chainToken = (address: string): ChainToken | undefined => tokens.get(address.toLowerCase())
