/**
 * What the deposit screen remembers across reloads: the id of the last
 * operation it showed, and nothing else (DEP-GEN-8). Never a wallet step,
 * calldata, a hash, an amount or a session value.
 *
 * Two backends. The fixture lab uses the in-memory one, so no fixture id ever
 * reaches browser storage. The localStorage one is for the live consumer
 * later; it is the only place any preview or deposit module touches browser
 * storage (tests/consumer.guard.test.mjs), and it never throws: storage can be
 * blocked, full or missing.
 */
export const MEMORY_KEY = 'domino-deposit-last-operation-v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface MemoryBackend {
  read(): string | null
  write(value: string): void
  remove(): void
}

export interface DepositMemory {
  lastOperationId(): string | null
  remember(id: string): void
  forget(): void
}

export function createMemory(backend: MemoryBackend): DepositMemory {
  return {
    lastOperationId() {
      const value = backend.read()
      return value !== null && UUID.test(value) ? value : null
    },
    remember(id) {
      if (UUID.test(id)) backend.write(id)
    },
    forget() {
      backend.remove()
    },
  }
}

export function inMemoryBackend(): MemoryBackend {
  let value: string | null = null
  return {
    read: () => value,
    write(next) {
      value = next
    },
    remove() {
      value = null
    },
  }
}

export function localStorageBackend(storage: () => Storage | null = () => globalThis.localStorage ?? null): MemoryBackend {
  const attempt = <T>(fn: (store: Storage) => T, fallback: T): T => {
    try {
      const store = storage()
      return store ? fn(store) : fallback
    } catch {
      return fallback
    }
  }
  return {
    read: () => attempt((store) => store.getItem(MEMORY_KEY), null),
    write: (value) => attempt((store) => store.setItem(MEMORY_KEY, value), undefined),
    remove: () => attempt((store) => store.removeItem(MEMORY_KEY), undefined),
  }
}
