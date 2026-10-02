/**
 * Mint blocks of position NFTs this browser learned (2026-10-01, item A1): from the wallet's own SetupMinted logs (the
 * Positions list's scan, lib/walletPositions.ts). A hint only: a reader checks one before it uses it (since 2026-10-02
 * the vault record's first block, lib/automationImpact.ts), so a wrong or stale one costs a read, never a wrong figure.
 *
 * Kept in this page's memory and in the browser's storage, per chain and PositionManager (the key), at most
 * MINT_HINTS ids, each a block and its transaction when known: public chain data, no wallet address. Every read and
 * write is behind try/catch; anything that does not validate is let go. Pure apart from the storage handed in.
 */
import { POSITION_MANAGER } from './constants'
import type { MintHint } from './types'

export const MINT_HINTS_KEY = 'domino:mint-hints:1'
export const MINT_HINTS = 256
const IDENTITY = `1:4663:${POSITION_MANAGER}`
const ID = /^[1-9]\d{0,77}$/
const HASH = /^0x[0-9a-f]{64}$/

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface MintHints {
  /** The block `id` was minted at, as learned: null when unknown. */
  get(id: string): MintHint | null
  /** Learned blocks (newest first wins); listeners hear of each new one. */
  note(entries: ReadonlyArray<{ id: string } & MintHint>): void
  listen(listener: (id: string, hint: MintHint) => void): () => void
}

const valid = (id: unknown, block: unknown, tx: unknown): boolean =>
  typeof id === 'string' && ID.test(id) && typeof block === 'number' && Number.isSafeInteger(block) && block > 0 && (tx === null || (typeof tx === 'string' && HASH.test(tx)))

export function createMintHints(storage: () => Storage | null): MintHints {
  const memory = new Map<string, MintHint>()
  const listeners = new Set<(id: string, hint: MintHint) => void>()
  let loaded = false
  const load = () => {
    if (loaded) return
    loaded = true
    try {
      const text = storage()?.getItem(MINT_HINTS_KEY)
      if (!text || text.length > 64 * 1024) return
      const root = JSON.parse(text) as { identity?: unknown; mints?: unknown }
      if (root.identity !== IDENTITY || !Array.isArray(root.mints)) return
      for (const entry of root.mints.slice(0, MINT_HINTS)) {
        if (!Array.isArray(entry) || entry.length !== 3 || !valid(entry[0], entry[1], entry[2])) continue
        if (!memory.has(entry[0])) memory.set(entry[0], { block: entry[1], ...(entry[2] ? { tx: entry[2] } : {}) })
      }
    } catch {
      // Unreadable or blocked storage: memory only.
    }
  }
  const save = () => {
    try {
      const target = storage()
      if (!target) return
      const mints = [...memory].slice(-MINT_HINTS).reverse().map(([id, hint]) => [id, hint.block, hint.tx ?? null])
      target.setItem(MINT_HINTS_KEY, JSON.stringify({ identity: IDENTITY, mints }))
    } catch {
      // Quota or private mode: memory only.
    }
  }
  return {
    get(id) {
      load()
      return memory.get(id) ?? null
    },
    note(entries) {
      load()
      let changed = false
      for (const { id, block, tx } of entries) {
        if (!valid(id, block, tx ?? null)) continue
        const known = memory.get(id)
        if (known?.block === block && (known.tx ?? null) === (tx ?? null)) continue
        memory.delete(id)
        const hint: MintHint = { block, ...(tx ? { tx } : known?.tx && known.block === block ? { tx: known.tx } : {}) }
        memory.set(id, hint)
        changed = true
        for (const listener of Array.from(listeners)) listener(id, hint)
      }
      while (memory.size > MINT_HINTS) memory.delete(memory.keys().next().value as string)
      if (changed) save()
    },
    listen(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** This page's hints (the browser's storage when it can be read). */
export const mintHints = createMintHints(() => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
})
