/**
 * A small live smoke test of the browser path to Elysium Testnet (2026-10-01, the chain2 workstream). Run on demand,
 * after `node scripts/test.mjs --build-only`: `node tests/elysium-live.mjs`. Not in any test list: it reaches the
 * network. It sends a dozen paced reads to the chain's public RPC, through the same client and chain code the page
 * uses, with Node's fetch standing in for the page's transport:
 *
 * 1. CORS: the RPC's answer to a browser's preflight for a JSON POST from this site's origin.
 * 2. The chain id and the head, through the client (its chain check first).
 * 3. One Multicall3 aggregate3 (the block, its time, a pool's state) through the chain code.
 * 4. The rehearsal's pools and a position, as the section reads them, and the position's uncollected fees checked against
 *    the position manager's own collect() simulated at the same block from the NFT's owner (an eth_call: nothing is
 *    sent, nothing is signed).
 *
 * It prints what it read, with the block, and exits 1 on any mismatch.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ELYSIUM } = require('../.test-build/app/src/config/chains.js');
const { createChainClient, pauseFor } = require('../.test-build/app/src/lib/chain/client.js');
const reads = require('../.test-build/app/functions/_lib/uniswap-v3/reads.js');
const abi = require('../.test-build/app/functions/_lib/uniswap-v3/abi.js');
const { ELYSIUM_REHEARSAL } = require('../.test-build/app/src/chains/elysium/rehearsal.js');
const { createElysiumAdapter } = require('../.test-build/app/src/chains/elysium/adapter.js');
const { sectionSource } = require('../.test-build/app/src/chains/elysium/flag.js');
const { positionRef } = require('../.test-build/app/src/chains/types.js');
const present = require('../.test-build/app/src/chains/elysium/present.js');

const URL_ = ELYSIUM.rpc.primary.url;
let calls = 0;
const runtime = {
  send: (url, init) => {
    if (url !== URL_) throw new Error(`not the chain RPC: ${url}`);
    calls += 1;
    return fetch(url, init);
  },
  now: () => Date.now(),
  pause: pauseFor,
};
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

// 1. CORS, as a browser's preflight from this site asks it.
const preflight = await fetch(URL_, { method: 'OPTIONS', headers: { Origin: 'https://domino.money', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
const allowOrigin = preflight.headers.get('access-control-allow-origin');
const allowHeaders = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase();
check(preflight.ok && (allowOrigin === '*' || allowOrigin === 'https://domino.money') && allowHeaders.includes('content-type'), `CORS preflight: ${preflight.status}, allow-origin ${allowOrigin}, allow-headers ${allowHeaders}`);

// 2. The chain id (the client's own check) and the head.
const client = createChainClient(ELYSIUM, runtime);
const head = await client.head();
check(client.state().trusted, `eth_chainId is ${ELYSIUM.id} (the client trusts the endpoint)`);
check(head.number > 1_500_000, `head block ${head.number} at ${new Date(head.timestamp * 1000).toISOString()}`);

// 3. One Multicall3 aggregate3: a pool's slot0 and liquidity with the block and its time.
const pool = ELYSIUM_REHEARSAL.pools[0].address;
const { results, stamp } = await reads.stamped(client, ELYSIUM, [{ target: pool, data: abi.V3_SELECTOR.slot0 }, { target: pool, data: abi.V3_SELECTOR.liquidity }], 'latest');
const slot0 = abi.decodeSlot0(results[0].data);
check(results.every((r) => r.success) && stamp.block >= head.number - 50, `Multicall3 aggregate3 at block ${stamp.block}: pool ${pool} tick ${slot0.tick}, liquidity ${abi.decodeUint(results[1].data, 128)}`);

// 4. The section's own reads: the rehearsal's pools, then a position and its fees against collect().
const adapter = createElysiumAdapter({ chain: ELYSIUM, mode: 'preview', source: sectionSource('preview', ELYSIUM), reader: client, api: null, signer: false });
const pools = await adapter.listPools();
check(pools.length >= 2, `pools from the factory's PoolCreated logs: ${pools.map((p) => `${present.tokenLabel(p.token0)}/${present.tokenLabel(p.token1)} ${present.feeTierText(p.fee)} (${p.ref.id})`).join(', ')}`);
for (const p of pools) {
  const line = present.priceLine(ELYSIUM, p);
  console.log(`     1 ${present.tokenLabel(line.base)} = ${line.text} ${present.tokenLabel(line.quote)}; holds ${present.amountText(p.balances[0] ?? 0n, p.token0.decimals)} ${present.tokenLabel(p.token0)} + ${present.amountText(p.balances[1] ?? 0n, p.token1.decimals)} ${present.tokenLabel(p.token1)}; block ${p.at.block}`);
}

/** NonfungiblePositionManager.collect((tokenId, recipient, amount0Max, amount1Max)), simulated from the owner. */
async function simulatedCollect(tokenId, owner, block) {
  const max = (1n << 128n) - 1n;
  const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
  const data = `0xfc6f7865${word(tokenId)}${owner.slice(2).padStart(64, '0')}${word(max)}${word(max)}`;
  const result = await client.call('eth_call', [{ from: owner, to: ELYSIUM_REHEARSAL.positionManager, data }, `0x${block.toString(16)}`]);
  return [BigInt(`0x${result.slice(2, 66)}`), BigInt(`0x${result.slice(66, 130)}`)];
}

let compared = 0;
for (const tokenId of [1n, 2n, 3n]) {
  const ref = positionRef(ELYSIUM, ELYSIUM_REHEARSAL.positionManager, tokenId.toString());
  let state;
  try {
    state = await adapter.position(ref);
  } catch (error) {
    console.log(`     position #${tokenId}: ${error.message}`);
    continue;
  }
  const owner = state.holder.kind === 'vault' ? state.holder.vault : state.holder.owner;
  const collect = await simulatedCollect(tokenId, owner, state.at.block);
  const same = collect[0] === state.fees[0] && collect[1] === state.fees[1];
  check(same, `position #${tokenId} (${state.holder.kind} ${owner}): fees by the app's math ${state.fees.join(' / ')}, by collect() at block ${state.at.block} ${collect.join(' / ')}; holds ${state.amounts.join(' / ')}, in range ${state.inRange}`);
  compared += 1;
}
check(compared > 0, `${compared} position(s) compared with collect()`);
console.log(`\n${calls} requests to ${URL_}; ${failures.length ? `${failures.length} FAILED` : 'all ok'}`);
process.exit(failures.length ? 1 : 0);
