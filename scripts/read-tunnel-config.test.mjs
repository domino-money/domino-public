import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extendReadTunnelConfig, storedPath, READ_TUNNEL_IDS, V3_READ_TUNNEL_IDS, V4_READ_TUNNEL_IDS, V5_READ_TUNNEL_IDS, V6_READ_TUNNEL_IDS } from './read-tunnel-config.mjs';

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

test('V3 opens only exact stored production routes and keeps Access and prior protocols', () => {
  assert.deepEqual(V3_READ_TUNNEL_IDS, [PROD]);
  const input = extendReadTunnelConfig(PROD, fixture(PROD));
  const before = structuredClone(input);
  const result = extendReadTunnelConfig(PROD, input, { enableV3: true });
  assert.deepEqual(input, before);
  const expected = structuredClone(before);
  expected.ingress[1].path = result.ingress[1].path;
  assert.deepEqual(result, expected);
  const pattern = new RegExp(result.ingress[1].path);
  for (const route of ['overview', 'history', 'search']) {
    assert.ok(pattern.test('/internal/read/v3/' + route));
  }
  for (const path of ['/internal/read/v3/token', '/internal/read/v3/capabilities', '/internal/read/v3/overview/',
                      '/internal/read/v3/%6fverview', '/internal/read/v3/overview/extra']) {
    assert.equal(pattern.test(path), false, path);
  }
  for (const route of [...V1, ...STORED]) assert.ok(pattern.test('/internal/read/v1/' + route));
  assert.ok(pattern.test('/internal/read/v2/pool-market'));
  assert.deepEqual(extendReadTunnelConfig(PROD, result), result);
  assert.deepEqual(extendReadTunnelConfig(PROD, result, { enableV3: true }), result);
  assert.throws(() => extendReadTunnelConfig(DEV, fixture(DEV), { enableV3: true }), /mismatch/);
})

test('V4 opens only the fixed production snapshot and preserves an existing V3 path', () => {
  assert.deepEqual(V4_READ_TUNNEL_IDS,[PROD]);
  const baseline=extendReadTunnelConfig(PROD,fixture(PROD));
  const v4=extendReadTunnelConfig(PROD,baseline,{enableV4:true});
  const pattern=new RegExp(v4.ingress[1].path);
  assert.equal(pattern.test('/internal/read/v4/sequence-snapshot'),true);
  for(const path of ['/internal/read/v4/eth_call','/internal/read/v4/sequence-snapshot/',
    '/internal/read/v4/%73equence-snapshot','/internal/read/v4/sequence-snapshot?method=eth_call'])
    assert.equal(pattern.test(path),false,path);
  assert.deepEqual(extendReadTunnelConfig(PROD,v4),v4);
  const both=extendReadTunnelConfig(PROD,extendReadTunnelConfig(PROD,baseline,{enableV3:true}),{enableV4:true});
  assert.equal(new RegExp(both.ingress[1].path).test('/internal/read/v3/overview'),true);
  assert.equal(new RegExp(both.ingress[1].path).test('/internal/read/v4/sequence-snapshot'),true);
  assert.deepEqual(extendReadTunnelConfig(PROD,both),both);
  const rolledBack=extendReadTunnelConfig(PROD,both,{disableV4:true});
  const rollbackPattern=new RegExp(rolledBack.ingress[1].path);
  assert.equal(rollbackPattern.test('/internal/read/v4/sequence-snapshot'),false);
  assert.equal(rollbackPattern.test('/internal/read/v3/overview'),true);
  assert.equal(rollbackPattern.test('/internal/read/v2/pool-market'),true);
  assert.deepEqual(extendReadTunnelConfig(PROD,rolledBack,{disableV4:true}),rolledBack);
  assert.deepEqual(extendReadTunnelConfig(PROD,fixture(PROD),{disableV4:true}),fixture(PROD));
  assert.throws(()=>extendReadTunnelConfig(PROD,both,{enableV4:true,disableV4:true}),/mismatch/);
  assert.throws(()=>extendReadTunnelConfig(PROD,both,{enableV3:true,disableV4:true}),/mismatch/);
  assert.throws(()=>extendReadTunnelConfig(DEV,fixture(DEV),{enableV4:true}),/mismatch/);
  assert.throws(()=>extendReadTunnelConfig(DEV,fixture(DEV),{disableV4:true}),/mismatch/);
});

