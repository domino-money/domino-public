/**
 * The Elysium v3 adapter, its source and its flag (src/chains/elysium/adapter.ts, flag.ts, rehearsal.ts; 2026-10-01,
 * the chain2 workstream, audit items G2, G7 and G8), over a small v3 chain (tests/support/v3-chain.mjs) and his
 * services' fixtures.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as read from '../functions/_lib/uniswap-v3/contracts/uniswap-v3-read-v1/runtime.mjs';
import * as actions from '../functions/_lib/uniswap-v3/contracts/uniswap-v3-actions-v1/runtime.mjs';
import { TOPIC, addr, fakeRuntime, fakeV3Chain, poolCreatedData, swapData, topicAddress, topicUint } from './support/v3-chain.mjs';

const require = createRequire(import.meta.url);
const { createElysiumAdapter, PUBLIC_WALLET_LANE } = require('../.test-build/app/src/chains/elysium/adapter.js');
const flag = require('../.test-build/app/src/chains/elysium/flag.js');
const { ELYSIUM_REHEARSAL } = require('../.test-build/app/src/chains/elysium/rehearsal.js');
const { createV3Api } = require('../.test-build/app/src/chains/elysium/api.js');
const { createChainClient } = require('../.test-build/app/src/lib/chain/client.js');
const { ELYSIUM, ROBINHOOD } = require('../.test-build/app/src/config/chains.js');
const { positionRef, poolRef } = require('../.test-build/app/src/chains/types.js');
const v3 = require('../.test-build/app/src/chains/v3math.js');
const { APP_ORIGIN, PREVIEW_ORIGIN } = require('../.test-build/app/functions/_lib/bridge.js');

const json = (name) => JSON.parse(readFileSync(new URL(`./fixtures/elysium/${name}`, import.meta.url), 'utf8'));
const pinOf = (family) => JSON.parse(readFileSync(new URL(`../functions/_lib/uniswap-v3/contracts/${family}/pin.json`, import.meta.url), 'utf8'));
const RUNTIMES = { read: { runtime: read, pin: pinOf('uniswap-v3-read-v1') }, actions: { runtime: actions, pin: pinOf('uniswap-v3-actions-v1') } };

test('the rehearsal\'s addresses are rugged97\'s S5 public deployment record, exactly', () => {
  const s5 = json('s5-public-deployment.json');
  assert.equal(s5.chainId, ELYSIUM.id);
  assert.equal(s5.publicRpcUrl, ELYSIUM.rpc.primary.url);
  for (const role of ['factory', 'positionManager', 'router', 'quoter', 'wrappedNative']) assert.equal(ELYSIUM_REHEARSAL[role], s5.contracts[role], role);
  assert.deepEqual(ELYSIUM_REHEARSAL.pools.map((p) => ({ id: p.id, address: p.address, token0: p.token0, token1: p.token1, fee: p.fee, tickSpacing: p.tickSpacing, createdAt: p.createdAt })), s5.pools.map((p) => ({ id: p.id, address: p.address, token0: p.token0, token1: p.token1, fee: p.fee, tickSpacing: p.tickSpacing, createdAt: Number(p.creationBlockNumberRaw) })));
  assert.deepEqual(ELYSIUM_REHEARSAL.vaults.map((v) => [v.id, v.address, v.createdAt]), s5.vaults.records.map((v) => [v.id, v.address, Number(v.blockNumberRaw)]));
  assert.equal(ELYSIUM_REHEARSAL.factoryBlock, Number(s5.transactions.find((t) => t.id === 'factory').blockNumberRaw));
  assert.ok(s5.pools.every((p) => p.factory === ELYSIUM_REHEARSAL.factory));
  assert.equal(ELYSIUM_REHEARSAL.source.commit, '7d1906907381c55e65d9b83ad1f3efafe1cabb36');
});

// Changed on purpose 2026-10-02 (review of the RPC switch, finding 1; the owner's final decision of 2026-10-01: the site
// reads nothing from a public RPC, on the preview too): the section's only line to its chain is the testnet's public RPC,
// so it is closed everywhere, the preview alias and the development server included, while it has no source of rugged97's
// to read (mode.ts SECTION_READS). The rule it follows once it has one is unchanged, and checked with `reads` true.
test('the section is closed everywhere while it can read its chain only from a public RPC; with a source of its own: off in production until qualified, on in preview, off anywhere else', () => {
  const mode = require('../.test-build/app/src/chains/elysium/mode.js');
  const qualified = { ...ELYSIUM, deployment: { ...ELYSIUM.deployment, status: 'qualified', contracts: { factory: addr(0xf1), positionManager: addr(0xf2), router: addr(0xf3), quoter: addr(0xf4) } }, firstBlocks: { factory: 77 } };
  assert.equal(mode.SECTION_READS, false, 'no source of rugged97\'s yet: nothing reads the testnet\'s public RPC');
  for (const origin of [APP_ORIGIN, PREVIEW_ORIGIN, flag.DEV_ORIGIN, 'https://abc123.domino-app-e65.pages.dev', 'https://evil.example']) {
    for (const chain of [ELYSIUM, qualified]) assert.equal(flag.sectionMode(origin, chain), 'off', `${origin} ${chain.deployment.status}`);
  }
  assert.equal(flag.sectionMode(APP_ORIGIN, ELYSIUM, true), 'off');
  assert.equal(flag.sectionMode(PREVIEW_ORIGIN, ELYSIUM, true), 'preview');
  assert.equal(flag.sectionMode(flag.DEV_ORIGIN, ELYSIUM, true), 'preview');
  assert.equal(flag.sectionMode('https://abc123.domino-app-e65.pages.dev', ELYSIUM, true), 'off', 'a hash deployment is not the preview alias');
  assert.equal(flag.sectionMode('https://evil.example', ELYSIUM, true), 'off');
  assert.equal(flag.sectionMode(APP_ORIGIN, qualified, true), 'live');
});

// Part B (2026-10-01): the mode is a module of its own that the app's menu asks on every page (src/chains/elysium/mode.ts),
// with copies of the forwarder's two origins rather than an import of it; the menu links the section exactly where the
// section is not off.
test('the menu links the section exactly where its mode is not off, by the same rule and the forwarder\'s own origins', () => {
  const mode = require('../.test-build/app/src/chains/elysium/mode.js');
  const identity = require('../.test-build/app/src/config/chainIdentity.js');
  assert.equal(mode.SITE_ORIGIN, APP_ORIGIN, 'a copy of functions/_lib/bridge.ts APP_ORIGIN');
  assert.equal(mode.PREVIEW_ALIAS, PREVIEW_ORIGIN, 'a copy of functions/_lib/bridge.ts PREVIEW_ORIGIN');
  assert.equal(flag.sectionMode, mode.sectionMode, 'flag.ts re-exports the one rule');
  assert.equal(flag.DEV_ORIGIN, mode.DEV_ORIGIN);
  assert.equal(identity.ELYSIUM_STATUS, ELYSIUM.deployment.status, 'the menu reads the record\'s own status');
  assert.equal(identity.ELYSIUM_NAME, ELYSIUM.name);
  assert.equal(identity.ELYSIUM_KEY, ELYSIUM.key);
  const qualified = { ...ELYSIUM, deployment: { ...ELYSIUM.deployment, status: 'qualified' } };
  for (const origin of [APP_ORIGIN, PREVIEW_ORIGIN, mode.DEV_ORIGIN, 'https://abc123.domino-app-e65.pages.dev', 'https://www.domino.money', 'http://domino.money', 'https://evil.example', '', 'null']) {
    for (const chain of [ELYSIUM, qualified]) {
      assert.equal(mode.sectionLinked(origin, chain.deployment.status), mode.sectionMode(origin, chain) !== 'off', `${origin} ${chain.deployment.status}`);
      assert.equal(mode.sectionLinked(origin, chain.deployment.status, true), mode.sectionMode(origin, chain, true) !== 'off', `${origin} ${chain.deployment.status}, with a source`);
    }
  }
  assert.equal(mode.sectionLinked(APP_ORIGIN, identity.ELYSIUM_STATUS), false, 'nothing appears on domino.money today');
  // Changed on purpose 2026-10-02 (review finding 1): nor on the preview, while the section could read only a public RPC.
  assert.equal(mode.sectionLinked(PREVIEW_ORIGIN, identity.ELYSIUM_STATUS), false, 'nor on the preview, today');
  assert.equal(mode.sectionLinked(PREVIEW_ORIGIN, identity.ELYSIUM_STATUS, true), true, 'the preview links it once the section has a source of its own');
});

test('what each mode reads: nothing off, the rehearsal in preview while unqualified, the registry\'s contracts once qualified', () => {
  assert.equal(flag.sectionSource('off', ELYSIUM), null);
  const preview = flag.sectionSource('preview', ELYSIUM);
  assert.equal(preview.kind, 'rehearsal');
  assert.equal(preview.factory, ELYSIUM_REHEARSAL.factory);
  assert.deepEqual(preview.vaults, ELYSIUM_REHEARSAL.vaults.map((v) => v.address));
  assert.equal(flag.sectionSource('live', ELYSIUM), null, 'production never reads the rehearsal');
  assert.equal(flag.sectionSource('preview', ROBINHOOD), null, 'the rehearsal is Elysium\'s alone');
  const qualified = { ...ELYSIUM, deployment: { ...ELYSIUM.deployment, status: 'qualified', contracts: { factory: addr(0xf1), positionManager: addr(0xf2), router: addr(0xf3), quoter: addr(0xf4) } }, firstBlocks: { factory: 77 } };
  assert.deepEqual(flag.sectionSource('live', qualified), { kind: 'qualified', factory: addr(0xf1), positionManager: addr(0xf2), fromBlock: 77, pools: [], vaults: [] });
});

// --- A small deployment -------------------------------------------------------------------------------------------

const FACTORY = addr(0xfac);
const NFPM = addr(0x9f);
const T0 = addr(0x10);
const T1 = addr(0x20);
const POOL = addr(0x4b);
const STRAY = addr(0x4c);
const OWNER = addr(0x0123);
const VAULT = addr(0x385);
const OTHER_VAULT = addr(0x386);
const Q128 = 1n << 128n;

function deployment() {
  const chain = fakeV3Chain({ head: 1_500_000, timestamp: 1_790_100_000 });
  chain.factory(FACTORY);
  chain.factory(addr(0xbad));
  chain.token(T0, 'TKA', 18);
  chain.token(T1, null, 6);
  chain.pool(POOL, { factory: FACTORY, token0: T0, token1: T1, fee: 3000, tickSpacing: 60, sqrtPriceX96: 79228162514264337593543950336n, tick: 0, liquidity: 10n ** 18n, feeGrowthGlobal0X128: 50n * Q128, feeGrowthGlobal1X128: 80n * Q128 });
  chain.pool(STRAY, { factory: addr(0xbad), token0: T0, token1: T1, fee: 500, tickSpacing: 10, sqrtPriceX96: 2n ** 96n, tick: 0 });
  chain.tick(POOL, -600, { feeGrowthOutside0X128: 10n * Q128, feeGrowthOutside1X128: 20n * Q128 });
  chain.tick(POOL, 600, { feeGrowthOutside0X128: 5n * Q128, feeGrowthOutside1X128: 6n * Q128 });
  chain.manager(NFPM, FACTORY);
  chain.position(NFPM, 3, VAULT, { token0: T0, token1: T1, fee: 3000, tickLower: -600, tickUpper: 600, liquidity: 1_000n, feeGrowthInside0LastX128: 30n * Q128, feeGrowthInside1LastX128: 40n * Q128, tokensOwed0: 7n });
  chain.position(NFPM, 7, OWNER, { token0: T0, token1: T1, fee: 3000, tickLower: -1200, tickUpper: -600, liquidity: 0n });
  chain.vault(VAULT, { owner: OWNER, pool: POOL, token0: T0, token1: T1, fee: 3000, tickSpacing: 60, paused: false, deployment: { factory: FACTORY, manager: NFPM }, positionIds: [3], positions: new Map([[3n, { known: true, active: true, generation: 0n, parent: 0n, lower: -600, upper: 600, liquidity: 1_000n }]]) });
  chain.vault(OTHER_VAULT, { owner: addr(0x9999), pool: POOL, token0: T0, token1: T1, fee: 3000, tickSpacing: 60, deployment: { factory: FACTORY, manager: NFPM } });
  chain.log({ address: FACTORY, blockNumber: 1_000_000, topics: [TOPIC.PoolCreated, topicAddress(T0), topicAddress(T1), topicUint(3000)], data: poolCreatedData(60, POOL) });
  chain.log({ address: POOL, blockNumber: 1_490_000, topics: [TOPIC.Swap, topicAddress(addr(1)), topicAddress(addr(2))], data: swapData(1_000_000, -990_000, 2n ** 96n, 1, 0) });
  return chain;
}

const SOURCE = { kind: 'rehearsal', factory: FACTORY, positionManager: NFPM, fromBlock: 900_000, pools: [STRAY], vaults: [VAULT, OTHER_VAULT] };

function adapterOver(chain, { api = null, mode = 'preview', signer = false, config = ELYSIUM } = {}) {
  return createElysiumAdapter({ chain: config, mode, source: SOURCE, reader: createChainClient(config, fakeRuntime(chain)), api, signer });
}

const notEnabled = async () => new Response(JSON.stringify({ error: 'not_enabled' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

test('capabilities without his services: pools from the chain, no USD, no APR, no actions (not connected yet)', async () => {
  const caps = await adapterOver(deployment()).capabilities();
  assert.equal(caps.chain, ELYSIUM);
  assert.equal(caps.pools, 'chain');
  assert.equal(caps.usd, false);
  assert.equal(caps.apr, false);
  assert.equal(caps.history, 'chain');
  assert.deepEqual(caps.actions, { available: false, reason: 'service-off' });
  assert.deepEqual(caps.service, { read: 'not-enabled', actions: 'not-enabled' });
  const routed = await adapterOver(deployment(), { api: createV3Api(notEnabled, RUNTIMES) }).capabilities();
  assert.deepEqual(routed.service, { read: 'not-enabled', actions: 'not-enabled' });
  assert.equal((await adapterOver(deployment(), { mode: 'off' }).capabilities()).actions.reason, 'section-off');
});

test('capabilities with his services answering: the identity they name, his vaults joined, actions still closed while unqualified', async () => {
  const readWire = json('uniswap-v3-read-v1.wire.json');
  const actionsWire = json('uniswap-v3-actions-v1.wire.json');
  const actionsCaps = { ...structuredClone(actionsWire.responses.capabilities), qualification: 'unqualified', localWalletActionsAvailable: false, vaults: [addr(0x777)] };
  const send = async (path) => {
    const family = path.includes('/read/') ? 'read' : 'actions';
    const pin = RUNTIMES[family].pin;
    const header = `X-Domino-Uniswap-V3-${family === 'read' ? 'Read' : 'Actions'}-Contract`;
    const body = family === 'read' ? readWire.responses.capabilities : actionsCaps;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', [header]: pin.contractVersion, [`${header}-Digest`]: pin.manifestSha256 } });
  };
  const adapter = adapterOver(deployment(), { api: createV3Api(send, RUNTIMES), signer: true });
  const caps = await adapter.capabilities();
  assert.deepEqual(caps.service, { read: 'connected', actions: 'connected' });
  assert.deepEqual(adapter.identity(), actionsWire.identity, 'the read service named none (unqualified), the actions service did');
  assert.equal(caps.history, 'service');
  assert.deepEqual(caps.actions, { available: false, reason: 'deployment-unqualified' });
});

test('his rc.2 actions contract offers this site no wallet lane: qualified, signed and answering, actions stay closed', async () => {
  const readWire = json('uniswap-v3-read-v1.wire.json');
  const actionsWire = json('uniswap-v3-actions-v1.wire.json');
  const qualified = { ...ELYSIUM, deployment: { ...ELYSIUM.deployment, status: 'qualified', contracts: { factory: FACTORY, positionManager: NFPM, router: addr(0xf3), quoter: addr(0xf4) } } };
  // The public lane rc.2 names (none) is a no by its version; his private rehearsal lane and his local fixture lane are
  // refused by api.ts before the adapter sees them, so the service counts as not reachable here.
  for (const [lane, service, reason] of [
    [{ qualification: 'unqualified' }, 'connected', 'service-says-no'],
    [{ qualification: 'testnet-rehearsal', rehearsalWalletActionsAvailable: true }, 'unreachable', 'service-off'],
    [{ qualification: 'local-fixture', localWalletActionsAvailable: true }, 'unreachable', 'service-off'],
  ]) {
    const actionsCaps = { ...structuredClone(actionsWire.responses.capabilities), localWalletActionsAvailable: false, ...lane };
    assert.equal(actions.validateResponse('capabilities', actionsCaps, actionsWire.identity), true, `his runtime takes the ${lane.qualification} answer`);
    const send = async (path) => {
      const family = path.includes('/read/') ? 'read' : 'actions';
      const pin = RUNTIMES[family].pin;
      const header = `X-Domino-Uniswap-V3-${family === 'read' ? 'Read' : 'Actions'}-Contract`;
      const body = family === 'read' ? readWire.responses.capabilities : actionsCaps;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', [header]: pin.contractVersion, [`${header}-Digest`]: pin.manifestSha256 } });
    };
    const caps = await adapterOver(deployment(), { api: createV3Api(send, RUNTIMES), signer: true, config: qualified }).capabilities();
    assert.deepEqual(caps.service, { read: 'connected', actions: service }, lane.qualification);
    assert.deepEqual(caps.actions, { available: false, reason }, lane.qualification);
  }
  assert.deepEqual(PUBLIC_WALLET_LANE, { '1.0.0-rc.2': false });
  assert.ok(Object.isFrozen(PUBLIC_WALLET_LANE));
});

test('the pool list is the factory\'s pools and the source\'s, of this deployment only, each at one block', async () => {
  const pools = await adapterOver(deployment()).listPools();
  assert.deepEqual(pools.map((p) => p.ref.id), [POOL], 'the stray pool of another factory is left out');
  const [pool] = pools;
  assert.deepEqual(pool.ref, poolRef(ELYSIUM, POOL));
  assert.equal(pool.ref.chainId, ELYSIUM.id);
  assert.deepEqual(pool.token1, { address: T1, symbol: null, decimals: 6 }, 'a token with no readable symbol keeps null');
  assert.deepEqual(pool.at, { source: 'chain', block: 1_500_000, timestamp: 1_790_100_000 });
  await assert.rejects(adapterOver(deployment()).poolState(poolRef(ELYSIUM, STRAY)), /pool_not_in_deployment/);
  await assert.rejects(adapterOver(deployment()).poolState({ chainId: 4663, protocol: 'uniswap-v3', id: POOL }), /pool_not_in_deployment/);
});

test('the pool scan is the visit\'s: a screen that leaves while it runs does not fail the next one', async () => {
  const adapter = adapterOver(deployment());
  const leaving = new AbortController();
  const first = adapter.listPools(leaving.signal);
  leaving.abort();
  await assert.rejects(first, { kind: 'aborted' });
  assert.deepEqual((await adapter.listPools()).map((p) => p.ref.id), [POOL]);
});

test('a pool\'s activity: its swaps over the hours asked, what was paid in, and the providers\' share', async () => {
  const activity = await adapterOver(deployment()).poolActivity(poolRef(ELYSIUM, POOL), 24);
  assert.equal(activity.swaps, 1);
  assert.deepEqual(activity.paidIn, [1_000_000n, 0n]);
  assert.deepEqual(activity.providerFees, [3_000n, 0n]);
  assert.equal(activity.toBlock, 1_500_000);
  assert.equal(activity.fromBlock, 1_500_000 - Math.ceil(24 * 3600 * ELYSIUM.blocksPerSecond));
});

test('a wallet\'s positions: in the vaults it owns, and the NFTs it holds itself, each named with its chain and manager', async () => {
  const positions = await adapterOver(deployment()).listPositions(OWNER);
  assert.deepEqual(positions.map((p) => [p.ref.tokenId, p.holder.kind, p.active, p.tickSpacing]), [['3', 'vault', true, 60], ['7', 'wallet', false, 60]]);
  assert.deepEqual(positions[0].ref, positionRef(ELYSIUM, NFPM, '3'));
  assert.deepEqual(positions[0].holder, { kind: 'vault', vault: VAULT, owner: OWNER });
  assert.equal(positions[0].pool.id, POOL);
  assert.deepEqual(await adapterOver(deployment()).listPositions(addr(0x5555)), []);
});

test('one position: what it holds and its uncollected fees at one block, exactly as the manager would pay them', async () => {
  const chain = deployment();
  const state = await adapterOver(chain).position(positionRef(ELYSIUM, NFPM, '3'));
  // Fee growth inside: global − lower's outside − upper's outside, per token; then the manager's arithmetic.
  const inside = [50n * Q128 - 10n * Q128 - 5n * Q128, 80n * Q128 - 20n * Q128 - 6n * Q128];
  assert.deepEqual(state.fees, v3.uncollectedFees({ liquidity: 1_000n, feeGrowthInside0LastX128: 30n * Q128, feeGrowthInside1LastX128: 40n * Q128, tokensOwed0: 7n, tokensOwed1: 0n }, inside));
  assert.deepEqual(state.fees, [7n + 5_000n, 14_000n]);
  assert.deepEqual(state.amounts, v3.amountsForLiquidity(79228162514264337593543950336n, -600, 600, 1_000n));
  assert.equal(state.inRange, true);
  assert.deepEqual(state.holder, { kind: 'vault', vault: VAULT, owner: OWNER }, 'the NFT\'s owner is a vault of this deployment holding it');
  assert.deepEqual(state.at, { source: 'chain', block: 1_500_000, timestamp: 1_790_100_000 });
  const own = await adapterOver(chain).position(positionRef(ELYSIUM, NFPM, '7'));
  assert.deepEqual(own.holder, { kind: 'wallet', owner: OWNER });
  assert.equal(own.inRange, false);
  await assert.rejects(adapterOver(chain).position(positionRef(ELYSIUM, addr(0x77), '3')), /position_not_in_deployment/);
});

test('a vault position\'s history: from his read service where it answers, else from the vault\'s own events', async () => {
  const chain = deployment();
  chain.log({ address: VAULT, blockNumber: 1_100_000, topics: ['0x7d0e8724081800bb6e83f71bfba54e13232b60f41079333a15ece9c610966cb7', topicUint(3), topicUint(0)], data: '0x' });
  const fromChain = await adapterOver(chain).history(positionRef(ELYSIUM, NFPM, '3'));
  assert.deepEqual(fromChain.items.map((i) => [i.kind, i.block, i.timestamp, i.source]), [['PositionOpened', 1_100_000, null, 'chain']], 'no time is invented for a log');
  assert.equal(await adapterOver(chain).history(positionRef(ELYSIUM, NFPM, '7')), null, 'a wallet-held NFT has no vault history');
});

test('the vault a wallet owns for a pool', async () => {
  const adapter = adapterOver(deployment());
  assert.equal((await adapter.vaultFor(OWNER, poolRef(ELYSIUM, POOL))).address, VAULT);
  assert.equal(await adapter.vaultFor(OWNER, poolRef(ELYSIUM, STRAY)), null);
  assert.equal(await adapter.vaultFor(addr(0x5555), poolRef(ELYSIUM, POOL)), null);
});

// Fix round 1 (2026-10-01): a well-formed link to a pool or position this deployment does not have is said not found,
// for good, where it was read again forever behind a skeleton; each screen of the section names its tab (item E11); and
// New position's "Another pool" goes back to the picker from a pool's own New position link too.
test('a pool or position the deployment does not have is gone for good; each screen names its tab; Another pool always picks again', () => {
  const { goneError } = require('../.test-build/app/src/chains/elysium/ui/useRead.js');
  const { sectionTitle } = require('../.test-build/app/src/chains/elysium/ui/routes.js');
  for (const message of ['pool_not_in_deployment', 'position_not_in_deployment', 'invalid_pool', 'invalid_position', 'invalid_position_pool']) assert.equal(goneError(new Error(message)), true, message);
  for (const error of [new Error('rpc_unavailable'), new Error('invalid_stamp'), new Error('not_a_pool'), new Error('xpool_not_in_deployment'), 'pool_not_in_deployment', null]) assert.equal(goneError(error), false, String(error));
  assert.deepEqual(['markets', 'pool', 'positions', 'position', 'new', 'receipts'].map((screen) => sectionTitle(ELYSIUM, { screen, param: '' })), ['Markets', 'Pool', 'Positions', 'Position', 'New position', 'Receipts'].map((name) => `${name} on ${ELYSIUM.name}`));
  const src = (path) => readFileSync(new URL(`../src/chains/elysium/ui/${path}`, import.meta.url), 'utf8');
  assert.match(src('ElysiumSection.tsx'), /useRouteTitle\(mode === 'off' \|\| !source \? chain\.name : sectionTitle\(chain, route\)\)/, 'above the early returns');
  assert.ok(src('ElysiumSection.tsx').indexOf('useRouteTitle(') < src('ElysiumSection.tsx').indexOf("if (mode === 'off' || !source) return"));
  assert.match(src('PoolPage.tsx'), /if \(!reference \|\| read\.phase === 'gone'\) \{/);
  assert.match(src('PositionPage.tsx'), /if \(!reference \|\| read\.phase === 'gone'\) \{/);
  assert.match(src('NewPosition.tsx'), /setChosen\(null\)\s+if \(param\) window\.location\.hash = sectionHref\(chain, 'new'\)/);
  assert.match(src('useRead.ts'), /if \(goneError\(error\)\) \{\s+setState\(\{ key, read: \{ phase: 'gone', value: null, problem: problemOf\(error\) \} \}\)\s+return\s/, 'no retry is scheduled');
});
