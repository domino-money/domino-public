import { getAddress, numberToHex, type Address } from 'viem'
import { injected, type Connector } from 'wagmi'
import { connect, disconnect, getConnection, reconnect, signMessage, watchConnection } from 'wagmi/actions'
import type { SignOutcome } from '../session/controller'
import { V2_CHAIN_IDS } from '../config/chainIdentity'
import { ROBINHOOD_CHAIN_ID, type WalletIdentity } from '../session/machine'
import { ADD_ROBINHOOD_CHAIN } from './chain'
import { walletConfig } from './config'
import { codesOf } from './codes'
import { memory } from './memory'

/**
 * Everything the session feature asks of the wallet. These requests reach the
 * provider: account access, the chain ID, `personal_sign` for the sign-in
 * message, and `wallet_switchEthereumChain` when the user asks to switch, with
 * `wallet_addEthereumChain` before it when the wallet does not know Robinhood
 * Chain (changed on purpose 2026-10-01, audit C1, the owner's OK; the network's
 * fixed details are in ./chain.ts). Nothing here can build, sign or send a
 * transaction.
 */

type Connection = ReturnType<typeof getConnection>

/**
 * wagmi's connection state as the machine's identity. Only a settled
 * connection counts: while wagmi is connecting or reconnecting, the account it
 * reports can be a stale one, so it is reported as unknown.
 *
 * The connector is identified by its wagmi uid, one per announced provider,
 * never by `connector.id`: for an EIP-6963 wallet that is the rdns the
 * provider announced about itself, and two providers can announce the same.
 */
export function toIdentity(connection: Connection): WalletIdentity {
  if (connection.status === 'disconnected') return { kind: 'disconnected' }
  const { address, chainId, connector } = connection
  if (connection.status !== 'connected' || !address || chainId === undefined || !connector) return { kind: 'unknown' }
  return { kind: 'connected', connectorUid: connector.uid, connectorName: connector.name, address: getAddress(address), chainId }
}

const USER_REJECTED = 4001
/** WalletConnect's own "User rejected." (its SDK error 5000), which a phone's wallet may answer instead of 4001. */
const WALLETCONNECT_REJECTED = 5000
const rejected = (codes: number[]) => codes.includes(USER_REJECTED) || codes.includes(WALLETCONNECT_REJECTED)
const UNRECOGNIZED_CHAIN = 4902
/** A request of the same kind is already open in the wallet (EIP-1474 resource unavailable): its prompt waits there. */
const ALREADY_PENDING = -32002
/** The wallet does not carry the method (EIP-1193 4200, JSON-RPC -32601). */
const UNSUPPORTED: ReadonlySet<number> = new Set([4200, -32601])

// ---- connecting --------------------------------------------------------------------------------------------------

export type ConnectOutcome = 'connected' | 'user_rejected' | 'pending' | 'cancelled' | 'error'

/**
 * The connection the person asked for and the wallet has not answered yet (2026-10-01, audit C7): the dialog keeps its
 * list, says which wallet to open, and Cancel lets go of it. A prompt hidden behind another window used to leave the
 * dialog on "Looking for your wallet…" until a reload, and the other wallets out of the list.
 */
interface Attempt {
  connector: Connector
  cancelled: boolean
}
type Connecting = { uid: string; name: string } | null
let attempt: Attempt | null = null
/**
 * The person's last pick in the dialog, whether its prompt is still open or has long since answered (2026-10-01, fix
 * round 1): `attempt` is let go when a pick settles or is cancelled, so it alone cannot tell a late approval of a wallet
 * the person moved away from (a later pick connected meanwhile) from one approved after Cancel with nothing picked since.
 */
let lastPick: Attempt | null = null
/** Every pick whose prompt has not answered yet, the cancelled ones too. */
const unanswered = new Set<Attempt>()
/**
 * The wallets whose open prompt the person moved away from (another wallet picked since): wagmi makes such a wallet the
 * page's current one the moment its late approval lands, before connectWallet can let it go, so the identity feed does
 * not report it meanwhile (the session would otherwise sign the chosen wallet out; fix round 1).
 */
const superseded = new Set<string>()
let shown: Connecting = null
const attemptListeners = new Set<() => void>()
function setAttempt(next: Attempt | null) {
  attempt = next
  shown = next ? { uid: next.connector.uid, name: next.connector.name } : null
  for (const listener of attemptListeners) listener()
}
/** The wallet whose connection prompt is open, as the dialog shows it, or null; the same object until it changes. */
export const connectingState = (): Connecting => shown
export function subscribeConnecting(listener: () => void): () => void {
  attemptListeners.add(listener)
  return () => {
    attemptListeners.delete(listener)
  }
}

