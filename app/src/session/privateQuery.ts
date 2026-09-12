import { QueryClient, useQuery } from '@tanstack/react-query'
import type { PrivateScope } from './controller'
import type { PrivateIdentity } from './machine'

/**
 * The cache for data that belongs to a signed-in wallet, and only that.
 *
 * Separate from any public read cache, so clearing it can never evict market
 * data, and cleared outright on every account, network, connector or session
 * change. Keys start with the scope (connector instance, address, chain and
 * session epoch), so even a request that resolves after a switch writes under
 * a scope nothing reads any more.
 *
 * Session credentials never enter this cache: the CSRF, preauth token,
 * challenge and signature stay inside the session machine.
 */
export const privateQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: Infinity,
      // Kept until cleared explicitly. Clearing is tied to identity and
      // session changes, not to whether a component happens to be mounted.
      gcTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
    mutations: { retry: false },
  },
})

export function privateKey(scope: PrivateScope, ...parts: ReadonlyArray<string | number>) {
  return ['private', scope.connectorUid, scope.address.toLowerCase(), scope.chainId, scope.epoch, ...parts] as const
}

/** Cancels private requests in flight and drops every private query and mutation. */
export function clearPrivate() {
  privateQueryClient.cancelQueries({ queryKey: ['private'] }).catch(() => {})
  privateQueryClient.clear()
}

export function storePrivate(scope: PrivateScope, identity: PrivateIdentity) {
  privateQueryClient.setQueryData(privateKey(scope, 'session'), identity)
}

/**
 * The options every private read uses: keyed by scope, disabled without one,
 * and given the query's AbortSignal so a switch cancels it. Exported apart from
 * the hook so the node tests drive exactly these options on a real client.
 */
export function privateQueryOptions<T>(
  scope: PrivateScope | null,
  parts: ReadonlyArray<string | number>,
  queryFn: (signal: AbortSignal) => Promise<T>,
) {
  return {
    queryKey: scope ? privateKey(scope, ...parts) : (['private', 'signed-out', ...parts] as const),
    queryFn: ({ signal }: { signal: AbortSignal }) => queryFn(signal),
    enabled: scope !== null,
  }
}

/** The pattern every private read follows (see privateQueryOptions). */
export function usePrivateQuery<T>(
  scope: PrivateScope | null,
  parts: ReadonlyArray<string | number>,
  queryFn: (signal: AbortSignal) => Promise<T>,
) {
  return useQuery(privateQueryOptions(scope, parts, queryFn))
}

/** The signed-in identity the session machine stored for this scope, if any. */
export function useSignedInIdentity(scope: PrivateScope | null) {
  return usePrivateQuery<PrivateIdentity>(scope, ['session'], () =>
    Promise.reject(new Error('The signed-in identity is written by the session machine, never fetched')),
  )
}
