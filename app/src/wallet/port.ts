import { getAddress, numberToHex, type Address } from 'viem'
import type { Connector } from 'wagmi'
import { connect, disconnect, getConnection, reconnect, signMessage, watchConnection } from 'wagmi/actions'
import type { SignOutcome } from '../session/controller'
import { ROBINHOOD_CHAIN_ID, type WalletIdentity } from '../session/machine'
import { walletConfig } from './config'

/**
 * Everything the session feature asks of the wallet. Four requests reach the
 * provider: account access, the chain ID, `personal_sign` for the sign-in
 * message, and `wallet_switchEthereumChain` when the user asks to switch.
 * Nothing here can build, sign or send a transaction.
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

/** Feeds the wallet identity to `onChange`, starting with the current one. */
export function startIdentityFeed(onChange: (identity: WalletIdentity) => void): () => void {
  // Start reconnecting before reading the state, so the first identity the
  // machine sees is "unknown" rather than a false "disconnected".
  reconnect(walletConfig).catch(() => {})
  onChange(toIdentity(getConnection(walletConfig)))
  return watchConnection(walletConfig, { onChange: (connection) => onChange(toIdentity(connection)) })
}

/** The EIP-1193 error code, wherever viem wrapped it. */
function codeOf(error: unknown): number | undefined {
  let current = error
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'number') return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

const USER_REJECTED = 4001
const UNRECOGNIZED_CHAIN = 4902

/**
 * Connects the connector the user picked: the very instance the dialog listed,
 * not one looked up by `connector.id` (an rdns two providers can share).
 */
export async function connectWallet(connector: Connector): Promise<'connected' | 'user_rejected' | 'error'> {
  if (!walletConfig.connectors.includes(connector)) return 'error'
  try {
    await connect(walletConfig, { connector })
    return 'connected'
  } catch (error) {
    return codeOf(error) === USER_REJECTED ? 'user_rejected' : 'error'
  }
}

export async function disconnectWallet(): Promise<void> {
  await disconnect(walletConfig).catch(() => {})
}

export async function signLoginMessage({ address, message }: { address: string; message: string }): Promise<SignOutcome> {
  const { connector } = getConnection(walletConfig)
  if (!connector) return { ok: false, reason: 'provider_error' }
  try {
    const signature = await signMessage(walletConfig, { account: address as Address, connector, message })
    return { ok: true, signature }
  } catch (error) {
    return { ok: false, reason: codeOf(error) === USER_REJECTED ? 'user_rejected' : 'provider_error' }
  }
}

interface RequestProvider {
  request(args: { method: string; params?: unknown }): Promise<unknown>
}

/**
 * Asks the wallet to switch to Robinhood Chain. Deliberately not wagmi's
 * switchChain: on an unknown chain that falls back to wallet_addEthereumChain,
 * which needs an RPC URL this app does not carry.
 */
export async function switchToRobinhood(): Promise<'switched' | 'unknown_chain' | 'user_rejected' | 'error'> {
  const { connector } = getConnection(walletConfig)
  const provider = (await connector?.getProvider().catch(() => undefined)) as RequestProvider | undefined
  if (!provider) return 'error'
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(ROBINHOOD_CHAIN_ID) }] })
    return 'switched'
  } catch (error) {
    const code = codeOf(error)
    if (code === UNRECOGNIZED_CHAIN) return 'unknown_chain'
    return code === USER_REJECTED ? 'user_rejected' : 'error'
  }
}