/**
 * Connects the connector the user picked: the very instance the dialog listed,
 * not one looked up by `connector.id` (an rdns two providers can share). A new
 * pick replaces one whose prompt never answered; a connection that wallet grants
 * later is let go, so the page never ends on a wallet the person moved away from.
 */
export async function connectWallet(connector: Connector): Promise<ConnectOutcome> {
  if (!walletConfig.connectors.includes(connector)) return 'error'
  if (attempt) attempt.cancelled = true
  const mine: Attempt = { connector, cancelled: false }
  for (const open of unanswered) if (open.connector !== connector) superseded.add(open.connector.uid)
  superseded.delete(connector.uid)
  unanswered.add(mine)
  lastPick = mine
  setAttempt(mine)
  try {
    await connect(walletConfig, { connector })
    if (mine.cancelled && lastPick !== mine && lastPick?.connector !== connector) {
      // Another wallet was picked meanwhile, whether its prompt is still open or it already connected: this late approval
      // is not what the person chose. It is let go, and the page stays on the wallet picked last where that one is
      // connected. (One approved after Cancel, with nothing picked since, is the person's own later choice, and stays.)
      const chosen = lastPick?.connector.uid
      await disconnect(walletConfig, { connector }).catch(() => {})
      if (chosen && walletConfig.state.connections.has(chosen) && walletConfig.state.current !== chosen) {
        walletConfig.setState((state) => ({ ...state, current: chosen, status: 'connected' }))
      }
      superseded.delete(connector.uid)
      return 'cancelled'
    }
    memory.connected(connector.id)
    return 'connected'
  } catch (error) {
    if (mine.cancelled) return 'cancelled'
    const codes = codesOf(error)
    if (rejected(codes)) return 'user_rejected'
    if (codes.includes(ALREADY_PENDING)) return 'pending'
    return 'error'
  } finally {
    unanswered.delete(mine)
    if (![...unanswered].some((open) => open.connector.uid === connector.uid) && lastPick?.connector !== connector) superseded.delete(connector.uid)
    if (attempt === mine) setAttempt(null)
  }
}

/**
 * Lets go of the connection whose prompt is open: the page stops waiting for it. The wallet's own prompt cannot be
 * closed from here; if the person approves it later, the page connects as if they had picked that wallet again.
 */
export function cancelConnect(): void {
  if (!attempt) return
  attempt.cancelled = true
  setAttempt(null)
  walletConfig.setState((state) => ({ ...state, status: state.current ? 'connected' : 'disconnected' }))
}

/**
 * Disconnect lets go of every wallet connection this page holds, not only the current one (2026-10-01, audit C11):
 * with two authorized wallets, wagmi used to move the page to the other wallet's account. Every listed wallet is
 * remembered as disconnected on this browser (./memory.ts, wallet ids only), so a reload connects none of them until
 * the person connects one.
 */
export async function disconnectWallet(): Promise<void> {
  cancelConnect()
  const connected = [...walletConfig.state.connections.values()].map((connection) => connection.connector)
  // Every wallet this page lists, not only the connected one: another wallet that also authorized this site would
  // otherwise be the one a reload connects (a shared computer stays disconnected until someone connects a wallet).
  memory.disconnectedAll([...walletConfig.connectors, ...connected].map((connector) => connector.id))
  for (const connector of connected) await disconnect(walletConfig, { connector }).catch(() => {})
  if (walletConfig.state.connections.size > 0 || walletConfig.state.status !== 'disconnected') {
    walletConfig.setState((state) => ({ ...state, connections: new Map(), current: null, status: 'disconnected' }))
  }
}

// ---- reconnecting ------------------------------------------------------------------------------------------------

/** wagmi's id for the browser wallet that announces itself only as window.ethereum (audit C9). */
export const LEGACY_ID = 'injected'
/** How long the page waits for an EIP-6963 announcement before it offers window.ethereum as a browser wallet. */
export const LEGACY_WAIT_MS = 300

/**
 * How long the first run waits for the remembered wallet to announce itself before it says no wallet is connected
 * (2026-10-15, pack 8, X2): extensions announce themselves at once as a rule, a few a moment later.
 */
export const REMEMBERED_WAIT_MS = 600

/** The wallet this browser connected last, unless the person disconnected it here since; null when none is remembered. */
function remembered(): string | null {
  const recent = memory.recent()
  return recent !== null && !memory.disconnected(recent) ? recent : null
}

