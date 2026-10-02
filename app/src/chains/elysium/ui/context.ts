/**
 * What every screen of the second chain's section shares (2026-10-01, the chain2 workstream): the chain, its adapter and
 * services, the wallet the person chose, and a clock for "read N s ago".
 */
import { createContext, useContext, useEffect, useState } from 'react'
import type { ChainConfig } from '../../../config/chainKit'
import type { ChainClient } from '../../../lib/chain/client'
import type { KeyValueStore } from '../../../lib/chainStorage'
import type { DiscoveredWallet } from '../../eip6963'
import type { ChainCapabilities } from '../../types'
import type { ElysiumAdapter } from '../adapter'
import type { V3Api } from '../api'
import type { SectionMode, SectionSource } from '../flag'
import type { OwnerSigner } from '../flow'

export interface WalletState {
  readonly wallet: DiscoveredWallet | null
  /** The account the person allowed, lowercase. */
  readonly account: string | null
  /** Whether the wallet is on this section's chain. */
  readonly onChain: boolean
}

export interface Section {
  readonly chain: ChainConfig
  readonly mode: SectionMode
  readonly source: SectionSource
  readonly adapter: ElysiumAdapter
  /** What the chain, the source and his services allow; null until first read. The screens are driven by it. */
  readonly caps: ChainCapabilities | null
  readonly api: V3Api | null
  readonly reader: ChainClient
  /** The closed signer for a chosen wallet (part B); null in a build without one. */
  readonly signerFor: ((wallet: DiscoveredWallet) => OwnerSigner) | null
  readonly wallet: WalletState
  /** Opens the wallet picker. */
  connect(): void
  readonly store: KeyValueStore | null
}

export const SectionContext = createContext<Section | null>(null)

export function useSection(): Section {
  const section = useContext(SectionContext)
  if (!section) throw new Error('outside the Elysium section')
  return section
}

/** The time now, moved on every `everyMs`, for the "read N s ago" lines. */
export function useNow(everyMs = 10_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}
