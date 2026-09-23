/** Pure update of the two existing read tunnel configurations; no I/O.
 *
 * Each tunnel accepts every path state it has been published with, and
 * writes `next`: `before` (read-v1 only), `after` (read-v2 pool-market added,
 * the live state) and `next` itself, so running it again changes nothing.
 * Production adds the stored markets snapshot to its read-v1 routes;
 * development adds it with pool-positions and pool-metrics. Nothing else in a
 * rule ever changes.
 */
const TARGETS = Object.freeze({
  '31526265-ca63-40f2-bbb7-bd37a537f899': {
    hostname: 'vm-read.domino.money',
    service: 'http://127.0.0.1:8878',
    before: '^/internal/read/v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics)$',
    after: '^/internal/read/(v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics)|v2/pool-market)$',
    next: '^/internal/read/(v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics|markets-snapshot)|v2/pool-market)$',
    v3: '^/internal/read/(v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics|markets-snapshot)|v2/pool-market|v3/(overview|history|search))$',
    v4: '^/internal/read/(v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics|markets-snapshot)|v2/pool-market|v4/sequence-snapshot)$',
    v3v4: '^/internal/read/(v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics|markets-snapshot)|v2/pool-market|v3/(overview|history|search)|v4/sequence-snapshot)$',
    controls: (rule) => record(rule.originRequest) && record(rule.originRequest.access) && rule.originRequest.access.required === true,
  },
  '7abb1264-ee70-4b69-a33c-b75a9deb4589': {
    hostname: 'dev-read.domino.money',
    service: 'http://127.0.0.1:8891',
    before: '^/internal/(read/v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|capabilities)|dev/v1/status)$',
    after: '^/internal/(read/v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|capabilities)|read/v2/(pool-market|capabilities)|dev/v1/status)$',
    next: '^/internal/(read/v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics|markets-snapshot|capabilities)|read/v2/(pool-market|capabilities)|dev/v1/status)$',
    controls: (rule) => record(rule.originRequest) && rule.originRequest.httpHostHeader === '127.0.0.1:8891',
  },
});

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function refuse() {
  throw new Error('read_tunnel_configuration_mismatch');
}

// The tunnels this release path touches, so inspection and publication can
// never disagree about which ones that is.
export const READ_TUNNEL_IDS = Object.freeze(Object.keys(TARGETS));
export const V3_READ_TUNNEL_IDS = Object.freeze(Object.keys(TARGETS).filter((id) => TARGETS[id].v3));
export const V4_READ_TUNNEL_IDS = Object.freeze(Object.keys(TARGETS).filter((id) => TARGETS[id].v4));

/** Pass the API response's config object, never the full response envelope. */
export function extendReadTunnelConfig(tunnelId, config, { enableV3 = false, enableV4 = false, disableV4 = false } = {}) {
  if (typeof tunnelId !== 'string' || !Object.hasOwn(TARGETS, tunnelId) || !record(config)
      || !Array.isArray(config.ingress) || !config.ingress.every(record)) refuse();
  const target = TARGETS[tunnelId];
  const matches = config.ingress.map((rule, index) => rule.hostname === target.hostname ? index : -1)
    .filter((index) => index >= 0);
  if (matches.length !== 1) refuse();
  const index = matches[0];
  const rule = config.ingress[index];
  if (typeof enableV3 !== 'boolean' || enableV3 && !target.v3 || typeof enableV4 !== 'boolean'
      || typeof disableV4 !== 'boolean' || (enableV4 || enableV3) && disableV4
      || (enableV4 || disableV4) && !target.v4) refuse();
  if (rule.service !== target.service || ![target.before, target.after, target.next, target.v3, target.v4, target.v3v4].filter(Boolean).includes(rule.path)
      || !target.controls(rule)) refuse();
  const result = structuredClone(config);
  // A rollback on a route that never enabled V4 is a true no-op: it must not
  // use the normal release's opportunity to extend older V1/V2 paths.
  if (disableV4 && rule.path !== target.v4 && rule.path !== target.v3v4) return result;
  // A normal V1/V2 publication must not roll back an already enabled V3 route.
  const v3 = enableV3 || rule.path === target.v3 || rule.path === target.v3v4;
  const v4 = !disableV4 && (enableV4 || rule.path === target.v4 || rule.path === target.v3v4);
  result.ingress[index].path = v3 && v4 ? target.v3v4 : v3 ? target.v3 : v4 ? target.v4 : target.next;
  return result;
}
