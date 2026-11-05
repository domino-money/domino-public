// The day-1 chain qualification (qualify-chain.mjs), offline. A fake chain answers every read the tool makes: synthetic
// contracts whose immutables sit in PUSH32 operands as a compiler puts them, the canonical CreateX and SafeL2 1.4.1
// runtimes from deploy-fixtures, and Arachnid's runtime from its presigned transaction. The reference profiles are two
// synthetic chains, except where a test says it reads the committed ones. No test reaches a network: the transport and
// command-line tests serve the fake chain on a loopback port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot, viem, readJson, CREATE_X, CREATE_X_CODE_HASH, SAFE_SINGLETONS, SAFE_PROXY_RUNTIME_HASHES, ENABLED_CHAINS } from './deploy.mjs';
import { ARB_SYS, NODE_INTERFACE, PERMIT2, MULTICALL3, ARACHNID_PROXY, SAFE_SINGLETON_FACTORY, SAFE_FACTORY_DEPLOYER, KEYLESS,
  SAFE_PROXY_FACTORIES, SAFE_SINGLETON_ROUTES, V3_POOL_INIT_CODE_HASH, CANCUN_PROBE, OPCODE_PROBES, READ_METHODS, RpcError, checkedUrl,
  rpcUrlFrom, jsonRpc, readOnly, substituteImmutables, sameBuild, permit2Domain, defaultReferences, loadProfiles, checkUniswapInput,
  qualifyChain, cli } from './qualify-chain.mjs';

const ZERO = '0x' + '0'.repeat(40);
const NOW = 1_800_000_000, CHAIN = 777001;
const word = v => (typeof v === 'bigint' ? v.toString(16) : v.slice(2).toLowerCase()).padStart(64, '0');
const hex = n => '0x' + BigInt(n).toString(16);
const label = name => '0x' + viem.keccak256(viem.toHex('qualify-test.' + name)).slice(26);
/** A runtime whose immutables are PUSH32 operands (each followed by POP), then STOP and a name. */
const synthetic = (name, immutables = []) => '0x6080' + immutables.map(v => '7f' + word(v) + '50').join('') + '00' + Buffer.from(name).toString('hex');
const ret = (types, values) => viem.encodeAbiParameters(types.map(type => ({ type })), values);
const args = (types, data) => viem.decodeAbiParameters(types.map(type => ({ type })), '0x' + data.slice(10));
const isqrt = n => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
const FORTY_TWO = '0x' + word(42n);
const CREATEX_RUNTIME = readJson(join(repoRoot, 'scripts/v2/deploy-fixtures/createx-runtime.json')).runtime;
const SAFE = readJson(join(repoRoot, 'scripts/v2/deploy-fixtures/safe-runtime.json'));
const ARACHNID_INIT = viem.parseTransaction(KEYLESS.arachnid.rawTransaction).data;
const ARACHNID_RUNTIME = '0x' + ARACHNID_INIT.slice(2 + 2 * 14, 2 + 2 * (14 + 69));
const SAFE_FACTORY = '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67';
const FACTORY_CODE = synthetic('safeProxyFactory 1.4.1');
const PROXY_CREATION = '0x' + 'ab'.repeat(40);
const PENDING = loadProfiles().pending.elysium;

/** One chain's contracts: per-chain immutables as the real ones carry them. */
function contracts(name, chainId) {
  const a = key => label(name + '.' + key);
  const c = { v3Factory: a('v3Factory'), v3PositionManager: a('npm'), quoterV2: a('quoterV2'), swapRouter02: a('router'), poolManager: a('poolManager'),
    v4PositionManager: a('v4pm'), stateView: a('stateView'), v4Quoter: a('v4Quoter'), universalRouter: a('ur'), wrapped: a('wrapped'), stable: a('stable') };
  c.code = {
    [c.v3Factory]: synthetic('v3Factory', [c.v3Factory]), [c.v3PositionManager]: synthetic('npm', [c.v3Factory, c.wrapped, a('descriptor')]),
    [c.quoterV2]: synthetic('quoterV2', [c.v3Factory, c.wrapped]), [c.swapRouter02]: synthetic('router', [c.v3Factory, c.wrapped, c.v3PositionManager]),
    [c.poolManager]: synthetic('poolManager', [c.poolManager]), [c.v4PositionManager]: synthetic('v4pm', [c.poolManager, PERMIT2, c.wrapped]),
    [c.stateView]: synthetic('stateView', [c.poolManager]), [c.v4Quoter]: synthetic('v4Quoter', [c.poolManager]),
    [c.universalRouter]: synthetic('ur', [c.poolManager, PERMIT2]), [PERMIT2]: synthetic('permit2', [BigInt(chainId), permit2Domain(chainId)]),
    [MULTICALL3]: synthetic('multicall3'), [CREATE_X]: CREATEX_RUNTIME, [ARACHNID_PROXY]: ARACHNID_RUNTIME, [SAFE_SINGLETON_FACTORY]: ARACHNID_RUNTIME,
    [c.wrapped]: synthetic('wrapped', [c.wrapped]), [c.stable]: synthetic('stable', [c.stable]), [ARB_SYS]: '0xfe' };
  return c;
}
/** An enabled profile as profileReferences reads one: addresses and the code hash of each contract. */
function profile(slug, chainId) {
  const c = contracts(slug, chainId);
  return { slug, chainId, enabled: true, permit2: viem.getAddress(PERMIT2), multicall3: viem.getAddress(MULTICALL3), deployer: { address: viem.getAddress(CREATE_X) },
    wrappedNative: { address: viem.getAddress(c.wrapped) },
    uniswap: { v3: { factory: c.v3Factory, positionManager: c.v3PositionManager, quoterV2: c.quoterV2, swapRouter02: c.swapRouter02 },
      v4: { poolManager: c.poolManager, positionManager: c.v4PositionManager, stateView: c.stateView, quoter: c.v4Quoter }, universalRouter: { address: c.universalRouter } },
    verification: { contracts: Object.entries(c.code).map(([address, code]) => ({ name: address, address: viem.getAddress(address), codehash: viem.keccak256(code) })) } };
}
const PROFILES = [profile('alpha', 1001), profile('beta', 1002)];
/** The synthetic profiles, and safe-deployments' 1.4.1 factory hash replaced by the synthetic factory's. */
function references(overrides = {}) {
  const base = defaultReferences(PROFILES);
  return { ...base, safeProxyFactories: { ...base.safeProxyFactories, [SAFE_FACTORY]: { ...base.safeProxyFactories[SAFE_FACTORY], codehash: viem.keccak256(FACTORY_CODE) } },
    ...overrides };
}

/** The fake chain. Options: chainId, nitro, cancun (true or the missing opcode), override (state overrides served),
 * simulate (true, 'unsupported', 'down'), finalized, baseFee, timestamp, l1PerByte, tiers, liquidity, noPool, poolAddress,
 * npmFactory, v4pmPool, nonces, code (an address to a runtime, or null for none), reorg. */
