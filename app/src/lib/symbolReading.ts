/**
 * How a token symbol reads to a person, for look-alike checks: the wallet
 * card's (lib/walletHoldings.ts) and the featured list's (lib/read/featuredList.ts).
 * Pure and Node-safe; moved here from walletHoldings.ts on 2026-09-26 so the
 * featured list can share it without the wallet card's price code.
 */

// Letters that only look Latin (Cyrillic and Greek capitals), and digits that pass for letters, as the Latin letter they imitate.
const LOOKS: Readonly<Record<string, string>> = {
  // Cyrillic
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y', 'І': 'I', 'Ѕ': 'S',
  // Greek
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  // Digits and signs
  '0': 'O', '1': 'I', L: 'I', '|': 'I', '5': 'S', '$': 'S',
}

/**
 * A symbol as it reads: compatibility forms and precomposed letters taken
 * apart (NFKD), invisible and combining marks and spaces dropped, upper case,
 * look-alike letters and digits mapped. "PONS" with a zero-width space inside
 * it, "P0NS", "ÜSDG" and "USDĢ" read "PONS" and "USDG".
 */
export function symbolReading(symbol: string): string {
  const plain = symbol.normalize('NFKD').replace(/[\p{Cf}\p{Mn}\p{Me}\p{Z}\s]/gu, '').toUpperCase()
  return [...plain].map((ch) => LOOKS[ch] ?? ch).join('')
}
