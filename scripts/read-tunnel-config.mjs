/** Pure update of the two existing read tunnel configurations; no I/O. */
const TARGETS = Object.freeze({
  '31526265-ca63-40f2-bbb7-bd37a537f899': {
    hostname: 'vm-read.domino.money',
    service: 'http://127.0.0.1:8878',
    before: '^/internal/read/v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics)$',
    after: '^/internal/read/(v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics)|v2/pool-market)$',
    controls: (rule) => record(rule.originRequest) && record(rule.originRequest.access) && rule.originRequest.access.required === true,
  },
  '7abb1264-ee70-4b69-a33c-b75a9deb4589': {
    hostname: 'dev-read.domino.money',
    service: 'http://127.0.0.1:8891',
    before: '^/internal/(read/v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|capabilities)|dev/v1/status)$',
    after: '^/internal/(read/v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|capabilities)|read/v2/(pool-market|capabilities)|dev/v1/status)$',
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

/** Pass the API response's config object, never the full response envelope. */
export function extendReadTunnelConfig(tunnelId, config) {
  if (typeof tunnelId !== 'string' || !Object.hasOwn(TARGETS, tunnelId) || !record(config)
      || !Array.isArray(config.ingress) || !config.ingress.every(record)) refuse();
  const target = TARGETS[tunnelId];
  const matches = config.ingress.map((rule, index) => rule.hostname === target.hostname ? index : -1)
    .filter((index) => index >= 0);
  if (matches.length !== 1) refuse();
  const index = matches[0];
  const rule = config.ingress[index];
  if (rule.service !== target.service || ![target.before, target.after].includes(rule.path)
      || !target.controls(rule)) refuse();
  const result = structuredClone(config);
  result.ingress[index].path = target.after;
  return result;
}