/**
 * The wallets a reload may reconnect, in the order they are tried: never one disconnected here.
 *
 * Changed on purpose 2026-10-15 (pack 8, incident X2: reconnect the wallet used last, or none). With a wallet
 * remembered as the one connected last, that wallet alone, by the id it announces: the other wallets were tried too, the
 * remembered one first only among those announced in the same moment, so with two extensions installed the one that
 * announced itself first and still authorized this site was reconnected (another address, another list, or Phantom's
 * "not supported"), and the "Browser wallet" entry, whoever holds window.ethereum, could be reconnected too. A wallet
 * the person did not use last is connected only when they pick it. With none remembered, as before.
 */
function candidates(list: readonly Connector[]): Connector[] {
  const recent = memory.recent()
  const last = remembered()
  // (2026-10-15, pack 8 review, L4): the "Browser wallet" entry remembered while a wallet now announces itself through
  // EIP-6963: that entry is not offered any more (offerLegacy), so the wallet it stood for is found as main found it,
  // among the announced ones that still authorize this site, in main's order. Still no prompt: only isAuthorized and
  // wagmi's reconnect.
  if (last === LEGACY_ID && announced(list)) return list.filter((connector) => connector.id !== LEGACY_ID && !memory.disconnected(connector.id) && connector.type !== 'walletConnect')
  if (last !== null) return list.filter((connector) => connector.id === last)
  return list
    .filter((connector) => !memory.disconnected(connector.id) && (connector.type !== 'walletConnect' || recent === connector.id))
    .sort((a, b) => Number(b.id === recent) - Number(a.id === recent))
}

/**
 * Resolves once the remembered wallet `id` is listed, or after REMEMBERED_WAIT_MS (2026-10-15, pack 8, X2): the first
 * run waits for it instead of saying "disconnected" a moment before that wallet announces itself.
 */
function listed(id: string): Promise<void> {
  // (2026-10-15, pack 8 review, L4): for the remembered "Browser wallet" entry, an announced wallet ends the wait too:
  // the entry will not be offered beside it, and that wallet is the one main reconnected (candidates).
  const there = (list: readonly Connector[]) => list.some((connector) => connector.id === id) || (id === LEGACY_ID && announced(list))
  if (there(walletConfig.connectors)) return Promise.resolve()
  return new Promise((done) => {
    let stop = () => {}
    const timer = setTimeout(() => { stop(); done() }, REMEMBERED_WAIT_MS)
    stop = walletConfig._internal.connectors.subscribe((list: readonly Connector[]) => {
      if (!there(list)) return
      clearTimeout(timer)
      stop()
      done()
    })
  })
}

/**
 * Added 2026-11-09 (core flows, the owner: nothing may load forever): how long a reload waits for a wallet to say whether it
 * still authorizes the site, and for wagmi's reconnect of the one that does. A wallet that never answered (a locked
 * extension, a provider stuck on an earlier request) held the page's identity on "unknown" for good, and every page that
 * waits for it (Positions, a position's page) on its loading frame. Past these the wallet counts as not authorizing, or as
 * not reconnected: the page says no wallet is connected, and Connect wallet works as ever.
 */
export const AUTHORIZED_WAIT_MS = 5_000
export const RECONNECT_WAIT_MS = 10_000

/** `work`'s answer, or `fallback` once `ms` have passed or it failed; the work itself is left to finish on its own. */
function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((done) => {
    const timer = setTimeout(() => done(fallback), ms)
    work.then((value) => { clearTimeout(timer); done(value) }, () => { clearTimeout(timer); done(fallback) })
  })
}

let reconnecting: Promise<void> = Promise.resolve()
/**
 * Reconnects one wallet at most, the first that still authorizes this site, after the page loads and again whenever a
 * wallet announces itself later (audit C9: one that announced itself 2.5 s after load was listed but never reconnected).
 * One run at a time, and none while the person is connecting one. `startup`: the first run, which reports the state as
 * connecting from the start, so the identity the session machine sees first is "unknown", not a false "disconnected".
 */
/** wagmi's state as it is now (read again after every await: a wallet event may have changed it meanwhile). */
const statusNow = () => walletConfig.state.status

