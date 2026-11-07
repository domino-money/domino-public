/**
 * The chain registry (src/config/chains.ts, 2026-10-01, the chain2 workstream, audit item G3).
 *
 * - Elysium's record is rugged97's chain profile and deployment registry at 7d190690, field by field
 *   (tests/fixtures/elysium/, whose bytes are the ones his read contract's manifest records as its sources).
 * - Robinhood's record is the app's own constants, imported, and the few copies it holds (LANE_PACE, the orientation's
 *   quote ranks, the explorer and code hashes of rugged97's profile) are held equal to their sources here.
 * - Both are frozen, and the helpers refuse what is not theirs.
 *
 * Part B (2026-10-01, audit items G3 and G4): the direction flipped. The values are the registry's own
 * (config/chainIdentity.ts, config/chainRobinhood.ts), and the six modules that each declared Robinhood Chain's id, the
 * copies of its addresses, the page's endpoints, the router's inputs and the fees lanes' pace read them from there. The
 * tests below hold every one of those modules to the registry, value for value and object for object, keep the six
 * declarations from writing the id again, and hold the money code's own pins (never rewired) equal to the registry.
 *
 * Changed on purpose 2026-10-01 (RPC-SPEC §7.1, the owner's rule: nothing is read from a public RPC): the page's router
 * (lib/chain/browser.ts, failover.ts, endpoints.ts), the three public fallbacks, their order and the fees lanes' pace are
 * gone. Robinhood's record names the chain's official RPC alone, for the wallet's "add network"; no fallback, no order,
 * no lane pace; and the chain code's RPC_URL is a sentinel, not that URL.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const registry = require('../.test-build/app/src/config/chains.js');
const owned = require('../.test-build/app/functions/_lib/owned.js');
const identity = require('../.test-build/app/src/config/chainIdentity.js');
const network = require('../.test-build/app/src/config/chainRobinhood.js');
const orientation = require('../.test-build/app/src/lib/read/orientation.js');
const mainTokens = require('../.test-build/app/src/config/mainTokens.js');
const feesConstants = require('../.test-build/app/src/lib/fees/constants.js');

const FIXTURES = new URL('./fixtures/elysium/', import.meta.url);
const bytes = (name) => readFileSync(new URL(name, FIXTURES));
const json = (name) => JSON.parse(bytes(name).toString('utf8'));
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const { ELYSIUM, ROBINHOOD, CHAINS } = registry;

test('the fixtures are rugged97\'s files at 7d190690: the bytes his read contract records as its sources', () => {
  const source = json('SOURCE.json');
  assert.equal(source.commit, '7d1906907381c55e65d9b83ad1f3efafe1cabb36');
  for (const [name, entry] of Object.entries(source.files)) assert.equal(sha(bytes(name)), entry.sha256, name);
  // His uniswap-v3-read-v1 manifest (vendored by pinned hash) names these two files and their hashes as sources.
  const manifest = JSON.parse(readFileSync(new URL('../functions/_lib/uniswap-v3/contracts/uniswap-v3-read-v1/manifest.json', import.meta.url), 'utf8'));
  const recorded = Object.fromEntries(manifest.sources.map((entry) => [entry.path, entry.sha256]));
  assert.equal(sha(bytes('elysium-99801.json')), recorded['chains/elysium-99801.json']);
  assert.equal(sha(bytes('elysium-v3-unqualified.json')), recorded['chains/deployments/elysium-v3-unqualified.json']);
});

test('Elysium\'s record is his profile and registry, field by field', () => {
  const profile = json('elysium-99801.json');
  const deployment = json('elysium-v3-unqualified.json');
  assert.equal(ELYSIUM.key, 'elysium');
  assert.equal(ELYSIUM.profileId, profile.id);
  assert.equal(ELYSIUM.id, profile.chainId);
  assert.equal(ELYSIUM.name, profile.name);
  assert.equal(ELYSIUM.network, profile.network);
  assert.equal(ELYSIUM.parentChainId, profile.parentChainId);
  assert.deepEqual({ ...ELYSIUM.native }, profile.nativeCurrency);
  assert.equal(ELYSIUM.wrapped, profile.wrappedNative);
  assert.deepEqual([...ELYSIUM.stables], profile.stableTokens);
  assert.equal(ELYSIUM.explorer, profile.explorerUrl);
  assert.equal(ELYSIUM.rpc.primary.url, profile.publicRpcUrl);
  assert.deepEqual([...ELYSIUM.rpc.fallbacks], [], 'his profile names one public RPC and no fallback');
  assert.equal(ELYSIUM.arbSys, profile.nitro.arbSys);
  assert.equal(ELYSIUM.webOrigin, profile.web.origin);
  assert.equal(profile.protocolDeploymentId, deployment.id);
  assert.equal(ELYSIUM.deployment.id, deployment.id);
  assert.equal(ELYSIUM.deployment.protocol, deployment.protocol);
  assert.equal(ELYSIUM.deployment.status, deployment.status);
  assert.equal(ELYSIUM.deployment.version, deployment.version);
  assert.deepEqual({ ...ELYSIUM.deployment.contracts }, deployment.contracts);
  assert.deepEqual({ ...ELYSIUM.deployment.codeHashes }, deployment.codeHashes);
  assert.deepEqual({ ...ELYSIUM.deployment.reference }, deployment.reference);
  assert.equal(ELYSIUM.deployment.evidencePath, deployment.evidencePath);
  // Unqualified: no address at all, and nothing from the rehearsal leaks into the registry.
  assert.ok(Object.values(ELYSIUM.deployment.contracts).every((address) => address === null));
  assert.equal(registry.hasContract(ELYSIUM, 'positionManager'), false);
  // The product's own fields for it (G6): USDC first, then WHYPE, no fixed dollar, no price provider, no external link.
  assert.deepEqual({ ...ELYSIUM.quoteRanks }, { [profile.stableTokens[0]]: 2, [profile.wrappedNative]: 1 });
  assert.deepEqual([...ELYSIUM.dollarTokens], []);
  assert.equal(ELYSIUM.priceProvider, null);
  assert.equal(ELYSIUM.dexLink, null);
  assert.equal(registry.poolSourceUrl(ELYSIUM, '0x4b79c0e837ab70451bc849bf21d9ea3b25b69883'), null);
});

test('Robinhood\'s record is built from the app\'s own constants', () => {
  assert.equal(ROBINHOOD.id, owned.CHAIN_ID);
  // Changed on purpose 2026-10-01 (RPC-SPEC §7.1): the official RPC, for the wallet alone; no fallback and no order.
  assert.equal(ROBINHOOD.rpc.primary.url, identity.ROBINHOOD_RPC_URL);
  assert.deepEqual([...ROBINHOOD.rpc.fallbacks], []);
  assert.deepEqual(Object.fromEntries(Object.entries(ROBINHOOD.rpc.order).map(([need, list]) => [need, [...list]])), { latest: [], state: [], archive: [], headers: [], simulate: [], logs: [] });
  assert.equal(ROBINHOOD.multicall3, owned.MULTICALL3);
  assert.equal(ROBINHOOD.wrapped, mainTokens.WETH);
  assert.deepEqual([...ROBINHOOD.stables], [mainTokens.USDG]);
  assert.equal(ROBINHOOD.nativeAddress, mainTokens.NATIVE_ETH);
  assert.deepEqual([...ROBINHOOD.dollarTokens], [mainTokens.USDG]);
  assert.equal(ROBINHOOD.deployment.contracts.positionManager, owned.POSITION_MANAGER);
  assert.equal(ROBINHOOD.deployment.contracts.poolManager, feesConstants.POOL_MANAGER);
  assert.equal(ROBINHOOD.deployment.contracts.stateView, feesConstants.STATE_VIEW);
  assert.equal(ROBINHOOD.deployment.contracts.setup, owned.SETUP_CONTRACT);
  assert.equal(ROBINHOOD.firstBlocks.positionManager, owned.FIRST_TRANSFER_BLOCK);
  assert.equal(ROBINHOOD.firstBlocks.setup, owned.SETUP_DEPLOY_BLOCK);
  assert.equal(ROBINHOOD.logs.maxSpan, owned.LOG_BLOCKS_ONE);
  assert.equal(ROBINHOOD.logs.maxSpanMany, owned.LOG_BLOCKS_MANY);
  assert.equal(registry.poolSourceUrl(ROBINHOOD, `0x${'ab'.repeat(32)}`), `https://app.uniswap.org/explore/pools/robinhood/0x${'ab'.repeat(32)}`, 'the link the featured list builds');
});

test('Robinhood\'s copies equal their sources: the quote ranks, his profile and registry; no lane pace any more', () => {
  assert.equal(ROBINHOOD.lanePace, null, 'RPC-SPEC: the fees worker asks the site\'s logs route, through a lane of its own (lib/fees/edgeLane.ts)');
  for (const [address, rank] of Object.entries(ROBINHOOD.quoteRanks)) assert.equal(orientation.quoteRank(address), rank, address);
  for (const address of [mainTokens.USDG, mainTokens.WETH, mainTokens.NATIVE_ETH, '0x1111111111111111111111111111111111111111']) {
    assert.equal(registry.quoteRankOn(ROBINHOOD, address), orientation.quoteRank(address), address);
    assert.equal(registry.priceInvertedOn(ROBINHOOD, address, mainTokens.USDG), orientation.priceInverted(address, mainTokens.USDG));
    assert.equal(registry.priceInvertedOn(ROBINHOOD, mainTokens.USDG, address), orientation.priceInverted(mainTokens.USDG, address));
  }
  const profile = json('robinhood-4663.json');
  const deployment = json('robinhood-v4.json');
  assert.equal(ROBINHOOD.profileId, profile.id);
  assert.equal(ROBINHOOD.id, profile.chainId);
  assert.equal(ROBINHOOD.name, profile.name);
  assert.equal(ROBINHOOD.parentChainId, profile.parentChainId);
  assert.deepEqual({ ...ROBINHOOD.native }, profile.nativeCurrency);
  assert.equal(ROBINHOOD.wrapped, profile.wrappedNative);
  assert.deepEqual([...ROBINHOOD.stables], profile.stableTokens);
  assert.equal(ROBINHOOD.explorer, profile.explorerUrl);
  assert.equal(ROBINHOOD.rpc.primary.url, profile.publicRpcUrl);
  assert.equal(ROBINHOOD.webOrigin, profile.web.origin);
  assert.equal(ROBINHOOD.deployment.id, deployment.id);
  assert.equal(ROBINHOOD.deployment.status, deployment.status);
  for (const role of ['poolManager', 'positionManager', 'stateView']) {
    assert.equal(ROBINHOOD.deployment.contracts[role], deployment.contracts[role], role);
    assert.equal(ROBINHOOD.deployment.codeHashes[role], deployment.codeHashes[role], role);
  }
  assert.deepEqual({ ...ROBINHOOD.deployment.reference }, deployment.reference);
});

test('the kit\'s canonical constants are the app\'s', () => {
  assert.equal(registry.MULTICALL3_CANONICAL, owned.MULTICALL3);
  assert.equal(ELYSIUM.multicall3, owned.MULTICALL3);
  assert.equal(registry.ARB_SYS, '0x0000000000000000000000000000000000000064');
  assert.equal(ELYSIUM.arbSys, json('elysium-99801.json').nitro.arbSys);
  assert.equal(ROBINHOOD.arbSys, json('robinhood-4663.json').nitro.arbSys);
});

test('every record is frozen, borrowed endpoint records are left as their module made them', () => {
  for (const chain of CHAINS) {
    assert.ok(Object.isFrozen(chain));
    assert.ok(Object.isFrozen(chain.deployment) && Object.isFrozen(chain.deployment.contracts) && Object.isFrozen(chain.quoteRanks));
    assert.throws(() => {
      'use strict';
      chain.id = 1;
    });
  }
  assert.ok(Object.isFrozen(ELYSIUM.rpc.primary));
  assert.equal(Object.isFrozen(network.PRIMARY), false, 'importing the registry changes nothing of config/chainRobinhood.ts');
});

test('lookups and helpers', () => {
  assert.equal(registry.chainById(4663), ROBINHOOD);
  assert.equal(registry.chainById(ELYSIUM.id), ELYSIUM);
  assert.equal(registry.chainById(1), null);
  assert.equal(registry.chainByKey('elysium'), ELYSIUM);
  assert.equal(registry.chainByKey('__proto__'), null);
  assert.equal(registry.hexChainId(ROBINHOOD), '0x1237');
  assert.equal(registry.hexChainId(ELYSIUM), '0x185d9');
  assert.equal(registry.explorerAddress(ELYSIUM, '0x385BFA95BBBDD8DA06E31FF49F94F1296317E156'), 'https://elysium.kinetiq.xyz/testnet-explorer/address/0x385bfa95bbbdd8da06e31ff49f94f1296317e156');
  assert.equal(registry.explorerAddress(ELYSIUM, 'javascript:alert(1)'), null);
  assert.equal(registry.explorerTx(ROBINHOOD, `0x${'a'.repeat(64)}`), `https://robinhoodchain.blockscout.com/tx/0x${'a'.repeat(64)}`);
  assert.equal(registry.explorerTx(ROBINHOOD, '0x1234'), null);
  assert.deepEqual(registry.addChainParameters(ELYSIUM), {
    chainId: '0x185d9',
    chainName: 'Elysium Testnet',
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: ['https://testnet-rpc.elysium.kinetiq.xyz'],
    blockExplorerUrls: ['https://elysium.kinetiq.xyz/testnet-explorer'],
  });
  // Changed on purpose 2026-10-01 (RPC-SPEC §7.5): the official RPC alone, as the wallet's own add-network (wallet/chain.ts).
  assert.deepEqual(registry.addChainParameters(ROBINHOOD).rpcUrls, [identity.ROBINHOOD_RPC_URL]);
  const { ADD_ROBINHOOD_CHAIN } = require('../.test-build/app/src/wallet/chain.js');
  assert.deepEqual(registry.addChainParameters(ROBINHOOD).rpcUrls, [...ADD_ROBINHOOD_CHAIN.rpcUrls]);
  assert.equal(registry.isDollarToken(ROBINHOOD, mainTokens.USDG.toUpperCase().replace('0X', '0x')), true);
  assert.equal(registry.isDollarToken(ELYSIUM, ELYSIUM.stables[0]), false, 'a testnet USDC is not a dollar by definition');
});

test('the registry is the one place a chain id is declared in the chain2 workstream\'s files, and every key is unique', () => {
  const keys = CHAINS.map((chain) => chain.key);
  const ids = CHAINS.map((chain) => chain.id);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(CHAINS[0], ROBINHOOD, 'Robinhood stays the default chain');
});

// ---------------------------------------------------------------------------------------------------------------------
// Part B (2026-10-01, audit items G3 and G4): every module reads the registry, and Robinhood's behaviour is unchanged.
// ---------------------------------------------------------------------------------------------------------------------

const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/\s.*$/gm, '');
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the six declarations of Robinhood Chain\'s id read the registry, and none writes it again', () => {
  assert.equal(identity.ROBINHOOD_ID, 4663, 'the one place the id is written');
  assert.equal(ROBINHOOD.id, identity.ROBINHOOD_ID);
  assert.equal(owned.CHAIN_ID, identity.ROBINHOOD_ID);
  assert.equal(require('../.test-build/app/src/session/machine.js').ROBINHOOD_CHAIN_ID, identity.ROBINHOOD_ID);
  assert.equal(require('../.test-build/app/src/lib/read/screens/identity.js').CHAIN_ID, identity.ROBINHOOD_ID);
  assert.equal(require('../.test-build/app/src/lib/read/project.js').identityKey('0xABC'), `${identity.ROBINHOOD_ID}:0xabc`);
  assert.equal(require('../.test-build/app/src/lib/capabilities.js').CAPABILITIES.chainId, identity.ROBINHOOD_ID);
  const { robinhoodChain, ADD_ROBINHOOD_CHAIN } = require('../.test-build/app/src/wallet/chain.js');
  assert.equal(robinhoodChain.id, identity.ROBINHOOD_ID);
  assert.equal(robinhoodChain.name, ROBINHOOD.name);
  assert.deepEqual({ ...robinhoodChain.nativeCurrency }, { ...ROBINHOOD.native });
  // The network a wallet is asked to add: the registry's chain, its official RPC and its explorer (tests/wallet-compat.test.mjs
  // holds the literal). Changed on purpose 2026-10-01 (RPC-SPEC §7.5): the one fallback a wallet was handed is gone.
  assert.deepEqual(JSON.parse(JSON.stringify(ADD_ROBINHOOD_CHAIN)), {
    chainId: registry.hexChainId(ROBINHOOD),
    chainName: ROBINHOOD.name,
    nativeCurrency: { ...ROBINHOOD.native },
    rpcUrls: [ROBINHOOD.rpc.primary.url],
    blockExplorerUrls: [ROBINHOOD.explorer],
  });
  for (const path of ['src/session/machine.ts', 'src/lib/read/screens/identity.ts', 'src/lib/read/project.ts', 'functions/_lib/owned.ts', 'src/wallet/chain.ts', 'src/lib/capabilities.ts']) {
    assert.doesNotMatch(strip(source(path)), /\b(?:4663|0x1237)\b/, `${path} writes the id itself`);
  }
});

test('the address copies read the registry, and the money code\'s own pins equal it', () => {
  const addresses = { poolManager: identity.ROBINHOOD_POOL_MANAGER, positionManager: identity.ROBINHOOD_POSITION_MANAGER, stateView: identity.ROBINHOOD_STATE_VIEW, setup: identity.ROBINHOOD_SETUP };
  assert.deepEqual({ ...ROBINHOOD.deployment.contracts }, addresses);
  assert.equal(owned.POSITION_MANAGER, addresses.positionManager);
  assert.equal(owned.SETUP_CONTRACT, addresses.setup);
  assert.equal(owned.MULTICALL3, identity.MULTICALL3_CANONICAL);
  assert.equal(feesConstants.POSITION_MANAGER, addresses.positionManager);
  assert.equal(feesConstants.POOL_MANAGER, addresses.poolManager);
  assert.equal(feesConstants.STATE_VIEW, addresses.stateView);
  assert.equal(feesConstants.MULTICALL3, identity.MULTICALL3_CANONICAL);
  const fees = require('../.test-build/app/functions/_lib/fees.js');
  assert.equal(fees.POOL_MANAGER, addresses.poolManager);
  assert.equal(fees.STATE_VIEW, addresses.stateView);
  assert.equal(require('../.test-build/app/src/lib/vaultLogs.js').VAULT_POOL_MANAGER, addresses.poolManager);
  assert.deepEqual([mainTokens.NATIVE_ETH, mainTokens.WETH, mainTokens.USDG], [identity.ROBINHOOD_NATIVE_ADDRESS, identity.ROBINHOOD_WETH, identity.ROBINHOOD_USDG]);
  const project = require('../.test-build/app/src/lib/read/project.js');
  for (const [address, key] of [[identity.ROBINHOOD_NATIVE_ADDRESS, 'ETH'], [identity.ROBINHOOD_WETH, 'WETH'], [identity.ROBINHOOD_USDG, 'USDG']]) {
    assert.equal(project.unreadToken(address).artwork, key, `the bundled artwork for ${key} is the registry's address`);
  }
  // Changed on purpose 2026-10-02 (CI Backend): owned.ts writes SETUP_CONTRACT as a literal again, because the backend's
  // tests/test_domino_positions.py reads that line from source. It is held equal to the registry above, and it is the one
  // place in owned.ts where that address may be written.
  assert.match(source('functions/_lib/owned.ts'), new RegExp(`export const SETUP_CONTRACT = '${addresses.setup}'`));
  assert.equal(source('functions/_lib/owned.ts').split(`'${addresses.setup}`).length - 1, 1, 'functions/_lib/owned.ts copies the Setup address again');
  for (const [path, pattern] of [
    ['functions/_lib/owned.ts', /'0x(?:58daec|ca11bde0)/],
    ['src/lib/fees/constants.ts', /'0x(?:58daec|8366a39c|f3334192|ca11bde0)/],
    ['functions/_lib/fees.ts', /'0x(?:8366a39c|f3334192)/],
    ['src/lib/vaultLogs.ts', /'0x8366a39c/],
    ['src/config/mainTokens.ts', /'0x(?:0{40}|0bd7d308|5fc5360d)/],
    ['src/lib/read/project.ts', /'0x(?:0{40}|0bd7d308|5fc5360d)/],
  ]) assert.doesNotMatch(source(path), pattern, `${path} copies an address again`);
  // The money code keeps its own pins (the audit's G3: never rewired, only held equal), and so do the reviewed pool
  // catalogue and Create position's journey.
  const pin = source('src/finance/pin.ts');
  assert.match(pin, new RegExp(`export const POSITION_MANAGER = '${addresses.positionManager}'`));
  assert.match(pin, new RegExp(`export const SETUP_CONTRACT: Pin = '${addresses.setup}'`));
  assert.match(pin, new RegExp(`export const STATE_VIEW = '${addresses.stateView}'`));
  assert.match(source('src/lib/create/journey.ts'), new RegExp(`export const USDG = addressKey\\('${identity.ROBINHOOD_USDG}'\\)`));
  const catalogue = source('src/config/selectedPoolCatalogue.ts');
  assert.ok(catalogue.includes(`'${identity.ROBINHOOD_WETH}': 'WETH'`) && catalogue.includes(`'${identity.ROBINHOOD_USDG}': 'USDG'`));
});

// Changed on purpose 2026-10-01 (RPC-SPEC §7.1 and §7.3): the page's endpoints, the router's inputs and the fees lanes'
// pace went with the public RPC; what stays is the official RPC record (for the wallet), the block rate, the log
// windows and the first blocks, and the chain code's RPC_URL is a sentinel, not a host.
test('the registry\'s network: the official RPC for the wallet, the block rate, the log windows and the first blocks', () => {
  assert.equal(ROBINHOOD.rpc.primary, network.PRIMARY, 'the same record');
  assert.deepEqual({ ...network.PRIMARY }, { url: 'https://rpc.mainnet.chain.robinhood.com', stateDepth: 0, logWindow: 0, logWindows: 0, logDepth: 0, headers: false, simulate: false, gapMs: 0, perMinute: 0, inFlight: 0 }, 'named for the wallet, never read by the page: no budget of its own');
  for (const gone of ['PUBLICNODE', 'ORDOFI', 'DRPC', 'FALLBACKS', 'ORDER', 'LANE_PACE']) assert.equal(network[gone], undefined, gone);
  for (const gone of ['ROBINHOOD_PUBLICNODE_URL', 'ROBINHOOD_ORDOFI_URL', 'ROBINHOOD_DRPC_URL']) assert.equal(identity[gone], undefined, gone);
  assert.equal(network.BLOCKS_PER_SECOND, 9.9);
  assert.equal(ROBINHOOD.blocksPerSecond, network.BLOCKS_PER_SECOND);
  // The log limits and first blocks.
  assert.deepEqual([owned.LOG_BLOCKS_ONE, owned.LOG_BLOCKS_MANY, owned.FIRST_TRANSFER_BLOCK, owned.SETUP_DEPLOY_BLOCK], [10_000_000, 100_000, 9506, 69_249_061]);
  assert.deepEqual([network.LOG_BLOCKS_ONE, network.LOG_BLOCKS_MANY, network.FIRST_TRANSFER_BLOCK, network.SETUP_DEPLOY_BLOCK], [owned.LOG_BLOCKS_ONE, owned.LOG_BLOCKS_MANY, owned.FIRST_TRANSFER_BLOCK, owned.SETUP_DEPLOY_BLOCK]);
  assert.equal(owned.RPC_URL, 'local-rpc:robinhood', 'the chain code\'s reads name a sentinel only the edge\'s transport answers');
  // Nothing froze what the module made unfrozen.
  assert.equal(Object.isFrozen(network.PRIMARY), false);
});

test('the registry\'s own modules import nothing but each other, so the site\'s middleware can build its CSP from them', () => {
  const imports = (path) => [...strip(source(path)).matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]).sort();
  // Changed on purpose 2026-11-07 (Elysium as a fourth V2 chain): one import, Elysium's literals (an id and the build's
  // switch; src/lib/elysiumIdentity.ts imports nothing), so V2's chain list follows the switch.
  assert.deepEqual(imports('src/config/chainIdentity.ts'), ['../lib/elysiumIdentity']);
  assert.deepEqual(imports('src/lib/elysiumIdentity.ts'), [], 'which imports nothing');
  assert.deepEqual(imports('src/config/chainRobinhood.ts'), ['./chainIdentity']);
  assert.deepEqual(imports('src/config/chainKit.ts'), ['./chainIdentity']);
  assert.deepEqual(imports('src/config/chainElysium.ts'), ['./chainIdentity', './chainKit']);
  assert.deepEqual([...new Set(imports('src/config/chains.ts'))], ['./chainElysium', './chainIdentity', './chainKit', './chainRobinhood']);
});
