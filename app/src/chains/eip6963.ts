/**
 * Every chain's wallet picker: the wallets a browser announces (EIP-6963), the account the person chooses, and the
 * switch to the chain a section needs, driven by the registry (2026-10-01, the chain2 workstream, audit items G11 and
 * G12).
 *
 * Why: rugged97's Elysium entry talked to window.ethereum (whichever extension won it, not the one chosen) and refused
 * to connect on another network; the Robinhood session treats any other chain as "wrong network". One picker for both
 * chains, with no wagmi and no window.ethereum, lets a person choose a wallet once and move it to the chain the page in
 * front of them reads. Nothing here names a chain id: it comes from the registry entry it is handed.
 *
 * What this module asks a wallet is fixed and read-only: eth_requestAccounts and eth_accounts (which account), eth_chainId
 * (which chain) and wallet_switchEthereumChain (move to the registry's chain). Adding a chain the wallet does not know
 * (EIP-3085, from config/chains.ts addChainParameters) and sending a transaction belong to the closed signer that part B
 * adds with its guard (the chain2 workstream's part-B plan); until then a wallet without the chain is told how to add it by
 * hand, with the registry's network details.
 *
 * A wallet's announced name is untrusted text and only ever written as text; its icon is never used (the same rule as
 * components/wallet). Nothing is kept in storage.
 */
import { hexChainId, type ChainConfig } from '../config/chainKit'

/** An EIP-1193 provider, as much of it as this module uses. */
export interface Eip1193 {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
}

export interface WalletInfo {
  readonly uuid: string
  readonly name: string
  readonly rdns: string
}

export interface DiscoveredWallet {
  readonly info: WalletInfo
  readonly provider: Eip1193
}

const UUID = /^[0-9a-f-]{8,64}$/i
const RDNS = /^[a-z0-9-]+(?:\.[a-z0-9-]+){1,8}$/i
const ACCOUNT = /^0x[0-9a-fA-F]{40}$/

/** A wallet's name as a page may write it: 1 to 40 characters, no control or direction marks; else null. */
function nameOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const points = [...trimmed]
  if (points.length === 0 || points.length > 40) return null
  const bad = points.some((point) => {
    const code = point.codePointAt(0) ?? 0
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
  })
  return bad ? null : trimmed
}

/** One announcement's wallet, or null when it is not a well-formed one. */
export function announced(detail: unknown): DiscoveredWallet | null {
  if (!detail || typeof detail !== 'object') return null
  const { info, provider } = detail as { info?: Record<string, unknown>; provider?: { request?: unknown } }
  if (!info || !provider || typeof provider.request !== 'function') return null
  const name = nameOf(info.name)
  if (typeof info.uuid !== 'string' || !UUID.test(info.uuid) || typeof info.rdns !== 'string' || !RDNS.test(info.rdns) || !name) return null
  return { info: { uuid: info.uuid, name, rdns: info.rdns.toLowerCase() }, provider: provider as Eip1193 }
}

/**
 * Listens for the browser's wallets (EIP-6963) and asks them to announce themselves; `onChange` gets the list, by name,
 * each wallet once (a second announcement with the same id replaces the first). Returns the way to stop listening.
 */
export function discoverWallets(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'>, onChange: (wallets: readonly DiscoveredWallet[]) => void): () => void {
  const found = new Map<string, DiscoveredWallet>()
  const listener = (event: Event) => {
    const wallet = announced((event as CustomEvent<unknown>).detail)
    if (!wallet) return
    found.set(wallet.info.uuid, wallet)
    onChange([...found.values()].sort((a, b) => a.info.name.localeCompare(b.info.name)))
  }
  target.addEventListener('eip6963:announceProvider', listener)
  target.dispatchEvent(new Event('eip6963:requestProvider'))
  return () => target.removeEventListener('eip6963:announceProvider', listener)
}

/** An EIP-1193 error's code, including a wrapped one (MetaMask Mobile puts it under data.originalError). */
export function errorCode(error: unknown): number | null {
  const e = error as { code?: unknown; data?: { originalError?: { code?: unknown } } } | null
  const code = e?.code ?? e?.data?.originalError?.code
  return typeof code === 'number' ? code : null
}

/** Whether a wallet's refusal of a switch says it does not know the chain (4902, wrapped or not, or its words). */
export function needsAdd(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; data?: { originalError?: { code?: unknown } } } | null
  if (e?.code === 4902 || e?.data?.originalError?.code === 4902) return true
  return typeof e?.message === 'string' && /unrecognized chain|not been added|unknown chain|chain .*not (?:supported|configured)/i.test(e.message)
}

/** The account the person allows (eth_requestAccounts), lowercase. */
export async function connectAccount(provider: Eip1193): Promise<string> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' })
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || !ACCOUNT.test(accounts[0])) throw new Error('no_account')
  return accounts[0].toLowerCase()
}

/** The account the wallet exposes now without asking (eth_accounts), lowercase, or null. */
export async function currentAccount(provider: Eip1193): Promise<string | null> {
  const accounts = await provider.request({ method: 'eth_accounts' })
  return Array.isArray(accounts) && typeof accounts[0] === 'string' && ACCOUNT.test(accounts[0]) ? accounts[0].toLowerCase() : null
}

/** The chain the wallet is on (eth_chainId), or null for an answer that is not a quantity. */
export async function walletChain(provider: Eip1193): Promise<number | null> {
  const value = await provider.request({ method: 'eth_chainId' })
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) return null
  const id = Number(BigInt(value))
  return Number.isSafeInteger(id) ? id : null
}

export type SwitchOutcome = 'already' | 'switched' | 'needs-add' | 'rejected' | 'failed'

/** Moves the wallet to `chain`: nothing when it is there already; `needs-add` when the wallet does not know it. */
export async function switchChain(provider: Eip1193, chain: ChainConfig): Promise<SwitchOutcome> {
  try {
    if ((await walletChain(provider)) === chain.id) return 'already'
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChainId(chain) }] })
    return (await walletChain(provider)) === chain.id ? 'switched' : 'failed'
  } catch (error) {
    if (needsAdd(error)) return 'needs-add'
    return errorCode(error) === 4001 ? 'rejected' : 'failed'
  }
}

/** Calls `onChange` when the wallet's account or chain changes, or it disconnects; returns the way to stop. */
export function watchWallet(provider: Eip1193, onChange: () => void): () => void {
  const events = ['accountsChanged', 'chainChanged', 'disconnect']
  for (const event of events) provider.on?.(event, onChange)
  return () => {
    for (const event of events) provider.removeListener?.(event, onChange)
  }
}