function chain(options = {}) {
  const c = contracts('candidate', options.chainId ?? CHAIN);
  const o = { chainId: CHAIN, head: 5_000_000n, timestamp: BigInt(NOW - 2), baseFee: 100_000_000n, l1PerByte: 10n, cancun: true, override: true,
    simulate: true, finalized: true, nitro: true, liquidity: 10n ** 18n, ...options };
  const code = { ...c.code, [SAFE.singleton.address.toLowerCase()]: SAFE.singleton.runtime, [SAFE_FACTORY]: FACTORY_CODE };
  if (!o.nitro) delete code[ARB_SYS];
  const [t0, t1] = BigInt(c.wrapped) < BigInt(c.stable) ? [c.wrapped, c.stable] : [c.stable, c.wrapped];
  const pool = (o.poolAddress ?? viem.getCreate2Address({ from: c.v3Factory, bytecodeHash: V3_POOL_INIT_CODE_HASH,
    salt: viem.keccak256(ret(['address', 'address', 'uint24'], [t0, t1, 500])) })).toLowerCase();
  if (!o.noPool) code[pool] = synthetic('pool', [c.v3Factory, t0, t1]);
  for (const [address, value] of Object.entries(o.code ?? {})) { if (value === null) delete code[address]; else code[address] = value; }
  // Each keyless contract present was sent by its presigned transaction (nonce 1), unless a test says otherwise.
  const nonces = { ...Object.fromEntries([...Object.values(KEYLESS).map(k => [k.deployer, k.contract]), [SAFE_FACTORY_DEPLOYER, SAFE_SINGLETON_FACTORY]]
    .map(([sender, contract]) => [sender, code[contract] ? 1n : 0n])), ...o.nonces };
  // 40 USDC per WHYPE: wrapped 18 decimals, stable 6.
  const sqrtPrice = t0 === c.wrapped ? isqrt(40n * 10n ** 6n * 2n ** 192n / 10n ** 18n) : isqrt(10n ** 18n * 2n ** 192n / (40n * 10n ** 6n));
  const v4Id = viem.keccak256(ret(['address', 'address', 'uint24', 'int24', 'address'], [ZERO, c.stable, 500, 10, ZERO]));
  const handlers = {};
  const on = (address, signature, answer) => { handlers[address + viem.toFunctionSelector(signature).slice(2)] = typeof answer === 'function' ? answer : () => answer; };
  const address = value => ret(['address'], [value]);
  if (o.nitro) on(ARB_SYS, 'arbOSVersion()', ret(['uint256'], [106n]));
  if (o.nitro) on(NODE_INTERFACE, 'gasEstimateL1Component(address,bool,bytes)', data => {
    const [, , payload] = args(['address', 'bool', 'bytes'], data);
    return ret(['uint64', 'uint256', 'uint256'], [BigInt((payload.length - 2) / 2) * o.l1PerByte, o.baseFee ?? 0n, 50_000_000n]);
  });
  on(PERMIT2, 'DOMAIN_SEPARATOR()', o.domain ?? permit2Domain(o.chainId));
  on(SAFE_FACTORY, 'proxyCreationCode()', ret(['bytes'], [PROXY_CREATION]));
  const tiers = o.tiers ?? { 100: 1, 500: 10, 3000: 60, 10000: 200 };
  on(c.v3Factory, 'feeAmountTickSpacing(uint24)', data => ret(['int24'], [tiers[Number(args(['uint24'], data)[0])] ?? 0]));
  on(c.v3Factory, 'getPool(address,address,uint24)', data => {
    const [x, y, fee] = args(['address', 'address', 'uint24'], data);
    const pair = new Set([x.toLowerCase(), y.toLowerCase()]);
    return address(!o.noPool && fee === 500 && pair.has(c.wrapped) && pair.has(c.stable) ? pool : ZERO);
  });
  on(c.v3PositionManager, 'factory()', address(o.npmFactory ?? c.v3Factory)); on(c.v3PositionManager, 'WETH9()', address(c.wrapped));
  on(c.quoterV2, 'factory()', address(c.v3Factory)); on(c.quoterV2, 'WETH9()', address(c.wrapped));
  on(c.swapRouter02, 'factory()', address(c.v3Factory)); on(c.swapRouter02, 'WETH9()', address(c.wrapped)); on(c.swapRouter02, 'positionManager()', address(c.v3PositionManager));
  on(c.v4PositionManager, 'poolManager()', address(o.v4pmPool ?? c.poolManager)); on(c.v4PositionManager, 'permit2()', address(PERMIT2));
  on(c.v4PositionManager, 'WETH9()', address(c.wrapped));
  on(c.stateView, 'poolManager()', address(c.poolManager)); on(c.v4Quoter, 'poolManager()', address(c.poolManager)); on(c.universalRouter, 'poolManager()', address(c.poolManager));
  on(c.stateView, 'getSlot0(bytes32)', data => ret(['uint160', 'int24', 'uint24', 'uint24'], args(['bytes32'], data)[0] === v4Id ? [sqrtPrice, -200000, 0, 500] : [0n, 0, 0, 0]));
  on(c.stateView, 'getLiquidity(bytes32)', ret(['uint128'], [7n]));
  on(c.wrapped, 'symbol()', ret(['string'], ['WHYPE'])); on(c.wrapped, 'decimals()', ret(['uint8'], [o.wrappedDecimals ?? 18]));
  on(c.stable, 'symbol()', ret(['string'], ['USDC'])); on(c.stable, 'decimals()', ret(['uint8'], [6]));
  on(pool, 'liquidity()', ret(['uint128'], [o.liquidity])); on(pool, 'slot0()', ret(['uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool'], [sqrtPrice, -200000, 0, 300, 300, 0, true]));
  const invalid = name => new RpcError('error', 'eth_call', { code: -32000, detail: 'invalid opcode: opcode 0x5e not defined (' + name + ')' });
  const run = data => {
    if (data === CANCUN_PROBE) { if (o.cancun === true) return FORTY_TWO; throw invalid(o.cancun); }
    const probe = Object.entries(OPCODE_PROBES).find(([, p]) => p.code === data);
    if (probe) { if (probe[0] === o.cancun) throw invalid(o.cancun); return probe[1].returns; }
    if (data.startsWith(PROXY_CREATION)) return SAFE.proxy.runtime;
    throw new RpcError('error', 'eth_call', { code: -32000, detail: 'unexpected creation' });
  };
  const block = n => ({ number: hex(n), hash: viem.keccak256(viem.toHex(`block ${n}`)), timestamp: hex(o.timestamp - (o.head - n) / 4n),
    ...(o.baseFee === null ? {} : { baseFeePerGas: hex(o.baseFee) }) });
  let headReads = 0;
  const log = [];
  const rpc = async (method, params = []) => {
    log.push(method);
    if (method === 'eth_chainId') return hex(o.chainId);
    if (method === 'web3_clientVersion') return o.client ?? 'nitro/v3.9.0-fake';
    if (method === 'eth_getBlockByNumber') {
      const [tag] = params;
      if (tag === 'latest') return block(o.head);
      if (tag === 'safe') return block(o.head - 400n);
      if (tag === 'finalized') return o.finalized ? block(o.head - 3600n) : null;
      const n = BigInt(tag);
      if (n === o.head && o.reorg && ++headReads > 0) return { ...block(n), hash: viem.keccak256(viem.toHex('reorged')) };
      return block(n);
    }
    if (method === 'eth_getCode') return code[params[0]] ?? '0x';
    if (method === 'eth_getTransactionCount') return hex(nonces[params[0]] ?? 0n);
    if (method === 'eth_getBalance') return hex(o.balances?.[params[0]] ?? 0n);
    if (method === 'eth_getStorageAt') return params[0] === c.stable && params[1] === '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
      ? '0x' + word(label('stable implementation')) : '0x' + '0'.repeat(64);
    if (method === 'eth_call') {
      const [tx, , overrides] = params;
      if (!tx.to) return run(tx.data);
      if (overrides?.[tx.to]) {
        if (!o.override) throw new RpcError('error', 'eth_call', { code: -32602, detail: 'invalid argument 2: state override not supported' });
        return run(overrides[tx.to].code);
      }
      const handler = handlers[tx.to + tx.data.slice(2, 10)];
      if (handler) return handler(tx.data);
      if ((code[tx.to] ?? '0x') === '0x') return '0x';
      throw new RpcError('error', 'eth_call', { code: 3, detail: 'execution reverted' });
    }
    if (method === 'eth_simulateV1') {
      if (o.simulate === 'unsupported') throw new RpcError('error', method, { code: -32601, detail: 'the method eth_simulateV1 does not exist/is not available' });
      if (o.simulate === 'down') throw new RpcError('transport', method, { detail: 'http 502' });
      const [request] = params, calls = request.blockStateCalls[0], time = BigInt(calls.blockOverrides.time);
      if (!calls.stateOverrides) return [{ calls: [{ status: '0x1', logs: [], returnData: '0x' }] }];
      // A simulator that runs each call on the block's own state, so nothing carries from call to call.
      if (o.simulate === 'stateless') return [{ calls: [{ status: '0x1', logs: [{ topics: [], data: '0x' }], returnData: '0x' }, { status: '0x1', logs: [], returnData: '0x' + word(0n) }] }];
      return [{ calls: [{ status: '0x1', logs: [{ topics: [], data: '0x' }], returnData: '0x' }, { status: '0x1', logs: [], returnData: '0x' + word(time) }] }];
    }
    throw new RpcError('error', method, { code: -32601, detail: `the method ${method} does not exist/is not available` });
  };
  rpc.log = log;
  return { rpc, c, pool };
}
const uniswapOf = c => ({ v3: { factory: c.v3Factory, positionManager: c.v3PositionManager, quoterV2: c.quoterV2, swapRouter02: c.swapRouter02 },
  v4: { poolManager: c.poolManager, positionManager: c.v4PositionManager, stateView: c.stateView, quoter: c.v4Quoter },
  universalRouter: { address: c.universalRouter, version: '2.1.2' }, sources: ['https://docs.example.invalid/uniswap-deployments'] });

