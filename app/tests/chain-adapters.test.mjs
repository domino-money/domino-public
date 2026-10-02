/**
 * The Robinhood v4 ChainAdapter (src/chains/robinhood/adapter.ts, 2026-10-01, the chain2 workstream, part B, audit item
 * G7): Robinhood Chain behind the interface the second chain's screens read through, over the very reads Robinhood's own
 * screens make. These tests hold it to that: its reads are the page's own functions, handed over as they are; it maps
 * their answers field for field and adds nothing; what it does not wrap it refuses rather than answers; and, over the
 * same fake chain the page's own read is tested on, it lists exactly what Positions lists.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { OWNER, TOKEN, USDG, fakeChain, nft } from './owned-chain.mjs';

const require = createRequire(import.meta.url);
const { createRobinhoodAdapter, NotWrapped, ReadFailed } = require('../.test-build/app/src/chains/robinhood/adapter.js');
const { ROBINHOOD_READS } = require('../.test-build/app/src/chains/robinhood/reads.js');
const { ROBINHOOD, ELYSIUM } = require('../.test-build/app/src/config/chains.js');
const { poolKey, positionKey } = require('../.test-build/app/src/chains/types.js');
const walletPositions = require('../.test-build/app/src/lib/walletPositions.js');
const feesClient = require('../.test-build/app/src/lib/fees/client.js');
const scan = require('../.test-build/app/functions/_lib/walletPositions.js');

const PM = ROBINHOOD.deployment.contracts.positionManager;
const POOL_ID = `0x${'ab'.repeat(32)}`;
const owner = OWNER.toLowerCase();

/** A wallet answer as Positions' read gives it (lib/walletPositions.ts WalletAnswer). */
const row = (tokenId, extra = {}) => ({
  tokenId,
  status: 'open',
  poolId: POOL_ID,
  currencies: [{ address: USDG, symbol: 'USDG', decimals: 6 }, { address: TOKEN, symbol: 'UFG', decimals: 18 }],
  fee: 40_000,
  tickSpacing: 800,
  hooks: '0x0000000000000000000000000000000000000000',
  tickLower: -887_200,
  tickUpper: 887_200,
  liquidity: '123456789',
  sqrtPriceX96: '79228162514264337593543950336',
  tick: 0,
  unclaimedFees: ['5', '6'],
  principal: ['7', '8'],
  ...extra,
});

/** A position page's state answer (lib/fees/types.ts StateResponse) for one id. */
const stateOf = (tokenId, extra = {}) => ({
  v: 1,
  block: 71_700_000,
  timestamp: 1_790_685_600,
  positions: [{
    tokenId,
    ok: true,
    owner: OWNER,
    poolId: POOL_ID,
    poolKey: { currency0: USDG, currency1: TOKEN, fee: 40_000, tickSpacing: 800, hooks: '0x0000000000000000000000000000000000000000' },
    currencies: [{ address: USDG, symbol: 'USDG', decimals: 6 }, { address: TOKEN, symbol: 'UFG', decimals: 18 }],
    tickLower: -800,
    tickUpper: 800,
    liquidity: '1000000000000',
    sqrtPriceX96: '79228162514264337593543950336',
    tick: 0,
    feeGrowthInside0X128: '0',
    feeGrowthInside1X128: '0',
    feeGrowthInside0LastX128: '0',
    feeGrowthInside1LastX128: '0',
    unclaimed0: '11',
    unclaimed1: '22',
    ...extra,
  }],
});

/** Fake reads that record every call. */
function fakes({ wallet = { ok: true, answer: { owner, block: 71_700_000, positions: [row('7'), row('8', { status: 'closed', liquidity: '0' })], deposits: [] } }, state = (ids) => ({ ok: true, value: stateOf(ids[0]), bytes: 1 }) } = {}) {
  const calls = [];
  return {
    calls,
    reads: {
      async walletPositions(...args) {
        calls.push(['walletPositions', ...args]);
        return wallet;
      },
      async positionState(...args) {
        calls.push(['positionState', ...args]);
        return state(args[0]);
      },
      principal(...args) {
        calls.push(['principal', ...args]);
        return scan.principalAt(...args);
      },
    },
  };
}

