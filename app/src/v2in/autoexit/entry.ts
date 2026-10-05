import { useSyncExternalStore } from 'react'

/** The legacy Robinhood-v4 key stays compatible; every other NFT is chain/DEX scoped. */
export const exitOrderKey = (tokenId: string, chainId = 4663, dex = 4): string => chainId === 4663 && dex === 4 ? tokenId : `${chainId}:${dex}:${tokenId}`

/**
 * A position page's way into its Stop-loss / take-profit from the page's actions row (the owner, 2026-10-04: "it belongs
 * inside the position, as a button there"). The page's automation panel (../automate/PositionAutomation.tsx), which knows
 * whether an order can be set on this position, says so here by NFT id; the "···" menu (../position/MoreActions.tsx)
 * lists the entry only then, and a pick asks that panel to open its order dialog (the same one its own card opens).
 * In this page's memory only: nothing is stored, read or sent here.
 */
const offers = new Set<string>()
const listeners = new Set<() => void>()
const askers = new Set<(tokenId: string) => void>()

/** Whether an order can be set on this position now (the panel's word); `false` withdraws it. */
export function offerExitOrder(tokenId: string, offered: boolean): void {
  if (offers.has(tokenId) === offered) return
  if (offered) offers.add(tokenId)
  else offers.delete(tokenId)
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The panel's word for this position, as a hook: re-renders when it changes. */
export function useExitOrderOffered(tokenId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => tokenId !== null && offers.has(tokenId), () => false)
}

/** Asks the panel of this position to open its order dialog. */
export function askExitOrder(tokenId: string): void {
  for (const asker of askers) asker(tokenId)
}

/** The panel's side: runs `open` for each ask; returns the way to stop listening. */
export function onExitOrderAsked(open: (tokenId: string) => void): () => void {
  askers.add(open)
  return () => {
    askers.delete(open)
  }
}