function reconnectOne(list: readonly Connector[], startup = false): Promise<void> {
  // The first run reports connecting at once, before it is queued (2026-10-01, fix round 1): the identity feed reads the
  // state on its next line, and a run queued behind `reconnecting` starts a microtask later, after that read.
  if (startup && statusNow() !== 'connected' && !attempt) walletConfig.setState((state) => ({ ...state, status: 'connecting' }))
  const run = async () => {
    if (statusNow() === 'connected' || attempt) return
    if (startup) walletConfig.setState((state) => ({ ...state, status: 'connecting' }))
    // X2 (2026-10-15, pack 8): the remembered wallet, given a moment to announce itself; then the list as it is.
    const last = startup ? remembered() : null
    if (last !== null) await listed(last)
    let found: Connector | null = null
    for (const connector of candidates(last !== null ? walletConfig.connectors : list)) {
      // Changed on purpose 2026-11-09 (core flows): within AUTHORIZED_WAIT_MS, and the reconnect within RECONNECT_WAIT_MS.
      if (await within(Promise.resolve().then(() => connector.isAuthorized()), AUTHORIZED_WAIT_MS, false)) {
        found = connector
        break
      }
    }
    const chosen = found
    let late = false
    if (chosen && !attempt && statusNow() !== 'connected') {
      late = await within(Promise.resolve().then(() => reconnect(walletConfig, { connectors: [chosen] })).then(() => false, () => false), RECONNECT_WAIT_MS, true)
    }
    // A reconnect that has not answered by then (startup or not) leaves wagmi saying "connecting": said as none connected.
    if (!attempt && (startup || late) && (statusNow() === 'connecting' || (late && statusNow() === 'reconnecting'))) {
      walletConfig.setState((state) => ({ ...state, connections: new Map(), current: null, status: 'disconnected' }))
    }
  }
  reconnecting = reconnecting.then(run, run).catch(() => {})
  return reconnecting
}

type Provider = { request(args: { method: string; params?: unknown }): Promise<unknown> }
/** window.ethereum, when a wallet put a usable provider there. */
function legacyProvider(win: Window | undefined = typeof window === 'undefined' ? undefined : window): Provider | undefined {
  const candidate = (win as { ethereum?: unknown } | undefined)?.ethereum as Provider | undefined
  return candidate && typeof candidate.request === 'function' ? candidate : undefined
}
const announced = (list: readonly Connector[]) => list.some((connector) => connector.type === 'injected' && connector.id !== LEGACY_ID)

let legacy: Connector | null = null
/**
 * A browser wallet that announces nothing through EIP-6963, only window.ethereum (an older extension, a wallet app's
 * own browser): offered as "Browser wallet" once no announcement came within LEGACY_WAIT_MS, through an injected
 * connector aimed at that provider alone (audit C9). It leaves the list again when a wallet announces itself later and
 * it is not the one connected, so one wallet is never listed twice.
 */
function offerLegacy() {
  if (legacy || announced(walletConfig.connectors) || !legacyProvider()) return
  const target = { id: LEGACY_ID, name: 'Browser wallet', provider: (win?: Window) => legacyProvider(win) }
  legacy = walletConfig._internal.connectors.setup(injected({ target: target as never }))
  const added = legacy
  walletConfig._internal.connectors.setState((list) => [...list, added])
}

/** Feeds the wallet identity to `onChange`, starting with the current one. */
export function startIdentityFeed(onChange: (identity: WalletIdentity) => void): () => void {
  // Start reconnecting before reading the state, so the first identity the
  // machine sees is "unknown" rather than a false "disconnected".
  const tried = new Set<string>(walletConfig.connectors.map((connector) => connector.uid))
  void reconnectOne(walletConfig.connectors, true)
  onChange(toIdentity(getConnection(walletConfig)))
  const stopWatch = watchConnection(walletConfig, {
    onChange: (connection) => {
      // A late approval of a wallet the person moved away from: let go at once by connectWallet, never reported.
      if (connection.connector && superseded.has(connection.connector.uid)) return
      // A wallet that connected, from the dialog or from the wallet itself ("Connect to this site"), is remembered as
      // the recent one and no longer kept disconnected.
      if (connection.status === 'connected' && connection.connector) memory.connected(connection.connector.id)
      onChange(toIdentity(connection))
    },
  })
  const stopConnectors = walletConfig._internal.connectors.subscribe((list: readonly Connector[]) => {
    if (legacy && announced(list) && walletConfig.state.current !== legacy.uid) {
      const gone = legacy
      legacy = null
      walletConfig._internal.connectors.setState((all) => all.filter((connector) => connector !== gone))
      return
    }
    const fresh = list.filter((connector) => !tried.has(connector.uid))
    for (const connector of fresh) tried.add(connector.uid)
    if (fresh.length > 0) void reconnectOne(fresh)
  })
  const legacyTimer = typeof window === 'undefined' ? null : window.setTimeout(offerLegacy, LEGACY_WAIT_MS)
  return () => {
    stopWatch()
    stopConnectors()
    if (legacyTimer !== null) window.clearTimeout(legacyTimer)
  }
}

