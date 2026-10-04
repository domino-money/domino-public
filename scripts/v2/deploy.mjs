#!/usr/bin/env node
/** V2 CREATE3 preparation, chain preflight and read-only verification.
 *
 * This module loads no key, signs nothing and sends nothing: every RPC call it
 * makes is a read. The tooling's only senders are Anvil instances that it
 * started or validated itself (deploy-anvil.mjs, deploy-local.mjs and
 * deploy-fork.mjs). docs/v2/DEPLOYMENT.md is the reference. */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync, rmSync, renameSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verificationRpcEndpoint, readBounded } from '../prepare-financial-release.mjs';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const CREATE_X = '0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed';
export const CREATE_X_CODE_HASH = '0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f';
/** keccak256 of CreateX's CREATE3 proxy init code 0x67363d3d37363d34f03d5260086018f3. */
export const CREATE3_PROXY_HASH = '0x21c35dbe1b344a2488cf3321d6ce542f8e9f305544ff09e4993a62319a497c1f';
/** What that init code leaves at the proxy address once it ran. */
export const CREATE3_PROXY_RUNTIME = '0x363d3d37363d34f0';
export const CONTRACT_NAMES = Object.freeze({
  registry: 'DominoRegistry', priceAnchor: 'DominoPriceAnchor', autoExit: 'DominoAutoExit',
  vaultSwap: 'DominoV2VaultSwapModule', 'vault.v3': 'DominoV2VaultV3', 'vault.v4': 'DominoV2VaultV4',
  'vaultFactory.v3': 'DominoV2VaultFactory', 'vaultFactory.v4': 'DominoV2VaultFactory',
  'zap.v4.steps': 'DominoZapV4Steps', 'zap.v3': 'DominoZapV3', 'zap.v4': 'DominoZapV4',
  'vaultExecutor.v3': 'DominoV2VaultExecutorV3', 'vaultExecutor.v4': 'DominoV2VaultExecutorV4',
});
export const DEPLOY_ORDER = Object.freeze(Object.keys(CONTRACT_NAMES).filter(k => !k.startsWith('vaultExecutor.')));
export const ROLE_NAMES = Object.freeze(['deployer', 'governance', 'guardian', 'feeRecipient', 'operator', 'publisher']);
export const POLICIES = Object.freeze({
  assistedSwapFeeBps: 65, bridgeAppFeeBps: 35, simpleCompoundFeeBps: 200, dominoCompoundFeeBps: 400,
  autoExitFeeBps: 20, automationFeeBasis: 'consumed_original_earned_fees_once_not_principal',
  additionalAutomationSwapFeeBps: 0, timelockSeconds: 86400, minTwapSeconds: 60,
  autoExitMaxObservationAgeSeconds: 300, autoExitMinTwapSeconds: 600,
  minimumUniversalRouterVersion: 212, hookedPoolsAllowed: false,
});
/** The Solidity constants each tariff policy must equal (read from the compiled AST). */
const POLICY_CONSTANTS = Object.freeze({
  'src/v2/DominoV2Types.sol': { FEE_ASSISTED_SWAP_BPS: 'assistedSwapFeeBps', FEE_AUTOMATION_SIMPLE_BPS: 'simpleCompoundFeeBps',
    FEE_AUTOMATION_DOMINO_BPS: 'dominoCompoundFeeBps', FEE_AUTO_EXIT_BPS: 'autoExitFeeBps' },
  'src/v2/registry/DominoRegistry.sol': { MIN_UNIVERSAL_ROUTER_VERSION: 'minimumUniversalRouterVersion' },
});
export const PRODUCTION = 'public-chain-preparation';
export const ENVIRONMENTS = Object.freeze([PRODUCTION, 'fork-rehearsal', 'local-test']);
export const ENABLED_CHAINS = Object.freeze([4663, 8453, 42161]);
/** The owner's deployer (issue #301). With the 0x00 flag its CREATE3 addresses are the same on every chain. */
export const PRODUCTION_DEPLOYER = '0x706627e3e75b0603c4b6f9a1ebbfc635da712747';
/** The first ten accounts of the public test mnemonic ("test test ... junk"), whose keys every Anvil and
 * Hardhat user holds; backend/v2_manifest.py refuses the same ten as production roles. */
export const PUBLIC_TEST_ACCOUNTS = Object.freeze([
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc', '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65', '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc',
  '0x976ea74026e726554db657fa54763abd0c3a0aa9', '0x14dc79964da2c08b23698b3d3cc7ca32193d9955',
  '0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f', '0xa0ee7a142d267c1f36714e4a8f75612f20a79720']);
/** EIP-7825 (Osaka): no transaction may ask for more gas. */
export const MAX_TRANSACTION_GAS = 16_777_216n;
/** Per-step gas limit = (simulated execution + live L1 component) x 125%. */
export const GAS_HEADROOM_PERCENT = 125n;
export const DEFAULT_VALIDITY_SECONDS = 86_400;
const MAX_VALIDITY_SECONDS = 7 * 86_400;
/** The canonical Safe singletons (safe-global deployments, canonical and eip155 variants), the code hash each
 * has on 4663, 8453 and 42161 (read on 2 Oct 2026) and the VERSION() it reports. */
export const SAFE_SINGLETONS = Object.freeze({
  '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': { version: '1.3.0', l2: false, codehash: '0xbba688fbdb21ad2bb58bc320638b43d94e7d100f6f3ebaab0a4e4de6304b1c2e' },
  '0x69f4d1788e39c87893c980c06edf4b7f686e2938': { version: '1.3.0', l2: false, codehash: '0xbba688fbdb21ad2bb58bc320638b43d94e7d100f6f3ebaab0a4e4de6304b1c2e' },
  '0x3e5c63644e683549055b9be8653de26e0b4cd36e': { version: '1.3.0', l2: true, codehash: '0x21842597390c4c6e3c1239e434a682b054bd9548eee5e9b1d6a4482731023c0f' },
  '0xfb1bffc9d739b8d520daf37df666da4c687191ea': { version: '1.3.0', l2: true, codehash: '0x21842597390c4c6e3c1239e434a682b054bd9548eee5e9b1d6a4482731023c0f' },
  '0x41675c099f32341bf84bfc5382af534df5c7461a': { version: '1.4.1', l2: false, codehash: '0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4' },
  '0x29fcb43b46531bca003ddc8fcb67ffe91900c762': { version: '1.4.1', l2: true, codehash: '0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff' },
  '0xff51a5898e281db6dfc7855790607438df2ca44b': { version: '1.5.0', l2: false, codehash: '0xdda019cbd7c867a533a2a86e5c53434fdc50b13122b5a5ddb4a8df61b31c20f2' },
  '0xedd160febbd92e350d4d398fb636302fccd67c7e': { version: '1.5.0', l2: true, codehash: '0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc' },
});
/** Runtime code hash of the proxy each canonical SafeProxyFactory creates (1.3.0, 1.4.1, 1.5.0). */
export const SAFE_PROXY_RUNTIME_HASHES = Object.freeze({
  '0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000': '1.3.0',
  '0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c': '1.4.1',
  '0x4e381985ca68b3e5d27b4425fa581c19cf33146d3f887a3cfca96f55528ea46f': '1.5.0',
});
const SAFE_SENTINEL = '0x0000000000000000000000000000000000000001';
const NODE_INTERFACE = '0x00000000000000000000000000000000000000c8';
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000f';
const COMPILER = Object.freeze({ version: '0.8.26+commit.8a97fa7a', optimizerRuns: 200, viaIR: true, evmVersion: 'cancun', bytecodeHash: 'none' });
const ZERO = '0x' + '0'.repeat(40);
const HEX32 = /^0x[0-9a-f]{64}$/;
const PARAMETER_KEYS = Object.freeze(['profile', 'roles', 'environment', 'sourceCommit', 'releaseTag', 'nonce', 'gasLimits',
  'maxFeePerGas', 'maxPriorityFeePerGas', 'expiresAt', 'steps', 'resumeOf']);

export const ensure = (ok, code) => { if (!ok) throw new Error(code); };
export const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export const sha256Hex = value => createHash('sha256').update(value).digest('hex');
export function toolsFor(root = repoRoot) { return createRequire(join(root, 'app/package.json'))('viem'); }
export const viem = toolsFor();
const SAFE_GUARD_SLOT = viem.keccak256(viem.toHex('guard_manager.guard.address'));
const SAFE_FALLBACK_HANDLER_SLOT = viem.keccak256(viem.toHex('fallback_manager.handler.address'));
export const CREATEX_EVENTS = Object.freeze({
  proxy: viem.keccak256(viem.toHex('Create3ProxyContractCreation(address,bytes32)')),
  creation: viem.keccak256(viem.toHex('ContractCreation(address)')),
});
const DEPLOY_CREATE3_ABI = [{ type: 'function', name: 'deployCreate3', stateMutability: 'payable',
  inputs: [{ name: 'salt', type: 'bytes32' }, { name: 'initCode', type: 'bytes' }], outputs: [{ type: 'address' }] }];

const lowerAddress = (x, allowZero = false) => {
  ensure(typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x), 'invalid_address');
  const out = x.toLowerCase(); ensure(allowZero || out !== ZERO, 'zero_address'); return out;
};
export const quantity = x => { ensure(typeof x === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(x), 'invalid_rpc_quantity'); return BigInt(x); };
const integer = (x, code = 'invalid_integer') => { ensure(typeof x === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(x), code); return BigInt(x); };
const hexQuantity = x => viem.toHex(BigInt(x));
const ceilPercent = (value, percent) => (value * percent + 99n) / 100n;
const wordAddress = word => { ensure(HEX32.test(word) && /^0x0{24}/.test(word), 'invalid_storage_address'); return '0x' + word.slice(26); };
const prepared = new WeakSet();
const compiledArtifacts = new WeakSet();
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function keys(value, expected, code) {
  const actual = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : null, wanted = [...expected].sort();
  ensure(actual && actual.length === wanted.length && actual.every((key, i) => key === wanted[i]), code);
}

// ------------------------------------------------------------------ roles

