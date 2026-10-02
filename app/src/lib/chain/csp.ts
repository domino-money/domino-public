/**
 * The page's connect-src for the chains it reads from the browser, generated from the chain registry (2026-10-01, the
 * chain2 workstream, audit item G4).
 *
 * functions/_middleware.ts builds the page's CSP from data (APP_CSP_SOURCES) and, where the second chain's section is
 * open (the preview), adds that chain's RPC origin with withChains below. Changed on purpose 2026-10-01 (RPC-SPEC §7.4,
 * the owner's rule: nothing is read from a public RPC): Robinhood Chain is read at the edge only, so the page's policy
 * names no RPC of it (the fees worker, which had a policy of its own, is gone since 2026-10-02); the only chain the browser
 * still reads is the Elysium testnet, on the preview (RPC-SPEC §7.12).
 *
 * Pure: strings in, strings out.
 */
import { rpcOrigins, type ChainConfig } from '../../config/chainKit'

/**
 * The page's own connect-src sources before the chains' RPCs: the site, the token metadata provider, and (2026-10-01,
 * audit C3) WalletConnect's relay, which a wallet on a phone is reached through whatever chain the page reads.
 */
export const PAGE_CONNECT_BASE: readonly string[] = ["'self'", 'https://api.dexscreener.com', 'wss://relay.walletconnect.org']

/** Every RPC origin of `chains`, in the registry's order (each chain's own first, then its fallbacks), each once. */
export function connectOrigins(chains: readonly ChainConfig[]): string[] {
  const seen = new Set<string>()
  for (const chain of chains) for (const origin of rpcOrigins(chain)) seen.add(origin)
  return [...seen]
}

/** The page's connect-src directive for `chains`. */
export const pageConnectSrc = (chains: readonly ChainConfig[]): string => `connect-src ${[...PAGE_CONNECT_BASE, ...connectOrigins(chains)].join(' ')}`

/**
 * `policy` (a whole CSP, directives joined by "; ") with its connect-src replaced by the one `chains` need. A policy
 * with no connect-src is returned unchanged: this never widens a policy that had none.
 */
export function withChains(policy: string, chains: readonly ChainConfig[]): string {
  const directives = policy.split('; ')
  const at = directives.findIndex((directive) => directive.startsWith('connect-src '))
  if (at === -1) return policy
  directives[at] = pageConnectSrc(chains)
  return directives.join('; ')
}