test('its reads are the page\'s own functions, handed over as they are', () => {
  assert.equal(ROBINHOOD_READS.walletPositions, walletPositions.readWalletPositions, 'Positions\' own read of a wallet');
  assert.equal(ROBINHOOD_READS.positionState, feesClient.chainState, 'a position page\'s own state read');
  assert.equal(ROBINHOOD_READS.principal, scan.principalAt, 'the scan\'s own arithmetic for what a position holds');
  assert.ok(Object.isFrozen(ROBINHOOD_READS));
});

test('capabilities: what the registry says of Robinhood Chain, with nothing asked', async () => {
  const { reads, calls } = fakes();
  const adapter = createRobinhoodAdapter({ chain: ROBINHOOD, reads });
  const caps = await adapter.capabilities();
  assert.equal(caps.chain, ROBINHOOD);
  assert.deepEqual({ ...caps, chain: undefined, actions: { ...caps.actions }, service: { ...caps.service } }, {
    chain: undefined,
    pools: 'service',
    usd: true,
    apr: true,
    positions: 'wallet',
    history: 'chain',
    actions: { available: true, reason: null },
    service: { read: 'none', actions: 'none' },
  });
  assert.deepEqual(calls, []);
  assert.throws(() => createRobinhoodAdapter({ chain: ELYSIUM, reads }), RangeError, 'a v4 chain of the registry only');
});

test('a wallet\'s positions: Positions\' own read, each row as a PositionSummary, field for field, and nothing added', async () => {
  const { reads, calls } = fakes();
  const adapter = createRobinhoodAdapter({ chain: ROBINHOOD, reads });
  const signal = new AbortController().signal;
  const list = await adapter.listPositions(OWNER, signal);
  assert.deepEqual(calls, [['walletPositions', OWNER, signal]], 'asked once, with the owner and the signal as given');
  assert.deepEqual(list.map((one) => positionKey(one.ref)), [`4663:${PM}:7`, `4663:${PM}:8`]);
  assert.deepEqual(list[0], {
    ref: { chainId: 4663, positionManager: PM, tokenId: '7' },
    pool: { chainId: 4663, protocol: 'uniswap-v4', id: POOL_ID },
    holder: { kind: 'wallet', owner },
    token0: { address: USDG, symbol: 'USDG', decimals: 6 },
    token1: { address: TOKEN, symbol: 'UFG', decimals: 18 },
    fee: 40_000,
    tickSpacing: 800,
    tickLower: -887_200,
    tickUpper: 887_200,
    liquidity: 123456789n,
    active: true,
  });
  assert.equal(list[1].active, false, 'a closed row is inactive');
  assert.equal(poolKey(list[0].pool), `4663:uniswap-v4:${POOL_ID}`);
  // A failed read is the read's own reason, never an empty list.
  const failed = createRobinhoodAdapter({ chain: ROBINHOOD, reads: fakes({ wallet: { ok: false, reason: 'chain_busy', retryAt: 123 } }).reads });
  await assert.rejects(failed.listPositions(OWNER), (error) => error instanceof ReadFailed && error.reason === 'chain_busy' && error.retryAt === 123);
});