async function qualify(options = {}, { uniswap, stable, wrappedNative = null, maximumCalls = 200, expectChainId = null, referenceOverrides } = {}) {
  const fake = chain(options), rpc = readOnly(fake.rpc, { maximumCalls });
  const { report, draft } = await qualifyChain({ rpc, now: NOW, expectChainId, pending: PENDING, uniswap: uniswap === undefined ? uniswapOf(fake.c) : uniswap,
    stable: stable === undefined ? fake.c.stable : stable, wrappedNative, references: references(referenceOverrides), apiSchemas: [], tool: { commit: 'f'.repeat(40) } });
  const check = id => report.checks.find(entry => entry.id === id) ?? assert.fail('no check ' + id);
  return { report, draft, fake, check, status: Object.fromEntries(report.checks.map(entry => [entry.id, entry.status])) };
}
const keyTree = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, keyTree(value[k])])) : null;

test('the presigned deployments are what the tool says: senders, addresses, runtime and gas', async () => {
  const tx = viem.parseTransaction(KEYLESS.arachnid.rawTransaction);
  assert.equal(tx.type, 'legacy'); assert.equal(tx.chainId, undefined); assert.equal(tx.nonce, 0); assert.equal(tx.to, undefined);
  assert.equal(tx.gas, KEYLESS.arachnid.gasLimits[0]); assert.equal(tx.gasPrice, KEYLESS.arachnid.gasPrice);
  const sender = (await viem.recoverTransactionAddress({ serializedTransaction: KEYLESS.arachnid.rawTransaction })).toLowerCase();
  assert.equal(sender, KEYLESS.arachnid.deployer);
  assert.equal(KEYLESS.arachnid.initCodeBytes, (tx.data.length - 2) / 2);
  // Every committed profile recorded the runtime its init code returns (CODECOPY of 0x45 bytes from offset 0x0e).
  assert.ok(tx.data.startsWith('0x604580600e600039806000f3'));
  for (const reference of defaultReferences().profiles) assert.equal(reference.arachnid.codehash, viem.keccak256(ARACHNID_RUNTIME), reference.slug);
  // 68,137 gas: intrinsic (21,000 + 32,000 creation + calldata + EIP-3860 words), the init code (PUSH1 ×3, DUP1 ×2, CODECOPY
  // 3 + 9 copy + 9 memory) and 200 per deposited byte.
  const data = Buffer.from(tx.data.slice(2), 'hex'), zeros = data.filter(b => b === 0).length;
  const intrinsic = 21_000 + 32_000 + 4 * zeros + 16 * (data.length - zeros) + 2 * Math.ceil(data.length / 32);
  assert.equal(BigInt(intrinsic + 3 * 3 + 2 * 3 + 21 + 3 + 200 * 69), KEYLESS.arachnid.executionGas);
  // Each keyless contract is its sender's nonce-0 CREATE address; so is the Safe Singleton Factory.
  for (const k of Object.values(KEYLESS)) assert.equal(viem.getContractAddress({ from: k.deployer, nonce: 0n }).toLowerCase(), k.contract, k.name);
  assert.equal(KEYLESS.createx.contract, CREATE_X);
  assert.equal(viem.getContractAddress({ from: SAFE_FACTORY_DEPLOYER, nonce: 0n }).toLowerCase(), SAFE_SINGLETON_FACTORY);
  // The upper-bound payloads cover the runtimes they stand for (CreateX's fixture; Multicall3's 3,808 bytes).
  assert.ok(KEYLESS.createx.initCodeBytes > (CREATEX_RUNTIME.length - 2) / 2);
  assert.ok(KEYLESS.multicall3.initCodeBytes > 3808);
});

