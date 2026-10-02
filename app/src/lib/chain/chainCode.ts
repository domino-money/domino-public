/**
 * The wallet feature's reads, as the money code imports them (finance/wallet.ts, finance/sequenceLive.ts,
 * components/create/CreatePosition.tsx, wallet/walletConnect.ts): a lazily loaded chunk, so the entry every page loads
 * carries none of it.
 *
 * Until 2026-10-01 this was the chain code the page ran: the routes' own scan and relay reads (functions/_lib/*) over the
 * page's router to the chain's public RPC and its fallbacks (lib/chain/browser.ts, failover.ts, endpoints.ts). Changed on
 * purpose 2026-10-01 (RPC-SPEC, the owner's rule: nothing is read from a public RPC): that code runs only at the edge
 * now, over Domino's own node (functions/_lib/chainRoutes.ts), and the router is gone. What is left here is the wallet
 * feature's two functions (lib/walletReads.ts): a read the site does not serve (D6), and a batch's simulation over the
 * site's fixed route (D7). The money code's imports are unchanged.
 */
export { readOnChain, simulateOnChain } from '../walletReads'