export async function signLoginMessage({ address, message }: { address: string; message: string }): Promise<SignOutcome> {
  const { connector } = getConnection(walletConfig)
  if (!connector) return { ok: false, reason: 'provider_error' }
  try {
    const signature = await signMessage(walletConfig, { account: address as Address, connector, message })
    return { ok: true, signature }
  } catch (error) {
    return { ok: false, reason: rejected(codesOf(error)) ? 'user_rejected' : 'provider_error' }
  }
}

// ---- switching network -------------------------------------------------------------------------------------------

/**
 * How a switch to Robinhood Chain ended, in the words of components/wallet/copy.ts SWITCH_NOTICE: `add_rejected` the
 * person declined adding the network, `pending` a network request already waits in the wallet, `unsupported` the
 * wallet cannot add a network, `phantom` Phantom, which does not support Robinhood Chain at all.
 */
export type SwitchOutcome = 'switched' | 'user_rejected' | 'add_rejected' | 'pending' | 'unsupported' | 'phantom' | 'error'

/**
 * Each outcome but `switched` in words, the same in the wallet dialog (components/wallet/copy.ts re-exports them), on
 * Review's Create position and on the automation page (2026-10-01, audit C1: those two said nothing at all). Kept
 * here, beside the switch, so the money screens take these few sentences without the dialog's copy.
 */
export const SWITCH_NOTICE: Readonly<Record<Exclude<SwitchOutcome, 'switched'>, string>> = {
  user_rejected: 'Your wallet declined the network switch.',
  add_rejected: 'Your wallet declined adding Robinhood Chain.',
  pending: 'A network request is already waiting in your wallet. Open it to approve or reject.',
  unsupported: 'Your wallet could not add Robinhood Chain. Add it in your wallet’s network settings, then try again.',
  phantom: 'Phantom doesn’t support Robinhood Chain. Connect another wallet, such as MetaMask or Rabby.',
  error: 'Your wallet could not switch networks.',
} as const

/** Phantom's EIP-6963 rdns: its EVM networks are fixed, and Robinhood Chain is not one of them. */
const PHANTOM = 'app.phantom'

/** The chain the provider says it is on now, or null when it cannot say. */
async function chainNow(provider: Provider): Promise<number | null> {
  try {
    const value = await provider.request({ method: 'eth_chainId' })
    return typeof value === 'string' || typeof value === 'number' ? Number(value) : null
  } catch {
    return null
  }
}

/**
 * Asks the wallet to switch to Robinhood Chain, and to add it first when it does not know it (4902, wrapped or not:
 * audit C1). The network's details are fixed in this build (./chain.ts ADD_ROBINHOOD_CHAIN); nothing a server or a
 * wallet said goes into them. After the wallet says it switched, the chain is read again once (audit C15): a wallet
 * that switched without saying so (no chainChanged) is caught up, and one that did not switch is said as a failure.
 */
export async function switchToRobinhood(): Promise<SwitchOutcome> {
  const { connector } = getConnection(walletConfig)
  const provider = (await connector?.getProvider().catch(() => undefined)) as Provider | undefined
  if (!connector || !provider) return 'error'
  const target = numberToHex(ROBINHOOD_CHAIN_ID)
  const outcome = (codes: number[], adding: boolean): SwitchOutcome => {
    if (rejected(codes)) return adding ? 'add_rejected' : 'user_rejected'
    if (codes.includes(ALREADY_PENDING)) return 'pending'
    if (connector.id === PHANTOM) return 'phantom'
    if (adding && codes.some((code) => UNSUPPORTED.has(code))) return 'unsupported'
    return 'error'
  }
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] })
  } catch (error) {
    const codes = codesOf(error)
    if (!codes.includes(UNRECOGNIZED_CHAIN)) return outcome(codes, false)
    try {
      await provider.request({ method: 'wallet_addEthereumChain', params: [ADD_ROBINHOOD_CHAIN] })
    } catch (added) {
      return outcome(codesOf(added), true)
    }
    // Most wallets switch as they add; one that only added is asked to switch once more.
    if ((await chainNow(provider)) !== ROBINHOOD_CHAIN_ID) {
      try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] })
      } catch (again) {
        return outcome(codesOf(again), false)
      }
    }
  }
  if ((await chainNow(provider)) !== ROBINHOOD_CHAIN_ID) return 'error'
  // The wallet is on Robinhood Chain; the page may not have heard it say so.
  if (getConnection(walletConfig).chainId !== ROBINHOOD_CHAIN_ID) connector.onChainChanged(target)
  return 'switched'
}

