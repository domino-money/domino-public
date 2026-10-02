import { encode } from 'uqr'
import { FORWARDED } from './walletConnectMethods'
import type { WalletConnectOptions, WalletConnectProvider } from './walletConnectProvider'

/**
 * Test builds only (wallet/walletConnect.ts loads it behind __DOMINO_TEST_HOOKS__, which a deployable build folds to
 * false): WalletConnect's relay and a phone's wallet stood in by the browser tests, so the dialog's pairing, its QR
 * code, the connection it makes and its disconnect are driven without a network. The same shape as
 * ./walletConnectProvider.ts: every request a phone would answer goes to the test through
 * window.__dominoWalletConnectPhone, and every read to lib/walletReads.ts readOnChain, as the real one does (refused at
 * once, RPC-SPEC D6, but a batch's simulation over the site's fixed route, D7).
 */

export function qrModules(text: string): boolean[][] {
  return encode(text, { ecc: 'M', border: 0 }).data
}

type Listener = (...args: unknown[]) => void
interface Phone {
  accept(address: string, chainId: number): void
  reject(): void
  end(): void
  /** What the page asked to open: the pairing link, once per pairing. */
  readonly links: string[]
  readonly disconnects: number
}
type PhoneWindow = Window & {
  __dominoWalletConnect?: Phone
  __dominoWalletConnectPhone?: (method: string, params: unknown[]) => Promise<{ result?: unknown; error?: { code: number; message: string } }>
}

export async function openWalletConnect(options: WalletConnectOptions): Promise<WalletConnectProvider> {
  const win = window as PhoneWindow
  const listeners = new Map<string, Set<Listener>>()
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }
  let account: string | null = null
  let chain = 4663
  let waiting: { resolve: () => void; reject: (error: Error) => void } | null = null
  const links: string[] = []
  let disconnects = 0
  Object.defineProperty(win, '__dominoWalletConnect', {
    configurable: true,
    value: {
      accept(address: string, chainId: number) {
        account = address
        chain = chainId
        waiting?.resolve()
        waiting = null
      },
      reject() {
        waiting?.reject(Object.assign(new Error('Rejected by the wallet.'), { code: 5000 }))
        waiting = null
      },
      end() {
        account = null
        emit('disconnect', Object.assign(new Error('The wallet ended the session.'), { code: 4900 }))
      },
      get links() {
        return links
      },
      get disconnects() {
        return disconnects
      },
    } satisfies Phone,
  })
  return {
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)?.add(listener)
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener)
    },
    connected: () => account !== null,
    peerName: () => (account ? 'Test Phone Wallet' : null),
    accounts: () => (account ? [account] : []),
    chainId: () => chain,
    async pair(onUri) {
      const link = `wc:${'7'.repeat(64)}@2?relay-protocol=irn&symKey=${'5'.repeat(64)}&expiryTimestamp=${Math.floor(Date.now() / 1000) + 300}`
      links.push(link)
      onUri(link)
      await new Promise<void>((resolve, reject) => {
        waiting = { resolve, reject }
      })
    },
    async disconnect() {
      disconnects += 1
      account = null
    },
    async request({ method, params }) {
      const list = Array.isArray(params) ? params : []
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return account ? [account] : []
      if (method === 'eth_chainId') return `0x${chain.toString(16)}`
      if (!FORWARDED.includes(method)) return options.read(method, list)
      if (!account) throw Object.assign(new Error('No wallet is connected through WalletConnect.'), { code: 4100 })
      const reply = await win.__dominoWalletConnectPhone?.(method, list)
      if (!reply) throw Object.assign(new Error('The phone did not answer.'), { code: 4001 })
      if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code })
      if (method === 'wallet_switchEthereumChain') {
        const wanted = Number((list[0] as { chainId?: unknown } | undefined)?.chainId)
        if (Number.isSafeInteger(wanted) && wanted !== chain) {
          chain = wanted
          emit('chainChanged', `0x${wanted.toString(16)}`)
        }
      }
      return reply.result
    },
  }
}
