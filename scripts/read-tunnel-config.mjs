/** Pure update of the two existing read tunnel configurations; no I/O.
 *
 * Each tunnel accepts every path state it has been published with, and
 * writes `next`: `before` (read-v1 only), `after` (read-v2 pool-market added,
 * the live state) and `next` itself, so running it again changes nothing.
 * Production adds the stored markets snapshot to its read-v1 routes;
 * development adds it with pool-positions and pool-metrics. Nothing else in a
 * rule ever changes.
 *
 * Production alone also opens the stored protocols, each by its own option:
 * read-v3's overview, history and search, read-v4's sequence snapshot and,
 * since 2026-09-26 (featured-pools v1 §10.3), read-v5's featured pools list.
 * Each such state is `next` plus the protocols it opens, in version order
 * (storedPath), so the states published before read-v5 existed (`next` with
 * v3, with v4, and with both) are among them, spelled as they were published;
 * scripts/read-tunnel-config.test.mjs holds those spellings. An ordinary
 * publication keeps every stored protocol a tunnel already opens; only that
 * protocol's own rollback option closes it.
 */
const PROD_NEXT_V1 = 'v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics|markets-snapshot)';
const STORED = Object.freeze({ v3: 'v3/(overview|history|search)', v4: 'v4/sequence-snapshot', v5: 'v5/featured-pools' });
const NONE = Object.freeze({ v3: false, v4: false, v5: false });
const DEV_NEXT = '^/internal/(read/v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics|markets-snapshot|capabilities)|read/v2/(pool-market|capabilities)|dev/v1/status)$';

/** Production's path: read-v1, read-v2 and the stored protocols `open` names, in version order. */
export function storedPath(open = NONE) {
  const paths = [PROD_NEXT_V1, 'v2/pool-market', ...Object.keys(STORED).filter((name) => open[name] === true).map((name) => STORED[name])];
  return `^/internal/read/(${paths.join('|')})$`;
}

/** Every combination of stored protocols, each with the one path that opens exactly those. The first is `next`. */
const STORED_STATES = [false, true].flatMap((v3) => [false, true].flatMap((v4) => [false, true].map((v5) =>
  Object.freeze({ path: storedPath({ v3, v4, v5 }), v3, v4, v5 }))));

const TARGETS = Object.freeze({
  '31526265-ca63-40f2-bbb7-bd37a537f899': {
    hostname: 'vm-read.domino.money',
    service: 'http://127.0.0.1:8878',
    states: [
      { path: '^/internal/read/v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics)$', ...NONE },
      { path: '^/internal/read/(v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics)|v2/pool-market)$', ...NONE },
      ...STORED_STATES,
    ],
    write: storedPath,
    stored: true,
    controls: (rule) => record(rule.originRequest) && record(rule.originRequest.access) && rule.originRequest.access.required === true,
  },
  '7abb1264-ee70-4b69-a33c-b75a9deb4589': {
    hostname: 'dev-read.domino.money',
    service: 'http://127.0.0.1:8891',
    states: [
      '^/internal/(read/v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|capabilities)|dev/v1/status)$',
      '^/internal/(read/v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|capabilities)|read/v2/(pool-market|capabilities)|dev/v1/status)$',
      DEV_NEXT,
    ].map((path) => ({ path, ...NONE })),
    write: () => DEV_NEXT,
    stored: false,
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
// The stored protocols are published on production alone.
export const V3_READ_TUNNEL_IDS = Object.freeze(Object.keys(TARGETS).filter((id) => TARGETS[id].stored));
export const V4_READ_TUNNEL_IDS = V3_READ_TUNNEL_IDS;
export const V5_READ_TUNNEL_IDS = V3_READ_TUNNEL_IDS;

/** Pass the API response's config object, never the full response envelope. */
export function extendReadTunnelConfig(tunnelId, config,
  { enableV3 = false, enableV4 = false, disableV4 = false, enableV5 = false, disableV5 = false } = {}) {
  if (typeof tunnelId !== 'string' || !Object.hasOwn(TARGETS, tunnelId) || !record(config)
      || !Array.isArray(config.ingress) || !config.ingress.every(record)) refuse();
  const target = TARGETS[tunnelId];
  const matches = config.ingress.map((rule, index) => rule.hostname === target.hostname ? index : -1)
    .filter((index) => index >= 0);
  if (matches.length !== 1) refuse();
  const index = matches[0];
  const rule = config.ingress[index];
  const enables = [enableV3, enableV4, enableV5];
  const disables = [disableV4, disableV5];
  // A rollback is one protocol's alone: it opens nothing and closes nothing else.
  if (![...enables, ...disables].every((option) => typeof option === 'boolean')
      || disables.filter(Boolean).length > 1 || (disables.some(Boolean) && enables.some(Boolean))
      || ([...enables, ...disables].some(Boolean) && !target.stored)) refuse();
  const state = target.states.find((known) => known.path === rule.path);
  if (rule.service !== target.service || !state || !target.controls(rule)) refuse();
  const result = structuredClone(config);
  // A rollback on a route that never opened its protocol is a true no-op: it
  // must not use the normal release's opportunity to extend older V1/V2 paths.
  if ((disableV4 && !state.v4) || (disableV5 && !state.v5)) return result;
  // A normal publication must not roll back a stored protocol already opened.
  result.ingress[index].path = target.write({
    v3: enableV3 || state.v3,
    v4: !disableV4 && (enableV4 || state.v4),
    v5: !disableV5 && (enableV5 || state.v5),
  });
  return result;
}
