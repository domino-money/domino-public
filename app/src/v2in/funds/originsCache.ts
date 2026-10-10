import type { CrosschainOutcome } from '../../v2/crosschain/client'
import type { CrosschainRequests } from '../../v2/crosschain/types'
import type { FundsServices } from './services'

/** Route discovery depends on destination, not the amount being typed. A useful in-flight discovery survives edits. */
export function createOriginsCache() {
  const entries = new Map<string, { until: number; result?: CrosschainOutcome<'origins'>; pending?: Promise<CrosschainOutcome<'origins'>> }>()
  return (services: FundsServices, access: string, request: CrosschainRequests['origins']) => {
    const key = `${services.owner}|${access}|${request.destinationChainId}|${request.destinationToken.toLowerCase()}`
    const now = services.clock.monoMs()
    const cached = entries.get(key)
    if (cached?.pending) return cached.pending
    if (cached?.result && cached.until > now) return Promise.resolve(cached.result)
    for (const [old, entry] of entries) if (!entry.pending && entry.until <= now) entries.delete(old)
    const entry: { until: number; result?: CrosschainOutcome<'origins'>; pending?: Promise<CrosschainOutcome<'origins'>> } = { until: 0 }
    entries.set(key, entry)
    entry.pending = services.client.origins(request, { owner: services.owner }).then((result) => {
      if (result.ok) {
        entry.result = result
        // An incomplete provider listing must recover promptly instead of concealing eligible sources for minutes.
        entry.until = services.clock.monoMs() + (result.data.origins.providers.some((provider) => provider.status !== 'listed') ? 10_000 : 300_000)
      }
      return result
    }).finally(() => { entry.pending = undefined; if (!entry.result) entries.delete(key) })
    return entry.pending
  }
}

export const fundingOrigins = createOriginsCache()

/** Stop waiting promptly without cancelling a shared read needed by another consumer. */
export function fundingWait<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(new Error('funding_cancelled'))
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('funding_cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
