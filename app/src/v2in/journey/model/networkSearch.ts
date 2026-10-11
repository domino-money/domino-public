import type { NetworkSearch, NetworkToken, OtherChainId } from '../../../lib/create/otherChains'
import type { TokenDisplay } from '../../../lib/read/types'

/**
 * The other networks' search in New position, what is pure of it (2026-10-06, the owner's point 3: on Base and Arbitrum
 * One the search "sometimes only brings Robinhood Chain"): which text each network is asked about, when, and what it
 * said. The reads, the clock and the page's visibility are handed in (../otherChains.ts gives read-v6's chain-tokens and
 * chain-pools, and the read screens' quiet waits), so this has no wallet, no React and no timer of its own.
 *
 *   - Only the newest text the open list asks for is asked (`ask`), one read at a time per network: a read cannot be
 *     called back once sent, so an older one out keeps its network's turn, and its answer, now stale, is ignored; the
 *     newest text is asked as soon as it is in. A slot of the reader is never held by more than one abandoned search.
 *   - A read that failed for the moment is asked again after a quiet wait (`delay`, `after`), a few times, only while the
 *     list still asks for its text; the function `ask` returned stops it (the list closed, or the text changed). Once its
 *     re-asks are spent, or the route is off, the network is done with that text: its own currencies stand in.
 *   - A pasted address is looked up on each network (what it is there: a token named, none, or not read), except where it
 *     is one of the network's own currencies, which are named without a read (`own`).
 *   - `pending` says whether some network is still being searched for a text (the search's icon pulses meanwhile).
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** The text a search asks the networks about: two characters at least, or a whole address (lower case); null otherwise. */
export function searchable(query: string): string | null {
  const text = query.trim()
  if (text.length < 2 || (/^0x/i.test(text) && !ADDRESS.test(text))) return null
  return /^0x/i.test(text) ? text.toLowerCase() : text
}

/** A pasted address on one network, as the search lists it: named, not a token there, or not read (looked up once chosen). */
export type Pasted = { state: 'token'; token: TokenDisplay } | { state: 'none' } | { state: 'unread' } | { state: 'metadata_unavailable' }

/** What one network said to a search's read. */
export type SearchAnswer =
  /** A name's hits there. */
  | { kind: 'hits'; rows: NetworkToken[] }
  /** What a pasted address is there. */
  | { kind: 'pasted'; said: Pasted }
  /** The route does not serve: nothing to wait for, the network's own currencies stand in. */
  | { kind: 'off' }
  /**
   * No answer; `passing` when asking again soon could help. `retryAfterS` (added 2026-10-06, rugged's answer of 6 Oct, §1):
   * the Retry-After a busy reader named, in whole seconds, for `delay`.
   */
  | { kind: 'failed'; passing: boolean; retryAfterS?: number }

export interface SearchDeps {
  /** The networks searched. */
  chains: readonly OtherChainId[]
  /** One network's read for a text (a name, or a whole address in lower case). Never rejects. */
  read: (chainId: OtherChainId, text: string) => Promise<SearchAnswer>
  /** Whether an address is one of the network's own currencies, named without a read. */
  own: (chainId: OtherChainId, address: string) => boolean
  /**
   * The wait before quiet re-ask number `attempt` (0 for the first), or null when no more are asked. Changed on purpose
   * 2026-10-06 (rugged's answer of 6 Oct, §1): with the Retry-After the failed read named, if any.
   */
  delay: (attempt: number, retryAfterS?: number) => number | null
  /** Runs `run` once `ms` have passed (with the page visible); returns what cancels it. */
  after: (ms: number, run: () => void) => () => void
  /** How many texts' answers are kept for the page (per network and text). */
  kept?: number
}

export interface SearchStore extends NetworkSearch {
  /** A name's hits on a network, once answered (the newest answer for that text); undefined before. */
  found: (chainId: OtherChainId, text: string) => readonly NetworkToken[] | undefined
  /** What a pasted address is on a network, once looked up; undefined while it is (or before). */
  pasted: (chainId: OtherChainId, address: string) => Pasted | undefined
}