/**
 * The production states published before read-v5 existed, spelled exactly as
 * read-tunnel-config.mjs wrote them then (2026-09-26): each must stay a state
 * the rule accepts, with the same meaning, or a live tunnel would be refused.
 */
const PRE_V5 = {
  next: '^/internal/read/(v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics|markets-snapshot)|v2/pool-market)$',
  v3: '^/internal/read/(v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics|markets-snapshot)|v2/pool-market|v3/(overview|history|search))$',
  v4: '^/internal/read/(v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics|markets-snapshot)|v2/pool-market|v4/sequence-snapshot)$',
  v3v4: '^/internal/read/(v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics|markets-snapshot)|v2/pool-market|v3/(overview|history|search)|v4/sequence-snapshot)$',
};

test('the states published before read-v5 keep their spelling, stay accepted and keep their meaning', () => {
  assert.equal(storedPath(), PRE_V5.next);
  assert.equal(storedPath({ v3: true }), PRE_V5.v3);
  assert.equal(storedPath({ v4: true }), PRE_V5.v4);
  assert.equal(storedPath({ v3: true, v4: true }), PRE_V5.v3v4);
  for (const [name, path] of Object.entries(PRE_V5)) {
    const input = fixture(PROD, path);
    // An ordinary publication changes nothing about an already current state.
    assert.deepEqual(extendReadTunnelConfig(PROD, input), input, name);
    const pattern = new RegExp(extendReadTunnelConfig(PROD, input, { enableV5: true }).ingress[1].path);
    assert.equal(pattern.test('/internal/read/v5/featured-pools'), true, name);
    assert.equal(pattern.test('/internal/read/v3/overview'), name.includes('v3'), name);
    assert.equal(pattern.test('/internal/read/v4/sequence-snapshot'), name.includes('v4'), name);
  }
});

test('V5 opens only the fixed production featured pools path and preserves V3 and V4', () => {
  assert.deepEqual(V5_READ_TUNNEL_IDS, [PROD]);
  assert.deepEqual(READ_TUNNEL_IDS, [PROD, DEV]);
  const baseline = extendReadTunnelConfig(PROD, fixture(PROD));
  const before = structuredClone(baseline);
  const v5 = extendReadTunnelConfig(PROD, baseline, { enableV5: true });
  assert.deepEqual(baseline, before);
  const expected = structuredClone(before);
  expected.ingress[1].path = v5.ingress[1].path;
  assert.deepEqual(v5, expected, 'only the one path changes');
  const pattern = new RegExp(v5.ingress[1].path);
  assert.equal(pattern.test('/internal/read/v5/featured-pools'), true);
  for (const path of ['/internal/read/v5/capabilities', '/internal/read/v5/featured-pools/', '/internal/read/v5/featured-pools/extra',
    '/internal/read/v5/%66eatured-pools', '/internal/read/v5/featured-pools?limit=1', '/internal/read/v5/featured_pools',
    '/internal/read/v5/overview', '/internal/read/v4/featured-pools', '/internal/read/v1/featured-pools', '/internal/read/v3/overview',
    '/internal/read/v4/sequence-snapshot', '/prefix/internal/read/v5/featured-pools']) {
    assert.equal(pattern.test(path), false, path);
  }
  for (const route of [...V1, ...STORED]) assert.ok(pattern.test('/internal/read/v1/' + route), route);
  assert.ok(pattern.test('/internal/read/v2/pool-market'));
  // Idempotent, and an ordinary publication keeps it.
  assert.deepEqual(extendReadTunnelConfig(PROD, v5), v5);
  assert.deepEqual(extendReadTunnelConfig(PROD, v5, { enableV5: true }), v5);
  // Every stored protocol together, in any order of opening, is one path.
  const all = extendReadTunnelConfig(PROD, extendReadTunnelConfig(PROD, extendReadTunnelConfig(PROD, baseline, { enableV4: true }), { enableV5: true }), { enableV3: true });
  const allPattern = new RegExp(all.ingress[1].path);
  for (const path of ['/internal/read/v3/overview', '/internal/read/v4/sequence-snapshot', '/internal/read/v5/featured-pools']) assert.equal(allPattern.test(path), true, path);
  assert.deepEqual(extendReadTunnelConfig(PROD, baseline, { enableV3: true, enableV4: true, enableV5: true }), all);
  assert.deepEqual(extendReadTunnelConfig(PROD, all), all);
  // The other rollback keeps V5, and V5's own rollback keeps V3 and V4.
  const withoutV4 = new RegExp(extendReadTunnelConfig(PROD, all, { disableV4: true }).ingress[1].path);
  assert.equal(withoutV4.test('/internal/read/v5/featured-pools'), true);
  assert.equal(withoutV4.test('/internal/read/v4/sequence-snapshot'), false);
  const withoutV5 = extendReadTunnelConfig(PROD, all, { disableV5: true });
  const rollback = new RegExp(withoutV5.ingress[1].path);
  assert.equal(rollback.test('/internal/read/v5/featured-pools'), false);
  assert.equal(rollback.test('/internal/read/v3/overview'), true);
  assert.equal(rollback.test('/internal/read/v4/sequence-snapshot'), true);
  assert.equal(rollback.test('/internal/read/v2/pool-market'), true);
  assert.equal(withoutV5.ingress[1].path, PRE_V5.v3v4, 'rolling V5 back returns to the state published before it');
  assert.deepEqual(extendReadTunnelConfig(PROD, withoutV5, { disableV5: true }), withoutV5);
  assert.equal(extendReadTunnelConfig(PROD, v5, { disableV5: true }).ingress[1].path, PRE_V5.next);
});