/** Owner input: exactly the six roles, each an EIP-55 checksummed, non-placeholder address. A production
 * preparation also refuses the public test mnemonic's keys. Returns the lower-case roles. */
export function validateRoleInput(roles, { production = false } = {}) {
  keys(roles, ROLE_NAMES, 'mandatory_roles_required');
  for (const name of ROLE_NAMES) {
    const value = roles[name];
    ensure(typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value), 'invalid_address');
    ensure(viem.getAddress(value) === value, 'role_address_not_checksummed: ' + name);
  }
  return checkRoleAddresses(Object.fromEntries(ROLE_NAMES.map(name => [name, roles[name].toLowerCase()])), { production });
}

/** The role rules on lower-case addresses (the manifest's form). */
export function checkRoleAddresses(roles, { production = false } = {}) {
  keys(roles, ROLE_NAMES, 'mandatory_roles_required');
  const result = Object.fromEntries(ROLE_NAMES.map(name => [name, lowerAddress(roles[name])]));
  for (const address of Object.values(result)) {
    ensure(BigInt(address) >= 65536n && !/^0x([0-9a-f])\1{39}$/.test(address), 'placeholder_role');
  }
  ensure(result.operator !== result.publisher, 'operator_publisher_conflict');
  if (production) ensure(Object.values(result).every(a => !PUBLIC_TEST_ACCOUNTS.includes(a)), 'public_test_key_as_production_role');
  return result;
}

// ------------------------------------------------------------- addresses

export function precomputeAddresses(deployer, createx = CREATE_X) {
  deployer = lowerAddress(deployer); createx = lowerAddress(createx);
  ensure(createx === CREATE_X, 'noncanonical_createx');
  const contracts = {}, salts = {}, guardedSalts = {}, proxies = {};
  for (const component of DEPLOY_ORDER) {
    const suffix = viem.keccak256(viem.toHex('domino.v2.' + component)).slice(2, 24);
    const salt = deployer + '00' + suffix;
    // CreateX guards a caller-prefixed salt before CREATE2; the raw salt would
    // predict the wrong address even though its chain byte is zero.
    const guarded = viem.keccak256(viem.encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [deployer, salt]));
    const proxy = viem.getCreate2Address({ from: createx, salt: guarded, bytecodeHash: CREATE3_PROXY_HASH }).toLowerCase();
    contracts[component] = viem.getContractAddress({ from: proxy, nonce: 1n }).toLowerCase();
    salts[component] = salt; guardedSalts[component] = guarded; proxies[component] = proxy;
  }
  for (const dex of ['v3', 'v4']) contracts['vaultExecutor.' + dex] = viem.getContractAddress({ from: contracts['vault.' + dex], nonce: 1n }).toLowerCase();
  ensure(new Set(Object.values(contracts)).size === Object.keys(contracts).length, 'address_collision');
  return { contracts, salts, guardedSalts, proxies };
}

// ---------------------------------------------------------------- compile

function gitOutput(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }); }

/** Compiles every V2 source with the pinned solc profile. `cacheDirectory` (tests only) reuses the output
 * of an identical standard-JSON input; production commands always compile. */
export function compileV2({ sourceRoot = repoRoot, cacheDirectory } = {}) {
  sourceRoot = resolve(sourceRoot);
  const sources = {};
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.sol')) sources[relative(join(sourceRoot, 'contracts'), full)] = { content: readFileSync(full, 'utf8') };
    }
  }
  walk(join(sourceRoot, 'contracts/src/v2'));
  ensure(sources['src/v2/autoexit/DominoAutoExit.sol'], 'missing_auto_exit_dependency_use_explicit_f4_source_root');
  const solc = createRequire(join(repoRoot, 'package.json'))('solc');
  ensure(solc.version().startsWith(COMPILER.version), 'compiler_pin_mismatch');
  const settings = { optimizer: { enabled: true, runs: COMPILER.optimizerRuns }, viaIR: true, evmVersion: COMPILER.evmVersion,
    metadata: { bytecodeHash: COMPILER.bytecodeHash } };
  const input = { language: 'Solidity', sources, settings: { ...settings,
    outputSelection: { '*': { '': ['ast'], '*': ['abi', 'evm.bytecode.object', 'evm.bytecode.linkReferences', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'evm.deployedBytecode.linkReferences'] } } } };
  const compileScript = join(repoRoot, 'scripts/solc-compile.cjs');
  const inputText = JSON.stringify(input);
  let raw, cacheFile;
  if (cacheDirectory) {
    cacheFile = join(cacheDirectory, sha256Hex([solc.version(), sha256Hex(readFileSync(compileScript)), inputText].join('\n')) + '.json');
    if (existsSync(cacheFile)) raw = readFileSync(cacheFile, 'utf8');
  }
  if (raw === undefined) {
    raw = execFileSync(process.execPath, [compileScript], { input: inputText, cwd: sourceRoot, maxBuffer: 512 * 1024 * 1024, timeout: 900000, encoding: 'utf8' });
    if (cacheFile) {
      // One entry per directory; a private temporary name, so parallel test processes never interleave.
      mkdirSync(cacheDirectory, { recursive: true });
      const temporary = cacheFile + '.' + process.pid + '.tmp';
      writeFileSync(temporary, raw); renameSync(temporary, cacheFile);
      for (const old of readdirSync(cacheDirectory)) if (old.endsWith('.json') && join(cacheDirectory, old) !== cacheFile) rmSync(join(cacheDirectory, old), { force: true });
    }
  }
  const compiled = JSON.parse(raw);
  const errors = (compiled.errors ?? []).filter(e => e.severity === 'error');
  ensure(!errors.length, 'v2_compile_failed: ' + errors.map(e => e.formattedMessage).join('\n'));
  const immutables = {}, constants = {};
  function visit(node, source) {
    if (node?.nodeType === 'VariableDeclaration' && node.mutability === 'immutable') immutables[node.id] = node.name;
    if (node?.nodeType === 'VariableDeclaration' && node.constant === true && POLICY_CONSTANTS[source]?.[node.name]) {
      constants[node.name] = literalNumber(node.value);
    }
    if (node && typeof node === 'object') for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, source)); else if (value && typeof value === 'object') visit(value, source);
    }
  }
  for (const [file, output] of Object.entries(compiled.sources)) visit(output.ast, file);
  checkPolicyConstants(constants);
  const contracts = {};
  for (const name of new Set(Object.values(CONTRACT_NAMES))) {
    const matches = Object.entries(compiled.contracts).flatMap(([file, byName]) => byName[name] ? [[file, byName[name]]] : []);
    ensure(matches.length === 1, 'missing_or_ambiguous_component: ' + name);
    contracts[name] = { source: matches[0][0], ...matches[0][1] };
  }
  const sourceCommit = gitOutput(sourceRoot, ['rev-parse', 'HEAD']).trim();
  const sourceHashes = Object.fromEntries(Object.entries(sources).map(([p, s]) => [p, sha256Hex(s.content)]));
  const status = paths => gitOutput(sourceRoot, ['status', '--porcelain', '--untracked-files=all', '--', ...paths]).trim().length > 0;
  const sourceState = { sourceTreeSha256: sha256Hex(canonical(sourceHashes)), workingTreeSourceChanges: status(['contracts/src/v2']),
    // The tool, its fixtures and the chain profiles are part of what a public package attests.
    workingTreeToolChanges: status(['scripts/v2', 'api-contracts/v2', 'scripts/solc-compile.cjs']) };
  const result = { contracts, immutables, policyConstants: constants, sourceCommit, sourceHashes, sourceState, sourceRoot,
    standardInput: { language: 'Solidity', sources, settings }, compiler: { ...COMPILER } };
  compiledArtifacts.add(result); return freeze(result);
}

/** A Solidity AST number literal's value; NaN for anything else, which no policy equals. */
export const literalNumber = node => node?.nodeType === 'Literal' && node.kind === 'number' && /^[0-9]+$/.test(node.value) ? Number(node.value) : NaN;

/** The tariffs this tooling records as policies are the constants the compiled contracts enforce. */
export function checkPolicyConstants(constants) {
  for (const names of Object.values(POLICY_CONSTANTS)) for (const [name, policy] of Object.entries(names)) {
    ensure(constants[name] === POLICIES[policy], 'policy_constant_mismatch: ' + name);
  }
  return constants;
}

// --------------------------------------------------------------- profiles