test('the Safe references agree with deploy.mjs and the repository fixture', () => {
  assert.deepEqual(Object.keys(SAFE_SINGLETON_ROUTES).sort(), Object.keys(SAFE_SINGLETONS).sort());
  for (const [address, route] of Object.entries(SAFE_SINGLETON_ROUTES)) {
    assert.equal(route === 'arachnid', SAFE_SINGLETONS[address].version === '1.3.0' && ['0xd9db270c1b5e3bd161e8c8503c55ceabee709552',
      '0x3e5c63644e683549055b9be8653de26e0b4cd36e'].includes(address));
  }
  assert.deepEqual([...new Set(Object.values(SAFE_PROXY_FACTORIES).map(f => f.version))].sort(), [...new Set(Object.values(SAFE_PROXY_RUNTIME_HASHES))].sort());
  for (const [address, factory] of Object.entries(SAFE_PROXY_FACTORIES)) {
    assert.ok(viem.isAddress(address) && address === address.toLowerCase() && /^0x[0-9a-f]{64}$/.test(factory.codehash), address);
  }
  // The fixture's SafeL2 1.4.1 proxy came from this factory, and its runtime is deploy.mjs's 1.4.1 proxy hash.
  assert.equal(SAFE_PROXY_FACTORIES[SAFE.proxy.factory.toLowerCase()].version, SAFE.proxy.factoryVersion);
  assert.equal(SAFE_PROXY_RUNTIME_HASHES[viem.keccak256(SAFE.proxy.runtime)], '1.4.1');
  assert.ok(READ_METHODS.every(method => /^(eth_(chainId|getBlockByNumber|getCode|getStorageAt|call|getBalance|getTransactionCount|simulateV1)|web3_clientVersion)$/.test(method)));
});

test('the committed profiles: one code hash for identical contracts, one per chain where immutables differ', () => {
  const { profiles, createxCodeHash } = defaultReferences();
  assert.deepEqual(profiles.map(p => p.slug), ['arbitrum', 'base', 'robinhood']);
  const hashes = key => new Set(profiles.map(p => p[key]?.codehash).filter(Boolean));
  assert.equal(createxCodeHash, CREATE_X_CODE_HASH);
  assert.deepEqual([...hashes('createx')], [CREATE_X_CODE_HASH]);
  assert.equal(hashes('multicall3').size, 1);
  assert.equal(hashes('arachnid').size, 1);
  assert.equal(hashes('permit2').size, 3);
  assert.equal(hashes('poolManager').size, 3);
  assert.deepEqual(profiles.filter(p => p.arbSys?.codehash).map(p => p.slug), ['arbitrum', 'robinhood']);
  assert.equal(profiles.find(p => p.slug === 'robinhood').arbSys.codehash, viem.keccak256('0xfe'));
});

test('immutables are replaced at PUSH32 instructions only, and a build matches the profile that recorded it', () => {
  // x's bytes are no PUSH opcode, so its word runs as single-byte instructions.
  const x = '0x' + '11'.repeat(20), y = '0x' + '22'.repeat(20);
  // A PUSH32 whose data ends in 0x7f, then x's word: a byte search would find "7f" + x there, the instruction walk only
  // at the real PUSH32 that follows.
  const hidden = '0x7f' + '00'.repeat(31) + '7f' + word(x) + '7f' + word(x) + '00';
  const { code, counts } = substituteImmutables(hidden, [[x, y]]);
  assert.deepEqual(counts, [1]);
  assert.equal(code, '0x7f' + '00'.repeat(31) + '7f' + word(x) + '7f' + word(y) + '00');
  const mine = synthetic('pm', [x]), theirs = synthetic('pm', [y]);
  assert.deepEqual(sameBuild(mine, [x], [{ slug: 'a', values: [y], codehash: viem.keccak256(theirs) }]).matches, ['a']);
  assert.deepEqual(sameBuild(mine, [x], [{ slug: 'a', values: [y], codehash: viem.keccak256(synthetic('other', [y])) }]).matches, []);
  assert.equal(sameBuild(mine, [label('absent')], [{ slug: 'a', values: [y], codehash: viem.keccak256(theirs) }]).comparable, false);
  assert.equal(sameBuild(mine, [x, x], [{ slug: 'a', values: [y, y], codehash: viem.keccak256(theirs) }]).reason, 'two immutables share a value');
  assert.equal(sameBuild(mine, [null], [{ slug: 'a', values: [y], codehash: viem.keccak256(theirs) }]).comparable, false);
});

