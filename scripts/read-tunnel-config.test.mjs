import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extendReadTunnelConfig } from './read-tunnel-config.mjs';

const PROD = '31526265-ca63-40f2-bbb7-bd37a537f899';
const DEV = '7abb1264-ee70-4b69-a33c-b75a9deb4589';
const V1 = ['token', 'pools', 'pool-market', 'wallet-assets', 'nft-positions', 'catalogue', 'pool-activity'];
/** The stored-data reads: the snapshot on both tunnels, and pool-positions and pool-metrics, which production already passed. */
const STORED = ['pool-positions', 'pool-metrics', 'markets-snapshot'];

/** Every path each tunnel has been published with, oldest first. The last is the live state before this change. */
const PUBLISHED = {
  [PROD]: [
    '^/internal/read/v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics)$',
    '^/internal/read/(v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics)|v2/pool-market)$',
  ],
  [DEV]: [
    '^/internal/(read/v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|capabilities)|dev/v1/status)$',
    '^/internal/(read/v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|capabilities)|read/v2/(pool-market|capabilities)|dev/v1/status)$',
  ],
};

function fixture(id, path = PUBLISHED[id][0]) {
  const rule = id === PROD ? {
    hostname: 'vm-read.domino.money', service: 'http://127.0.0.1:8878', path,
    originRequest: { access: { required: true, teamName: 'fixture-team', audTag: ['fixture-aud'] }, connectTimeout: 5 },
  } : {
    hostname: 'dev-read.domino.money', service: 'http://127.0.0.1:8891', path,
    originRequest: { httpHostHeader: '127.0.0.1:8891', connectTimeout: 5 },
  };
  return { ingress: [{ hostname: 'other.example.invalid', service: 'http_status:403', extra: { preserve: true } },
                     rule, { service: 'http_status:404' }],
           originRequest: { noTLSVerify: false }, 'warp-routing': { enabled: false } };
}

for (const id of [PROD, DEV]) {
  for (const [state, path] of PUBLISHED[id].entries()) {
    test(`${id}: from published state ${state}, changes exactly one path, preserves input and is idempotent`, () => {
      const input = fixture(id, path), before = structuredClone(input);
      const result = extendReadTunnelConfig(id, input);
      assert.deepEqual(input, before);
      const expected = structuredClone(before);
      expected.ingress[1].path = result.ingress[1].path;
      assert.deepEqual(result, expected);
      assert.notEqual(result.ingress[1].path, before.ingress[1].path);
      assert.deepEqual(extendReadTunnelConfig(id, result), result);
      result.ingress[1].originRequest.connectTimeout = 99;
      assert.equal(input.ingress[1].originRequest.connectTimeout, 5);
    });
  }

  test(`${id}: every published state ends in the same new path`, () => {
    const ends = PUBLISHED[id].map((path) => extendReadTunnelConfig(id, fixture(id, path)).ingress[1].path);
    assert.equal(new Set(ends).size, 1);
    assert.equal(PUBLISHED[id].includes(ends[0]), false, 'the new state is none of the old ones');
  });

  test(`${id}: keeps the exact V1 routes, adds the stored-data reads, and adds only its intended V2 paths`, () => {
    const pattern = new RegExp(extendReadTunnelConfig(id, fixture(id)).ingress[1].path);
    for (const route of [...V1, ...STORED]) assert.ok(pattern.test('/internal/read/v1/' + route), route);
    assert.ok(pattern.test('/internal/read/v2/pool-market'));
    assert.equal(pattern.test('/internal/read/v2/capabilities'), id === DEV);
    assert.equal(pattern.test('/internal/dev/v1/status'), id === DEV);
    assert.equal(pattern.test('/internal/read/v1/capabilities'), id === DEV);
    for (const path of ['/internal/read/v2/token', '/internal/read/v2/pool-positions', '/internal/read/v2/markets-snapshot', '/internal/read/v2/pool-market/',
                        '/internal/read/v2/pool-market/extra', '/internal/read/v3/pool-market', '/internal/session/v1/state',
                        '/internal/read/v2/%70ool-market', '/prefix/internal/read/v2/pool-market', '/internal/read/v1/markets-snapshot/',
                        '/internal/read/v1/markets-snapshot/extra', '/internal/read/v1/swap-preview', '/internal/read/v1/%6darkets-snapshot']) {
      assert.equal(pattern.test(path), false, path);
    }
  });

  test(`${id}: unknown path, another tunnel's path, destination, host or duplicate rule fails closed`, () => {
    for (const mutate of [
      (c) => { c.ingress[1].path = '^/internal/.*$'; },
      (c) => { c.ingress[1].path = PUBLISHED[id === PROD ? DEV : PROD][1]; },
      (c) => { c.ingress[1].hostname = 'unexpected.example.invalid'; },
      (c) => { c.ingress[1].service = 'http://127.0.0.1:8876'; },
      (c) => { c.ingress.push(structuredClone(c.ingress[1])); },
      (c) => { c.ingress[1].originRequest = {}; },
    ]) {
      const config = fixture(id); mutate(config);
      const original = structuredClone(config);
      assert.throws(() => extendReadTunnelConfig(id, config), /^Error: read_tunnel_configuration_mismatch$/);
      assert.deepEqual(config, original);
    }
  });
}

test('production Access remains required and dev Host must stay exact', () => {
  for (const value of [false, 'true', 1, null]) {
    const config = fixture(PROD); config.ingress[1].originRequest.access.required = value;
    assert.throws(() => extendReadTunnelConfig(PROD, config), /read_tunnel_configuration_mismatch/);
  }
  const dev = fixture(DEV); dev.ingress[1].originRequest.httpHostHeader = 'localhost:8891';
  assert.throws(() => extendReadTunnelConfig(DEV, dev), /read_tunnel_configuration_mismatch/);
});

test('rejects unknown tunnel and config/envelope shapes with fixed errors', () => {
  for (const id of ['other', '__proto__', 'constructor', null]) {
    assert.throws(() => extendReadTunnelConfig(id, fixture(PROD)), /^Error: read_tunnel_configuration_mismatch$/);
  }
  for (const config of [null, [], {}, { config: fixture(PROD) }, { ingress: [] }, { ingress: [null] }]) {
    assert.throws(() => extendReadTunnelConfig(PROD, config), /^Error: read_tunnel_configuration_mismatch$/);
  }
});