export function dependencyMap(profile) {
  return Object.fromEntries(Object.entries({
    v3Factory: profile.uniswap.v3.factory, v3PositionManager: profile.uniswap.v3.positionManager,
    v3Quoter: profile.uniswap.v3.quoterV2, v3SwapRouter: profile.uniswap.v3.swapRouter02,
    v4PoolManager: profile.uniswap.v4.poolManager, v4PositionManager: profile.uniswap.v4.positionManager,
    v4StateView: profile.uniswap.v4.stateView, v4Quoter: profile.uniswap.v4.quoter,
    universalRouter: profile.uniswap.universalRouter.address, permit2: profile.permit2,
    wrappedNative: profile.wrappedNative.address,
  }).map(([k, v]) => [k, lowerAddress(v)]));
}
function profileHashes(profile, deps, environment) {
  ensure(profile.enabled === true && Number.isSafeInteger(profile.chainId) && profile.chainId > 0
    && (ENABLED_CHAINS.includes(profile.chainId) || environment === 'local-test'), 'unsupported_chain_profile');
  ensure(profile.deployer.address.toLowerCase() === CREATE_X && profile.deployer.codehash === CREATE_X_CODE_HASH, 'createx_profile_mismatch');
  const version = profile.uniswap.universalRouter.version.split('.').map(Number);
  ensure(version.length === 3 && version.every(Number.isSafeInteger)
    && (version[0] > 2 || (version[0] === 2 && (version[1] > 1 || (version[1] === 1 && version[2] >= 2)))), 'universal_router_version_too_old');
  ensure(HEX32.test(profile.uniswap.v3.poolInitCodeHash), 'invalid_pool_init_code_hash');
  ensure(profile.bridge?.appFeeBps === POLICIES.bridgeAppFeeBps, 'policy_bridge_fee_mismatch');
  const expected = {};
  for (const [name, addr] of Object.entries(deps)) {
    const rows = profile.verification.contracts.filter(row => row.address.toLowerCase() === addr);
    const hashes = new Set(rows.filter(row => HEX32.test(row.codehash ?? '')).map(row => row.codehash));
    ensure(hashes.size === 1, 'dependency_hash_missing_or_conflicting: ' + name); expected[name] = [...hashes][0];
  }
  return expected;
}
function domainHash(chainId, addr) {
  return viem.keccak256(viem.encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [viem.keccak256(viem.toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), viem.keccak256(viem.toHex('Domino')), viem.keccak256(viem.toHex('2')), BigInt(chainId), addr]));
}
export function expectedRuntime(component, artifacts, manifest, profile) {
  const artifact = artifacts.contracts[CONTRACT_NAMES[component]], refs = artifact.evm.deployedBytecode.immutableReferences;
  ensure(!Object.keys(artifact.evm.bytecode.linkReferences).length && !Object.keys(artifact.evm.deployedBytecode.linkReferences).length, 'unlinked_component');
  const bytes = Buffer.from(artifact.evm.deployedBytecode.object, 'hex');
  ensure(bytes.length > 0 && bytes.length <= 24576, 'runtime_size_limit: ' + component);
  const c = manifest.contracts, d = manifest.dependencies, dex = component.endsWith('.v3') ? 3 : 4;
  const pm = dex === 3 ? d.v3PositionManager : d.v4PositionManager;
  const addr = c[component];
  const values = {
    registry: c.registry, FEE_REGISTRY: c.registry, ROUTE_REGISTRY: c.registry, REGISTRY: c.registry,
    v3Factory: d.v3Factory, V3_FACTORY: d.v3Factory, v3PoolInitCodeHash: profile.uniswap.v3.poolInitCodeHash,
    V3_POOL_INIT_CODE_HASH: profile.uniswap.v3.poolInitCodeHash, v4StateView: d.v4StateView,
    minTwapSeconds: component === 'autoExit' ? POLICIES.autoExitMinTwapSeconds : POLICIES.minTwapSeconds,
    maxObservationAgeSeconds: POLICIES.autoExitMaxObservationAgeSeconds,
    _cachedChainId: manifest.chain.chainId, _cachedThis: addr, _cachedDomainSeparator: domainHash(manifest.chain.chainId, addr),
    priceAnchor: c.priceAnchor, PRICE_ANCHOR: c.priceAnchor, PERMIT2: d.permit2, V4_POOL_MANAGER: d.v4PoolManager,
    DEX: dex, dex, FACTORY: c['vaultFactory.v' + dex], factory: c['vaultFactory.v' + dex],
    POSITION_MANAGER: pm, positionManager: pm, SWAP_MODULE: c.vaultSwap, AUTO_EXIT: c.autoExit,
    EXECUTOR: c['vaultExecutor.v' + dex], SELF: addr, POOL_MANAGER: d.v4PoolManager,
    WRAPPED_NATIVE: d.wrappedNative, STEPS: c['zap.v4.steps'], implementation: c['vault.v' + dex],
  };
  const occupied = new Set();
  for (const [id, ranges] of Object.entries(refs ?? {})) {
    const name = artifacts.immutables[id];
    ensure(Object.hasOwn(values, name), 'unknown_immutable: ' + component + ':' + name);
    const value = values[name];
    const hex = typeof value === 'string' ? value.slice(2) : BigInt(value).toString(16);
    ensure(hex.length <= 64, 'immutable_overflow');
    const word = Buffer.from(hex.padStart(64, '0'), 'hex');
    for (const { start, length } of ranges) {
      ensure(length === 32 && start >= 0 && start + length <= bytes.length, 'invalid_immutable_range');
      for (let i = start; i < start + length; i++) { ensure(!occupied.has(i), 'overlapping_immutable_range'); occupied.add(i); }
      word.copy(bytes, start);
    }
  }
  return '0x' + bytes.toString('hex');
}

// ----------------------------------------------------------- preparation

/** The unsigned package: a pure function of `parameters` and the compiled sources. Every field is explicit,
 * so `verify`, `preflight` and `resume` rebuild a supplied package and compare it byte for byte. */
export function prepareDeployment(parameters, artifacts) {
  ensure(compiledArtifacts.has(artifacts), 'preparation_requires_source_compilation');
  keys(parameters, PARAMETER_KEYS, 'invalid_preparation_parameters');
  const { profile, environment } = parameters;
  ensure(ENVIRONMENTS.includes(environment), 'invalid_environment');
  const production = environment === PRODUCTION;
  const roles = validateRoleInput(parameters.roles, { production }), deps = dependencyMap(profile);
  const dependencyHashes = profileHashes(profile, deps, environment);
  ensure(parameters.sourceCommit === artifacts.sourceCommit && /^[0-9a-f]{40}$/.test(parameters.sourceCommit), 'source_commit_mismatch');
  ensure(typeof parameters.releaseTag === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(parameters.releaseTag), 'invalid_release_tag');
  const steps = parameters.steps;
  ensure(Array.isArray(steps) && steps.length > 0 && steps.every(s => DEPLOY_ORDER.includes(s))
    && steps.every((s, i) => i === 0 || DEPLOY_ORDER.indexOf(steps[i - 1]) < DEPLOY_ORDER.indexOf(s)), 'invalid_step_selection');
  // A package that leaves components out continues an earlier one (resume) and names it.
  ensure(steps.length === DEPLOY_ORDER.length ? parameters.resumeOf === null
    : typeof parameters.resumeOf === 'string' && /^[0-9a-f]{64}$/.test(parameters.resumeOf), 'invalid_resume_reference');
  keys(parameters.gasLimits, steps, 'gas_limits_must_cover_each_step');
  const gasLimits = Object.fromEntries(steps.map(s => [s, integer(parameters.gasLimits[s], 'invalid_gas_limit')]));
  ensure(Object.values(gasLimits).every(g => g >= 21000n && g <= MAX_TRANSACTION_GAS), 'gas_limit_out_of_bounds');
  const nonce = integer(parameters.nonce), fee = integer(parameters.maxFeePerGas), tip = integer(parameters.maxPriorityFeePerGas);
  ensure(nonce + BigInt(steps.length) < 2n ** 64n - 1n && fee > 0n && fee < 2n ** 128n && tip <= fee, 'invalid_transaction_budget');
  ensure(Number.isSafeInteger(parameters.expiresAt) && parameters.expiresAt > 0, 'invalid_expiry');
  const { contracts, salts, guardedSalts, proxies } = precomputeAddresses(roles.deployer);
  ensure(Object.values(roles).every(addr => !Object.values(contracts).includes(addr) && addr !== CREATE_X), 'role_component_conflict');
  const charge = profile.chargeCurrencies.map(x => ({ token: lowerAddress(x.address, true), rank: x.rank }));
  ensure(charge.length >= 2 && charge.every(x => Number.isInteger(x.rank) && x.rank > 0 && x.rank < 256)
    && new Set(charge.map(x => x.token)).size === charge.length, 'invalid_charge_currencies');
  const route = { registry: contracts.registry, permit2: deps.permit2, v3Factory: deps.v3Factory,
    v3PoolInitCodeHash: profile.uniswap.v3.poolInitCodeHash, v4PoolManager: deps.v4PoolManager };
  const vaultDeployment = dex => ({ factory: contracts['vaultFactory.' + dex], registry: contracts.registry,
    priceAnchor: contracts.priceAnchor, positionManager: deps[dex === 'v3' ? 'v3PositionManager' : 'v4PositionManager'], swapModule: contracts.vaultSwap, autoExit: contracts.autoExit });
  const args = {
    registry: [{ governance: roles.governance, guardian: roles.guardian, timelockSeconds: POLICIES.timelockSeconds, feeRecipient: roles.feeRecipient,
      operators: [roles.operator], publishers: [roles.publisher], routers: [deps.universalRouter], chargeCurrencies: charge }],
    priceAnchor: [contracts.registry, deps.v3Factory, profile.uniswap.v3.poolInitCodeHash, deps.v4StateView, POLICIES.minTwapSeconds],
    autoExit: [route, contracts.priceAnchor, POLICIES.autoExitMaxObservationAgeSeconds, POLICIES.autoExitMinTwapSeconds], vaultSwap: [route],
    'vault.v3': [vaultDeployment('v3')], 'vault.v4': [vaultDeployment('v4')],
    'vaultFactory.v3': [contracts['vault.v3']], 'vaultFactory.v4': [contracts['vault.v4']],
    'zap.v4.steps': [], 'zap.v3': [route, deps.v3PositionManager], 'zap.v4': [route, deps.v4PositionManager, contracts['zap.v4.steps']],
  };
  const p = structuredClone(parameters);
  const manifest = {
    schemaVersion: 1, kind: 'domino-v2-deployment', status: 'prepared', environment,
    chain: { name: profile.name, chainId: profile.chainId, nativeCurrency: profile.nativeSymbol },
    sourceCommit: p.sourceCommit, releaseTag: p.releaseTag, contractNames: { ...CONTRACT_NAMES }, contracts,
    dependencies: deps, roles, policies: { ...POLICIES }, chargeCurrencies: charge, runtimeCodeHashes: { ...dependencyHashes },
    createx: { address: CREATE_X, runtimeCodeHash: CREATE_X_CODE_HASH, salts, guardedSalts },
    build: { ...artifacts.compiler, sourceTreeSha256: artifacts.sourceState.sourceTreeSha256,
      workingTreeSourceChanges: artifacts.sourceState.workingTreeSourceChanges, sourceHashes: artifacts.sourceHashes,
      chainProfileSha256: sha256Hex(canonical(profile)) },
    deploymentReceipts: {}, verification: null,
  };
  for (const component of Object.keys(CONTRACT_NAMES)) manifest.runtimeCodeHashes[component] = viem.keccak256(expectedRuntime(component, artifacts, manifest, profile));
  const components = {}, calldata = {};
  for (const component of DEPLOY_ORDER) {
    const artifact = artifacts.contracts[CONTRACT_NAMES[component]];
    const init = viem.encodeDeployData({ abi: artifact.abi, bytecode: '0x' + artifact.evm.bytecode.object, args: args[component] });
    ensure((init.length - 2) / 2 <= 49152, 'initcode_size_limit: ' + component);
    calldata[component] = viem.encodeFunctionData({ abi: DEPLOY_CREATE3_ABI, functionName: 'deployCreate3', args: [salts[component], init] });
    components[component] = { expectedAddress: contracts[component], create3Proxy: proxies[component], salt: salts[component],
      guardedSalt: guardedSalts[component], initcodeHash: viem.keccak256(init), callDataHash: viem.keccak256(calldata[component]) };
  }
  const chainId = hexQuantity(profile.chainId);
  const unsigned = steps.map((component, index) => ({ component, expectedAddress: contracts[component], create3Proxy: proxies[component],
    salt: salts[component], guardedSalt: guardedSalts[component], constructorArguments: args[component], initcodeHash: components[component].initcodeHash,
    transaction: { from: roles.deployer, to: CREATE_X, data: calldata[component], type: '0x2', chainId, nonce: hexQuantity(nonce + BigInt(index)),
      gas: hexQuantity(gasLimits[component]), value: '0x0', maxFeePerGas: hexQuantity(fee), maxPriorityFeePerGas: hexQuantity(tip), accessList: [] } }));
  const result = { schemaVersion: 2, kind: 'domino-v2-unsigned-deployment', parameters: p, manifest, components, steps: unsigned,
    maximumExecutionGasCostWei: steps.reduce((sum, s) => sum + gasLimits[s] * fee, 0n).toString(),
    l1DataFees: 'nitro_l1_component_inside_gas_limits_op_l1_fee_in_preflight' };
  prepared.add(result); return freeze(result);
}