/**
 * How a switch to one of Domino V2's chains ended (spec F7 §1.3): SwitchOutcome's words, and `unknown_chain` for a wallet
 * that does not know Base or Arbitrum One. Said as "Add {chain} to your wallet, then try again." (v2SwitchNotice).
 */
export type ChainSwitchOutcome = SwitchOutcome | 'unknown_chain'

/**
 * "Add {chain} to your wallet, then try again." (spec §1.3, §2.12 wallet 4902) for Base and Arbitrum One; every other
 * outcome in V1's own words (SWITCH_NOTICE), Robinhood Chain's add-network outcomes included.
 */
export const v2SwitchNotice = (outcome: Exclude<ChainSwitchOutcome, 'switched'>, chainName: string): string =>
  outcome === 'unknown_chain' ? `Add ${chainName} to your wallet, then try again.` : SWITCH_NOTICE[outcome as Exclude<SwitchOutcome, 'switched'>]

/**
 * Asks the wallet to switch to one of Domino V2's chains (Changed on purpose 2026-10-02, Domino V2 spec F7 §1.3). Robinhood
 * Chain is switchToRobinhood itself, unchanged, its add-network included. Base and Arbitrum One are only switched to,
 * never added: a wallet that does not know them (4902, wrapped or not) is `unknown_chain`, and the person adds the network
 * in the wallet (the spec's rule; this app hands a wallet no network details for them and reads neither chain itself).
 * As for Robinhood, the chain is read again once after the wallet says it switched.
 */
export async function switchToChain(chainId: number): Promise<ChainSwitchOutcome> {
  if (chainId === ROBINHOOD_CHAIN_ID) return switchToRobinhood()
  if (!V2_CHAIN_IDS.includes(chainId)) return 'error'
  const { connector } = getConnection(walletConfig)
  const provider = (await connector?.getProvider().catch(() => undefined)) as Provider | undefined
  if (!connector || !provider) return 'error'
  const target = numberToHex(chainId)
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] })
  } catch (error) {
    const codes = codesOf(error)
    if (codes.includes(UNRECOGNIZED_CHAIN)) return 'unknown_chain'
    if (rejected(codes)) return 'user_rejected'
    if (codes.includes(ALREADY_PENDING)) return 'pending'
    return 'error'
  }
  if ((await chainNow(provider)) !== chainId) return 'error'
  if (getConnection(walletConfig).chainId !== chainId) connector.onChainChanged(target)
  return 'switched'
}

/**
 * Asks the wallet to switch to a deposit's ORIGIN chain (Changed on purpose (data) 2026-10-02, Domino V2 spec F7 §1.3,
 * §3.6 step 1): any EVM chain the crosschain-v1 origins listing names, not only V2's. A switch and nothing else: a network
 * is never added here, not even Robinhood Chain (the guard forbids it, and this app holds no network details for an
 * arbitrary chain). A wallet that does not know the chain (4902, wrapped or not) is `unknown_chain`, said as "Add {origin}
 * to your wallet, then try again." (src/v2/crosschain/copy.ts ADD_ORIGIN). As switchToChain does, the chain is read again
 * once after the wallet says it switched, and a wallet that did not switch is `error`. Additive: no other function here
 * changed.
 */
export async function switchToOrigin(chainId: number): Promise<ChainSwitchOutcome> {
  if (!Number.isSafeInteger(chainId) || chainId < 1) return 'error'
  const { connector } = getConnection(walletConfig)
  const provider = (await connector?.getProvider().catch(() => undefined)) as Provider | undefined
  if (!connector || !provider) return 'error'
  const target = numberToHex(chainId)
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] })
  } catch (error) {
    const codes = codesOf(error)
    if (codes.includes(UNRECOGNIZED_CHAIN)) return 'unknown_chain'
    if (rejected(codes)) return 'user_rejected'
    if (codes.includes(ALREADY_PENDING)) return 'pending'
    return 'error'
  }
  if ((await chainNow(provider)) !== chainId) return 'error'
  if (getConnection(walletConfig).chainId !== chainId) connector.onChainChanged(target)
  return 'switched'
}
