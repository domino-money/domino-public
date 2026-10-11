import type { ReactNode } from 'react'
import type { OtherChains } from '../../lib/create/otherChains'
import { useOtherChainsDiscovery } from './useOtherChainsDiscovery'

/** Loaded only by V2 Markets. Public discovery never connects or switches a wallet. */
export default function MarketsNetworks({ children }: { children: (others: OtherChains | null, checking: boolean) => ReactNode }) {
  const { gates, others } = useOtherChainsDiscovery({ walletFallback: false })
  return children(others, gates === null)
}
