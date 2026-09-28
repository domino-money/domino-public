/**
 * The endpoints the page may read Robinhood Chain from (2026-09-28), and what each one serves.
 *
 * Why: the DNS of Vivo, one of Brazil's largest ISPs, answers NXDOMAIN for every host under chain.robinhood.com
 * (confirmed that day from the owner's own line; Cloudflare's and Google's resolvers answer, a CNAME to
 * customer-origin.offchainlabs.com). On that network the browser meets net::ERR_NAME_NOT_RESOLVED for the chain's own
 * RPC, and Your positions, a position's page and its fees read nothing. The owner asked for no backend change: the page
 * itself falls back to other public RPCs of chain 4663 while the chain's own cannot be reached (lib/chain/failover.ts),
 * and goes back to it as soon as it answers again.
 *
 * The primary is the chain's own RPC, the routes' pin (functions/_lib/owned.ts RPC_URL), and it stays first: every call
 * goes to it while it can be reached. The fallbacks below were each measured from a Vivo line on 2026-09-28 (all resolve
 * there, all answer `access-control-allow-origin: *`, errors included, and all take JSON-RPC batches); their numbers are
 * those measurements, rounded down:
 *
 * - robinhood-rpc.publicnode.com: a pruned node. eth_call at the head and 30 blocks below it answered; 100 below it was
 *   refused ("Archive requests require a personal token", HTTP 403), and so were logs from 100 blocks below the head
 *   (61 answered). Block headers at any height, and eth_simulateV1.
 * - rpc.ordofi.network: an archive (eth_call a million blocks back answered), but its eth_getLogs walks the blocks one by
 *   one, about 1 ms each: 5,000 blocks in 1.9 s, 8,000 in 3.6 s, 10,000 old blocks in 9.2 s, and 10,001 recent ones
 *   refused as -32005 "the network is busy, please try again in a moment" (the site's full cold scan met that four
 *   times in a row). That word is a rate signal: the endpoint rests (failover.ts). No eth_simulateV1 without a key.
 * - robinhood.drpc.org: calls at 'latest' only (any numbered block, the head included, was refused as "Unknown state",
 *   HTTP 400); eth_getLogs over 100 blocks answered and over 200 was refused ("ranges over 10000 blocks are not
 *   supported on free plan", code 35, HTTP 400, whatever the range's size past that). Headers and eth_simulateV1.
 *
 * Not here, on purpose: rpc.arrowrpc.com (down, Cloudflare 1033) and rpc.domino.money (not serving).
 *
 * None of them reads a wide log range the way the chain's own RPC does (the Positions list's cold scan asks 5.6 million
 * blocks of SetupMinted logs in one call): while the primary is unreachable, the list finds the owner's position ids in
 * DominoSetupV1's own state instead (functions/_lib/walletPositions.ts operationIds), and a read that needs a wide range
 * of logs (a fees history's pool epochs) answers that it cannot be served, with no call made.
 *
 * Every one of these hosts is named, and no other, in the page's and the fees worker's connect-src
 * (functions/_middleware.ts); tests/read.test.mjs pins this list, and tests/rpc-failover.test.mjs what the page does
 * with it. Pure data, Node-safe.
 */
import { RPC_URL } from '../../../functions/_lib/owned'

/** What a call needs from an endpoint (failover.ts needOf). */
export type Need = 'latest' | 'state' | 'archive' | 'headers' | 'simulate' | 'logs'

export interface Endpoint {
  readonly url: string
  /**
   * How far below the head a numbered state read (eth_call, eth_getBalance, eth_getCode at a block number) is served:
   * Infinity for an archive, 0 for none (only 'latest').
   */
  readonly stateDepth: number
  /** eth_getLogs: the most blocks one of its calls may cover, and how many such calls one read of the page may take. */
  readonly logWindow: number
  readonly logWindows: number
  /** How far below the head its logs reach (Infinity: all of them). */
  readonly logDepth: number
  /** eth_getBlockByNumber at any height. */
  readonly headers: boolean
  readonly simulate: boolean
  /** This page's (or this worker's) own budget with it: the least gap between two requests, the most in a minute, the most at once. */
  readonly gapMs: number
  readonly perMinute: number
  readonly inFlight: number
}

/** The chain's own RPC: everything, as it always served the page; the lanes and the chain code pace it, not this. */
export const PRIMARY: Endpoint = {
  url: RPC_URL,
  stateDepth: Infinity,
  logWindow: Infinity,
  logWindows: 1,
  logDepth: Infinity,
  headers: true,
  simulate: true,
  gapMs: 0,
  perMinute: Infinity,
  inFlight: Infinity,
}

export const PUBLICNODE: Endpoint = {
  url: 'https://robinhood-rpc.publicnode.com',
  stateDepth: 24,
  logWindow: 24,
  logWindows: 1,
  logDepth: 24,
  headers: true,
  simulate: true,
  gapMs: 100,
  perMinute: 120,
  inFlight: 2,
}

export const ORDOFI: Endpoint = {
  url: 'https://rpc.ordofi.network',
  stateDepth: Infinity,
  logWindow: 5_000,
  logWindows: 1,
  logDepth: Infinity,
  headers: true,
  simulate: false,
  gapMs: 250,
  perMinute: 40,
  inFlight: 1,
}

export const DRPC: Endpoint = {
  url: 'https://robinhood.drpc.org',
  stateDepth: 0,
  logWindow: 100,
  logWindows: 8,
  logDepth: Infinity,
  headers: true,
  simulate: true,
  gapMs: 150,
  perMinute: 90,
  inFlight: 2,
}

/** The fallbacks, in the order they are named in the CSP. */
export const FALLBACKS: readonly Endpoint[] = [PUBLICNODE, ORDOFI, DRPC]

/**
 * The order the fallbacks are asked in, per need (a batch takes the order of its most demanding call): calls at the
 * head first where they are cheapest; a numbered read near the head where it is kept, else the archive; logs where one
 * call covers the range (publicnode near the head, ordofi's 5,000 blocks, dRPC's windows of 100).
 */
export const ORDER: Readonly<Record<Need, readonly Endpoint[]>> = {
  latest: [PUBLICNODE, DRPC, ORDOFI],
  state: [PUBLICNODE, ORDOFI],
  archive: [ORDOFI],
  headers: [DRPC, PUBLICNODE, ORDOFI],
  simulate: [PUBLICNODE, DRPC],
  logs: [PUBLICNODE, ORDOFI, DRPC],
}
