/**
 * Extra bundled decoration, matched by network and contract identity only.
 * These USDC addresses already belong to the app's chain and funding profiles;
 * this table changes no admission, balance, price or execution decision.
 * The original SVG is Circle's token logo from its official pressroom brand kit.
 * https://www.circle.com/pressroom#brand-kit
 * https://6778953.fs1.hubspotusercontent-na1.net/hubfs/6778953/Pressroom/brandkit/logo-downloads/usdc.zip
 * Entry: Token Logo/USDC Token.svg (unmodified, retrieved 2026-10-10).
 */
const USDC: Readonly<Record<number, string>> = {
  1: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  10: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
}

export function bundledTokenArtwork(chainId: number, address: string): 'USDC' | null {
  return USDC[chainId] === address.toLowerCase() ? 'USDC' : null
}
