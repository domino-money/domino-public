import { custom } from 'viem'
import { createConfig, type CreateConnectorFn } from 'wagmi'
import { robinhoodChain } from './chain'
import { walletConnectConnector } from './walletConnect'

/**
 * The wagmi configuration: Robinhood Chain only. Its wallets are the ones that
 * announce themselves through EIP-6963, each as its own connector; a browser
 * wallet that announces itself only as window.ethereum (wallet/port.ts, audit
 * C9); and WalletConnect, for a wallet on a phone (wallet/walletConnect.ts,
 * audit C3), offered only once the build has its project id.
 *
 * - No connector SDK from wagmi: WalletConnect's own client is loaded on demand,
 *   in a chunk of its own, by wallet/walletConnect.ts. Coinbase, MetaMask SDK
 *   and the rest are optional peers of wagmi and are not installed.
 * - The chain's transport refuses every request. Connecting, reading the
 *   chain ID, switching network and signing all go through the connector's
 *   own EIP-1193 provider, so nothing here opens a connection of its own.
 * - No wagmi storage. wagmi would otherwise keep the last connector and the
 *   connected accounts in localStorage; reconnecting after a reload relies on
 *   the wallet's own permission, and on wallet/memory.ts, which keeps only the
 *   ids of the wallets the person disconnected and of the one used last.
 */
const refuse = custom({
  request: () => Promise.reject(new Error('This app makes no RPC calls of its own')),
})

// Announced wallets are added by wagmi as they announce themselves; WalletConnect is the one connector named here.
const connectors: CreateConnectorFn[] = [walletConnectConnector()]

export const walletConfig = createConfig({
  chains: [robinhoodChain],
  connectors,
  multiInjectedProviderDiscovery: true,
  transports: { [robinhoodChain.id]: refuse },
  storage: null,
  ssr: false,
})
