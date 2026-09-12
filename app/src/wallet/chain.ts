import { defineChain } from 'viem'

/**
 * Robinhood Chain, the only network this app talks to.
 *
 * Declared here rather than imported from viem/chains so that no RPC URL is
 * compiled into the bundle. The page's CSP allows connections to its own
 * origin only, and the app makes no RPC calls of its own: anything that needs
 * the chain goes through the connected wallet's provider.
 */
export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [] } },
})
