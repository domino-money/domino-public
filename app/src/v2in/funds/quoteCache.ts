import type { CrosschainOutcome } from '../../v2/crosschain/client'
import type { CrosschainRequests } from '../../v2/crosschain/types'
import type { FundsServices } from './services'

/**
 * Added 2026-10-30 (launch capacity, CAP-11): how long a bridge quote the offer prepared is handed out again for the very
 * same request (the wallet, its session, the route and the amount, ./BringFunds.tsx's speculative preparations only).
 * Each quote spends one call of the providers' shared budget (Relay's and Across's, site-wide), and the same amount is
 * prepared again often: typed back, the tab shown again, the offer opened again. Short enough that the quote is still
 * well inside its own deadline (its timing is the first ask's, so the offer's expiry counts from then).
 */
export const FUNDS_QUOTE_REUSE_MS = 12_000

type Outcome = CrosschainOutcome<'quote'>
interface Entry {
  until: number
  result: Outcome | null
  pending: Promise<Outcome> | null
  /** The preparations still waiting for the pending ask; the last one to leave stops it. */
  waiting: number
  stop: AbortController | null
}

const ABORTED: Outcome = { ok: false, route: 'quote', failure: { kind: 'aborted' } }

/**
 * One in-flight ask per identical request, shared by every preparation that wants it, and its successful answer reused
 * for FUNDS_QUOTE_REUSE_MS. A preparation that is abandoned stops waiting at once; the ask itself stops only when nobody
 * waits for it any more, so a quote still queued for the wallet's request budget (finance/v2/requestCoordinator.ts) never
 * takes a slot for nobody. A refusal, a failure or an abort is never kept.
 */
export function createQuoteCache(reuseMs = FUNDS_QUOTE_REUSE_MS) {
  const entries = new Map<string, Entry>()
  return (services: Pick<FundsServices, 'owner' | 'clock' | 'client'>, access: string, request: CrosschainRequests['quote'], signal?: AbortSignal): Promise<Outcome> => {
    if (signal?.aborted) return Promise.resolve(ABORTED)
    const key = `${services.owner}|${access}|${JSON.stringify(request)}`
    const now = services.clock.monoMs()
    for (const [old, entry] of entries) if (!entry.pending && entry.until <= now) entries.delete(old)
    const found = entries.get(key)
    if (found && !found.pending && found.result && found.until > now) return Promise.resolve(found.result)
    let shared = found?.pending ? found : null
    if (!shared) {
      const stop = new AbortController()
      const entry: Entry = { until: 0, result: null, pending: null, waiting: 0, stop }
      entry.pending = services.client
        .quote(request, { owner: services.owner, signal: stop.signal, priority: 'preview' })
        .then((result) => {
          if (result.ok) {
            entry.result = result
            entry.until = services.clock.monoMs() + reuseMs
          }
          return result
        })
        .finally(() => {
          entry.pending = null
          entry.stop = null
          if (!entry.result && entries.get(key) === entry) entries.delete(key)
        })
      entries.set(key, entry)
      shared = entry
    }
    const work = shared.pending as Promise<Outcome>
    const owner = shared
    owner.waiting += 1
    return new Promise<Outcome>((resolve, reject) => {
      let settled = false
      const leave = () => {
        if (settled) return
        settled = true
        owner.waiting -= 1
        resolve(ABORTED)
        if (owner.waiting === 0 && owner.pending) {
          owner.stop?.abort()
          if (entries.get(key) === owner) entries.delete(key)
        }
      }
      signal?.addEventListener('abort', leave, { once: true })
      work.then(
        (result) => {
          if (settled) return
          settled = true
          owner.waiting -= 1
          signal?.removeEventListener('abort', leave)
          resolve(result)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          owner.waiting -= 1
          signal?.removeEventListener('abort', leave)
          reject(error)
        },
      )
    })
  }
}

/** The page's one quote cache for the funding offer (module scope: it outlives a remount of the offer, as fundingOrigins does). */
export const fundingQuote = createQuoteCache()
