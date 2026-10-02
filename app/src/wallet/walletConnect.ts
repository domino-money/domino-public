import { getAddress, type Address } from 'viem'
import { createConnector } from 'wagmi'
import { WALLETCONNECT_PROJECT_ID } from '../config/walletConnect'
import { memory } from './memory'
import type { WalletConnectProvider } from './walletConnectProvider'

/**
 * WalletConnect as one of the wallet dialog's connectors (2026-10-01, audit C3, the owner's OK): a phone's wallet
 * pairs by scanning a QR code, or, on the phone itself, by opening the wallet app. The heavy part,
 * ./walletConnectProvider.ts with WalletConnect's client, is a chunk of its own, loaded only when the person picks
 * WalletConnect, or after a reload when it was the wallet connected last on this browser (./memory.ts). Every other
 * visitor downloads none of it. Without a project id (config/walletConnect.ts) the option is not offered at all.
 */

export const WALLETCONNECT_ID = 'walletConnect'
/** Test builds stand in a fake project and a fake phone (./walletConnectFake.ts) for WalletConnect's relay. */
const PROJECT_ID = __DOMINO_TEST_HOOKS__ ? '0123456789abcdef0123456789abcdef' : WALLETCONNECT_PROJECT_ID

/** Whether this build offers WalletConnect: a project id in the shape Reown's dashboard gives. */
export const walletConnectOffered = (): boolean => /^[0-9a-f]{32}$/.test(PROJECT_ID)

type Module = typeof import('./walletConnectProvider')
const loadModule = (): Promise<Module> => (__DOMINO_TEST_HOOKS__ ? import('./walletConnectFake') : import('./walletConnectProvider'))
/**
 * Every read a WalletConnect wallet is not asked (it answers none): refused at once, with no network call, since the site
 * serves no read of the chain (lib/walletReads.ts readOnChain, RPC-SPEC D6); only a batch's simulation goes to the site's
 * fixed route, off unless the deployment turns it on (D7). Changed on purpose 2026-10-02 (review of the RPC switch,
 * finding 2): this was the page's own line to the chain, which is gone.
 */
const read = (method: string, params: readonly unknown[]) => import('../lib/chain/chainCode').then((chain) => chain.readOnChain(method, params))

let provider: Promise<WalletConnectProvider> | null = null
/** The provider, loaded and opened once per page. */
function load(): Promise<WalletConnectProvider> {
  if (!walletConnectOffered()) return Promise.reject(new Error('walletconnect_not_configured'))
  provider ??= loadModule()
    .then((module) => module.openWalletConnect({ projectId: PROJECT_ID, origin: window.location.origin, read }))
    .catch((error: unknown) => {
      provider = null
      throw error
    })
  return provider
}

/** The QR code of a pairing link, from the chunk the pairing itself loaded. */
export const pairingQr = (uri: string): Promise<boolean[][]> => loadModule().then((module) => module.qrModules(uri))

/** The pairing link of the connection waiting for a phone's wallet, while it waits; for WalletConnectPanel.tsx. */
let pairing: string | null = null
const pairingListeners = new Set<() => void>()
function setPairing(next: string | null) {
  pairing = next
  for (const listener of pairingListeners) listener()
}
export const pairingLink = (): string | null => pairing
export function subscribePairing(listener: () => void): () => void {
  pairingListeners.add(listener)
  return () => {
    pairingListeners.delete(listener)
  }
}

export const walletConnectConnector = () =>
  createConnector<WalletConnectProvider>((config) => {
    let attached: WalletConnectProvider | null = null
    const handlers = {
      accounts: (accounts: unknown) => (Array.isArray(accounts) && accounts.length === 0 ? config.emitter.emit('disconnect') : config.emitter.emit('change', { accounts: (accounts as string[]).map((account) => getAddress(account)) })),
      chain: (chain: unknown) => config.emitter.emit('change', { chainId: Number(chain) }),
      ended: () => config.emitter.emit('disconnect'),
    }
    function attach(next: WalletConnectProvider) {
      if (attached === next) return
      attached = next
      next.on('accountsChanged', handlers.accounts)
      next.on('chainChanged', handlers.chain)
      next.on('disconnect', handlers.ended)
    }
    function detach() {
      attached?.removeListener('accountsChanged', handlers.accounts)
      attached?.removeListener('chainChanged', handlers.chain)
      attached?.removeListener('disconnect', handlers.ended)
      attached = null
    }
    return {
      id: WALLETCONNECT_ID,
      name: 'WalletConnect',
      type: 'walletConnect',
      async connect({ isReconnecting } = {}) {
        const opened = await load()
        if (!opened.connected()) {
          if (isReconnecting) throw new Error('walletconnect_no_session')
          // The pairing link, for the dialog's QR code and its "Open your wallet app" button (WalletConnectPanel.tsx).
          try {
            await opened.pair((uri) => {
              setPairing(uri)
              config.emitter.emit('message', { type: 'display_uri', data: uri })
            })
          } finally {
            setPairing(null)
          }
        }
        attach(opened)
        const accounts = opened.accounts().map((account) => getAddress(account))
        if (accounts.length === 0) throw new Error('walletconnect_no_account')
        // withCapabilities is never asked by this app (wagmi's connect action passes it through).
        return { accounts: accounts as never, chainId: opened.chainId() }
      },
      async disconnect() {
        const opened = attached
        detach()
        await opened?.disconnect()
      },
      async getAccounts() {
        return (await load()).accounts().map((account) => getAddress(account)) as readonly Address[]
      },
      async getChainId() {
        return (await load()).chainId()
      },
      getProvider: load,
      async isAuthorized() {
        // Only a browser where WalletConnect connected last, and was not disconnected since, loads it to look.
        if (!walletConnectOffered() || memory.recent() !== WALLETCONNECT_ID || memory.disconnected(WALLETCONNECT_ID)) return false
        try {
          return (await load()).connected()
        } catch {
          return false
        }
      },
      onAccountsChanged: (accounts: string[]) => handlers.accounts(accounts),
      onChainChanged: (chain: string) => handlers.chain(chain),
      onDisconnect: () => handlers.ended(),
    }
  })