test('a complete chain qualifies, and deploy.mjs\'s own dependency check accepts the draft', async () => {
  const { report, draft, fake, check, status } = await qualify();
  const c = fake.c;
  for (const [id, value] of Object.entries(status)) assert.equal(value, 'pass', `${id}: ${check(id).summary}`);
  assert.deepEqual(Object.keys(status), ['chain.id', 'chain.head', 'chain.blockTime', 'chain.finalized', 'chain.arbOS', 'chain.l1Component', 'chain.baseFee',
    'chain.cancun', 'chain.simulateV1', 'infra.createx', 'infra.arachnid', 'infra.safeSingletonFactory', 'infra.multicall3', 'infra.unprotectedTransactions',
    'infra.permit2', 'infra.safe', 'uniswap.v3.factory', 'uniswap.v3.positionManager', 'uniswap.v3.quoterV2', 'uniswap.v3.swapRouter02', 'uniswap.v4.poolManager',
    'uniswap.v4.positionManager', 'uniswap.v4.stateView', 'uniswap.v4.quoter', 'uniswap.universalRouter', 'tokens.wrappedNative', 'tokens.stable',
    'uniswap.v3.poolInitCodeHash', 'liquidity.v3', 'liquidity.v4', 'deployTool.dependencies', 'chain.anchor']);
  assert.equal(report.verdict.deploy.status, 'pass'); assert.equal(report.verdict.run.status, 'pass');
  assert.ok(report.rpc.calls < 100, `${report.rpc.calls} calls`);
  assert.deepEqual(report.bootstrap.filter(b => b.needed), []);
  // Byte comparisons: each build matches both synthetic profiles once its immutables are substituted.
  for (const id of ['uniswap.v4.poolManager', 'uniswap.v3.factory', 'uniswap.v3.quoterV2', 'uniswap.v4.stateView', 'uniswap.v4.quoter', 'infra.permit2']) {
    assert.deepEqual(check(id).evidence.byteComparison.matches, ['alpha', 'beta'], id);
  }
  assert.equal(check('uniswap.v3.positionManager').evidence.byteComparison, 'not meaningful: per-chain immutables');
  assert.equal(check('chain.arbOS').evidence.arbOSVersion, 51);
  assert.equal(check('chain.l1Component').evidence.l1Gas, String(42276n * 10n));
  assert.equal(check('chain.cancun').evidence.method, 'state override');
  assert.deepEqual(check('infra.safe').evidence.complete, ['1.4.1']);
  assert.equal(check('tokens.stable').evidence.upgradeableProxyImplementation, viem.getAddress(label('stable implementation')));
  const price = Number(check('liquidity.v3').evidence.pools.find(p => p.fee === 500).stablePerWrapped);
  assert.ok(Math.abs(price - 40) < 1e-4, String(price));
  assert.equal(check('liquidity.v4').evidence.pools.filter(p => p.liquidity === '7').length, 1);

  // The draft: the profile's shape, verified values, enabled false.
  const robinhood = readJson(join(repoRoot, 'api-contracts/v2/chains/robinhood-4663.json'));
  const filled = { ...draft, gasPrice: robinhood.gasPrice, bridge: { ...draft.bridge, providers: [] } };
  assert.deepEqual(keyTree(filled), keyTree(robinhood));
  const g = viem.getAddress;
  assert.equal(draft.enabled, false); assert.equal(draft.chainId, CHAIN); assert.equal(draft.slug, 'elysium'); assert.equal(draft.nativeSymbol, 'HYPE');
  assert.equal(draft.stack, 'arbitrum-nitro'); assert.equal(draft.blockTimeSeconds, 0.25);
  assert.deepEqual(draft.uniswap, {
    v3: { factory: g(c.v3Factory), positionManager: g(c.v3PositionManager), quoterV2: g(c.quoterV2), swapRouter02: g(c.swapRouter02),
      poolInitCodeHash: V3_POOL_INIT_CODE_HASH, tickSpacingByFee: { 100: 1, 500: 10, 3000: 60, 10000: 200 } },
    v4: { poolManager: g(c.poolManager), positionManager: g(c.v4PositionManager), stateView: g(c.stateView), quoter: g(c.v4Quoter) },
    universalRouter: { address: g(c.universalRouter), version: null } });
  assert.deepEqual(draft.deployer, { kind: 'createx', address: g(CREATE_X), codehash: CREATE_X_CODE_HASH });
  assert.deepEqual(draft.wrappedNative, { symbol: 'WHYPE', address: g(c.wrapped), decimals: 18 });
  assert.deepEqual(draft.chargeCurrencies, [{ rank: 1, symbol: 'USDC', address: g(c.stable), decimals: 6 },
    { rank: 2, symbol: 'HYPE', address: ZERO, decimals: 18, native: true }, { rank: 2, symbol: 'WHYPE', address: g(c.wrapped), decimals: 18 }]);
  assert.equal(draft.gasPrice, null); assert.deepEqual(draft.bridge, { providers: null, appFeeBps: 35 });
  assert.equal(draft.verification.block, 5_000_000); assert.equal(draft.verification.checkedAt, '2027-01-15');
  const rows = Object.fromEntries(draft.verification.contracts.map(row => [row.name, row]));
  for (const [name, address] of [['UniswapV3Factory', c.v3Factory], ['PoolManager', c.poolManager], ['Permit2', PERMIT2], ['CreateX', CREATE_X],
    ['ArbSys', ARB_SYS], ['WHYPE', c.wrapped], ['USDC', c.stable], ['Safe 1.4.1 SafeL2 singleton', SAFE.singleton.address]]) {
    assert.deepEqual(rows[name], { name, address: g(address), codehash: viem.keccak256((fake.rpc && await fake.rpc('eth_getCode', [address.toLowerCase(), 'latest']))) }, name);
  }
  assert.equal(rows['v3 pool WHYPE/USDC fee 500 (getPool == CREATE2(initCodeHash): True)'].address, g(fake.pool));
  assert.equal(new Set(draft.verification.contracts.map(row => row.address)).size, draft.verification.contracts.length);
  for (const address of [...JSON.stringify(draft).matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)].map(m => m[0])) assert.equal(address, g(address));
  assert.ok(draft.sources.includes('https://docs.example.invalid/uniswap-deployments'));

  // What it could not verify, and what the schema cannot express.
  const unverified = report.unverifiedFields.map(f => f.path);
  for (const path of ['gasPrice', 'bridge.providers', 'uniswap.universalRouter.version', 'slug', 'nativeSymbol', 'chargeCurrencies[0]', 'bridge.appFeeBps']) {
    assert.ok(unverified.includes(path), path);
  }
  assert.ok(!unverified.some(path => path.startsWith('verification')));
  const gaps = report.schemaGaps.map(gap => gap.field);
  for (const field of ['gasPrice.chainlinkEthUsd', 'uniswap.universalRouter.version', 'enabled', 'bridge.providers', 'slug', 'chainId']) assert.ok(gaps.includes(field), field);
  assert.match(report.schemaGaps.find(gap => gap.where.includes('ENABLED_CHAINS')).gap, new RegExp(ENABLED_CHAINS.join(', ')));
  assert.doesNotThrow(() => JSON.stringify(report));
});

test('deploy.mjs\'s check is its own: a CreateX the tool was told to accept is still refused there', async () => {
  const fake = synthetic('not CreateX');
  const { check, status } = await qualify({ code: { [CREATE_X]: fake } }, { referenceOverrides: { createxCodeHash: viem.keccak256(fake) } });
  assert.equal(status['infra.createx'], 'pass');
  assert.equal(status['deployTool.dependencies'], 'fail');
  assert.match(check('deployTool.dependencies').summary, /dependency_codehash_mismatch: createx/);
});

test('a fresh chain: every absence, and the bootstrap each needs', async () => {
  const fresh = { code: { [CREATE_X]: null, [ARACHNID_PROXY]: null, [SAFE_SINGLETON_FACTORY]: null, [MULTICALL3]: null, [PERMIT2]: null,
    [SAFE.singleton.address.toLowerCase()]: null, [SAFE_FACTORY]: null } };
  const { report, status, draft } = await qualify(fresh, { uniswap: null, stable: null });
  for (const id of ['infra.createx', 'infra.arachnid', 'infra.safeSingletonFactory', 'infra.multicall3', 'infra.permit2', 'infra.safe']) assert.equal(status[id], 'fail', id);
  assert.equal(status['infra.unprotectedTransactions'], 'unknown');
  assert.equal(report.verdict.deploy.status, 'fail');
  const items = Object.fromEntries(report.bootstrap.map(b => [b.target, b]));
  assert.deepEqual(Object.keys(items).sort(), ['Arachnid deterministic deployment proxy', 'CreateX', 'Multicall3', 'Permit2', 'Safe 1.3.0', 'Safe 1.4.1',
    'Safe 1.5.0', 'Safe Singleton Factory']);
  assert.equal(items.CreateX.possible, 'yes');
  assert.match(items.CreateX.recommendation, /^the 3000000-gas variant: fund 0\.3 of the native coin$/);
  assert.equal(items.CreateX.estimate.l1Gas, String(12_350n * 10n));
  assert.equal(items['Arachnid deterministic deployment proxy'].transactions[0].rawTransaction, KEYLESS.arachnid.rawTransaction);
  assert.equal(items['Arachnid deterministic deployment proxy'].estimate.l1Gas, String(83n * 10n));
  assert.equal(items['Safe 1.3.0'].possible, 'after the Arachnid proxy');
  assert.equal(items['Safe 1.4.1'].possible, 'after the Safe Singleton Factory');
  assert.equal(items['Safe Singleton Factory'].possible, 'yes, by the Safe team');
  assert.equal(items['Safe 1.4.1'].fundingUpperBoundPerTransactionWei, String(16_777_216n * 100_000_000n));
  assert.equal(draft.deployer, null); assert.equal(draft.permit2, null);
  assert.deepEqual(draft.verification.contracts.filter(row => row.absent).map(row => row.name).sort(),
    ['Arachnid deterministic deployment proxy', 'CreateX', 'Multicall3', 'Permit2', 'safeSingletonFactory']);
  // A checked absence's null code hash is evidence, not an unverified field.
  assert.ok(!report.unverifiedFields.some(field => field.path.startsWith('verification')));
  assert.ok(report.unverifiedFields.some(field => field.path === 'deployer'));
  assert.ok(report.schemaGaps.some(gap => gap.field === 'deployer'));

  // The L1 part counts twice: 2,580,902 + 308,750 fits 3M, 2,580,902 + 2 × 308,750 does not.
  const margin = await qualify({ ...fresh, l1PerByte: 25n }, { uniswap: null, stable: null });
  assert.match(margin.report.bootstrap.find(b => b.target === 'CreateX').recommendation, /^the 25000000-gas variant/);
  // A dearer L1: CreateX needs its 25M variant, Multicall3's 1M cannot hold it, Arachnid's 100k still can.
  const dear = await qualify({ ...fresh, l1PerByte: 50n }, { uniswap: null, stable: null });
  const dearItems = Object.fromEntries(dear.report.bootstrap.map(b => [b.target, b]));
  assert.match(dearItems.CreateX.recommendation, /^the 25000000-gas variant: fund 2\.5 of the native coin$/);
  assert.equal(dearItems.Multicall3.possible, 'no');
  assert.match(dearItems.Multicall3.recommendation, /preinstall/);
  assert.equal(dearItems['Arachnid deterministic deployment proxy'].possible, 'yes');
});

