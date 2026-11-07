import { ELYSIUM_LIVE, ELYSIUM_V2_ID } from './elysiumIdentity'

/**
 * A sentence written for Ether, in a network's own currency (added 2026-11-07, Elysium's screens): on Elysium, where the
 * build serves it, ETH reads HYPE and WETH reads WHYPE, whole words only ("Network fees are extra, paid in HYPE."), as
 * src/v2/chains.ts inChainCurrency writes V2's sentences there; on every other network, and in every build where Elysium
 * is off, the sentence as written. For the V1 screens New position shares with V2's networks (components/create), which
 * import nothing of V2.
 */
export const nativeWords = (text: string, chainId: number | null | undefined): string =>
  ELYSIUM_LIVE && chainId === ELYSIUM_V2_ID ? text.replace(/\bWETH\b/g, 'WHYPE').replace(/\bETH\b/g, 'HYPE') : text
