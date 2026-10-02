/**
 * How a token symbol reads to a person, for look-alike checks: the wallet
 * card's (lib/walletHoldings.ts) and the featured list's (lib/read/featuredList.ts).
 * Pure and Node-safe; moved here from walletHoldings.ts on 2026-09-26 so the
 * featured list can share it without the wallet card's price code.
 *
 * Changed 2026-10-01 (audit I2): letters that pass for Latin capitals in
 * Armenian, Cherokee, Lisu, Coptic and the Latin small capitals are mapped
 * too (a subset of Unicode's confusables, UTS #39, for the letters a symbol is
 * written in); a symbol that mixes scripts to pass for another one letter at a
 * time is caught whatever the table maps (`mixesInto`); and a symbol holding a
 * format character (bidirectional controls, zero-width joiners: \p{Cf}) is
 * unsafe (`hasFormatCharacter`): such a character can reorder the text around
 * it on screen.
 */

// Letters that only look Latin, and digits and signs that pass for letters, as the Latin capital they imitate. Looked up
// for the character as it is and, failing that, for its upper case.
const LOOKS: Readonly<Record<string, string>> = {
  // Cyrillic
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y', 'І': 'I', 'Ѕ': 'S',
  'Ј': 'J', 'Ԁ': 'D', 'ԁ': 'D', 'Ԍ': 'G', 'Ԛ': 'Q', 'Ԝ': 'W', 'Ү': 'Y',
  // Greek
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  'υ': 'U', 'ν': 'V', 'ϲ': 'C', 'Ϲ': 'C', 'ϳ': 'J',
  // Armenian
  'Ս': 'U', 'Օ': 'O', 'Ց': 'G', 'ց': 'G', 'Զ': 'Z', 'Ո': 'N', 'Վ': 'V', 'Ք': 'P',
  // Cherokee (its small letters take these as their upper case)
  'Ꭺ': 'A', 'Ᏼ': 'B', 'Ꮯ': 'C', 'Ꭰ': 'D', 'Ꭼ': 'E', 'Ꮐ': 'G', 'Ꮋ': 'H', 'Ꭵ': 'I', 'Ꮶ': 'K', 'Ꮮ': 'L', 'Ꮇ': 'M', 'Ꮲ': 'P', 'Ꭱ': 'R',
  'Ꮪ': 'S', 'Ꭲ': 'T', 'Ꮩ': 'V', 'Ꮃ': 'W', 'Ꮤ': 'W', 'Ꮓ': 'Z', 'Ꮍ': 'Y', 'Ꮻ': 'O', 'Ꭻ': 'J',
  // Lisu
  'ꓮ': 'A', 'ꓐ': 'B', 'ꓚ': 'C', 'ꓓ': 'D', 'ꓰ': 'E', 'ꓝ': 'F', 'ꓖ': 'G', 'ꓧ': 'H', 'ꓲ': 'I', 'ꓙ': 'J', 'ꓗ': 'K', 'ꓡ': 'L', 'ꓟ': 'M',
  'ꓠ': 'N', 'ꓳ': 'O', 'ꓑ': 'P', 'ꓣ': 'R', 'ꓢ': 'S', 'ꓔ': 'T', 'ꓴ': 'U', 'ꓦ': 'V', 'ꓪ': 'W', 'ꓫ': 'X', 'ꓬ': 'Y', 'ꓜ': 'Z',
  // Coptic
  'Ⲁ': 'A', 'Ⲃ': 'B', 'Ⲉ': 'E', 'Ⲏ': 'H', 'Ⲓ': 'I', 'Ⲕ': 'K', 'Ⲙ': 'M', 'Ⲛ': 'N', 'Ⲟ': 'O', 'Ⲣ': 'P', 'Ⲥ': 'C', 'Ⲧ': 'T', 'Ⲩ': 'Y', 'Ⲭ': 'X',
  // Latin small capitals, and other Latin letters that pass for a capital
  'ᴀ': 'A', 'ʙ': 'B', 'ᴄ': 'C', 'ᴅ': 'D', 'ᴇ': 'E', 'ɢ': 'G', 'ʜ': 'H', 'ɪ': 'I', 'ᴊ': 'J', 'ᴋ': 'K', 'ʟ': 'L', 'ᴍ': 'M', 'ɴ': 'N',
  'ᴏ': 'O', 'ᴘ': 'P', 'ʀ': 'R', 'ꜱ': 'S', 'ᴛ': 'T', 'ᴜ': 'U', 'ᴠ': 'V', 'ᴡ': 'W', 'ʏ': 'Y', 'ᴢ': 'Z', 'ɡ': 'G', 'Ɡ': 'G', 'Ɪ': 'I',
  // Digits and signs
  '0': 'O', '1': 'I', L: 'I', '|': 'I', '5': 'S', '$': 'S',
}

const STRIPPED = /[\p{Cf}\p{Mn}\p{Me}\p{Z}\s]/gu

/**
 * A symbol as it reads: compatibility forms and precomposed letters taken
 * apart (NFKD), invisible and combining marks and spaces dropped, upper case,
 * look-alike letters and digits mapped. "PONS" with a zero-width space inside
 * it, "P0NS", "ÜSDG", "USDĢ" and Lisu "ꓴꓢꓓꓖ" read "PONS" and "USDG".
 */
export function symbolReading(symbol: string): string {
  const plain = symbol.normalize('NFKD').replace(STRIPPED, '')
  return [...plain].map((ch) => LOOKS[ch] ?? LOOKS[ch.toUpperCase()] ?? ch.toUpperCase()).join('')
}

/** Whether a symbol holds a format character (\p{Cf}: bidirectional controls, zero-width joiners), which can reorder the text around it. */
export const hasFormatCharacter = (symbol: string) => /\p{Cf}/u.test(symbol)

/**
 * Text a symbol never holds, upper-cased: what reads as a web address or a claim. The featured selector's own rule
 * (backend/featured_pools.py UNSAFE_SYMBOL_TEXT, `token_symbol_unsafe`); moved here from lib/read/featuredList.ts on
 * 2026-10-01 so the Wallet card applies it too (audit I2).
 */
export const UNSAFE_SYMBOL_TEXT: readonly string[] = Object.freeze(['.', '/', ':', 'WWW', 'HTTP', 'CLAIM'])

/** Whether a symbol holds text of a web address or a claim (UNSAFE_SYMBOL_TEXT), or a format character (audit I2). */
export const unsafeSymbol = (symbol: string) => {
  const upper = symbol.toUpperCase()
  return UNSAFE_SYMBOL_TEXT.some((text) => upper.includes(text)) || hasFormatCharacter(symbol)
}

const PRINTABLE_ASCII = /^[\x20-\x7e]$/

/**
 * Whether a symbol mixes scripts to pass for `target` (an ASCII symbol, upper case) one letter at a time: as long as
 * it, at least two of its characters the very letters of `target` in their places, and every other one outside ASCII.
 * "USDꓖ" and "WEТH" (a Cyrillic T) pass for "USDG" and "WETH" whatever the table above maps.
 */
export function mixesInto(symbol: string, target: string): boolean {
  const chars = [...symbol.normalize('NFKD').replace(STRIPPED, '')]
  if (chars.length !== target.length) return false
  let ascii = 0
  for (let i = 0; i < chars.length; i++) {
    if (!PRINTABLE_ASCII.test(chars[i])) continue
    if (chars[i].toUpperCase() !== target[i]) return false
    ascii += 1
  }
  return ascii >= 2 && ascii < chars.length
}