test('a spent keyless nonce is never a bootstrap; one that deployed is evidence of unprotected transactions', async () => {
  const spent = await qualify({ code: { [CREATE_X]: null }, nonces: { [KEYLESS.createx.deployer]: 1n } }, { uniswap: null });
  const item = spent.report.bootstrap.find(b => b.target === 'CreateX');
  assert.equal(item.possible, 'no');
  assert.match(item.recommendation, /can never be at 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed/);
  assert.deepEqual(spent.check('infra.unprotectedTransactions').evidence.senders.find(s => s.name === 'CreateX'),
    { name: 'CreateX', deployer: viem.getAddress(KEYLESS.createx.deployer), nonce: '1', contractPresent: false, spent: true, accepted: false, keyless: false });

  const only = sender => Object.fromEntries(Object.values(KEYLESS).map(k => [k.deployer, k.deployer === sender ? 1n : 0n]));
  const consistent = await qualify({ nonces: only(KEYLESS.createx.deployer) }, { uniswap: null });
  assert.equal(consistent.status['infra.unprotectedTransactions'], 'pass');
  assert.match(consistent.check('infra.unprotectedTransactions').summary, /CreateX \(consistent with; their senders' keys exist\)$/);
  const proof = await qualify({ nonces: only(KEYLESS.arachnid.deployer) }, { uniswap: null });
  assert.equal(proof.check('infra.unprotectedTransactions').summary, 'pre-EIP-155 presigned transactions were mined: Arachnid deterministic deployment proxy');
  // Genesis preinstalls: every contract there, no sender ever sent.
  const preinstalled = await qualify({ nonces: only(null) }, { uniswap: null });
  assert.equal(preinstalled.status['infra.unprotectedTransactions'], 'unknown');

  const other = await qualify({ code: { [CREATE_X]: synthetic('impostor') } }, { uniswap: null });
  assert.equal(other.status['infra.createx'], 'fail');
  assert.equal(other.check('infra.createx').summary, 'other code at its address: not the canonical contract');
  assert.equal(other.report.bootstrap.find(b => b.target === 'CreateX'), undefined);
});

test('chain facts that fail: chain id, stale head, no finality, no base fee, a reorg, not Nitro', async () => {
  assert.equal((await qualify({}, { expectChainId: 99801 })).status['chain.id'], 'fail');
  assert.equal((await qualify({ timestamp: BigInt(NOW - 600) })).status['chain.head'], 'fail');
  const final = await qualify({ finalized: false });
  assert.equal(final.status['chain.finalized'], 'fail'); assert.equal(final.draft.finality, null);
  assert.equal((await qualify({ baseFee: null })).status['chain.baseFee'], 'fail');
  assert.equal((await qualify({ reorg: true })).status['chain.anchor'], 'fail');
  const op = await qualify({ nitro: false });
  assert.equal(op.status['chain.arbOS'], 'fail'); assert.equal(op.check('chain.arbOS').summary, 'not an Arbitrum Nitro chain (no ArbSys at 0x64)');
  assert.equal(op.status['chain.l1Component'], 'unknown'); assert.equal(op.draft.stack, null); assert.equal(op.report.verdict.deploy.status, 'fail');
  // A contract at 0x64 that answers arbOSVersion() is still not Nitro's precompile.
  const spoof = await qualify({ code: { [ARB_SYS]: synthetic('not a precompile') } });
  assert.equal(spoof.status['chain.arbOS'], 'fail'); assert.equal(spoof.check('chain.arbOS').summary, 'the code at 0x64 is not Nitro\'s ArbSys precompile');
  assert.equal(spoof.draft.stack, null);
  // An L1 component that the incompressible bound puts over deploy.mjs's per-transaction cap: undecided, not refused.
  const heavy = await qualify({ l1PerByte: 200n });
  assert.equal(heavy.status['chain.l1Component'], 'unknown');
  assert.equal(heavy.check('chain.l1Component').summary,
    '8455200 L1 gas for vault.v4\'s 42276 B; (execution >= 8162704 + L1) x 1.25 > the 16777216 cap');
});

test('Cancun opcodes and eth_simulateV1: the fallback, the missing opcode, a node without the method', async () => {
  const noOverride = await qualify({ override: false });
  assert.equal(noOverride.status['chain.cancun'], 'pass'); assert.equal(noOverride.check('chain.cancun').evidence.method, 'creation call');
  const noMcopy = await qualify({ cancun: 'MCOPY' });
  assert.equal(noMcopy.status['chain.cancun'], 'fail');
  assert.equal(noMcopy.check('chain.cancun').summary, 'does not run: MCOPY');
  assert.deepEqual(noMcopy.check('chain.cancun').evidence.opcodes, { PUSH0: 'runs', 'TSTORE/TLOAD': 'runs', MCOPY: 'rpc_error' });
  const unsupported = await qualify({ simulate: 'unsupported' });
  assert.equal(unsupported.status['chain.simulateV1'], 'fail'); assert.equal(unsupported.report.verdict.run.status, 'fail');
  assert.equal(unsupported.report.verdict.deploy.status, 'pass');
  assert.equal((await qualify({ simulate: 'down' })).status['chain.simulateV1'], 'unknown');
  const stateless = await qualify({ simulate: 'stateless' });
  assert.equal(stateless.status['chain.simulateV1'], 'unknown');
  assert.equal(stateless.check('chain.simulateV1').summary, 'eth_simulateV1 answers a bare call, but not the stateful probe');
});

test('tokens, Permit2 and Safe factories that are not what the profile needs fail', async () => {
  // A 1.4.1 factory whose proxy is another version's does not complete 1.4.1.
  const proxy = await qualify({}, { referenceOverrides: { safeProxyRuntimeHashes: { [viem.keccak256(SAFE.proxy.runtime)]: '1.3.0' } } });
  assert.equal(proxy.status['infra.safe'], 'fail'); assert.equal(proxy.report.verdict.deploy.status, 'fail');
  const wrapped = await qualify({ wrappedDecimals: 6 });
  assert.equal(wrapped.status['tokens.wrappedNative'], 'fail'); assert.equal(wrapped.draft.wrappedNative, null);
  const permit2 = await qualify({ domain: permit2Domain(1) });
  assert.equal(permit2.status['infra.permit2'], 'fail'); assert.equal(permit2.check('infra.permit2').summary, 'DOMAIN_SEPARATOR() is not Permit2\'s for this chain');
  assert.equal(permit2.draft.permit2, null);
  const build = await qualify({ code: { [PERMIT2]: synthetic('another Permit2', [BigInt(CHAIN), permit2Domain(CHAIN)]) } });
  assert.equal(build.status['infra.permit2'], 'fail'); assert.equal(build.check('infra.permit2').summary, 'not the build any profile recorded');
});

test('Uniswap wiring that does not hold fails the check that reads it, and leaves the field unverified', async () => {
  const elsewhere = label('elsewhere');
  const npm = await qualify({ npmFactory: elsewhere });
  assert.equal(npm.status['uniswap.v3.positionManager'], 'fail');
  assert.equal(npm.draft.uniswap.v3.positionManager, null);
  assert.equal(npm.status['deployTool.dependencies'], 'unknown');
  assert.ok(npm.report.unverifiedFields.some(f => f.path === 'uniswap.v3.positionManager'));
  assert.equal((await qualify({ v4pmPool: elsewhere })).status['uniswap.v4.positionManager'], 'fail');
  const { fake } = await qualify();
  const pm = await qualify({ code: { [fake.c.poolManager]: synthetic('another PoolManager build', [fake.c.poolManager]) } });
  assert.equal(pm.status['uniswap.v4.poolManager'], 'fail'); assert.deepEqual(pm.check('uniswap.v4.poolManager').evidence.byteComparison.matches, []);
  const tiers = await qualify({ tiers: { 100: 2, 500: 10, 3000: 60, 10000: 200 } });
  assert.equal(tiers.status['uniswap.v3.factory'], 'fail');
  const notCreate2 = label('not a CREATE2 pool');
  const pool = await qualify({ poolAddress: notCreate2 });
  assert.equal(pool.status['uniswap.v3.poolInitCodeHash'], 'fail'); assert.equal(pool.draft.uniswap.v3.poolInitCodeHash, null);
  const weth = await qualify({}, { wrappedNative: label('another wrapper') });
  assert.equal(weth.status['uniswap.v3.positionManager'], 'fail');
  assert.equal(weth.check('uniswap.v3.positionManager').evidence.wiring.find(w => w.getter === 'WETH9()').status, 'fail');
});

test('liquidity: pools without liquidity, no pool, and what a missing input leaves unknown', async () => {
  const dry = await qualify({ liquidity: 0n });
  assert.equal(dry.status['liquidity.v3'], 'fail'); assert.equal(dry.check('liquidity.v3').summary, 'pools exist but none holds liquidity');
  const none = await qualify({ noPool: true });
  assert.equal(none.status['liquidity.v3'], 'fail'); assert.equal(none.status['uniswap.v3.poolInitCodeHash'], 'unknown');
  const bare = await qualify({}, { uniswap: null, stable: null });
  for (const id of ['uniswap.v3.factory', 'uniswap.universalRouter', 'tokens.wrappedNative', 'tokens.stable', 'liquidity.v3', 'liquidity.v4', 'deployTool.dependencies']) {
    assert.equal(bare.status[id], 'unknown', id);
  }
  // A wrapped native given without a periphery to confirm it: read, but not written into the draft.
  const given = await qualify({}, { uniswap: null, stable: null, wrappedNative: chain().c.wrapped });
  assert.equal(given.status['tokens.wrappedNative'], 'pass'); assert.equal(given.draft.wrappedNative, null);
  assert.match(given.report.unverifiedFields.find(f => f.path === 'wrappedNative').reason, /not cross-checked/);
});

test('reads only, within the budget; a pinned answer is asked once', async () => {
  const fake = chain();
  const rpc = readOnly(fake.rpc, { maximumCalls: 6 });
  const { report } = await qualifyChain({ rpc, now: NOW, pending: PENDING, uniswap: uniswapOf(fake.c), stable: fake.c.stable, references: references(), apiSchemas: [] });
  assert.equal(fake.rpc.log.length, 6);
  assert.equal(report.rpc.calls, 6);
  assert.equal(report.checks.find(c => c.id === 'chain.cancun').status, 'unknown');
  assert.equal(report.checks.find(c => c.id === 'chain.cancun').evidence.stateOverride.kind, 'budget');
  await assert.rejects(readOnly(fake.rpc)('eth_sendRawTransaction', ['0x00']), error => error instanceof RpcError && error.kind === 'refused');
  let inFlight = 0, most = 0, calls = 0;
  const slow = async () => { calls += 1; inFlight += 1; most = Math.max(most, inFlight); await new Promise(done => setTimeout(done, 5)); inFlight -= 1; return '0x'; };
  const limited = readOnly(slow, { concurrency: 3 });
  await Promise.all([...Array(12).keys()].map(i => limited('eth_getCode', [label('a' + i), '0x1'])));
  await Promise.all([limited('eth_getCode', [label('a0'), '0x1']), limited('eth_getCode', [label('a0'), '0x1'])]);
  assert.equal(most, 3); assert.equal(calls, 12);
});

async function serve(handler) {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const out = await handler(JSON.parse(body));
    response.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
    response.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => server.close(done)) };
}
/** The fake chain over JSON-RPC, as a node serves it. */
const node = (fake, extra = () => null) => serve(async body => {
  const replaced = await extra(body);
  if (replaced) return replaced;
  try { return { body: { jsonrpc: '2.0', id: body.id, result: await fake.rpc(body.method, body.params) } }; } catch (error) {
    return { body: { jsonrpc: '2.0', id: body.id, error: { code: error.code ?? -32000, message: error.detail ?? 'error' } } };
  }
});

