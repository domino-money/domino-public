import { custom } from 'viem'
import { createConfig, type CreateConnectorFn } from 'wagmi'
import { robinhoodChain } from './chain'

/**
 * The wagmi configuration: Robinhood Chain only, and only wallets that
 * announce themselves through EIP-6963, each as its own connector.
 *
 * - No connector packages. WalletConnect, Coinbase, MetaMask SDK and the rest
 *   are optional peers of wagmi and are not installed.
 * - The chain's transport refuses every request. Connecting, reading the
 *   chain ID, switching network and signing all go through the connector's
 *   own EIP-1193 provider, so nothing here opens a connection of its own. (The
 *   page's connect-src is the site itself and, since 2026-09-25, the chain's
 *   public RPC, which only lib/chain/browser.ts asks, for the page's reads.)
 * - No storage. wagmi would otherwise keep the last connector and account
 *   list in localStorage; reconnecting after a reload relies on the wallet's
 *   own permission instead.
 */
const refuse = custom({
  request: () => Promise.reject(new Error('This app makes no RPC calls of its own')),
})

// Empty on purpose: every connector comes from an EIP-6963 announcement.
const connectors: CreateConnectorFn[] = []

export const walletConfig = createConfig({
  chains: [robinhoodChain],
  connectors,
  multiInjectedProviderDiscovery: true,
  transports: { [robinhoodChain.id]: refuse },
  storage: null,
  ssr: false,
})