test('a V5 rollback on a tunnel that never opened V5 is a true no-op, and a rollback opens nothing', () => {
  for (const path of [...PUBLISHED[PROD], ...Object.values(PRE_V5)]) {
    const input = fixture(PROD, path);
    assert.deepEqual(extendReadTunnelConfig(PROD, input, { disableV5: true }), input, path);
  }
  const v5 = extendReadTunnelConfig(PROD, fixture(PROD), { enableV5: true });
  for (const options of [{ enableV5: true, disableV5: true }, { enableV3: true, disableV5: true }, { enableV4: true, disableV5: true },
    { disableV4: true, disableV5: true }, { enableV5: true, disableV4: true }, { enableV5: 'true' }, { disableV5: 1 }]) {
    assert.throws(() => extendReadTunnelConfig(PROD, v5, options), /^Error: read_tunnel_configuration_mismatch$/, JSON.stringify(options));
  }
  assert.throws(() => extendReadTunnelConfig(DEV, fixture(DEV), { enableV5: true }), /mismatch/);
  assert.throws(() => extendReadTunnelConfig(DEV, fixture(DEV), { disableV5: true }), /mismatch/);
  // A path that opens V5 some other way is not a state this rule knows.
  for (const path of [PRE_V5.next.replace('v2/pool-market', 'v2/pool-market|v5/(featured-pools|capabilities)'),
    PRE_V5.next.replace('v2/pool-market', 'v5/featured-pools|v2/pool-market'), PRE_V5.next.replace('v2/pool-market', 'v2/pool-market|v5/.*')]) {
    assert.throws(() => extendReadTunnelConfig(PROD, fixture(PROD, path)), /mismatch/, path);
  }
});

/**
 * 2026-10-02 (spec F7 §6.2): read-v6, Domino V2's wallet reads. The production states published before it existed
 * (next and every mix of v3, v4 and v5) keep their spelling; three of them are written out here as they were published.
 */
const PRE_V6 = {
  next: PRE_V5.next,
  v5: '^/internal/read/(v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics|markets-snapshot)|v2/pool-market|v5/featured-pools)$',
  v3v4v5: '^/internal/read/(v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics|markets-snapshot)|v2/pool-market|v3/(overview|history|search)|v4/sequence-snapshot|v5/featured-pools)$',
};
/** read-v6's routes as this release writes them: 1.1.0-rc.1's five, then 1.2.0-rc.1's position-fees (2026-11-07). */
const V6_ROUTES = ['portfolio', 'activity', 'chain-pools', 'chain-balances', 'chain-tokens', 'position-fees'];