test('the HTTP transport: rate limits retried, node messages redacted by value, bad replies refused', async () => {
  const secret = 'k3y-0123456789abcdef';
  let first = true;
  const server = await serve(async body => {
    if (body.method === 'eth_chainId' && first) { first = false; return { status: 429, body: '{}' }; }
    if (body.method === 'eth_chainId') return { body: { jsonrpc: '2.0', id: body.id, result: '0x1' } };
    if (body.method === 'eth_call') return { body: { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: `key ${secret} refused at ${server.url}/v2/${secret}?x=1` } } };
    if (body.method === 'eth_getCode') return { body: { jsonrpc: '2.0', id: body.id + 1, result: '0x' } };
    if (body.method === 'eth_getBalance') return { body: { jsonrpc: '2.0', id: body.id, result: '0x' + 'f'.repeat(4000) } };
    return { status: 500, body: '' };
  });
  try {
    const transport = jsonRpc(`${server.url}/v2/${secret}`, { retryDelays: [0], maxReplyBytes: 2048 });
    assert.equal(await transport('eth_chainId', []), '0x1'); assert.equal(transport.requests, 2);
    const error = await transport('eth_call', [{}]).catch(e => e);
    assert.ok(error instanceof RpcError && error.kind === 'error' && error.code === -32000);
    assert.equal(error.detail, 'key [redacted] refused at [url]');
    assert.ok(!error.message.includes(secret) && !error.message.includes(server.url));
    await assert.rejects(transport('eth_getCode', []), e => e.kind === 'transport' && e.detail === 'invalid reply');
    await assert.rejects(transport('eth_getBalance', []), e => e.kind === 'transport' && e.detail === 'invalid or oversized reply');
    await assert.rejects(transport('eth_blockNumber', []), e => e.kind === 'transport' && e.detail === 'http 500');
  } finally { await server.close(); }
  assert.equal(checkedUrl('https://rpc.example.invalid/v2/key?apikey=1'), 'https://rpc.example.invalid/v2/key?apikey=1');
  assert.equal(checkedUrl('http://127.0.0.1:8547'), 'http://127.0.0.1:8547');
  for (const url of ['http://rpc.example.invalid', 'https://' + 'user:pw@rpc.example.invalid', 'ftp://rpc.example.invalid', 'https://rpc.example.invalid/#k', '', 42]) {
    assert.throws(() => checkedUrl(url), /^Error: invalid_rpc_url$/, String(url));
  }
});