export const packageDigest = bundle => sha256Hex(canonical(bundle));

/** All eleven steps of a package's deployment (gas and fees aside, a resume package's steps are a subset of
 * these): what the gas simulation replays in order, and what explorers verify. */
export function fullPackage(bundle, artifacts) {
  ensure(prepared.has(bundle), 'full_package_requires_fresh_authenticated_preparation');
  return prepareDeployment({ ...bundle.parameters, steps: [...DEPLOY_ORDER], resumeOf: null,
    gasLimits: Object.fromEntries(DEPLOY_ORDER.map(c => [c, MAX_TRANSACTION_GAS.toString()])) }, artifacts);
}

/** Rebuilds a package read from disk from its own parameters and the current compile; any edit is refused. */
export function rebuildPackage(supplied, artifacts) {
  ensure(supplied && typeof supplied === 'object' && supplied.schemaVersion === 2 && supplied.kind === 'domino-v2-unsigned-deployment', 'unsupported_package');
  const rebuilt = prepareDeployment(supplied.parameters, artifacts);
  ensure(canonical(rebuilt) === canonical(supplied), 'unsigned_package_changed');
  return rebuilt;
}

// --------------------------------------------------------------------- RPC

const RATE_LIMITED = body => [429, -32005, -32016].includes(body?.error?.code) || /rate limit|too many requests/i.test(String(body?.error?.message ?? ''));
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
/** A local EVM's error message helps; a remote node's is never echoed (it may quote a keyed URL). */
export function rpcErrorReason(endpoint, body) {
  if (!LOOPBACK_HOSTS.includes(new URL(endpoint).hostname) || !body?.error) return '';
  return ' (' + String(body.error.message ?? '').replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 200) + ')';
}
/** The largest JSON-RPC reply this tool reads; bytecode, blocks and receipts stay far below it (audit DV2-05). */
export const RPC_REPLY_MAX_BYTES = 8 * 1024 * 1024;

/** A reply's text, refused once it passes `max` bytes, before the rest is read. */
async function boundedReply(response, max) {
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > max) throw new Error('rpc_reply_too_large'); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

/** A JSON-RPC 2.0 reply to request `id`: exactly one of result and error. An error may carry a null id (the spec's
 * answer when the request id could not be read); a result never does. */
function validReply(body, id) {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== '2.0') return false;
  const hasResult = Object.hasOwn(body, 'result'), hasError = Object.hasOwn(body, 'error');
  if (hasResult === hasError) return false;
  if (hasError) return body.error !== null && typeof body.error === 'object' && (body.id === id || body.id === null);
  return body.id === id;
}

/** JSON-RPC over HTTP. A rate-limit answer (HTTP 429, -32005, -32016) is retried with backoff, at most five
 * times; any other failure is final. A reply is read up to `maxReplyBytes` and must answer the request it was
 * sent for (rpc_reply_too_large, rpc_invalid_reply). Errors never carry the URL. */
export function makeRpc(url, { retryDelays = [1000, 2000, 4000, 8000, 8000], maxReplyBytes = RPC_REPLY_MAX_BYTES } = {}) {
  const endpoint = new URL(url); ensure(['http:', 'https:'].includes(endpoint.protocol), 'invalid_rpc_url');
  let id = 0;
  return async (method, params = []) => {
    for (let attempt = 0; ; attempt++) {
      const requestId = ++id;
      let body, limited = false, text;
      try {
        const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }), signal: AbortSignal.timeout(60000) });
        limited = response.status === 429;
        if (limited) await response.body?.cancel().catch(() => {});
        else { ensure(response.ok, 'rpc_http_failed'); text = await boundedReply(response, maxReplyBytes); }
      } catch (error) {
        throw new Error((error.message === 'rpc_reply_too_large' ? 'rpc_reply_too_large: ' : 'rpc_transport_failed: ') + method);
      }
      if (!limited) {
        try { body = JSON.parse(text); } catch { throw new Error('rpc_invalid_reply: ' + method); }
        ensure(validReply(body, requestId), 'rpc_invalid_reply: ' + method);
        limited = RATE_LIMITED(body);
      }
      if (limited && attempt < retryDelays.length) { await new Promise(done => setTimeout(done, retryDelays[attempt])); continue; }
      ensure(body && !body.error && Object.hasOwn(body, 'result'), 'rpc_method_failed: ' + method + rpcErrorReason(url, body)); return body.result;
    }
  };
}

const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_call',
  'eth_getBalance', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_maxPriorityFeePerGas',
  'web3_clientVersion', 'anvil_metadata']);
/** The production commands' transport: reads only, bounded in calls and time, never the URL in an error. */
export function readOnlyRpc(endpoint, { maximumCalls = 2000, seconds = 900 } = {}) {
  const transport = makeRpc(endpoint), end = Date.now() + seconds * 1000;
  let calls = 0;
  return async (method, params) => {
    ensure(READ_METHODS.has(method), 'rpc_method_not_read_only: ' + method);
    ensure(++calls <= maximumCalls && Date.now() < end, 'readonly_rpc_budget');
    return transport(method, params);
  };
}

export async function pinBlock(rpc, tag = 'latest') {
  const block = await rpc('eth_getBlockByNumber', [tag, false]);
  ensure(block && HEX32.test(block.hash), 'block_missing: ' + tag);
  return { tag: block.number, number: quantity(block.number), hash: block.hash, timestamp: quantity(block.timestamp),
    baseFeePerGas: block.baseFeePerGas === undefined || block.baseFeePerGas === null ? 0n : quantity(block.baseFeePerGas) };
}

async function call(rpc, to, signature, inputs, outputs, tag, from) {
  const args = inputs.map(x => x.value);
  const data = viem.concatHex([viem.toFunctionSelector(signature), inputs.length ? viem.encodeAbiParameters(inputs.map(x => ({ type: x.type })), args) : '0x']);
  const raw = await rpc('eth_call', [{ ...(from ? { from } : {}), to, data }, tag]);
  return viem.decodeAbiParameters(outputs.map(type => ({ type })), raw);
}

/** A public preparation never runs against a development EVM, whatever chain id it reports. */
export async function refuseDevelopmentChain(rpc) {
  const client = await rpc('web3_clientVersion', []);
  ensure(typeof client === 'string' && !/anvil|hardhat|ganache|tenderly/i.test(client), 'development_chain_refused_for_public_preparation');
  let answered = false;
  try { await rpc('anvil_metadata', []); answered = true; } catch { /* a real node does not know the method */ }
  ensure(!answered, 'development_chain_refused_for_public_preparation');
  return client;
}

export async function checkDependencies(profile, rpc, block = 'latest') {
  const deps = dependencyMap(profile), hashes = profileHashes(profile, deps, 'local-test');
  ensure(quantity(await rpc('eth_chainId', [])) === BigInt(profile.chainId), 'chain_id_mismatch');
  for (const [name, addr] of Object.entries({ createx: CREATE_X, ...deps })) {
    const code = await rpc('eth_getCode', [addr, block]);
    ensure(code !== '0x' && viem.keccak256(code) === (name === 'createx' ? CREATE_X_CODE_HASH : hashes[name]), 'dependency_codehash_mismatch: ' + name);
  }
  for (const currency of profile.chargeCurrencies) {
    const addr = lowerAddress(currency.address, true);
    if (addr === ZERO) continue;
    const rows = profile.verification.contracts.filter(row => row.address.toLowerCase() === addr);
    const hashes = new Set(rows.filter(row => HEX32.test(row.codehash ?? '')).map(row => row.codehash));
    ensure(hashes.size === 1, 'charge_currency_hash_missing');
    ensure(viem.keccak256(await rpc('eth_getCode', [addr, block])) === [...hashes][0], 'charge_currency_codehash_mismatch');
  }
  // The dependencies point at each other as the profile says.
  for (const [contract, signature, expected, code] of [
    [deps.v3PositionManager, 'factory()', deps.v3Factory, 'v3_manager_factory_mismatch'],
    [deps.v3PositionManager, 'WETH9()', deps.wrappedNative, 'wrapped_native_mismatch'],
    [deps.v3Quoter, 'factory()', deps.v3Factory, 'v3_quoter_factory_mismatch'],
    [deps.v3SwapRouter, 'factory()', deps.v3Factory, 'v3_router_factory_mismatch'],
    [deps.v4PositionManager, 'poolManager()', deps.v4PoolManager, 'v4_manager_pool_mismatch'],
    [deps.v4PositionManager, 'permit2()', deps.permit2, 'v4_manager_permit2_mismatch'],
    [deps.v4StateView, 'poolManager()', deps.v4PoolManager, 'v4_state_view_pool_mismatch'],
    [deps.v4Quoter, 'poolManager()', deps.v4PoolManager, 'v4_quoter_pool_mismatch'],
  ]) {
    const [value] = await call(rpc, contract, signature, [], ['address'], block);
    ensure(lowerAddress(value, true) === expected, code);
  }
  return hashes;
}

