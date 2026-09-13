/**
 * Token search by name over the tokens this app already knows by exact
 * address: the labelled tokens of the selected pools, the rows of a wallet
 * listing, and tokens already read. The backend has no symbol route, so a
 * name here is only a way to an address. Identity is always chain 4663 plus
 * the address, and choosing a hit still performs the real token read for that
 * address (or hands over a candidate that read already produced).
 *
 * Labels are decoration: a read symbol is untrusted text from the contract,
 * a catalogue label is a display name bound to one address. Neither is ever
 * matched on anything but itself, and an artwork key is never searched.
 */
import type { CatalogueToken } from '../../../config/selectedPoolCatalogue'
import type { ArtworkKey } from '../types'
import { addressKey, parseAddressInput, type AddressKey } from './identity'
import { selectable, type TokenCandidate } from './tokens'

export type KnownSource = 'catalogue' | 'wallet' | 'read'

export interface KnownToken {
  key: AddressKey
  /** What goes back on the wire when this token has to be read: the lowercase address, or a candidate's own wire. */
  wire: string
  /** The read symbol when there is one, else the catalogue label, else null. Untrusted text, never an identity. */
  label: string | null
  /** Where this app knows the token from, catalogue first. */
  sources: KnownSource[]
  /** From the read token when there is one, else the catalogue. Never derived from a label. */
  artwork: ArtworkKey | null
  /** The candidate a read or a wallet listing already produced, when there is one. */
  candidate: TokenCandidate | null
  /** A wallet row's balance text, only when the row is selectable. */
  balanceText: string | null
}

const sourceOf = (candidate: TokenCandidate): KnownSource => (candidate.source === 'wallet' ? 'wallet' : 'read')

/**
 * One entry per lowercase address. Catalogue tokens come first, in catalogue
 * order; every other address follows in candidate order. A later candidate
 * for the same address replaces an earlier one, as the picker's own merge does.
 */
export function knownTokens(input: { catalogue: readonly CatalogueToken[]; candidates: readonly TokenCandidate[] }): KnownToken[] {
  const order: AddressKey[] = []
  const fromCatalogue = new Map<AddressKey, CatalogueToken>()
  for (const token of input.catalogue) {
    const key = addressKey(token.address)
    if (fromCatalogue.has(key)) continue
    fromCatalogue.set(key, token)
    order.push(key)
  }
  const latest = new Map<AddressKey, TokenCandidate>()
  const seen = new Map<AddressKey, KnownSource[]>()
  for (const candidate of input.candidates) {
    if (!fromCatalogue.has(candidate.key) && !latest.has(candidate.key)) order.push(candidate.key)
    latest.set(candidate.key, candidate)
    const sources = seen.get(candidate.key) ?? []
    const source = sourceOf(candidate)
    if (!sources.includes(source)) sources.push(source)
    seen.set(candidate.key, sources)
  }
  return order.map((key) => {
    const entry = fromCatalogue.get(key) ?? null
    const candidate = latest.get(key) ?? null
    const sources: KnownSource[] = [...(entry ? (['catalogue'] as const) : []), ...(seen.get(key) ?? [])]
    return {
      key,
      wire: entry ? key : (candidate?.wire ?? key),
      label: candidate?.token.symbol ?? entry?.label ?? null,
      sources,
      artwork: candidate?.token.artwork ?? entry?.artwork ?? null,
      candidate,
      balanceText: candidate !== null && candidate.source === 'wallet' && selectable(candidate) ? (candidate.balance?.text ?? null) : null,
    }
  })
}

export type SearchResult =
  /** A token this app knows. Rank: 0 exact label, 1 label prefix, 2 label substring; 0 for an address or an empty query. */
  | { kind: 'known'; token: KnownToken; rank: 0 | 1 | 2 }
  /** A well-formed address nobody here knows yet: only a read can say what it is. */
  | { kind: 'address'; wire: string; key: AddressKey }

const rankOf = (label: string, needle: string): 0 | 1 | 2 | null => {
  const haystack = label.toLowerCase()
  if (haystack === needle) return 0
  if (haystack.startsWith(needle)) return 1
  if (haystack.includes(needle)) return 2
  return null
}

/**
 * The hits for a query. Empty: every known token, catalogue-sourced first.
 * An address: the known token with that key, else the address itself. Any
 * other text: known tokens ranked by their label, case-insensitively, exact
 * before prefix before substring, stable within a rank. A token with no label
 * never matches a name; nothing but the label is ever searched.
 */
export function searchTokens(query: string, known: readonly KnownToken[], limit = 8): SearchResult[] {
  const trimmed = query.trim()
  if (trimmed === '') {
    const catalogue = known.filter((token) => token.sources.includes('catalogue'))
    const rest = known.filter((token) => !token.sources.includes('catalogue'))
    return [...catalogue, ...rest].slice(0, limit).map((token) => ({ kind: 'known', token, rank: 0 }))
  }
  const address = parseAddressInput(trimmed)
  if (address.ok) {
    const hit = known.find((token) => token.key === address.key)
    return hit ? [{ kind: 'known', token: hit, rank: 0 }] : [{ kind: 'address', wire: address.wire, key: address.key }]
  }
  const needle = trimmed.toLowerCase()
  const ranked: Array<{ token: KnownToken; rank: 0 | 1 | 2; at: number }> = []
  known.forEach((token, at) => {
    if (token.label === null) return
    const rank = rankOf(token.label, needle)
    if (rank !== null) ranked.push({ token, rank, at })
  })
  ranked.sort((a, b) => a.rank - b.rank || a.at - b.at)
  return ranked.slice(0, limit).map(({ token, rank }) => ({ kind: 'known', token, rank }))
}