test('the states published before read-v6 keep their spelling, stay accepted and keep their meaning', () => {
  assert.equal(storedPath({ v5: true }), PRE_V6.v5);
  assert.equal(storedPath({ v3: true, v4: true, v5: true }), PRE_V6.v3v4v5);
  for (const [name, path] of [...Object.entries(PRE_V5), ...Object.entries(PRE_V6)]) {
    const input = fixture(PROD, path);
    assert.deepEqual(extendReadTunnelConfig(PROD, input), input, name);
    const pattern = new RegExp(extendReadTunnelConfig(PROD, input, { enableV6: true }).ingress[1].path);
    for (const route of V6_ROUTES) {
      assert.equal(pattern.test(`/internal/read/v6/${route}`), true, name);
    }
    assert.equal(pattern.test('/internal/read/v5/featured-pools'), name.includes('v5'), name);
    assert.equal(pattern.test('/internal/read/v3/overview'), name.includes('v3'), name);
  }
});

test('V6 opens only its six fixed production read paths and preserves V3, V4 and V5', () => {
  assert.deepEqual(V6_READ_TUNNEL_IDS, [PROD]);
  const baseline = extendReadTunnelConfig(PROD, fixture(PROD, PRE_V6.v3v4v5));
  const before = structuredClone(baseline);
  const v6 = extendReadTunnelConfig(PROD, baseline, { enableV6: true });
  assert.deepEqual(baseline, before);
  const expected = structuredClone(before);
  expected.ingress[1].path = v6.ingress[1].path;
  assert.deepEqual(v6, expected, 'only the one path changes');
  // Changed on purpose 2026-11-07 (the owner's approval): position-fees joins, named last, as the gateway and the Worker name it.
  assert.equal(v6.ingress[1].path,
    PRE_V6.v3v4v5.replace(')$', '|v6/(portfolio|activity|chain-pools|chain-balances|chain-tokens|position-fees))$'),
    'v6 last, in version order');
  const pattern = new RegExp(v6.ingress[1].path);
  for (const path of ['/internal/read/v6/portfolio', '/internal/read/v6/activity', '/internal/read/v6/chain-pools',
    '/internal/read/v6/chain-balances', '/internal/read/v6/chain-tokens', '/internal/read/v6/position-fees',
    '/internal/read/v5/featured-pools', '/internal/read/v4/sequence-snapshot', '/internal/read/v3/overview',
    '/internal/read/v2/pool-market']) {
    assert.equal(pattern.test(path), true, path);
  }
  for (const path of ['/internal/read/v6/capabilities', '/internal/read/v6/portfolio/', '/internal/read/v6/portfolio/extra',
    '/internal/read/v6/%70ortfolio', '/internal/read/v6/activity?limit=1', '/internal/read/v6/Portfolio', '/internal/read/v6/',
    '/internal/read/v6/featured-pools', '/internal/read/v5/portfolio', '/internal/read/v1/activity', '/prefix/internal/read/v6/portfolio',
    '/internal/read/v6/chain-pools/', '/internal/read/v6/chain-swaps', '/internal/read/v1/chain-pools',
    '/internal/read/v6/position-fees/', '/internal/read/v6/position-fees/extra', '/internal/read/v6/%70osition-fees',
    '/internal/read/v6/position-fees?chainId=8453', '/internal/read/v6/Position-fees', '/internal/read/v6/position_fees',
    '/internal/read/v6/position-fee', '/internal/read/v6/positions-fees', '/internal/read/v6/position-fees-extra',
    '/internal/read/v6/fees', '/internal/read/v5/position-fees', '/internal/read/v1/position-fees',
    '/internal/read/v2/position-fees', '/prefix/internal/read/v6/position-fees']) {
    assert.equal(pattern.test(path), false, path);
  }
  // Idempotent, and an ordinary publication keeps it.
  assert.deepEqual(extendReadTunnelConfig(PROD, v6), v6);
  assert.deepEqual(extendReadTunnelConfig(PROD, v6, { enableV6: true }), v6);
  // The others' rollbacks keep V6, and V6's own rollback returns to the state published before it.
  for (const options of [{ disableV4: true }, { disableV5: true }]) {
    assert.equal(new RegExp(extendReadTunnelConfig(PROD, v6, options).ingress[1].path).test('/internal/read/v6/portfolio'), true, JSON.stringify(options));
  }
  const withoutV6 = extendReadTunnelConfig(PROD, v6, { disableV6: true });
  assert.equal(withoutV6.ingress[1].path, PRE_V6.v3v4v5);
  assert.deepEqual(extendReadTunnelConfig(PROD, withoutV6, { disableV6: true }), withoutV6);
  assert.equal(extendReadTunnelConfig(PROD, extendReadTunnelConfig(PROD, fixture(PROD), { enableV6: true }), { disableV6: true }).ingress[1].path, PRE_V5.next);
});