test('one position: a position page\'s own state read, with what it holds from the scan\'s own arithmetic', async () => {
  const { reads, calls } = fakes();
  const adapter = createRobinhoodAdapter({ chain: ROBINHOOD, reads });
  const ref = { chainId: 4663, positionManager: PM, tokenId: '3325113' };
  const state = await adapter.position(ref);
  assert.deepEqual(calls.map(([name]) => name), ['positionState', 'principal']);
  assert.deepEqual(calls[0].slice(1, 2), [['3325113']]);
  assert.deepEqual(calls[1].slice(1), [79228162514264337593543950336n, 0, -800, 800, 1000000000000n], 'principalAt over the read\'s own figures');
  assert.deepEqual(state.amounts, scan.principalAt(79228162514264337593543950336n, 0, -800, 800, 1000000000000n));
  assert.deepEqual(state.fees, [11n, 22n], 'the uncollected fees exactly as the read computed them');
  assert.deepEqual([state.tick, state.sqrtPriceX96, state.inRange, state.liquidity, state.active], [0, 79228162514264337593543950336n, true, 1000000000000n, true]);
  assert.deepEqual(state.at, { source: 'chain', block: 71_700_000, timestamp: 1_790_685_600 });
  assert.deepEqual([state.fee, state.tickSpacing, state.holder], [40_000, 800, { kind: 'wallet', owner }]);
  // Out of range at either end, as v4 counts it: below tickLower, or at tickUpper and above.
  for (const [tick, inRange] of [[-801, false], [-800, true], [799, true], [800, false]]) {
    const one = createRobinhoodAdapter({ chain: ROBINHOOD, reads: fakes({ state: (ids) => ({ ok: true, value: stateOf(ids[0], { tick }), bytes: 1 }) }).reads });
    assert.equal((await one.position(ref)).inRange, inRange, String(tick));
  }
  // Not this chain's, or a failed read: refused with the read's own reason.
  await assert.rejects(adapter.position({ ...ref, chainId: ELYSIUM.id }), RangeError);
  await assert.rejects(adapter.position({ ...ref, positionManager: '0x1111111111111111111111111111111111111111' }), RangeError);
  for (const [answer, reason] of [
    [{ ok: false, failure: 'rate_limited', retryAfterMs: 0 }, 'rate_limited'],
    [{ ok: true, value: { v: 1, block: 1, timestamp: 1, positions: [{ tokenId: '3325113', ok: false, reason: 'not_found' }] }, bytes: 1 }, 'not_found'],
    [{ ok: true, value: { v: 1, block: 1, timestamp: 1, positions: [] }, bytes: 1 }, 'not_found'],
  ]) {
    const one = createRobinhoodAdapter({ chain: ROBINHOOD, reads: fakes({ state: () => answer }).reads });
    await assert.rejects(one.position(ref), (error) => error instanceof ReadFailed && error.reason === reason, reason);
  }
});

test('what it does not wrap it refuses, rather than answer from anything else', async () => {
  const { reads, calls } = fakes();
  const adapter = createRobinhoodAdapter({ chain: ROBINHOOD, reads });
  const pool = { chainId: 4663, protocol: 'uniswap-v4', id: POOL_ID };
  for (const [name, run] of [['pools', () => adapter.listPools()], ['pool', () => adapter.poolState(pool)], ['activity', () => adapter.poolActivity(pool, 24)], ['history', () => adapter.history({ chainId: 4663, positionManager: PM, tokenId: '7' })]]) {
    await assert.rejects(run(), (error) => error instanceof NotWrapped && error.read === name, name);
  }
  assert.deepEqual(calls, [], 'and nothing is read for them');
});

// The same fake chain and runtime the page's own read is tested on (tests/wallet-positions.test.mjs): through the
// adapter, the very list Positions gets.
// Changed on purpose (RPC-SPEC, 2026-10-01): the page's own read asks the site's route (POST /api/owned/v2/positions),
// answered here by tests/support/edge-routes.mjs over the same fake chain, where it read the public RPC itself.
test('over the page\'s own read and a fake chain, the adapter lists exactly what Positions lists', async () => {
  const { edgeFetch } = await import('./support/edge-routes.mjs');
  const setup = { minted: [{ block: 69_300_000, id: 7 }, { block: 69_400_000, id: 8 }], nfts: { 7: nft(), 8: nft({ liquidity: 0n }) } };
  const run = async (read) => {
    const chain = fakeChain(setup);
    const original = globalThis.fetch;
    walletPositions.forgetMinted();
    globalThis.fetch = edgeFetch(chain.deps);
    try {
      return await read();
    } finally {
      globalThis.fetch = original;
    }
  };
  const direct = await run(() => walletPositions.readWalletPositions(OWNER, new AbortController().signal));
  assert.equal(direct.ok, true);
  const adapter = createRobinhoodAdapter({ chain: ROBINHOOD, reads: ROBINHOOD_READS });
  const listed = await run(() => adapter.listPositions(OWNER, new AbortController().signal));
  assert.deepEqual(listed.map((one) => [one.ref.tokenId, one.active, one.liquidity, one.tickLower, one.tickUpper, one.pool.id, one.token0.address, one.token1.address]),
    direct.answer.positions.map((one) => [one.tokenId, one.status === 'open', BigInt(one.liquidity), one.tickLower, one.tickUpper, one.poolId, one.currencies[0].address, one.currencies[1].address]));
  assert.equal(listed.length, 2);
});