/** Governance must be a deployed canonical Safe that two keys must agree to move: a canonical proxy, a
 * canonical singleton (1.3.0 to 1.5.0, L1 or L2) with its code and version, threshold >= 2, owners >=
 * threshold, no module (a module bypasses the threshold) and no guard. An owner that also holds a Domino
 * role is the owner's choice (2 Oct 2026: the deployer and the guardian sign the Safe): a warning, never a
 * refusal. */
export async function inspectGovernance(address, rpc, tag, roles) {
  address = lowerAddress(address);
  const code = await rpc('eth_getCode', [address, tag]);
  ensure(code !== '0x', 'governance_has_no_code');
  const proxyVersion = SAFE_PROXY_RUNTIME_HASHES[viem.keccak256(code)];
  ensure(proxyVersion, 'governance_not_a_safe_proxy');
  const singleton = wordAddress(await rpc('eth_getStorageAt', [address, '0x0', tag]));
  const info = SAFE_SINGLETONS[singleton];
  ensure(info, 'governance_singleton_not_canonical');
  ensure(viem.keccak256(await rpc('eth_getCode', [singleton, tag])) === info.codehash, 'governance_singleton_code_mismatch');
  const [version] = await call(rpc, address, 'VERSION()', [], ['string'], tag);
  ensure(version === info.version, 'governance_version_mismatch');
  const [threshold] = await call(rpc, address, 'getThreshold()', [], ['uint256'], tag);
  const owners = (await call(rpc, address, 'getOwners()', [], ['address[]'], tag))[0].map(o => o.toLowerCase());
  ensure(threshold >= 2n, 'governance_threshold_below_two');
  ensure(BigInt(owners.length) >= threshold && new Set(owners).size === owners.length
    && owners.every(o => o !== ZERO && o !== SAFE_SENTINEL), 'governance_owners_invalid');
  const [modules] = await call(rpc, address, 'getModulesPaginated(address,uint256)', [{ type: 'address', value: SAFE_SENTINEL }, { type: 'uint256', value: 10n }], ['address[]', 'address'], tag);
  ensure(modules.length === 0, 'governance_has_modules');
  ensure(BigInt(await rpc('eth_getStorageAt', [address, SAFE_GUARD_SLOT, tag])) === 0n, 'governance_has_guard');
  // A Safe never owns itself (setupOwners refuses it), so only the other roles can appear among its owners.
  const warnings = ROLE_NAMES.filter(name => owners.includes(roles[name])).map(name => 'governance_owner_holds_role: ' + name);
  return { checked: true, address, kind: 'safe', proxyVersion, singleton, version, l2: info.l2, threshold: Number(threshold), owners,
    modules: [], guard: ZERO, fallbackHandler: wordAddress(await rpc('eth_getStorageAt', [address, SAFE_FALLBACK_HANDLER_SLOT, tag])), warnings };
}

/** The L1 data cost of each step. Nitro (Robinhood, Arbitrum) charges it as extra L2 gas inside the gas
 * limit (NodeInterface.gasEstimateL1Component); OP Stack (Base) charges an L1 fee in wei on top
 * (GasPriceOracle.getL1Fee of the unsigned serialized transaction). */
export async function l1Costs(profile, steps, rpc, { required = true, from } = {}) {
  ensure(['arbitrum-nitro', 'op-stack'].includes(profile.stack), 'unsupported_chain_stack');
  const result = {};
  try {
    if (profile.stack === 'arbitrum-nitro') {
      for (const step of steps) {
        const [gas, baseFee, l1BaseFee] = await call(rpc, NODE_INTERFACE, 'gasEstimateL1Component(address,bool,bytes)',
          [{ type: 'address', value: CREATE_X }, { type: 'bool', value: false }, { type: 'bytes', value: step.transaction.data }],
          ['uint64', 'uint256', 'uint256'], 'latest', from);
        result[step.component] = { l1Gas: gas.toString(), l1FeeWei: '0', l2BaseFee: baseFee.toString(), l1BaseFeeEstimate: l1BaseFee.toString() };
      }
      return { status: 'estimated', method: 'NodeInterface.gasEstimateL1Component', steps: result };
    }
    for (const step of steps) {
      const t = step.transaction;
      const serialized = viem.serializeTransaction({ type: 'eip1559', chainId: Number(quantity(t.chainId)), nonce: Number(quantity(t.nonce)),
        gas: quantity(t.gas), maxFeePerGas: quantity(t.maxFeePerGas), maxPriorityFeePerGas: quantity(t.maxPriorityFeePerGas),
        to: t.to, value: 0n, data: t.data, accessList: [] });
      const [fee] = await call(rpc, GAS_PRICE_ORACLE, 'getL1Fee(bytes)', [{ type: 'bytes', value: serialized }], ['uint256'], 'latest');
      result[step.component] = { l1Gas: '0', l1FeeWei: fee.toString() };
    }
    return { status: 'estimated', method: 'GasPriceOracle.getL1Fee', steps: result };
  } catch {
    ensure(!required, 'l1_estimate_unavailable');
    // A local EVM charges no L1 cost; only non-production packages accept the gap.
    return { status: 'unavailable', method: null, steps: Object.fromEntries(steps.map(s => [s.component, { l1Gas: '0', l1FeeWei: '0' }])) };
  }
}

/** What the chain holds at each predicted address: `empty` (component and its CREATE3 proxy have no code)
 * or `deployed` (the exact expected runtime, and CreateX's spent proxy). Anything else is refused. */
export async function deploymentState(bundle, rpc, tag) {
  const state = {}, m = bundle.manifest;
  for (const component of DEPLOY_ORDER) {
    const entry = bundle.components[component];
    const code = await rpc('eth_getCode', [entry.expectedAddress, tag]), proxyCode = await rpc('eth_getCode', [entry.create3Proxy, tag]);
    if (code === '0x' && proxyCode === '0x') { state[component] = 'empty'; continue; }
    ensure(code !== '0x' && viem.keccak256(code) === m.runtimeCodeHashes[component] && proxyCode === CREATE3_PROXY_RUNTIME,
      'component_address_conflict: ' + component);
    state[component] = 'deployed';
  }
  for (const dex of ['v3', 'v4']) {
    const executor = 'vaultExecutor.' + dex, code = await rpc('eth_getCode', [m.contracts[executor], tag]);
    ensure(state['vault.' + dex] === 'deployed' ? code !== '0x' && viem.keccak256(code) === m.runtimeCodeHashes[executor] : code === '0x',
      'component_address_conflict: ' + executor);
    state[executor] = state['vault.' + dex];
  }
  return state;
}

/** Everything the owner's signature depends on, read at one pinned block. Refuses unless the chain, the
 * dependencies, governance, the deployer's nonce and funds, the gas limits and the target addresses are
 * what this package assumes. `simulatedGas` maps each component to its measured execution gas. */
export async function preflightDeployment(bundle, { rpc, l1Rpc = rpc, simulatedGas, now = Math.floor(Date.now() / 1000), requireSafeGovernance = false }) {
  ensure(prepared.has(bundle), 'preflight_requires_fresh_authenticated_preparation');
  const p = bundle.parameters, m = bundle.manifest, profile = p.profile, production = p.environment === PRODUCTION;
  ensure(Number.isSafeInteger(now) && now < p.expiresAt, 'package_expired');
  const block = await pinBlock(rpc, 'latest'), tag = block.tag;
  const client = production ? await refuseDevelopmentChain(rpc) : await rpc('web3_clientVersion', []);
  await checkDependencies(profile, rpc, tag);
  const roles = m.roles;
  const governance = production || requireSafeGovernance ? await inspectGovernance(roles.governance, rpc, tag, roles)
    : { checked: false, reason: 'safe_governance_required_only_for_public_preparation' };
  const roleCode = {};
  for (const name of ROLE_NAMES) roleCode[name] = (await rpc('eth_getCode', [roles[name], tag])) !== '0x';
  const nonce = quantity(await rpc('eth_getTransactionCount', [roles.deployer, tag]));
  ensure(nonce === BigInt(p.nonce), 'deployer_nonce_mismatch');
  ensure(quantity(await rpc('eth_getTransactionCount', [roles.deployer, 'pending'])) === nonce, 'deployer_has_pending_transactions');
  const state = await deploymentState(bundle, rpc, tag), sending = new Set(p.steps);
  for (const component of DEPLOY_ORDER) {
    ensure(!sending.has(component) || state[component] === 'empty', 'component_already_deployed: ' + component);
    ensure(sending.has(component) || state[component] === 'deployed', 'resume_prerequisite_missing: ' + component);
  }
  const l1 = await l1Costs(profile, bundle.steps, l1Rpc, { required: production, from: roles.deployer });
  const maxFee = BigInt(p.maxFeePerGas);
  ensure(maxFee >= block.baseFeePerGas, 'max_fee_below_base_fee');
  const steps = [];
  let worstCase = 0n, gasTotal = 0n, l1Total = 0n;
  for (const step of bundle.steps) {
    ensure(simulatedGas && typeof simulatedGas[step.component] === 'string', 'gas_simulation_missing: ' + step.component);
    const simulated = integer(simulatedGas[step.component]), cost = l1.steps[step.component];
    const l1Gas = BigInt(cost.l1Gas), l1Fee = ceilPercent(BigInt(cost.l1FeeWei), GAS_HEADROOM_PERCENT);
    const limit = quantity(step.transaction.gas), required = simulated + l1Gas;
    ensure(limit >= required, 'gas_limit_below_requirement: ' + step.component);
    const worst = limit * maxFee + l1Fee;
    worstCase += worst; gasTotal += limit; l1Total += l1Fee;
    steps.push({ component: step.component, nonce: Number(quantity(step.transaction.nonce)), gasLimit: limit.toString(),
      simulatedExecutionGas: simulated.toString(), l1Gas: l1Gas.toString(), l1FeeWei: cost.l1FeeWei,
      headroomGas: (limit - required).toString(), worstCaseWei: worst.toString() });
  }
  const balance = quantity(await rpc('eth_getBalance', [roles.deployer, tag]));
  ensure(balance >= worstCase, 'deployer_balance_insufficient');
  const again = await rpc('eth_getBlockByNumber', [tag, false]);
  ensure(again?.hash === block.hash, 'preflight_anchor_reorg');
  return { schemaVersion: 1, kind: 'domino-v2-deployment-preflight', status: 'passed', environment: p.environment, warnings: governance.warnings ?? [],
    packageSha256: packageDigest(bundle), resumeOf: p.resumeOf, checkedAt: new Date(now * 1000).toISOString(), expiresAt: p.expiresAt,
    chain: { chainId: profile.chainId, client, block: { number: Number(block.number), hash: block.hash, baseFeePerGas: block.baseFeePerGas.toString() } },
    dependencies: 'codehashes_and_cross_references_matched', governance, roleHasCode: roleCode,
    deployer: { address: roles.deployer, nonce: nonce.toString(), balanceWei: balance.toString() },
    components: state, l1: { status: l1.status, method: l1.method },
    fees: { maxFeePerGas: p.maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas },
    steps, funding: { worstCaseWei: worstCase.toString(), balanceWei: balance.toString(), marginWei: (balance - worstCase).toString(),
      gasLimitTotal: gasTotal.toString(), l1FeesWithHeadroomWei: l1Total.toString(),
      maxFeeCeilingWei: gasTotal === 0n ? '0' : ((balance - l1Total) / gasTotal).toString() } };
}