test('the RPC URL comes from exactly one source: an environment variable or an owner-only JSON file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'domino-qualify-rpc-'));
  const url = 'https://rpc.example.invalid/v2/secret-key-123456';
  assert.equal(rpcUrlFrom({ 'rpc-env': 'ELYSIUM_RPC_URL' }, { ELYSIUM_RPC_URL: url + '\n' }), url);
  assert.throws(() => rpcUrlFrom({ 'rpc-env': 'ELYSIUM_RPC_URL' }, {}), /^Error: rpc_env_unset$/);
  assert.throws(() => rpcUrlFrom({ 'rpc-env': 'BAD-NAME' }, {}), /^Error: invalid_rpc_env_name$/);
  assert.throws(() => rpcUrlFrom({}, {}), /exactly_one_rpc_source_required/);
  const file = join(directory, 'rpc.json');
  writeFileSync(file, JSON.stringify({ url }), { mode: 0o600 });
  assert.equal(rpcUrlFrom({ 'rpc-file': file }), url);
  assert.throws(() => rpcUrlFrom({ 'rpc-file': file, 'rpc-env': 'X' }, { X: url }), /exactly_one_rpc_source_required/);
  chmodSync(file, 0o644);
  assert.throws(() => rpcUrlFrom({ 'rpc-file': file }), error => /^invalid_private_rpc_file/.test(error.message) && !error.message.includes('secret-key'));
  const extra = join(directory, 'extra.json');
  writeFileSync(extra, JSON.stringify({ url, chain: 'elysium' }), { mode: 0o600 });
  assert.throws(() => rpcUrlFrom({ 'rpc-file': extra }), /^Error: invalid_private_rpc_file/);
});

test('inputs: Uniswap candidates in the profile\'s shape, addresses checksummed or lower case', () => {
  const c = chain().c;
  const parsed = checkUniswapInput({ v3: { factory: viem.getAddress(c.v3Factory) }, universalRouter: { version: '2.1.2' } });
  assert.equal(parsed.v3.factory, c.v3Factory); assert.equal(parsed.universalRouter.version, '2.1.2');
  assert.throws(() => checkUniswapInput({ v3: { factroy: c.v3Factory } }), /invalid_uniswap_input: v3/);
  assert.throws(() => checkUniswapInput({ v5: {} }), /^Error: invalid_uniswap_input$/);
  const bad = viem.getAddress(c.v3Factory).replace(/[a-f]/, x => x.toUpperCase()).replace(/[A-F](?=[^A-F]*$)/, x => x.toLowerCase());
  if (bad !== viem.getAddress(c.v3Factory) && bad.toLowerCase() !== bad) assert.throws(() => checkUniswapInput({ v3: { factory: bad } }), /invalid_address: v3.factory/);
  assert.throws(() => checkUniswapInput({ v3: { factory: c.v3Factory }, v4: { poolManager: c.v3Factory } }), /addresses_not_distinct/);
  assert.throws(() => checkUniswapInput({ universalRouter: { version: 'v2' } }), /universalRouter.version/);
  assert.throws(() => checkUniswapInput({ v4: { stateView: ZERO } }), /invalid_address/);
});

test('the command line: outputs outside the checkout, never the URL or its key', async () => {
  const secret = 'qualify-secret-0123456789';
  const fake = chain({ client: 'nitro/v3.9.0' });
  let url;
  const server = await node(fake, body => body.method === 'web3_clientVersion'
    ? { body: { jsonrpc: '2.0', id: body.id, result: `nitro/v3.9.0 behind ${url} (${secret})` } } : null);
  url = `${server.url}/v1/${secret}`;
  try {
    const directory = mkdtempSync(join(tmpdir(), 'domino-qualify-cli-')), out = join(directory, 'day1');
    const uniswap = join(directory, 'uniswap.json');
    writeFileSync(uniswap, JSON.stringify(uniswapOf(fake.c)));
    const argv = ['--rpc-env', 'QUALIFY_TEST_RPC', '--out', out, '--pending', 'elysium', '--uniswap', uniswap, '--stable', fake.c.stable, '--chain-id', String(CHAIN)];
    const message = await cli(argv, { env: { QUALIFY_TEST_RPC: url } });
    const report = readFileSync(join(out, 'report.json'), 'utf8'), draft = readFileSync(join(out, 'profile-draft.json'), 'utf8');
    for (const text of [message, report, draft]) { assert.ok(!text.includes(secret)); assert.ok(!text.includes(server.url)); }
    assert.match(message, /^Domino V2 chain qualification: chain 777001 at block 5000000 \(\d+ RPC calls, [0-9.]+ s\)$/m);
    assert.match(message, /^PASS    chain\.id {24}eth_chainId 777001, as expected$/m);
    assert.ok(/^[\x20-\x7e\n]+$/.test(message), 'the console summary is plain ASCII');
    // The committed safe-deployments hashes do not know the synthetic 1.4.1 factory, so no Safe version is complete here.
    assert.match(message, /^Bootstrap Safe 1\.3\.0: possible yes$/m);
    assert.equal(JSON.parse(report).chain.client, 'nitro/v3.9.0 behind [url] ([redacted])');
    assert.equal(JSON.parse(draft).enabled, false);
    assert.equal(JSON.parse(report).tool.commit.length, 40);
    await assert.rejects(cli(argv, { env: { QUALIFY_TEST_RPC: url } }), /^Error: output_exists$/);
    // A name of this run only, so a directory an earlier failure left cannot hide a regression.
    const inside = join(repoRoot, 'scripts/v2', `qualify-test-${process.pid}-${Date.now()}`);
    await assert.rejects(cli(['--rpc-env', 'QUALIFY_TEST_RPC', '--out', inside], { env: { QUALIFY_TEST_RPC: url } }), /output_inside_the_checkout/);
    assert.ok(!existsSync(inside));
    await assert.rejects(cli(['--rpc-env', 'QUALIFY_TEST_RPC', '--out', join(directory, 'x'), '--pending', 'atlantis'], { env: { QUALIFY_TEST_RPC: url } }), /unknown_pending_profile/);
    await assert.rejects(cli(['--rpc-env', 'QUALIFY_TEST_RPC', '--out', join(directory, 'x'), '--sign', 'yes'], { env: { QUALIFY_TEST_RPC: url } }), /^Error: usage/);
  } finally { await server.close(); }
});
