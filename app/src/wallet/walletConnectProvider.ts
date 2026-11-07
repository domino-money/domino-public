import SignClient from '@walletconnect/sign-client'
import { encode } from 'uqr'
import { ELYSIUM_LIVE, ELYSIUM_V2_ID } from '../lib/elysiumIdentity'
import { FORWARDED } from './walletConnectMethods'

/**
 * WalletConnect, for wallets that live on a phone (2026-10-01, audit C3, the owner's OK): loaded only when the person
 * picks WalletConnect in the Connect dialog, or after a reload when WalletConnect was the wallet used last on this
 * browser (wallet/walletConnect.ts). Its weight stays out of every chunk a page loads otherwise.
 *
 * What it is: an EIP-1193 provider over one WalletConnect v2 session (@walletconnect/sign-client, no modal and no
 * wallet list fetched from anywhere). The page draws its own QR code and buttons (components/wallet/WalletConnectPanel.tsx).
 * - Only the requests a wallet must answer go to the phone, over WalletConnect's relay: the sign-in message, the
 *   transactions the money screens already offer (each reviewed in the wallet before it is signed), the network
 *   switch, and the EIP-5792 batch requests, as ./walletConnectMethods.ts names them (FORWARDED).
 * - No read goes to the relay or to WalletConnect's RPC service: a read is handed to the page's `read` (lib/walletReads.ts
 *   readOnChain), which since 2026-10-01 serves none (RPC-SPEC D6) but a batch's simulation over the site's fixed route.
 * - Telemetry is off. The relay (wss://relay.walletconnect.org) and the Verify API's frame
 *   (https://verify.walletconnect.org) are the two hosts it reaches; functions/_middleware.ts names exactly those.
 * - The session's keys and its account are kept by WalletConnect's own client in this browser (IndexedDB) until the
 *   person disconnects: what lets a phone's wallet stay connected across a reload.
 */

const EVENTS = ['accountsChanged', 'chainChanged']
const ROBINHOOD = 4663
/**
 * The chains the session asks for, all optional: Robinhood Chain, and Ethereum so that a wallet that does not know
 * Robinhood Chain yet still pairs and is then asked to add it (the dialog's "Switch to Robinhood Chain").
 * Changed on purpose 2026-10-04 (Domino V2 live on Base and Arbitrum One, #327): those two as well. A WalletConnect
 * request names its chain, and the session must hold it, so V2's switch to Base or Arbitrum One and what follows there
 * need them in the session. Changed on purpose 2026-11-07 (Elysium as a fourth V2 chain): and Elysium (99901), last,
 * where the build serves it (lib/elysiumIdentity.ts ELYSIUM_LIVE), for the same reason.
 */
const CHAINS = ELYSIUM_LIVE ? [`eip155:${ROBINHOOD}`, 'eip155:1', 'eip155:8453', 'eip155:42161', `eip155:${ELYSIUM_V2_ID}`] : [`eip155:${ROBINHOOD}`, 'eip155:1', 'eip155:8453', 'eip155:42161']

export interface WalletConnectOptions {
  projectId: string
  /** The page's origin, which WalletConnect's Verify API checks against the project's verified domain. */
  origin: string
  /** The page's answer to a read (lib/walletReads.ts readOnChain: refused at once since 2026-10-01, RPC-SPEC D6). */
  read(method: string, params: readonly unknown[]): Promise<unknown>
}

interface Namespace {
  accounts: string[]
  methods: string[]
  events: string[]
  chains?: string[]
}
interface Session {
  topic: string
  expiry: number
  namespaces: Record<string, Namespace>
  peer: { metadata: { name: string } }
}
type Listener = (...args: unknown[]) => void

const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code })
const chainOf = (caip: string) => Number(caip.split(':')[1])

export interface WalletConnectProvider {
  request(args: { method: string; params?: unknown }): Promise<unknown>
  on(event: string, listener: Listener): void
  removeListener(event: string, listener: Listener): void
  /** Whether a session with a wallet is open. */
  connected(): boolean
  /** The paired wallet's own name, as it announced itself. */
  peerName(): string | null
  accounts(): string[]
  chainId(): number
  /** Opens a pairing: `onUri` gets the link the wallet scans or opens; resolves once the wallet approved the session. */
  pair(onUri: (uri: string) => void): Promise<void>
  disconnect(): Promise<void>
}

/** The QR code for a pairing link, as rows of dark (true) and light modules, with no border. */
export function qrModules(text: string): boolean[][] {
  return encode(text, { ecc: 'M', border: 0 }).data
}