/** Prepares a package from the chain's current state: the deployer's nonce, the remaining components (on
 * resume), simulated execution gas and live L1 costs for per-step limits, and fees from the pinned block. */
export async function planDeployment({ profile, roles, environment, releaseTag, artifacts, rpc, l1Rpc = rpc, simulate, now = Math.floor(Date.now() / 1000),
  validitySeconds = DEFAULT_VALIDITY_SECONDS, maxFeePerGas, maxPriorityFeePerGas, resumeFrom }) {
  ensure(typeof simulate === 'function', 'gas_simulator_required');
  ensure(Number.isSafeInteger(validitySeconds) && validitySeconds > 0 && validitySeconds <= MAX_VALIDITY_SECONDS, 'invalid_validity');
  if (resumeFrom) {
    ensure(prepared.has(resumeFrom), 'resume_requires_fresh_authenticated_preparation');
    ({ profile, roles, environment, releaseTag } = resumeFrom.parameters);
  }
  const production = environment === PRODUCTION;
  const lower = validateRoleInput(roles, { production });
  const block = await pinBlock(rpc, 'latest');
  ensure(quantity(await rpc('eth_chainId', [])) === BigInt(profile.chainId), 'chain_id_mismatch');
  const nonce = quantity(await rpc('eth_getTransactionCount', [lower.deployer, block.tag]));
  ensure(quantity(await rpc('eth_getTransactionCount', [lower.deployer, 'pending'])) === nonce, 'deployer_has_pending_transactions');
  const base = { profile, roles, environment, sourceCommit: artifacts.sourceCommit, releaseTag, nonce: nonce.toString(),
    maxFeePerGas: '1', maxPriorityFeePerGas: '0', expiresAt: now + validitySeconds };
  const probe = prepareDeployment({ ...base, gasLimits: Object.fromEntries(DEPLOY_ORDER.map(c => [c, MAX_TRANSACTION_GAS.toString()])),
    steps: [...DEPLOY_ORDER], resumeOf: null }, artifacts);
  const state = await deploymentState(resumeFrom ?? probe, rpc, block.tag);
  const steps = DEPLOY_ORDER.filter(c => state[c] === 'empty');
  if (resumeFrom) ensure(steps.length > 0, 'nothing_to_resume');
  else ensure(steps.length === DEPLOY_ORDER.length, 'deployment_already_started_use_resume');
  const resumeOf = resumeFrom ? packageDigest(resumeFrom) : null;
  const provisional = prepareDeployment({ ...base, steps, resumeOf,
    gasLimits: Object.fromEntries(steps.map(c => [c, MAX_TRANSACTION_GAS.toString()])) }, artifacts);
  // The simulation replays all eleven steps in order: a constructor reads the components before it.
  const simulatedGas = await simulate(probe);
  const l1 = await l1Costs(profile, provisional.steps, l1Rpc, { required: production, from: lower.deployer });
  const gasLimits = {};
  for (const c of steps) {
    ensure(typeof simulatedGas[c] === 'string', 'gas_simulation_missing: ' + c);
    const limit = ceilPercent(integer(simulatedGas[c]) + BigInt(l1.steps[c].l1Gas), GAS_HEADROOM_PERCENT);
    ensure(limit <= MAX_TRANSACTION_GAS, 'gas_limit_cap_exceeded: ' + c);
    gasLimits[c] = limit.toString();
  }
  let tip = maxPriorityFeePerGas;
  if (tip === undefined) {
    // Nitro ignores priority fees; on OP Stack take the node's suggestion, within reason.
    tip = profile.stack === 'op-stack' ? quantity(await rpc('eth_maxPriorityFeePerGas', [])).toString() : '0';
    ensure(BigInt(tip) <= 10n ** 9n, 'suggested_priority_fee_implausible');
  }
  const fee = maxFeePerGas ?? (3n * block.baseFeePerGas + BigInt(tip)).toString();
  const bundle = prepareDeployment({ ...base, steps, resumeOf, gasLimits, maxFeePerGas: fee, maxPriorityFeePerGas: tip }, artifacts);
  return { bundle, simulatedGas, l1, state, block: { number: Number(block.number), hash: block.hash, baseFeePerGas: block.baseFeePerGas.toString() } };
}

// ------------------------------------------------------------ verification

