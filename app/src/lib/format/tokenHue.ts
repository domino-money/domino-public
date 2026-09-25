/**
 * The hue of a token's address-derived disc (DESIGN-V2 §3.8): the first two
 * bytes of the lower-cased address, modulo 360. Anything that is not `0x`
 * followed by hex gets 0. A calm colour, never an identity guarantee. Wallet
 * components import it from here, never from TokenIcon.
 */
export function tokenHue(address: string): number {
  const lower = address.toLowerCase()
  if (!/^0x[0-9a-f]{4,}$/.test(lower)) return 0
  return parseInt(lower.slice(2, 6), 16) % 360
}
