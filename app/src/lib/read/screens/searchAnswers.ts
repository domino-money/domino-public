/**
 * The token search's stored answers, kept for a minute and reused (speed wave,
 * 2026-09-28; study item 29).
 *
 * Every pause in typing sent one read-v3 `search` read, and every read spends
 * one of the gateway's per-client reads (a burst of five, then one every two
 * seconds: scheduler.ts). Typing a name slowly, or on a phone, spent them all
 * before the token was even chosen, and the token, pools and balance reads that
 * followed waited up to three seconds for them. Now an answer is kept for this
 * page for a minute (SEARCH_KEEP_MS), and a query is not asked again when it can
 * be answered from what is kept:
 *
 *   - the same query, in any letter case, is its own kept answer;
 *   - a longer query that begins with a kept one ("usd" after "us") is that
 *     answer's tokens whose symbol begins with it, when that answer was
 *     complete (fewer tokens than the limit asked, so nothing was cut off).
 *
 * That is exactly what the service would answer. Its search
 * (backend/public_observations.py `search`) returns the verified tokens whose
 * address or symbol begins with the query, case-insensitively (ILIKE, the
 * query's own % and _ taken literally), ordered by address, at most `limit` of
 * them. A query here never begins with 0x (TokenSearch.tsx sends none), so no
 * address begins with it, and every token a longer query matches is among a
 * shorter one's: when that answer was complete, filtering it keeps the same
 * tokens in the same order. Only ASCII letter case is folded, so a query or a
 * symbol with any other character is always asked of the service. That search
 * is pinned by tests/backend-contract.test.mjs (added 2026-09-28 after
 * review): a change to it fails there, and this file changes with it.
 *
 * Nothing here is shown by itself: TokenSearch.tsx lists the known tokens and
 * these as it did, and a kept answer only saves the wait and the read.
 */
import type { SearchResponse } from 'api-contracts/read-v3/types'
import type { ReadSource } from '../types'
import { candidateFromToken, type TokenCandidate } from './tokens'

/** How many tokens a search asks for (TokenSearch.tsx). */
export const SEARCH_LIMIT = 20
/** How long an answer is reused. */
export const SEARCH_KEEP_MS = 60_000
const MAX_KEPT = 32

type Entry = { source: ReadSource; query: string; tokens: SearchResponse['tokens']; complete: boolean; at: number }

const kept: Entry[] = []

const ASCII = /^[\x20-\x7e]*$/
const fold = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())

/** Whether `query` begins with `shorter`, as the service compares them: an answer to `shorter` may answer it. */
export const extendsQuery = (query: string, shorter: string) => ASCII.test(query) && ASCII.test(shorter) && fold(query).startsWith(fold(shorter))

/** The candidates an answer names, in its order: a token with no stored value names none. */
export const searchCandidates = (tokens: SearchResponse['tokens']): TokenCandidate[] =>
  tokens.flatMap((entry) => (entry.value ? [candidateFromToken(entry.value, entry.address)] : []))

/** Whether `symbol` begins with `query` the way the service's ILIKE decides it, or null when only the service can tell. */
function beginsWith(symbol: string, query: string): boolean | null {
  const head = symbol.slice(0, query.length)
  if (!ASCII.test(head)) return null
  return fold(head) === query
}

/** The answer's tokens for a longer query, or null when one of them cannot be decided here. */
function narrowed(tokens: SearchResponse['tokens'], query: string): SearchResponse['tokens'] | null {
  const out: SearchResponse['tokens'] = []
  for (const entry of tokens) {
    // A token with no stored value names no candidate either way.
    if (!entry.value) continue
    const symbol = entry.value.asset.symbol
    if (symbol === null) continue
    const match = beginsWith(symbol, query)
    if (match === null) return null
    if (match) out.push(entry)
  }
  return out
}

/** The candidates for `query` from what is kept for `source`, or null when the service has to be asked. */
export function keptSearch(source: ReadSource, query: string, at = Date.now()): TokenCandidate[] | null {
  if (!ASCII.test(query)) return null
  const wanted = fold(query)
  let best: Entry | null = null
  for (const entry of kept) {
    if (entry.source !== source || at - entry.at >= SEARCH_KEEP_MS) continue
    const asked = fold(entry.query)
    if (asked === wanted) return searchCandidates(entry.tokens)
    if (entry.complete && wanted.startsWith(asked) && (!best || asked.length > best.query.length)) best = entry
  }
  if (!best) return null
  const tokens = narrowed(best.tokens, wanted)
  return tokens ? searchCandidates(tokens) : null
}

/** Keeps the service's answer to `query`, asked with `limit`. */
export function keepSearch(source: ReadSource, query: string, tokens: SearchResponse['tokens'], limit = SEARCH_LIMIT, at = Date.now()): void {
  if (!ASCII.test(query)) return
  const same = kept.findIndex((entry) => entry.source === source && entry.query === query)
  if (same !== -1) kept.splice(same, 1)
  kept.push({ source, query, tokens, complete: tokens.length < limit, at })
  while (kept.length > MAX_KEPT) kept.shift()
}

/** Forgets every kept answer (tests). */
export function forgetSearches(): void {
  kept.length = 0
}