export async function verifyDeployment(bundle, { rpc, transactionHashes, blockTag = 'latest' }) {
  ensure(prepared.has(bundle), 'verify_requires_fresh_authenticated_preparation');
  const m = bundle.manifest, c = m.contracts, d = m.dependencies, r = m.roles, profile = bundle.parameters.profile;
  keys(transactionHashes, DEPLOY_ORDER, 'deployment_receipts_required');
  ensure(Object.values(transactionHashes).every(h => typeof h === 'string' && HEX32.test(h))
    && new Set(Object.values(transactionHashes)).size === DEPLOY_ORDER.length, 'deployment_receipts_required');
  if (bundle.parameters.environment === PRODUCTION) await refuseDevelopmentChain(rpc);
  const block = await pinBlock(rpc, blockTag), tag = block.tag;
  // The transactions first: a deployment newer than the verification block is not final yet, not wrong.
  const receipts = {};
  for (const component of DEPLOY_ORDER) {
    const entry = bundle.components[component], hash = transactionHashes[component];
    const receipt = await rpc('eth_getTransactionReceipt', [hash]), tx = await rpc('eth_getTransactionByHash', [hash]);
    ensure(receipt && tx && receipt.transactionHash === hash && tx.hash === hash, 'deployment_receipt_missing: ' + component);
    ensure(quantity(receipt.blockNumber) <= block.number, 'deployment_not_final_at_' + blockTag + ': ' + component);
    ensure(quantity(receipt.status) === 1n, 'deployment_reverted: ' + component);
    const rb = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
    ensure(rb?.hash === receipt.blockHash && tx.blockHash === receipt.blockHash, 'deployment_receipt_noncanonical: ' + component);
    // Any successful deployer -> CreateX call with this step's exact input deployed this component, whatever
    // nonce, gas and fees it carried: a resumed deployment re-signs the remaining steps with new ones.
    ensure(lowerAddress(tx.from) === r.deployer && lowerAddress(tx.to) === CREATE_X && viem.keccak256(tx.input) === entry.callDataHash
      && quantity(tx.value) === 0n && typeof tx.chainId === 'string' && quantity(tx.chainId) === BigInt(profile.chainId),
      'deployment_transaction_mismatch: ' + component);
    const logs = (receipt.logs ?? []).filter(log => lowerAddress(log.address) === CREATE_X);
    const topic = address => viem.padHex(address, { size: 32 });
    ensure(logs.some(log => log.topics?.[0] === CREATEX_EVENTS.proxy && log.topics[1] === topic(entry.create3Proxy) && log.topics[2] === entry.guardedSalt)
      && logs.some(log => log.topics?.[0] === CREATEX_EVENTS.creation && log.topics[1] === topic(entry.expectedAddress)), 'deployment_creation_event_missing: ' + component);
    receipts[component] = { transactionHash: hash, blockNumber: Number(quantity(receipt.blockNumber)), blockHash: receipt.blockHash,
      gasUsed: quantity(receipt.gasUsed).toString(), effectiveGasPrice: quantity(receipt.effectiveGasPrice).toString() };
  }
  await checkDependencies(profile, rpc, tag);
  for (const [key, addr] of Object.entries(c)) {
    const code = await rpc('eth_getCode', [addr, tag]);
    ensure(code !== '0x' && viem.keccak256(code) === m.runtimeCodeHashes[key], 'runtime_codehash_mismatch: ' + key);
  }
  async function expect(component, signature, args, types, expected) {
    const values = await call(rpc, c[component], signature, args, types, tag);
    const normalized = values.map(v => typeof v === 'bigint' ? v.toString() : typeof v === 'string' ? v.toLowerCase() : v);
    ensure(canonical(normalized) === canonical(expected.map(v => typeof v === 'bigint' ? v.toString() : v)), 'deployment_wiring_mismatch: ' + component + ':' + signature);
  }
  for (const [fn, value] of [['governance', r.governance], ['guardian', r.guardian], ['feeRecipient', r.feeRecipient], ['pendingGovernance', ZERO]]) await expect('registry', fn + '()', [], ['address'], [value]);
  await expect('registry', 'timelockSeconds()', [], ['uint32'], [POLICIES.timelockSeconds]);
  await expect('registry', 'MIN_UNIVERSAL_ROUTER_VERSION()', [], ['uint16'], [POLICIES.minimumUniversalRouterVersion]);
  await expect('registry', 'automationHalted()', [], ['bool'], [false]);
  await expect('registry', 'isOperator(address)', [{ type: 'address', value: r.operator }], ['bool'], [true]);
  await expect('registry', 'isPublisher(address)', [{ type: 'address', value: r.publisher }], ['bool'], [true]);
  await expect('registry', 'isOperator(address)', [{ type: 'address', value: r.publisher }], ['bool'], [false]);
  await expect('registry', 'isPublisher(address)', [{ type: 'address', value: r.operator }], ['bool'], [false]);
  await expect('registry', 'routerVersion(address)', [{ type: 'address', value: d.universalRouter }], ['uint16'], [POLICIES.minimumUniversalRouterVersion]);
  for (const currency of m.chargeCurrencies) await expect('registry', 'chargeCurrencyRank(address)', [{ type: 'address', value: currency.token }], ['uint8'], [currency.rank]);
  for (const [fn, type, value] of [['registry', 'address', c.registry], ['v3Factory', 'address', d.v3Factory], ['v3PoolInitCodeHash', 'bytes32', profile.uniswap.v3.poolInitCodeHash], ['v4StateView', 'address', d.v4StateView], ['minTwapSeconds', 'uint32', POLICIES.minTwapSeconds], ['domainSeparator', 'bytes32', domainHash(m.chain.chainId, c.priceAnchor)]]) await expect('priceAnchor', fn + '()', [], [type], [value]);
  for (const [fn, type, value] of [['registry', 'address', c.registry], ['priceAnchor', 'address', c.priceAnchor], ['maxObservationAgeSeconds', 'uint32', POLICIES.autoExitMaxObservationAgeSeconds], ['minTwapSeconds', 'uint32', POLICIES.autoExitMinTwapSeconds]]) await expect('autoExit', fn + '()', [], [type], [value]);
  for (const dex of ['v3', 'v4']) {
    const pm = d[dex === 'v3' ? 'v3PositionManager' : 'v4PositionManager'];
    const vault = 'vault.' + dex, factory = 'vaultFactory.' + dex, zap = 'zap.' + dex;
    await expect(vault, 'wiring()', [], ['address', 'address', 'address', 'address', 'address', 'address'], [c[factory], c.registry, c.priceAnchor, pm, c.vaultSwap, c.autoExit]);
    await expect(vault, 'executor()', [], ['address'], [c['vaultExecutor.' + dex]]);
    await expect(vault, 'root()', [], ['uint8', 'address', 'uint256'], [dex === 'v3' ? 3 : 4, pm, '0']);
    for (const [fn, type, value] of [['implementation', 'address', c[vault]], ['registry', 'address', c.registry], ['dex', 'uint8', dex === 'v3' ? 3 : 4]]) await expect(factory, fn + '()', [], [type], [value]);
    await expect(zap, 'positionManager()', [], ['address'], [pm]);
    await expect(zap, 'hookedPoolsAllowed()', [], ['bool'], [POLICIES.hookedPoolsAllowed]);
  }
  const again = await rpc('eth_getBlockByNumber', [tag, false]);
  ensure(again?.hash === block.hash, 'verification_anchor_reorg');
  const output = structuredClone(m); output.status = 'verified'; output.deploymentReceipts = receipts;
  output.verification = { blockNumber: Number(block.number), blockHash: block.hash, blockTag,
    codeHashes: 'exact_precomputed_immutable_runtime', wiring: 'checked', checkedAt: new Date().toISOString() };
  return output;
}

// ------------------------------------------------------ signing, explorers

/** Offline check of the owner's signed transactions before broadcast: each must be one of this package's
 * steps exactly (chain, nonce, target, value, data, gas, fees, empty access list) and be signed by the deployer.
 * CreateX would not revert for another signer; it would deploy under that signer's namespace instead. */
export async function checkSignedTransactions(bundle, raws, { now = Math.floor(Date.now() / 1000) } = {}) {
  ensure(prepared.has(bundle), 'check_requires_fresh_authenticated_preparation');
  ensure(now < bundle.parameters.expiresAt, 'package_expired');
  ensure(Array.isArray(raws) && raws.length > 0 && raws.length <= bundle.steps.length, 'signed_transactions_required');
  const seen = new Set(), checked = [];
  for (const raw of raws) {
    ensure(typeof raw === 'string' && /^0x02[0-9a-f]+$/i.test(raw), 'signed_transaction_not_eip1559');
    const tx = viem.parseTransaction(raw);
    const signer = (await viem.recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase();
    ensure(signer === bundle.manifest.roles.deployer, 'signer_is_not_the_deployer');
    const step = bundle.steps.find(s => quantity(s.transaction.nonce) === BigInt(tx.nonce));
    ensure(step && !seen.has(step.component), 'signed_nonce_not_in_package'); seen.add(step.component);
    const t = step.transaction;
    for (const [field, ok] of [['chainId', BigInt(tx.chainId) === quantity(t.chainId)], ['to', tx.to?.toLowerCase() === CREATE_X],
      ['value', (tx.value ?? 0n) === 0n], ['data', (tx.data ?? '0x').toLowerCase() === t.data], ['gas', tx.gas === quantity(t.gas)],
      ['maxFeePerGas', tx.maxFeePerGas === quantity(t.maxFeePerGas)], ['maxPriorityFeePerGas', tx.maxPriorityFeePerGas === quantity(t.maxPriorityFeePerGas)],
      ['accessList', (tx.accessList ?? []).length === 0]]) ensure(ok, 'signed_transaction_mismatch: ' + step.component + ':' + field);
    checked.push({ component: step.component, nonce: tx.nonce, transactionHash: viem.keccak256(raw), signer });
  }
  return checked.sort((a, b) => a.nonce - b.nonce);
}

/** Block-explorer verification input: the exact standard-JSON compiler input and, per component, its fully
 * qualified name, address and ABI-encoded constructor arguments (executors take their vault's Deployment). */
export function explorerInput(bundle, artifacts) {
  ensure(prepared.has(bundle), 'explorer_input_requires_fresh_authenticated_preparation');
  const m = bundle.manifest, components = {};
  const constructorArguments = (component, args) => {
    const abi = artifacts.contracts[CONTRACT_NAMES[component]].abi.find(x => x.type === 'constructor');
    return abi && abi.inputs.length ? viem.encodeAbiParameters(abi.inputs, args) : '0x';
  };
  const deployment = Object.fromEntries(fullPackage(bundle, artifacts).steps.map(s => [s.component, s.constructorArguments]));
  for (const component of Object.keys(CONTRACT_NAMES)) {
    const artifact = artifacts.contracts[CONTRACT_NAMES[component]];
    const args = component.startsWith('vaultExecutor.') ? deployment['vault.' + component.slice(-2)] : deployment[component];
    components[component] = { contract: artifact.source + ':' + CONTRACT_NAMES[component], address: m.contracts[component],
      constructorArguments: constructorArguments(component, args), runtimeCodeHash: m.runtimeCodeHashes[component] };
  }
  return { standardJsonInput: artifacts.standardInput, compilerVersion: 'v' + artifacts.compiler.version,
    chainId: m.chain.chainId, sourceCommit: m.sourceCommit, components };
}

// -------------------------------------------------------------- provenance

/** The committed chain profile with this chain id, at `commit`. */
export function committedProfile(sourceRoot, commit, chainId) {
  const listed = gitOutput(sourceRoot, ['ls-tree', '--name-only', commit, 'api-contracts/v2/chains/']).split('\n').filter(x => x.endsWith('.json'));
  const matches = listed.map(path => JSON.parse(gitOutput(sourceRoot, ['show', commit + ':' + path]))).filter(x => x.chainId === chainId);
  ensure(matches.length === 1, 'committed_chain_profile_missing');
  return matches[0];
}

/** A public package is built by this checkout's committed tool, from its committed sources and profile,
 * and only from the reviewed release (docs/v2/FREEZE.md). */
export function checkProvenance({ artifacts, profile }) {
  ensure(resolve(artifacts.sourceRoot) === resolve(repoRoot), 'public_preparation_requires_the_tool_checkout');
  ensure(!artifacts.sourceState.workingTreeSourceChanges && !artifacts.sourceState.workingTreeToolChanges, 'uncommitted_changes_refused_for_public_preparation');
  ensure(canonical(committedProfile(repoRoot, artifacts.sourceCommit, profile.chainId)) === canonical(profile), 'chain_profile_not_the_committed_one');
  checkReleaseManifest(artifacts);
}

// ---------------------------------------------------------------- release

/** The reviewed manifest of the V2 release (docs/v2/FREEZE.md). */
export const RELEASE_MANIFEST_PATH = 'contracts/release-artifacts-v2.json';
/** What decides the bytecode or what this tool prepares, besides the V2 sources: the compile wrapper and the
 * deployment tool. The compiler is pinned by its version (compileV2) and the bytecode by its hashes. */
export const RELEASE_INPUTS = Object.freeze(['scripts/solc-compile.cjs', 'scripts/prepare-financial-release.mjs',
  'scripts/v2/deploy.mjs', 'scripts/v2/deploy-schema.mjs', 'scripts/v2/deploy-manifest.schema.json', 'scripts/v2/release-manifest.mjs']);

/** One compiled contract as the manifest pins it: its creation and runtime bytecode as compiled (immutable
 * slots zero), where its immutables sit, and its ABI. AST ids differ between compilation units; the offsets
 * do not. Takes a solc output or a Foundry artifact. Top-level ABI order is the only thing normalized. */
export function artifactIdentity(artifact) {
  const bytecode = artifact.evm?.bytecode ?? artifact.bytecode, deployed = artifact.evm?.deployedBytecode ?? artifact.deployedBytecode;
  const bytes = value => {
    ensure(typeof value === 'string' && /^(?:0x)?(?:[0-9a-f]{2})+$/.test(value), 'invalid_release_bytecode');
    return Buffer.from(value.replace(/^0x/, ''), 'hex');
  };
  const creation = bytes(bytecode?.object), runtime = bytes(deployed?.object);
  ensure(Array.isArray(artifact.abi), 'invalid_release_abi');
  ensure(!Object.keys(bytecode.linkReferences ?? {}).length && !Object.keys(deployed.linkReferences ?? {}).length, 'unlinked_release_artifact');
  const immutableRanges = Object.values(deployed.immutableReferences ?? {}).flat()
    .map(({ start, length }) => ({ start, length })).sort((a, b) => a.start - b.start);
  let end = 0;
  for (const { start, length } of immutableRanges) {
    ensure(Number.isSafeInteger(start) && start >= end && length === 32 && start + length <= runtime.length, 'invalid_release_immutable_range');
    end = start + length;
  }
  return { creationSha256: sha256Hex(creation), runtimeSha256: sha256Hex(runtime), creationBytes: creation.length,
    runtimeBytes: runtime.length, abiSha256: sha256Hex(canonical(artifact.abi.map(canonical).sort().map(entry => JSON.parse(entry)))),
    immutableRanges };
}

/** The release manifest of a compile: the compiler, every V2 source, the release inputs and each deployable
 * contract. Its sourceTreeSha256 is the one a deployment manifest's build records. */
export function releaseManifest(artifacts) {
  const byPath = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    schemaVersion: 1, kind: 'domino-v2-reviewed-release-artifacts', compiler: { ...COMPILER }, components: { ...CONTRACT_NAMES },
    sourceTreeSha256: sha256Hex(canonical(artifacts.sourceHashes)),
    sources: Object.fromEntries(Object.entries(artifacts.sourceHashes).sort(byPath)),
    releaseInputs: Object.fromEntries(RELEASE_INPUTS.map(name => [name, sha256Hex(readFileSync(join(artifacts.sourceRoot, name)))])),
    contracts: Object.fromEntries([...new Set(Object.values(CONTRACT_NAMES))].sort().map(name =>
      [name, { source: artifacts.contracts[name].source, ...artifactIdentity(artifacts.contracts[name]) }])),
  };
}

