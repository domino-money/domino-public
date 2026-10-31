import type { ReactNode } from 'react'
import { ROBINHOOD_EXPLORER } from '../../config/chainIdentity'
import { Address } from '../read/screens/Address'

/**
 * Where an address in a pool's Technical details opens (QA round 2, N24, the owner's yes): its page on the pool's
 * network's own explorer, on a person's click only, never a read. The hosts and names the docs' Contracts page links
 * (components/docs/DocsContent.tsx). v2/explorers.ts is not imported, so the pool page does not carry V2's chain
 * profiles. Kept out of components/read/screens, which hold no link (tests/screens.test.mjs), as the page's other ways
 * out are (PoolAutomation's docs links).
 */
const EXPLORERS: Readonly<Record<number, { name: string; host: string }>> = {
  4663: { name: 'Robinhood explorer', host: ROBINHOOD_EXPLORER },
  8453: { name: 'Basescan', host: 'https://basescan.org' },
  42161: { name: 'Arbiscan', host: 'https://arbiscan.io' },
}

const CONTRACT = /^0x[0-9a-fA-F]{40}$/

/**
 * A contract's short address as a link to its explorer page, in a new tab. Assistive technology hears the full address,
 * what it is (`children`, e.g. the token's symbol as text) and where it opens. The short address alone where the network
 * has no explorer here or the value is not a contract address.
 */
export function ExplorerAddress({ address, chainId, children }: { address: string; chainId: number; children: ReactNode }) {
  const explorer = EXPLORERS[chainId]
  if (!explorer || !CONTRACT.test(address)) return <Address value={address} short />
  return (
    <a href={`${explorer.host}/address/${address}`} target="_blank" rel="noreferrer noopener" className="dm-pool-kv-link" data-pool-explorer={chainId}>
      <Address value={address} short />
      <span className="sr-only">, {children} on {explorer.name} (opens in a new tab)</span>
    </a>
  )
}
