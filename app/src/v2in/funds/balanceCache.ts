/** Shared, short-lived wallet reads. No balances or wallet identifiers are persisted. */
type Token = { chainId: number; address: string }
type Entry = { until: number; value?: unknown; pending?: Promise<unknown> }

export function createFundingBalanceCache(now: () => number = Date.now) {
  const entries = new Map<string, Entry>()
  const keyOf = (owner: string, tokens: readonly Token[]) => `${owner.toLowerCase()}|${tokens.map((t) => `${t.chainId}:${t.address.toLowerCase()}`).sort().join(',')}`
  return {
    read<T extends { kind: string }>(owner: string, tokens: readonly Token[], load: () => Promise<T>): Promise<T> {
      const key = keyOf(owner, tokens)
      const cached = entries.get(key)
      if (cached?.pending) return cached.pending as Promise<T>
      if (cached?.value !== undefined && cached.until > now()) return Promise.resolve(cached.value as T)
      // A wallet switch must never reuse another wallet's result. Bound retained wallet data as well as its lifetime.
      for (const [oldKey, entry] of entries) if (!entry.pending && entry.until <= now()) entries.delete(oldKey)
      const entry: Entry = { until: 0 }
      entries.set(key, entry)
      const pending = Promise.resolve().then(load).then((result) => {
        if (entries.get(key) === entry && result.kind === 'ok') { entry.value = result; entry.until = now() + 10_000 }
        return result
      }).finally(() => {
        entry.pending = undefined
        if (entries.get(key) === entry && entry.value === undefined) entries.delete(key)
      })
      entry.pending = pending
      return pending
    },
    invalidate(owner: string) {
      const prefix = `${owner.toLowerCase()}|`
      for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key)
    },
  }
}

const shared = createFundingBalanceCache()
export const readFundingBalanceGroup = shared.read
export const invalidateFundingBalances = shared.invalidate