// Changed on purpose 2026-11-07: a publication now widens the two first routes to all six, position-fees included.
test('a tunnel published with the two first read-v6 routes is a known state that any publication widens to six', () => {
  const first = (path) => path.replace('|v6/(portfolio|activity|chain-pools|chain-balances|chain-tokens|position-fees))$',
    '|v6/(portfolio|activity))$');
  const widened = extendReadTunnelConfig(PROD, extendReadTunnelConfig(PROD, fixture(PROD, PRE_V6.v3v4v5)), { enableV6: true });
  const published = fixture(PROD, first(widened.ingress[1].path));
  assert.notEqual(published.ingress[1].path, widened.ingress[1].path);
  for (const options of [{}, { enableV6: true }, { disableV4: true }, { disableV5: true }]) {
    const next = extendReadTunnelConfig(PROD, published, options);
    assert.equal(new RegExp(next.ingress[1].path).test('/internal/read/v6/chain-pools'), true, JSON.stringify(options));
    assert.equal(new RegExp(next.ingress[1].path).test('/internal/read/v6/portfolio'), true, JSON.stringify(options));
    assert.equal(new RegExp(next.ingress[1].path).test('/internal/read/v6/position-fees'), true, JSON.stringify(options));
  }
  assert.deepEqual(extendReadTunnelConfig(PROD, published), widened);
  assert.equal(extendReadTunnelConfig(PROD, published, { disableV6: true }).ingress[1].path, PRE_V6.v3v4v5);
});

/**
 * 2026-11-07 (the owner's approval of position-fees): read-v6's five 1.1.0-rc.1 routes, the path `tunnels-v6` wrote
 * from 2026-10-05, spelled exactly as published. Each mix of v3, v4 and v5 with them stays a known state, and any
 * publication writes the same mix with all six.
 */
const FIVE_V6 = '|v6/(portfolio|activity|chain-pools|chain-balances|chain-tokens))$';
const PRE_FEES = {
  v6: PRE_V6.next.replace(')$', FIVE_V6),
  v5v6: PRE_V6.v5.replace(')$', FIVE_V6),
  v3v4v5v6: PRE_V6.v3v4v5.replace(')$', FIVE_V6),
};

test('a tunnel published with read-v6\'s five 1.1.0-rc.1 routes is a known state that any publication widens to six', () => {
  assert.equal(PRE_FEES.v3v4v5v6, '^/internal/read/(v1/(token|pools|pool-market|wallet-assets|nft-positions|catalogue|pool-activity|pool-positions|pool-metrics|markets-snapshot)|v2/pool-market|v3/(overview|history|search)|v4/sequence-snapshot|v5/featured-pools|v6/(portfolio|activity|chain-pools|chain-balances|chain-tokens))$');
  for (const [name, path] of Object.entries(PRE_FEES)) {
    const published = fixture(PROD, path);
    const before = structuredClone(published);
    const widened = extendReadTunnelConfig(PROD, published);
    assert.deepEqual(published, before, name);
    const expected = structuredClone(before);
    expected.ingress[1].path = path.replace(FIVE_V6, '|v6/(portfolio|activity|chain-pools|chain-balances|chain-tokens|position-fees))$');
    assert.deepEqual(widened, expected, `${name}: only the one path changes, to the same mix with all six`);
    // Any publication: an ordinary one, tunnels-v6, or another protocol's rollback where that protocol is open (where it
    // is not, its rollback is a true no-op and leaves the five routes as they are, still a known state).
    for (const options of [{}, { enableV6: true }, { disableV4: true }, { disableV5: true }]) {
      const next = extendReadTunnelConfig(PROD, published, options);
      if ((options.disableV4 && !name.includes('v4')) || (options.disableV5 && !name.includes('v5'))) {
        assert.deepEqual(next, published, `${name} ${JSON.stringify(options)}`);
        continue;
      }
      const pattern = new RegExp(next.ingress[1].path);
      for (const route of V6_ROUTES) assert.equal(pattern.test(`/internal/read/v6/${route}`), true, `${name} ${route} ${JSON.stringify(options)}`);
      assert.equal(pattern.test('/internal/read/v6/position-fees/'), false, name);
    }
    // Idempotent once widened, and read-v6's own rollback closes all six, returning to the state published before it.
    assert.deepEqual(extendReadTunnelConfig(PROD, widened), widened, name);
    assert.deepEqual(extendReadTunnelConfig(PROD, published, { enableV6: true }), widened, name);
    assert.equal(extendReadTunnelConfig(PROD, published, { disableV6: true }).ingress[1].path, path.replace(FIVE_V6, ')$'), name);
  }
  // Every mix of the other stored protocols with the five routes, not only those spelled out above.
  for (const v3 of [false, true]) for (const v4 of [false, true]) for (const v5 of [false, true]) {
    const six = storedPath({ v3, v4, v5, v6: true });
    const five = six.replace('|chain-tokens|position-fees))$', '|chain-tokens))$');
    assert.notEqual(five, six);
    assert.equal(extendReadTunnelConfig(PROD, fixture(PROD, five)).ingress[1].path, six, five);
  }
});