export function createNetworkSearch(deps: SearchDeps): SearchStore {
  const kept = deps.kept ?? 200
  const found = new Map<string, NetworkToken[]>()
  const pastes = new Map<string, Pasted>()
  /** A name search done without an answer: its route is off, or it failed for good. */
  const settled = new Set<string>()
  /** Quiet re-asks spent, per network and text. */
  const spent = new Map<string, number>()
  /** The text each network's one read out is about. */
  const lanes = new Map<OtherChainId, string>()
  /** A quiet re-ask waiting, per network. */
  const waiting = new Map<OtherChainId, { text: string; cancel: () => void }>()
  const listeners = new Set<() => void>()
  let version = 0
  let wanted: string | null = null
  const keyOf = (chainId: OtherChainId, text: string) => `${chainId}|${text}`
  const notify = () => {
    version += 1
    for (const listener of listeners) listener()
  }
  const keep = <T>(map: Map<string, T>, key: string, value: T) => {
    map.delete(key)
    map.set(key, value)
    while (map.size > kept) map.delete(map.keys().next().value as string)
  }
  /** Whether a network still has to be asked about a text, or is being asked. */
  function open(chainId: OtherChainId, text: string): boolean {
    const key = keyOf(chainId, text)
    if (ADDRESS.test(text)) return !deps.own(chainId, text) && !pastes.has(key)
    return !found.has(key) && !settled.has(key)
  }
  function stopWaiting(keepText: string | null) {
    for (const [chainId, wait] of waiting) {
      if (wait.text === keepText) continue
      wait.cancel()
      waiting.delete(chainId)
    }
  }
  /** A failed name search asked again after its quiet wait, while the list still asks for its text; or done for good. */
  function again(chainId: OtherChainId, text: string, retryAfterS?: number) {
    const key = keyOf(chainId, text)
    const attempt = spent.get(key) ?? 0
    const wait = deps.delay(attempt, retryAfterS)
    if (wait === null) {
      settled.add(key)
      return
    }
    spent.set(key, attempt + 1)
    const cancel = deps.after(wait, () => {
      if (waiting.get(chainId)?.text !== text) return
      waiting.delete(chainId)
      pump(chainId)
    })
    waiting.set(chainId, { text, cancel })
  }
  /** Asks the network about the text the list wants now, unless a read is out or waiting, or it was answered. */
  function pump(chainId: OtherChainId) {
    const text = wanted
    if (text === null || lanes.has(chainId) || waiting.has(chainId) || !open(chainId, text)) return
    lanes.set(chainId, text)
    void deps.read(chainId, text).then(
      (answer) => settle(chainId, text, answer),
      () => settle(chainId, text, { kind: 'failed', passing: true }),
    )
  }
  function settle(chainId: OtherChainId, text: string, answer: SearchAnswer) {
    lanes.delete(chainId)
    // An answer to a text the list no longer asks for is ignored; the newest text is asked now.
    if (text === wanted) {
      const key = keyOf(chainId, text)
      if (answer.kind === 'hits') keep(found, key, answer.rows)
      else if (answer.kind === 'pasted') keep(pastes, key, answer.said)
      else if (answer.kind === 'failed' && answer.passing && !ADDRESS.test(text)) again(chainId, text, answer.retryAfterS)
      else if (ADDRESS.test(text)) keep(pastes, key, { state: 'unread' })
      else settled.add(key)
      notify()
    }
    pump(chainId)
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    version: () => version,
    ask(query) {
      const text = searchable(query)
      if (text === null) return () => undefined
      wanted = text
      stopWaiting(text)
      for (const chainId of deps.chains) pump(chainId)
      return () => {
        if (wanted !== text) return
        wanted = null
        stopWaiting(null)
        // Asked afresh the next time the list asks for this text: a failure is not kept past an open list.
        for (const chainId of deps.chains) {
          const key = keyOf(chainId, text)
          settled.delete(key)
          spent.delete(key)
          const state = pastes.get(key)?.state
          if (state === 'unread' || state === 'metadata_unavailable') pastes.delete(key)
        }
        notify()
      }
    },
    pending(query) {
      const text = searchable(query)
      return text !== null && deps.chains.some((chainId) => open(chainId, text))
    },
    unavailable(query) {
      const text = searchable(query)
      if (text === null) return []
      return deps.chains.filter((chainId) => {
        const key = keyOf(chainId, text)
        const state = pastes.get(key)?.state
        return ADDRESS.test(text) ? state === 'unread' || state === 'metadata_unavailable' : settled.has(key)
      })
    },
    found: (chainId, text) => found.get(keyOf(chainId, text)),
    pasted: (chainId, address) => pastes.get(keyOf(chainId, address)),
  }
}
