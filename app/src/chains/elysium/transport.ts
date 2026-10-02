/**
 * The second chain's section's one network call (2026-10-01, the chain2 workstream, part B): tests/read.test.mjs admits
 * this file to the page's fetcher allowlist by name and pins its two fetches.
 *
 * Two destinations and nothing else:
 * - the chain's own public RPC, exactly the registry's URLs (config/chainElysium.ts ELYSIUM.rpc), with no credentials
 *   and no referrer. Changed on purpose 2026-10-02 (review of the RPC switch, finding 1; the owner's rule: the site reads
 *   nothing from a public RPC, on the preview too): refused like any other URL while mode.ts SECTION_READS is false,
 *   which also keeps the section closed everywhere, until rugged97 serves its reads through this site's own route;
 * - this site's own /uniswap-v3/{read,actions}/v1/<route> (functions/uniswap-v3/[[path]].ts), same-origin, which
 *   forwards to rugged97's bridge Worker and strips every cookie and credential on the way (the beta gate's cookie is
 *   what lets the request through the gate; it goes no further).
 * Any other URL is refused before anything is sent. Nothing is kept anywhere.
 */
import { ELYSIUM } from '../../config/chainElysium'
import { SECTION_READS } from './mode'

/** The page's network for the chain, as the section takes it (ui/ElysiumSection.tsx). */
export interface ElysiumTransport {
  /** One request to the chain's own RPC (the registry's URL), with no credentials and no referrer. */
  rpc(url: string, init: RequestInit): Promise<Response>
  /** One same-origin request to this site's /uniswap-v3/ routes. */
  api(path: string, init: RequestInit): Promise<Response>
}

const RPC_URLS: ReadonlySet<string> = new Set([ELYSIUM.rpc.primary.url, ...ELYSIUM.rpc.fallbacks.map((endpoint) => endpoint.url)])
const API_PATH = /^\/uniswap-v3\/(?:read|actions)\/v1\/[a-z][a-z-]{0,63}$/
const refuse = () => Promise.reject(new TypeError('not an Elysium endpoint'))

export const elysiumTransport: ElysiumTransport = {
  rpc: (url, init) => (SECTION_READS && RPC_URLS.has(url) ? fetch(url, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' }) : refuse()),
  api: (path, init) => (API_PATH.test(path) ? fetch(path, { ...init, credentials: 'same-origin', redirect: 'error', cache: 'no-store' }) : refuse()),
}