export async function openWalletConnect(options: WalletConnectOptions): Promise<WalletConnectProvider> {
  const client = await SignClient.init({
    projectId: options.projectId,
    telemetryEnabled: false,
    logger: 'error',
    metadata: { name: 'Domino', description: 'Liquidity positions on Robinhood Chain', url: options.origin, icons: [`${options.origin}/favicon.svg`] },
  })
  const listeners = new Map<string, Set<Listener>>()
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }
  let session: Session | null = null
  let active = ROBINHOOD

  const approved = (): number[] => (session?.namespaces.eip155?.accounts ?? []).map(chainOf).filter((id) => Number.isSafeInteger(id))
  const settle = () => {
    const chains = approved()
    active = chains.includes(ROBINHOOD) ? ROBINHOOD : chains.includes(active) ? active : chains[0] ?? ROBINHOOD
  }
  const accounts = (): string[] => {
    const all = session?.namespaces.eip155?.accounts ?? []
    const mine = all.filter((account) => chainOf(account) === active).map((account) => account.split(':')[2])
    return [...new Set(mine.length > 0 ? mine : all.map((account) => account.split(':')[2]))]
  }
  const live = (candidate: Session) => candidate.expiry * 1000 > Date.now() && !!candidate.namespaces.eip155
  // A session this browser already holds (the page was reloaded, or the phone's wallet came back to it).
  const kept = (client.session.getAll() as unknown as Session[]).filter(live)
  session = kept.at(-1) ?? null
  settle()

  client.on('session_event', (event: unknown) => {
    const { topic, params } = event as { topic: string; params: { event: { name: string; data: unknown } } }
    if (topic !== session?.topic) return
    if (params.event.name === 'chainChanged') {
      const id = Number(params.event.data)
      if (!Number.isSafeInteger(id) || id === active) return
      active = id
      emit('chainChanged', `0x${id.toString(16)}`)
    } else if (params.event.name === 'accountsChanged') emit('accountsChanged', accounts())
  })
  client.on('session_update', (event: unknown) => {
    const { topic, params } = event as { topic: string; params: { namespaces: Record<string, Namespace> } }
    if (!session || topic !== session.topic) return
    const before = active
    session = { ...session, namespaces: params.namespaces }
    settle()
    if (active !== before) emit('chainChanged', `0x${active.toString(16)}`)
    emit('accountsChanged', accounts())
  })
  const ended = (event: unknown) => {
    if ((event as { topic?: string }).topic !== session?.topic) return
    session = null
    emit('disconnect', rpcError(4900, 'The wallet ended the session.'))
  }
  client.on('session_delete', ended)
  client.on('session_expire', ended)

  return {
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)?.add(listener)
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener)
    },
    connected: () => session !== null,
    peerName: () => session?.peer.metadata.name ?? null,
    accounts,
    chainId: () => active,
    async pair(onUri) {
      const { uri, approval } = await client.connect({
        optionalNamespaces: { eip155: { chains: CHAINS, methods: [...FORWARDED], events: EVENTS } },
      })
      if (uri) onUri(uri)
      session = (await approval()) as unknown as Session
      settle()
    },
    async disconnect() {
      const topic = session?.topic
      session = null
      if (topic) await client.disconnect({ topic, reason: { code: 6000, message: 'User disconnected.' } }).catch(() => {})
    },
    async request({ method, params }) {
      const list = Array.isArray(params) ? params : []
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return session ? accounts() : []
      if (method === 'eth_chainId') return `0x${active.toString(16)}`
      if (!FORWARDED.includes(method)) return options.read(method, list)
      if (!session) throw rpcError(4100, 'No wallet is connected through WalletConnect.')
      // A chain the session already holds is switched to here; the wallet is asked only for one it does not.
      if (method === 'wallet_switchEthereumChain') {
        const wanted = Number((list[0] as { chainId?: unknown } | undefined)?.chainId)
        if (approved().includes(wanted)) {
          if (wanted !== active) {
            active = wanted
            emit('chainChanged', `0x${wanted.toString(16)}`)
          }
          return null
        }
      }
      if (!(session.namespaces.eip155?.methods ?? []).includes(method)) throw rpcError(4200, `The wallet does not support ${method}.`)
      const answer = await client.request({ topic: session.topic, chainId: `eip155:${active}`, request: { method, params: list } })
      // The wallet switched: its session update may come a moment later than its answer, and every later request names
      // this chain (a WalletConnect request carries its chain).
      if (method === 'wallet_switchEthereumChain') {
        const now = Number((list[0] as { chainId?: unknown } | undefined)?.chainId)
        if (Number.isSafeInteger(now) && now !== active) {
          active = now
          emit('chainChanged', `0x${now.toString(16)}`)
        }
      }
      return answer
    },
  }
}