test('a V6 rollback on a tunnel that never opened V6 is a true no-op, and a rollback opens nothing', () => {
  for (const path of [...PUBLISHED[PROD], ...Object.values(PRE_V5), ...Object.values(PRE_V6)]) {
    const input = fixture(PROD, path);
    assert.deepEqual(extendReadTunnelConfig(PROD, input, { disableV6: true }), input, path);
  }
  const v6 = extendReadTunnelConfig(PROD, fixture(PROD), { enableV6: true });
  for (const options of [{ enableV6: true, disableV6: true }, { enableV3: true, disableV6: true }, { enableV5: true, disableV6: true },
    { disableV5: true, disableV6: true }, { disableV4: true, disableV6: true }, { enableV6: true, disableV5: true },
    { enableV6: 'true' }, { disableV6: 1 }]) {
    assert.throws(() => extendReadTunnelConfig(PROD, v6, options), /^Error: read_tunnel_configuration_mismatch$/, JSON.stringify(options));
  }
  assert.throws(() => extendReadTunnelConfig(DEV, fixture(DEV), { enableV6: true }), /mismatch/);
  assert.throws(() => extendReadTunnelConfig(DEV, fixture(DEV), { disableV6: true }), /mismatch/);
  // A path that opens V6 some other way is not a state this rule knows.
  for (const path of [PRE_V5.next.replace('v2/pool-market', 'v2/pool-market|v6/(portfolio|activity|capabilities)'),
    PRE_V5.next.replace('v2/pool-market', 'v6/(portfolio|activity)|v2/pool-market'), PRE_V5.next.replace('v2/pool-market', 'v2/pool-market|v6/.*'),
    PRE_V5.next.replace('v2/pool-market', 'v2/pool-market|v6/portfolio'),
    // 2026-11-07: nor is one that names position-fees but not as this release writes it.
    ...['v6/position-fees', 'v6/(position-fees)', 'v6/(portfolio|activity|position-fees)',
      'v6/(portfolio|activity|chain-pools|chain-balances|chain-tokens|position-fees|capabilities)',
      'v6/(position-fees|portfolio|activity|chain-pools|chain-balances|chain-tokens)',
      'v6/(portfolio|activity|chain-pools|chain-balances|chain-tokens|position-fees|position-fees)',
      'v6/(portfolio|activity|chain-pools|chain-balances|chain-tokens)|v6/position-fees',
      'v6/(portfolio|activity|chain-pools|chain-balances|chain-tokens|position_fees)',
      'v6/(portfolio|activity|chain-pools|chain-balances|position-fees)']
      .map((v6) => PRE_V5.next.replace('v2/pool-market', `v2/pool-market|${v6}`))]) {
    assert.throws(() => extendReadTunnelConfig(PROD, fixture(PROD, path)), /mismatch/, path);
  }
  // A known state with position-fees in another protocol's place is not one either.
  for (const path of [PRE_V6.v5.replace('v5/featured-pools', 'v5/(featured-pools|position-fees)'),
    PRE_FEES.v3v4v5v6.replace('v4/sequence-snapshot', 'v4/(sequence-snapshot|position-fees)')]) {
    assert.throws(() => extendReadTunnelConfig(PROD, fixture(PROD, path)), /mismatch/, path);
  }
});

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