/** The committed manifest at the compiled commit, unchanged in the checkout and equal to this compile.
 * Returns its SHA-256. */
export function checkReleaseManifest(artifacts) {
  let committed;
  try { committed = gitOutput(artifacts.sourceRoot, ['show', artifacts.sourceCommit + ':' + RELEASE_MANIFEST_PATH]); }
  catch { throw new Error('release_manifest_not_committed'); }
  const path = join(artifacts.sourceRoot, RELEASE_MANIFEST_PATH);
  ensure(existsSync(path) && readFileSync(path, 'utf8') === committed, 'release_manifest_changed');
  ensure(canonical(JSON.parse(committed)) === canonical(releaseManifest(artifacts)), 'release_manifest_mismatch');
  return sha256Hex(committed);
}

// --------------------------------------------------------------------- CLI

export function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
const stringify = value => JSON.stringify(value, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2) + '\n';
/** Never overwrites: an existing output is evidence, so a rerun must name a new file. */
export function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  try { writeFileSync(path, stringify(value), { flag: 'wx', mode: 0o600 }); }
  catch (error) { throw new Error(error.code === 'EEXIST' ? 'output_exists' : 'output_write_failed'); }
}
export function flags(argv, booleans = []) {
  const result = {};
  for (let i = 0; i < argv.length;) {
    const name = argv[i]?.startsWith('--') ? argv[i].slice(2) : null;
    ensure(name && !Object.hasOwn(result, name), name ? 'duplicate_cli_argument' : 'invalid_cli_arguments');
    if (booleans.includes(name)) { result[name] = true; i += 1; continue; }
    ensure(argv[i + 1] !== undefined && !argv[i + 1].startsWith('--'), 'invalid_cli_arguments');
    result[name] = argv[i + 1]; i += 2;
  }
  return result;
}
const readInput = path => JSON.parse(readBounded(path, 16 * 1024 * 1024));
const preflightPath = out => out.endsWith('.json') ? out.slice(0, -5) + '.preflight.json' : out + '.preflight.json';
function endpoint(f) {
  const source = Object.fromEntries(['rpc', 'rpc-file'].filter(k => Object.hasOwn(f, k)).map(k => [k, f[k]]));
  return readOnlyRpc(verificationRpcEndpoint(source));
}
function validity(f) {
  if (f['valid-hours'] === undefined) return DEFAULT_VALIDITY_SECONDS;
  const hours = Number(integer(f['valid-hours'], 'invalid_valid_hours'));
  ensure(hours >= 1 && hours <= 168, 'invalid_valid_hours'); return hours * 3600;
}
const optionalWei = value => value === undefined ? undefined : integer(value, 'invalid_fee').toString();
/** Warnings lead the command's output; they never change its result. */
const warned = report => report.warnings.map(w => 'WARNING ' + w + '\n').join('');

export async function cli(argv) {
  const command = argv[0], f = flags(argv.slice(1));
  const allowed = {
    addresses: [['deployer', 'out'], []], validate: [['manifest'], []],
    prepare: [['chain-profile', 'roles', 'release-tag', 'out'], ['rpc', 'rpc-file', 'max-fee-per-gas', 'priority-fee-per-gas', 'valid-hours']],
    resume: [['package', 'out'], ['rpc', 'rpc-file', 'max-fee-per-gas', 'priority-fee-per-gas', 'valid-hours']],
    preflight: [['package', 'out'], ['rpc', 'rpc-file']],
    'check-signed': [['package', 'signed'], ['out']],
    verify: [['package', 'receipts', 'out'], ['rpc', 'rpc-file', 'block-tag']],
    'explorer-input': [['package', 'out'], []],
  }[command];
  ensure(allowed, 'command_required: addresses|validate|prepare|resume|preflight|check-signed|verify|explorer-input');
  ensure(allowed[0].every(k => Object.hasOwn(f, k)) && Object.keys(f).every(k => allowed[0].includes(k) || allowed[1].includes(k)), 'unknown_or_missing_cli_argument');
  if (command === 'addresses') { const out = precomputeAddresses(f.deployer); writeJson(f.out, out); return 'Predicted 13 addresses.'; }
  if (command === 'validate') { const { validateManifest } = await import('./deploy-schema.mjs'); validateManifest(readInput(f.manifest)); return 'V2 manifest valid.'; }
  // Every input is resolved before the minute-long compile.
  const rpc = ['prepare', 'resume', 'preflight', 'verify'].includes(command) ? endpoint(f) : null;
  for (const key of ['out', 'package', 'chain-profile', 'roles', 'receipts', 'signed']) if (f[key] !== undefined) ensure(typeof f[key] === 'string' && f[key].length > 0, 'invalid_cli_arguments');
  if (f.out !== undefined) ensure(!existsSync(f.out) && (command !== 'prepare' && command !== 'resume' || !existsSync(preflightPath(f.out))), 'output_exists');
  const validitySeconds = validity(f), maxFeePerGas = optionalWei(f['max-fee-per-gas']), maxPriorityFeePerGas = optionalWei(f['priority-fee-per-gas']);
  const artifacts = compileV2();
  const supplied = f.package ? readInput(f.package) : null;
  const bundle = supplied ? rebuildPackage(supplied, artifacts) : null;
  const environment = bundle ? bundle.parameters.environment : PRODUCTION;
  if (environment === PRODUCTION) checkProvenance({ artifacts, profile: bundle ? bundle.parameters.profile : readInput(f['chain-profile']) });
  if (command === 'check-signed') {
    const raws = readFileSync(f.signed, 'utf8').split(/\s+/).filter(Boolean);
    const checked = await checkSignedTransactions(bundle, raws);
    if (f.out) writeJson(f.out, checked);
    return checked.map(x => `${x.component} nonce ${x.nonce} signed by the deployer: ${x.transactionHash}`).join('\n');
  }
  if (command === 'explorer-input') { writeJson(f.out, explorerInput(bundle, artifacts)); return 'Wrote the block-explorer verification input.'; }
  if (command === 'verify') {
    const verified = await verifyDeployment(bundle, { rpc, transactionHashes: readInput(f.receipts), blockTag: f['block-tag'] ?? 'finalized' });
    const { validateManifest } = await import('./deploy-schema.mjs'); validateManifest(verified);
    writeJson(f.out, verified); return 'Verified V2 deployment code, wiring, roles and receipts.';
  }
  const { simulateGas } = await import('./deploy-anvil.mjs');
  const now = Math.floor(Date.now() / 1000);
  if (command === 'preflight') {
    const report = await preflightDeployment(bundle, { rpc, simulatedGas: await simulateGas(fullPackage(bundle, artifacts)), now });
    writeJson(f.out, report);
    return warned(report) + `Preflight passed at block ${report.chain.block.number}: ${report.steps.length} transaction(s), worst case ${report.funding.worstCaseWei} wei of ${report.funding.balanceWei}.`;
  }
  const planned = await planDeployment({ profile: supplied ? undefined : readInput(f['chain-profile']), roles: supplied ? undefined : readInput(f.roles),
    environment, releaseTag: f['release-tag'], artifacts, rpc, simulate: simulateGas, now, validitySeconds,
    maxFeePerGas, maxPriorityFeePerGas, resumeFrom: bundle ?? undefined });
  const report = await preflightDeployment(planned.bundle, { rpc, simulatedGas: planned.simulatedGas, now, requireSafeGovernance: true });
  writeJson(f.out, planned.bundle); writeJson(preflightPath(f.out), report);
  return warned(report) + `Prepared ${planned.bundle.steps.length} unsigned CREATE3 transaction(s) from nonce ${planned.bundle.parameters.nonce}; preflight passed; nothing was signed or sent.`;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then(message => console.log(message)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
