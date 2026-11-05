#!/usr/bin/env node
/** Day-1 qualification of a new chain for Domino V2: can V2 deploy and run there, and a draft chain profile filled
 * with verified values only (docs/v2/QUALIFY_CHAIN.md is the runbook).
 *
 * Built for Kinetiq's Elysium mainnet, an Arbitrum Orbit (Nitro) chain that settles to HyperEVM with HYPE as its gas
 * coin: on the day it publishes its chain id, RPC and contracts, one run answers in minutes, and the draft carries code
 * hashes computed the way the profiles in api-contracts/v2/chains were (keccak256 of eth_getCode at one block).
 *
 * Read-only: it holds no key, signs nothing and sends nothing. Every method it can call is a read (READ_METHODS),
 * within a call budget. The RPC URL comes from an environment variable or an owner-only JSON file and never reaches
 * the output: a provider URL carries its API key, so node error messages are redacted by value.
 *
 * Not a release input (docs/v2/FREEZE.md): it imports deploy.mjs's constants and functions (CreateX, the Safe
 * singletons and proxies, the policies, the profile's dependency map and deploy.mjs's own dependency check) and
 * changes nothing frozen. Where today's profile schema cannot express the chain, the report says so (schemaGaps).
 */
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CREATE_X, CREATE_X_CODE_HASH, SAFE_SINGLETONS, SAFE_PROXY_RUNTIME_HASHES, POLICIES, MAX_TRANSACTION_GAS,
  GAS_HEADROOM_PERCENT, CONTRACT_NAMES, DEPLOY_ORDER, ENABLED_CHAINS, RELEASE_MANIFEST_PATH, RPC_REPLY_MAX_BYTES, repoRoot,
  viem, ensure, quantity, flags, writeJson, dependencyMap, checkDependencies } from './deploy.mjs';
import { readBounded } from '../prepare-financial-release.mjs';

export const PROFILE_DIRECTORY = 'api-contracts/v2/chains';
export const DEFAULT_MAX_CALLS = 200;
/** A head older than this is a stalled node or chain. */
export const HEAD_MAX_AGE_SECONDS = 120;
const ZERO = '0x' + '0'.repeat(40);
const GWEI = 10n ** 9n;
const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Nitro's precompiles: ArbSys answers arbOSVersion() (55 + the ArbOS version); NodeInterface is the node's virtual
 * contract deploy.mjs's l1Costs reads the L1 component of a step's gas from. */
export const ARB_SYS = '0x0000000000000000000000000000000000000064';
export const NODE_INTERFACE = '0x00000000000000000000000000000000000000c8';
export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
export const ARACHNID_PROXY = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
export const SAFE_SINGLETON_FACTORY = '0x914d7fec6aac8cd542e72bca78b30650d45643d7';
/** The Safe team's key, which deploys the factory at its nonce 0 with an EIP-155 transaction per chain, on request. */
export const SAFE_FACTORY_DEPLOYER = '0xe1cb04a0fa36ddd16a06ea828007e35e1a3cbc37';
/** Uniswap's v3-sdk POOL_INIT_CODE_HASH; all three profiles record it. */
export const V3_POOL_INIT_CODE_HASH = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54';
export const STANDARD_TICK_SPACING = Object.freeze({ 100: 1, 500: 10, 3000: 60, 10000: 200 });

/** The presigned deployments anyone may broadcast once the sender is funded: legacy transactions at 100 gwei, valid
 * on every chain id (pre-EIP-155), each the sender's nonce 0. A transaction that runs out of gas still spends that
 * nonce, and the contract can then never be at its address on that chain. On Nitro the L1 component counts inside
 * the gas limit, which is why the published limits may not suffice (mds1/multicall3: Arbitrum One needed 14,345,935).
 * `executionGas` is what Ethereum's EVM spends. Arachnid's sender has no known key (r = s = 0x22...22). */
export const KEYLESS = Object.freeze({
  createx: Object.freeze({ name: 'CreateX', contract: CREATE_X, deployer: '0xed456e05caab11d66c4c797dd6c1d6f9a7f352b5', keyless: false,
    gasPrice: 100n * GWEI, gasLimits: Object.freeze([3_000_000n, 25_000_000n, 45_000_000n]), executionGas: 2_580_902n, initCodeBytes: 12_350,
    source: 'https://github.com/pcaversaccio/createx (scripts/presigned-createx-deployment-transactions, README "New Deployment(s)")' }),
  arachnid: Object.freeze({ name: 'Arachnid deterministic deployment proxy', contract: ARACHNID_PROXY, deployer: '0x3fab184622dc19b6109349b94811493bf2a45362',
    keyless: true, gasPrice: 100n * GWEI, gasLimits: Object.freeze([100_000n]), executionGas: 68_137n, initCodeBytes: 83,
    rawTransaction: '0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222',
    source: 'https://github.com/Arachnid/deterministic-deployment-proxy (README)' }),
  multicall3: Object.freeze({ name: 'Multicall3', contract: MULTICALL3, deployer: '0x05f32b3cc3888453ff71b01135b34ff8e41263f2', keyless: false,
    gasPrice: 100n * GWEI, gasLimits: Object.freeze([1_000_000n]), executionGas: 872_776n, initCodeBytes: 4_320,
    source: 'https://github.com/mds1/multicall3 (README "New Deployments")' }),
});

/** The canonical SafeProxyFactory of each version and the runtime hash safe-global/safe-deployments records for it;
 * the proxy each creates has deploy.mjs's SAFE_PROXY_RUNTIME_HASHES hash. `via`: what deploys it on a new chain. */
export const SAFE_PROXY_FACTORIES = Object.freeze({
  '0xa6b71e26c5e0845f74c812102ca7114b6a896ab2': Object.freeze({ version: '1.3.0', via: 'arachnid', codehash: '0x337d7f54be11b6ed55fef7b667ea5488db53db8320a05d1146aa4bd169a39a9b' }),
  '0xc22834581ebc8527d974f8a1c97e1bea4ef910bc': Object.freeze({ version: '1.3.0', via: 'safeSingletonFactory', codehash: '0x337d7f54be11b6ed55fef7b667ea5488db53db8320a05d1146aa4bd169a39a9b' }),
  '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67': Object.freeze({ version: '1.4.1', via: 'safeSingletonFactory', codehash: '0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317' }),
  '0x14f2982d601c9458f93bd70b218933a6f8165e7b': Object.freeze({ version: '1.5.0', via: 'safeSingletonFactory', codehash: '0x967dae4cda22b0c9ef7f31b010bdc1ceb0af9904b0c3dc060b5302e4c18a4529' }),
});
/** What deploys each of deploy.mjs's SAFE_SINGLETONS on a new chain: 1.3.0's `canonical` addresses are CREATE2 through
 * the Arachnid proxy (permissionless); its `eip155` ones and every 1.4.1 and 1.5.0 one go through the Safe Singleton
 * Factory (safe-deployments). */
export const SAFE_SINGLETON_ROUTES = Object.freeze({
  '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': 'arachnid', '0x3e5c63644e683549055b9be8653de26e0b4cd36e': 'arachnid',
  '0x69f4d1788e39c87893c980c06edf4b7f686e2938': 'safeSingletonFactory', '0xfb1bffc9d739b8d520daf37df666da4c687191ea': 'safeSingletonFactory',
  '0x41675c099f32341bf84bfc5382af534df5c7461a': 'safeSingletonFactory', '0x29fcb43b46531bca003ddc8fcb67ffe91900c762': 'safeSingletonFactory',
  '0xff51a5898e281db6dfc7855790607438df2ca44b': 'safeSingletonFactory', '0xedd160febbd92e350d4d398fb636302fccd67c7e': 'safeSingletonFactory',
});

/** Where a probe contract sits in a state override, and who calls it. */
const PROBE_ADDRESS = '0x00000000000000000000000000000000d0e1a7e0';
const PROBE_SENDER = '0x00000000000000000000000000000000d0e1a7e1';
/** TSTORE 42 at key 1, TLOAD it, MSTORE it with PUSH0, MCOPY the word to offset 32 and return it: 42 when the chain runs
 * Cancun's opcodes (and Shanghai's PUSH0), which V2's `cancun` build emits. As a runtime (state override) or as the
 * init code of a creation call, it returns the same word. */
export const CANCUN_PROBE = '0x602a60015d60015c5f5260205f60205e60206020f3';
/** One opcode each, without the others, to say which one a chain lacks; each runs as a creation call. */
export const OPCODE_PROBES = Object.freeze({
  PUSH0: Object.freeze({ code: '0x5f5ff3', returns: '0x' }),
  'TSTORE/TLOAD': Object.freeze({ code: '0x602a60015d60015c60005260206000f3', returns: '0x' + '0'.repeat(62) + '2a' }),
  MCOPY: Object.freeze({ code: '0x602a6000526020600060205e60206020f3', returns: '0x' + '0'.repeat(62) + '2a' }),
});
const FORTY_TWO = '0x' + '0'.repeat(62) + '2a';
/** With calldata: SSTORE(0, TIMESTAMP) and LOG0; without: return SLOAD(0). Two calls in one simulated block prove what
 * the V2 plan API relies on (backend/v2_position_plan.py): blockOverrides.time, state carried from call to call, logs. */
export const SIMULATE_PROBE = '0x3615600c57425f555f5fa0005b5f545f5260205ff3';

export const READ_METHODS = Object.freeze(['eth_chainId', 'web3_clientVersion', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt',
  'eth_call', 'eth_getBalance', 'eth_getTransactionCount', 'eth_simulateV1']);
/** Answers that only depend on the pinned block, read once per run. */
const PINNED_METHODS = new Set(['eth_chainId', 'eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_getBalance', 'eth_getTransactionCount']);
const EIP1967_IMPLEMENTATION_SLOT = viem.toHex(BigInt(viem.keccak256(viem.toHex('eip1967.proxy.implementation'))) - 1n, { size: 32 });
/** USDC's FiatTokenProxy keeps its implementation here (zos AdminUpgradeabilityProxy). */
const ZOS_IMPLEMENTATION_SLOT = viem.keccak256(viem.toHex('org.zeppelinos.proxy.implementation'));

const lower = a => a.toLowerCase();
const checksummed = a => viem.getAddress(a);
const word = v => (typeof v === 'bigint' || typeof v === 'number' ? BigInt(v).toString(16) : v.slice(2).toLowerCase()).padStart(64, '0');
const bytesOf = code => (code.length - 2) / 2;
const hashOf = code => code === '0x' ? null : viem.keccak256(code);
const hex = n => '0x' + BigInt(n).toString(16);
const ceilPercent = (value, percent) => (value * percent + 99n) / 100n;
const gwei = wei => viem.formatUnits(wei, 9);
const printable = text => String(text).replace(/[^\x20-\x7e]/g, '?');
const isSymbol = s => typeof s === 'string' && /^[A-Za-z0-9.]{1,16}$/.test(s);

// ---------------------------------------------------------------- RPC

export class RpcError extends Error {
  /** kind: `error` (the node answered with a JSON-RPC error), `transport`, `budget` or `refused` (not a read). */
  constructor(kind, method, { code = null, detail = '' } = {}) {
    super(`rpc_${kind}: ${method}${code === null ? '' : ` (${code})`}${detail ? ': ' + detail : ''}`);
    Object.assign(this, { kind, method, code, detail });
  }
}

/** Every URL in a text, whatever its host. */
export const redactUrls = text => String(text).replace(/\b(?:https?|wss?):\/\/[^\s"'<>]*/gi, '[url]');
/** Node messages may quote the endpoint, or the key alone: redact by value, URLs first, then the endpoint's host,
 * path segments and query values. */
export function redactor(url) {
  const u = new URL(url);
  const secrets = [...new Set([url, url.replace(/^[a-z]+:\/\//i, ''), u.host, u.search.slice(1), ...u.pathname.split('/'),
    ...u.searchParams.values()].filter(s => s && s.length >= 6))].sort((a, b) => b.length - a.length);
  return text => {
    let out = redactUrls(text);
    for (const secret of secrets) out = out.split(secret).join('[redacted]');
    return printable(out).slice(0, 200);
  };
}

/** HTTPS, or HTTP on a loopback address (a local node or tunnel); no user info or fragment. The URL never appears in
 * an error. */
export function checkedUrl(text) {
  try {
    ensure(typeof text === 'string' && /^[\x21-\x7e]{1,2048}$/.test(text), 'x');
    const url = new URL(text);
    ensure((url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
      && !url.username && !url.password && !url.hash, 'x');
    return text;
  } catch { throw new Error('invalid_rpc_url'); }
}

/** The RPC URL from `--rpc-env NAME` (an environment variable) or `--rpc-file PATH` (an owner-only 0600 JSON file
 * {"url": "..."}), exactly one of them. */
export function rpcUrlFrom(options, env = process.env) {
  const fromEnv = Object.hasOwn(options, 'rpc-env'), fromFile = Object.hasOwn(options, 'rpc-file');
  ensure(fromEnv !== fromFile, 'exactly_one_rpc_source_required: --rpc-env NAME or --rpc-file PATH');
  if (fromEnv) {
    ensure(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(options['rpc-env']), 'invalid_rpc_env_name');
    const value = env[options['rpc-env']];
    ensure(typeof value === 'string' && value.trim().length > 0, 'rpc_env_unset');
    return checkedUrl(value.trim());
  }
  let fd, document;
  try {
    fd = openSync(options['rpc-file'], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    ensure(info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= 4096 && typeof process.getuid === 'function'
      && info.uid === process.getuid() && !(info.mode & 0o077), 'x');
    const buffer = Buffer.alloc(4097);
    let length = 0, count;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    ensure(length <= 4096, 'x');
    document = JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } catch { throw new Error('invalid_private_rpc_file: an owner-only (0600) regular file holding {"url": "https://..."}'); }
  finally { if (fd !== undefined) closeSync(fd); }
  ensure(document && typeof document === 'object' && !Array.isArray(document) && Object.keys(document).join() === 'url', 'invalid_private_rpc_file: {"url": "https://..."}');
  return checkedUrl(document.url);
}

const sleep = ms => new Promise(done => setTimeout(done, ms));
async function boundedText(response, max) {
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length; if (length > max) throw new Error('too_large'); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}
/** JSON-RPC 2.0: exactly one of result and error, for this request (an error may carry a null id). */
function validReply(body, id) {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== '2.0') return false;
  const result = Object.hasOwn(body, 'result'), error = Object.hasOwn(body, 'error');
  if (result === error) return false;
  return error ? body.error !== null && typeof body.error === 'object' && (body.id === id || body.id === null) : body.id === id;
}

/** JSON-RPC over HTTP, deploy.mjs's makeRpc rules (POST, no redirect, bounded and validated replies, rate limits retried)
 * except that a node's error keeps its code and its message, redacted by value: a qualification tells "method not
 * found" from "reverted". `transport.requests` counts HTTP requests, retries included. */
export function jsonRpc(url, { timeoutMs = 30_000, retryDelays = [1000, 2000, 4000], maxReplyBytes = RPC_REPLY_MAX_BYTES } = {}) {
  const endpoint = new URL(checkedUrl(url)), scrub = redactor(url);
  let id = 0;
  const transport = async (method, params = []) => {
    for (let attempt = 0; ; attempt++) {
      const requestId = ++id; transport.requests += 1;
      let response;
      try {
        response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }), signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) { throw new RpcError('transport', method, { detail: error?.name === 'TimeoutError' ? 'timeout' : 'network' }); }
      if (response.status === 429 && attempt < retryDelays.length) {
        await response.body?.cancel().catch(() => {}); await sleep(retryDelays[attempt]); continue;
      }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new RpcError('transport', method, { detail: 'http ' + response.status }); }
      let body;
      try { body = JSON.parse(await boundedText(response, maxReplyBytes)); } catch { throw new RpcError('transport', method, { detail: 'invalid or oversized reply' }); }
      if (!validReply(body, requestId)) throw new RpcError('transport', method, { detail: 'invalid reply' });
      if (Object.hasOwn(body, 'error')) {
        const code = Number.isSafeInteger(body.error.code) ? body.error.code : null, detail = scrub(body.error.message ?? '');
        if (([429, -32005, -32016].includes(code) || /rate limit|too many requests/i.test(detail)) && attempt < retryDelays.length) {
          await sleep(retryDelays[attempt]); continue;
        }
        throw new RpcError('error', method, { code, detail });
      }
      return body.result;
    }
  };
  transport.requests = 0;
  transport.scrub = scrub;
  return transport;
}

/** Reads only, at most `maximumCalls` reaching the transport and `concurrency` at a time; an answer that depends only
 * on the pinned block is asked once (deploy.mjs's checkDependencies then re-reads nothing). */
export function readOnly(transport, { maximumCalls = DEFAULT_MAX_CALLS, concurrency = 6 } = {}) {
  let calls = 0, active = 0;
  const queue = [], memo = new Map();
  const pump = () => {
    while (active < concurrency && queue.length) {
      const job = queue.shift(); active += 1;
      job().finally(() => { active -= 1; pump(); });
    }
  };
  const rpc = (method, params = []) => {
    if (!READ_METHODS.includes(method)) return Promise.reject(new RpcError('refused', method));
    const key = PINNED_METHODS.has(method) ? method + JSON.stringify(params) : null;
    if (key && memo.has(key)) return memo.get(key);
    const promise = new Promise((resolveCall, rejectCall) => {
      queue.push(async () => {
        if (calls >= maximumCalls) { rejectCall(new RpcError('budget', method, { detail: `${maximumCalls} calls spent` })); return; }
        calls += 1;
        try { resolveCall(await transport(method, params)); } catch (error) { rejectCall(error); }
      });
      pump();
    });
    if (key) memo.set(key, promise);
    return promise;
  };
  rpc.stats = () => ({ calls, requests: transport.requests ?? calls, maximumCalls });
  /** Free text a node returns (its client version) is redacted like its error messages. */
  rpc.scrub = transport.scrub ?? (text => printable(redactUrls(text)).slice(0, 200));
  return rpc;
}

/** Why a read failed, and whether that says something about the chain (`reverted`, `empty`, `undecodable`: the
 * contract answered, wrongly) or only about the read (`transport`, `budget`, `state_unavailable`, `rpc_error`). */
export function failureOf(error) {
  if (error instanceof RpcError && error.kind === 'error') {
    const reverted = error.code === 3 || /revert/i.test(error.detail);
    const unsupported = error.code === -32601 || /(method|namespace)\b.{0,60}\b(not found|not supported|does not exist|not available|unsupported)/i.test(error.detail);
    const unavailable = /missing trie node|header not found|historical state|state.{0,24}(not available|unavailable|pruned)/i.test(error.detail);
    return { kind: reverted ? 'reverted' : unsupported ? 'unsupported' : unavailable ? 'state_unavailable' : 'rpc_error', code: error.code, detail: error.detail };
  }
  if (error instanceof RpcError) return { kind: error.kind === 'budget' ? 'budget' : error.kind === 'refused' ? 'refused' : 'transport', detail: error.detail };
  if (error?.decoding) return { kind: error.decoding, detail: error.message };
  return { kind: 'error', detail: printable(redactUrls(error?.message ?? error)).slice(0, 200) };
}
const DEFINITE = new Set(['reverted', 'empty', 'undecodable', 'unsupported']);
const statusOf = failure => DEFINITE.has(failure.kind) ? 'fail' : 'unknown';
const combine = statuses => statuses.includes('fail') ? 'fail' : statuses.includes('unknown') ? 'unknown' : 'pass';
function decodingError(kind, message) { const error = new Error(message); error.decoding = kind; return error; }

const encodeCall = (signature, inputs = []) => viem.concatHex([viem.toFunctionSelector(signature),
  inputs.length ? viem.encodeAbiParameters(inputs.map(([type]) => ({ type })), inputs.map(([, value]) => value)) : '0x']);
function decodeReturn(outputs, raw) {
  if (raw === '0x') throw decodingError('empty', 'empty return: no code or no such function');
  try { return viem.decodeAbiParameters(outputs.map(type => ({ type })), raw); } catch { throw decodingError('undecodable', 'return data does not decode as ' + outputs.join(',')); }
}
const settle = promise => promise.then(value => ({ value }), error => ({ failure: failureOf(error) }));

// ------------------------------------------------------- byte comparison

/** Immutables sit in a runtime as PUSH32 operands. At every PUSH32 instruction (a walk from offset 0 that skips push
 * data, so data never matches), an operand equal to a pair's `from` word takes its `to` word. Returns the code and how
 * many operands each pair replaced. */
export function substituteImmutables(code, pairs) {
  const bytes = Buffer.from(code.slice(2), 'hex');
  const from = pairs.map(([a]) => Buffer.from(word(a), 'hex')), to = pairs.map(([, b]) => Buffer.from(word(b), 'hex'));
  const counts = pairs.map(() => 0);
  for (let i = 0; i < bytes.length;) {
    const op = bytes[i];
    if (op === 0x7f && i + 33 <= bytes.length) {
      const k = from.findIndex(w => w.equals(bytes.subarray(i + 1, i + 33)));
      if (k >= 0) { to[k].copy(bytes, i + 1); counts[k] += 1; }
    }
    i += op >= 0x60 && op <= 0x7f ? op - 0x5e : 1;
  }
  return { code: '0x' + bytes.toString('hex'), counts };
}

/** Whether `code` is the build a profile recorded: with this chain's immutable values replaced by that chain's, it must
 * hash to the code hash the profile recorded. `references`: [{ slug, values, codehash }]. */
export function sameBuild(code, values, references) {
  const usable = references.filter(r => r.codehash && r.values.every(Boolean));
  if (values.some(v => v === null || v === undefined)) return { comparable: false, reason: 'immutable values unknown', matches: [] };
  if (new Set(values.map(word)).size !== values.length) return { comparable: false, reason: 'two immutables share a value', matches: [] };
  if (!usable.length) return { comparable: false, reason: 'no profile records this contract', matches: [] };
  const matches = [];
  let occurrences;
  for (const reference of usable) {
    const substituted = substituteImmutables(code, values.map((value, i) => [value, reference.values[i]]));
    occurrences = substituted.counts;
    if (substituted.counts.some(n => n === 0)) return { comparable: false, reason: 'an immutable value is not in the runtime', occurrences, matches: [] };
    if (viem.keccak256(substituted.code) === reference.codehash) matches.push(reference.slug);
  }
  return { comparable: true, occurrences, matches, profiles: usable.map(r => r.slug) };
}

/** Permit2's EIP-712 domain separator, cached in its runtime with the chain id. */
export const permit2Domain = chainId => viem.keccak256(viem.encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
  [viem.keccak256(viem.toHex('EIP712Domain(string name,uint256 chainId,address verifyingContract)')), viem.keccak256(viem.toHex('Permit2')), BigInt(chainId), PERMIT2]));

// ------------------------------------------------------------ references

/** The committed chain profiles: the enabled ones (the references) and the pending placeholders by slug. */
export function loadProfiles(directory = join(repoRoot, PROFILE_DIRECTORY)) {
  const documents = readdirSync(directory).filter(name => name.endsWith('.json')).sort()
    .map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')));
  return { enabled: documents.filter(p => p.enabled === true), pending: Object.fromEntries(documents.filter(p => p.enabled === false).map(p => [p.slug, p])) };
}

/** What each enabled profile recorded for the contracts this tool compares: addresses and code hashes. */
export function profileReferences(profiles) {
  return profiles.map(profile => {
    const hashes = new Map(profile.verification.contracts.filter(row => row.codehash).map(row => [lower(row.address), row.codehash]));
    const at = address => address ? { address: lower(address), codehash: hashes.get(lower(address)) ?? null } : null;
    const u = profile.uniswap;
    return { slug: profile.slug, chainId: profile.chainId, permit2: at(profile.permit2), multicall3: at(profile.multicall3),
      createx: at(profile.deployer?.address), arachnid: at(ARACHNID_PROXY), safeSingletonFactory: at(SAFE_SINGLETON_FACTORY),
      arbSys: at(ARB_SYS), v3Factory: at(u.v3.factory), quoterV2: at(u.v3.quoterV2), poolManager: at(u.v4.poolManager),
      stateView: at(u.v4.stateView), v4Quoter: at(u.v4.quoter), wrappedNative: lower(profile.wrappedNative.address) };
  });
}

export function defaultReferences(profiles = loadProfiles().enabled) {
  return { profiles: profileReferences(profiles), createxCodeHash: CREATE_X_CODE_HASH, safeSingletons: SAFE_SINGLETONS,
    safeProxyRuntimeHashes: SAFE_PROXY_RUNTIME_HASHES, safeProxyFactories: SAFE_PROXY_FACTORIES };
}
const recordedHashes = (references, key) => new Set(references.profiles.map(p => p[key]?.codehash).filter(Boolean));

/** The largest deployment step of the frozen release (contracts/release-artifacts-v2.json): its deployCreate3 calldata
 * (selector, salt, offset, length and the init code with up to 1 KiB of constructor arguments) and a lower bound of its
 * execution gas (base cost, its CREATEs and 200 gas per deposited runtime byte; a vault also deposits its executor). */
export function releaseSizes(root = repoRoot) {
  const manifest = JSON.parse(readFileSync(join(root, RELEASE_MANIFEST_PATH), 'utf8'));
  let largest = null;
  for (const component of DEPLOY_ORDER) {
    const contract = manifest.contracts[CONTRACT_NAMES[component]];
    const executor = component.startsWith('vault.') ? manifest.contracts[CONTRACT_NAMES['vaultExecutor.' + component.slice(-2)]] : null;
    const calldataBytes = 4 + 3 * 32 + Math.ceil((contract.creationBytes + 1024) / 32) * 32;
    if (largest && calldataBytes <= largest.calldataBytes) continue;
    const deposited = contract.runtimeBytes + (executor?.runtimeBytes ?? 0), creates = executor ? 3n : 2n;
    largest = { component, calldataBytes, depositedBytes: deposited,
      executionLowerBound: (21_000n + creates * 32_000n + 200n * BigInt(deposited) + 4n * BigInt(calldataBytes)).toString() };
  }
  return largest;
}

/** API schemas (api-contracts/**\/*.schema.json) with an enum that lists every enabled chain id but not `chainId`. */
export function chainEnumSchemas(chainId, root = repoRoot) {
  const lists = node => Array.isArray(node)
    ? (ENABLED_CHAINS.every(id => node.some(v => Number(v) === id)) && !node.some(v => Number(v) === chainId)) || node.some(lists)
    : node !== null && typeof node === 'object' && Object.values(node).some(lists);
  const found = [];
  const walk = directory => {
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.schema.json')) { try { if (lists(JSON.parse(readFileSync(full, 'utf8')))) found.push(relative(root, full)); } catch { /* not JSON */ } }
    }
  };
  walk(join(root, 'api-contracts'));
  return found;
}

/** A deterministic payload the compressor cannot shrink: an upper bound of the L1 cost of real bytecode of that size. */
function incompressible(length) {
  const out = Buffer.alloc(length);
  let seed = viem.keccak256(viem.toHex('domino.v2.qualify-chain.l1-payload'));
  for (let i = 0; i < length; i += 32) { seed = viem.keccak256(seed); Buffer.from(seed.slice(2), 'hex').copy(out, i); }
  return '0x' + out.toString('hex');
}

/** A price as a decimal string with six significant digits: num / den. */
function decimalRatio(num, den) {
  if (den === 0n) return null;
  const places = 30n, q = num * 10n ** places / den, s = q.toString().padStart(Number(places) + 1, '0');
  return Number(s.slice(0, -Number(places)) + '.' + s.slice(-Number(places))).toPrecision(6);
}
/** Stable per unit of `base` from a Uniswap sqrtPriceX96 of the pair (token0 < token1 by address). */
function stablePerBase(sqrtPriceX96, base, baseDecimals, stableDecimals, stableAddress) {
  const p2 = sqrtPriceX96 * sqrtPriceX96, q192 = 2n ** 192n;
  if (sqrtPriceX96 === 0n) return null;
  return BigInt(base) < BigInt(stableAddress)
    ? decimalRatio(p2 * 10n ** BigInt(baseDecimals), q192 * 10n ** BigInt(stableDecimals))
    : decimalRatio(q192 * 10n ** BigInt(baseDecimals), p2 * 10n ** BigInt(stableDecimals));
}

// --------------------------------------------------------------- inputs

const optionalAddress = (value, name) => {
  if (value === undefined || value === null) return null;
  ensure(typeof value === 'string' && ADDRESS.test(value) && (value === lower(value) || viem.isAddress(value, { strict: true }))
    && BigInt(value) !== 0n, 'invalid_address: ' + name);
  return lower(value);
};
const UNISWAP_KEYS = Object.freeze({ v3: ['factory', 'positionManager', 'quoterV2', 'swapRouter02'],
  v4: ['poolManager', 'positionManager', 'stateView', 'quoter'], universalRouter: ['address', 'version'] });

/** Candidate Uniswap addresses in the profile's own shape (every key optional, no other key): {"v3": {factory,
 * positionManager, quoterV2, swapRouter02}, "v4": {poolManager, positionManager, stateView, quoter}, "universalRouter":
 * {address, version}, "sources": [text]}. The version is Uniswap's word, not something the chain can show. */
export function checkUniswapInput(input) {
  if (input === null || input === undefined) return null;
  const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  ensure(plain(input) && Object.keys(input).every(k => [...Object.keys(UNISWAP_KEYS), 'sources'].includes(k)), 'invalid_uniswap_input');
  const out = { v3: {}, v4: {}, universalRouter: {}, sources: [] };
  for (const [section, names] of Object.entries(UNISWAP_KEYS)) {
    if (input[section] === undefined) continue;
    ensure(plain(input[section]) && Object.keys(input[section]).every(k => names.includes(k)), 'invalid_uniswap_input: ' + section);
    for (const name of names) {
      if (input[section][name] === undefined) continue;
      if (section === 'universalRouter' && name === 'version') {
        ensure(typeof input[section][name] === 'string' && /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(input[section][name]), 'invalid_uniswap_input: universalRouter.version');
        out.universalRouter.version = input[section][name];
      } else out[section][name] = optionalAddress(input[section][name], `${section}.${name}`);
    }
  }
  if (input.sources !== undefined) {
    ensure(Array.isArray(input.sources) && input.sources.length <= 32 && input.sources.every(s => typeof s === 'string' && s.length > 0 && s.length <= 2000),
      'invalid_uniswap_input: sources'); out.sources = [...input.sources];
  }
  const addresses = [...Object.values(out.v3), ...Object.values(out.v4), out.universalRouter.address].filter(Boolean);
  ensure(new Set(addresses).size === addresses.length, 'invalid_uniswap_input: addresses_not_distinct');
  return out;
}

// ------------------------------------------------------------ qualification

const DEPLOY_REQUIRED = ['chain.id', 'chain.finalized', 'chain.arbOS', 'chain.l1Component', 'chain.baseFee', 'chain.cancun', 'chain.anchor',
  'infra.createx', 'infra.safe', 'infra.permit2', 'uniswap.v3.factory', 'uniswap.v3.positionManager', 'uniswap.v3.quoterV2',
  'uniswap.v3.swapRouter02', 'uniswap.v3.poolInitCodeHash', 'uniswap.v4.poolManager', 'uniswap.v4.positionManager', 'uniswap.v4.stateView',
  'uniswap.v4.quoter', 'uniswap.universalRouter', 'tokens.wrappedNative', 'deployTool.dependencies'];
const RUN_REQUIRED = ['chain.id', 'chain.head', 'chain.finalized', 'chain.baseFee', 'chain.cancun', 'chain.simulateV1', 'chain.anchor',
  'infra.permit2', 'infra.multicall3', 'uniswap.v3.factory', 'uniswap.v3.positionManager', 'uniswap.v3.quoterV2', 'uniswap.v3.swapRouter02',
  'uniswap.v3.poolInitCodeHash', 'uniswap.v4.poolManager', 'uniswap.v4.positionManager', 'uniswap.v4.stateView', 'uniswap.v4.quoter',
  'uniswap.universalRouter', 'tokens.wrappedNative', 'tokens.stable', 'liquidity.v3'];
/** What each Uniswap contract's runtime embeds, which makes its bytes differ from chain to chain. */
const IMMUTABLES = Object.freeze({
  v3Factory: 'its own address (NoDelegateCall)', v3PositionManager: 'the factory, WETH9 and its token descriptor',
  quoterV2: 'the factory and WETH9', swapRouter02: 'the v2 and v3 factories, the position manager and WETH9',
  poolManager: 'its own address (NoDelegateCall)',
  v4PositionManager: 'PoolManager, Permit2, WETH9, its descriptor, its unsubscribe gas limit and its EIP-712 chain id and domain separator',
  stateView: 'PoolManager', v4Quoter: 'PoolManager',
  universalRouter: 'Permit2, WETH9, the v2 and v3 factories and pool init code hashes, PoolManager and both position managers',
});

/** Runs every check at one pinned block. `rpc` is a readOnly() reader. Returns { report, draft }. */
export async function qualifyChain({ rpc, now = Math.floor(Date.now() / 1000), expectChainId = null, pending = null, uniswap = null,
  stable = null, wrappedNative = null, references = defaultReferences(), release = releaseSizes(), apiSchemas = null, tool = null }) {
  uniswap = checkUniswapInput(uniswap) ?? { v3: {}, v4: {}, universalRouter: {}, sources: [] };
  stable = optionalAddress(stable, 'stable'); wrappedNative = optionalAddress(wrappedNative, 'wrapped-native');
  const checks = [], bootstrap = [], rows = new Map(), notes = [];
  const add = (id, section, status, summary, evidence = {}) => { checks.push({ id, section, status, summary, evidence }); return status; };
  const row = (name, address, code) => rows.set(lower(address), { name, address: checksummed(address), codehash: hashOf(code) });
  const absentRow = (name, address) => rows.set(lower(address), { name, address: checksummed(address), codehash: null, absent: true });

  // ---------------------------------------------------------------- chain
  const [idRead, clientRead, latestRead] = await Promise.all([settle(rpc('eth_chainId', [])), settle(rpc('web3_clientVersion', [])),
    settle(rpc('eth_getBlockByNumber', ['latest', false]))]);
  ensure(idRead.value && latestRead.value && HEX32.test(latestRead.value.hash ?? ''), 'chain_unreachable: '
    + (idRead.failure?.kind ?? latestRead.failure?.kind ?? 'no_latest_block') + (idRead.failure?.detail || latestRead.failure?.detail ? ' ' + (idRead.failure?.detail || latestRead.failure?.detail) : ''));
  const chainId = Number(quantity(idRead.value));
  ensure(Number.isSafeInteger(chainId) && chainId > 0, 'invalid_chain_id');
  const head = { number: quantity(latestRead.value.number), hash: latestRead.value.hash, timestamp: quantity(latestRead.value.timestamp),
    baseFeePerGas: typeof latestRead.value.baseFeePerGas === 'string' ? quantity(latestRead.value.baseFeePerGas) : null };
  const tag = latestRead.value.number;
  const code = address => rpc('eth_getCode', [address, tag]);
  const call = (to, signature, outputs, inputs = []) => rpc('eth_call', [{ to, data: encodeCall(signature, inputs) }, tag]).then(raw => decodeReturn(outputs, raw));
  const read = (...args) => settle(call(...args));
  const known = references.profiles.find(p => p.chainId === chainId);
  const testnetOf = pending?.testnet?.chainId === chainId ? pending.slug : null;
  add('chain.id', 'chain', expectChainId === null || expectChainId === chainId ? 'pass' : 'fail',
    `eth_chainId ${chainId}${expectChainId === null ? '' : expectChainId === chainId ? ', as expected' : `, expected ${expectChainId}`}${testnetOf ? ` (${testnetOf}'s testnet)` : ''}${known ? ` (already Domino's ${known.slug})` : ''}`,
    { chainId, expected: expectChainId, client: typeof clientRead.value === 'string' ? (rpc.scrub ?? redactUrls)(clientRead.value).slice(0, 120) : null,
      testnetOf, alreadyEnabledAs: known?.slug ?? null });
  const age = now - Number(head.timestamp);
  add('chain.head', 'chain', age <= HEAD_MAX_AGE_SECONDS && age >= -60 ? 'pass' : 'fail', `block ${head.number}, ${age} s old`,
    { number: Number(head.number), hash: head.hash, timestamp: Number(head.timestamp), ageSeconds: age, maximumAgeSeconds: HEAD_MAX_AGE_SECONDS });

  const windows = [100, 1000, 10000].filter(n => BigInt(n) < head.number);
  const [samples, tagged, arbCode, arbVersion] = await Promise.all([
    Promise.all(windows.map(n => settle(rpc('eth_getBlockByNumber', [hex(head.number - BigInt(n)), false])))),
    Promise.all(['safe', 'finalized'].map(t => settle(rpc('eth_getBlockByNumber', [t, false])))),
    settle(code(ARB_SYS)), read(ARB_SYS, 'arbOSVersion()', ['uint256'])]);
  const measured = windows.flatMap((blocks, i) => samples[i].value ? [{ blocks, seconds: Number(head.timestamp - quantity(samples[i].value.timestamp)) }] : [])
    .map(w => ({ ...w, averageSeconds: Number((w.seconds / w.blocks).toFixed(4)) }));
  const widest = measured.at(-1), blockTimeSeconds = widest && widest.seconds > 0 ? Number((widest.seconds / widest.blocks).toFixed(3)) : null;
  add('chain.blockTime', 'chain', blockTimeSeconds === null ? 'unknown' : blockTimeSeconds <= 60 ? 'pass' : 'fail',
    blockTimeSeconds === null ? 'no sample' : `${blockTimeSeconds} s per block over the last ${widest.blocks} blocks`,
    { windows: measured, note: 'Nitro block timestamps have 1 s resolution; a quiet chain makes fewer blocks' });
  const lag = answer => answer.value ? { number: Number(quantity(answer.value.number)), blocks: Number(head.number - quantity(answer.value.number)),
    seconds: Number(head.timestamp - quantity(answer.value.timestamp)) } : null;
  const [safeLag, finalLag] = tagged.map(lag);
  add('chain.finalized', 'chain', finalLag ? 'pass' : tagged[1].failure && !DEFINITE.has(tagged[1].failure.kind) && tagged[1].failure.kind !== 'rpc_error' ? 'unknown' : 'fail',
    finalLag ? `'finalized' trails the head by ${finalLag.blocks} blocks (${finalLag.seconds} s)` : "no 'finalized' block: deploy.mjs verify reads at 'finalized' by default",
    { safe: safeLag, finalized: finalLag, failure: tagged[1].failure ?? null });

  const nitro = arbCode.value === '0xfe' && arbVersion.value !== undefined;
  const stack = nitro ? 'arbitrum-nitro' : null;
  if (nitro) {
    const raw = arbVersion.value[0];
    row('ArbSys', ARB_SYS, arbCode.value);
    add('chain.arbOS', 'chain', pending && pending.stack !== 'arbitrum-nitro' ? 'fail' : 'pass', `Arbitrum Nitro, ArbOS ${raw - 55n}`,
      { arbOSVersion: Number(raw - 55n), arbOSVersionRaw: raw.toString(), arbSysCodehash: hashOf(arbCode.value), pendingStack: pending?.stack ?? null });
  } else {
    // Nitro marks its precompiles with the one-byte code 0xfe; anything else at 0x64 is not ArbSys.
    const reason = arbCode.value === undefined ? null : arbCode.value === '0x' ? 'not an Arbitrum Nitro chain (no ArbSys at 0x64)'
      : arbCode.value !== '0xfe' ? 'the code at 0x64 is not Nitro\'s ArbSys precompile'
        : DEFINITE.has(arbVersion.failure.kind) ? 'ArbSys does not answer arbOSVersion()' : null;
    add('chain.arbOS', 'chain', reason ? 'fail' : 'unknown', reason ?? 'ArbSys unreadable',
      { arbSysCode: arbCode.value === undefined ? null : arbCode.value.slice(0, 10), failure: arbVersion.failure ?? arbCode.failure ?? null, pendingStack: pending?.stack ?? null });
  }

  const l1Estimate = async (payload, to, creation) => {
    const answer = await read(NODE_INTERFACE, 'gasEstimateL1Component(address,bool,bytes)', ['uint64', 'uint256', 'uint256'],
      [['address', to], ['bool', creation], ['bytes', payload]]);
    return answer.value ? { l1Gas: answer.value[0], l2BaseFee: answer.value[1], l1BaseFeeEstimate: answer.value[2] } : { failure: answer.failure };
  };
  if (nitro) {
    const l1 = await l1Estimate(incompressible(release.calldataBytes), CREATE_X, false);
    if (l1.failure) add('chain.l1Component', 'chain', l1.failure.kind === 'rpc_error' || DEFINITE.has(l1.failure.kind) ? 'fail' : 'unknown',
      'NodeInterface.gasEstimateL1Component did not answer: deploy.mjs refuses a production preparation without it', { failure: l1.failure });
    else {
      const execution = BigInt(release.executionLowerBound), required = ceilPercent(execution + l1.l1Gas, GAS_HEADROOM_PERCENT);
      const fits = required <= MAX_TRANSACTION_GAS;
      add('chain.l1Component', 'chain', fits ? 'pass' : 'unknown',
        `${l1.l1Gas} L1 gas for ${release.component}'s ${release.calldataBytes} B; (execution >= ${execution} + L1) x 1.25 ${fits ? '<=' : '>'} the ${MAX_TRANSACTION_GAS} cap`,
        { method: 'NodeInterface.gasEstimateL1Component', largestStep: release.component, payloadBytes: release.calldataBytes,
          l1Gas: l1.l1Gas.toString(), l2BaseFeeWei: l1.l2BaseFee.toString(), l1BaseFeeEstimateWei: l1.l1BaseFeeEstimate.toString(),
          executionLowerBound: execution.toString(), requiredWithHeadroom: required.toString(), transactionGasCap: MAX_TRANSACTION_GAS.toString(),
          note: 'an incompressible payload: an upper bound of the L1 component; deploy.mjs plan/preflight measure the real steps' });
    }
  } else add('chain.l1Component', 'chain', 'unknown', 'not a Nitro chain: deploy.mjs prices an OP Stack L1 fee with GasPriceOracle (not checked here)');
  add('chain.baseFee', 'chain', head.baseFeePerGas !== null ? 'pass' : 'fail',
    head.baseFeePerGas !== null ? `${gwei(head.baseFeePerGas)} gwei` : 'the latest block has no baseFeePerGas (no EIP-1559)',
    { baseFeePerGasWei: head.baseFeePerGas?.toString() ?? null });

  {
    const overridden = await settle(rpc('eth_call', [{ to: PROBE_ADDRESS, data: '0x' }, tag, { [PROBE_ADDRESS]: { code: CANCUN_PROBE } }]));
    if (overridden.value === FORTY_TWO) add('chain.cancun', 'chain', 'pass', 'TSTORE, TLOAD, MCOPY and PUSH0 run (eth_call with a state override)', { method: 'state override' });
    else {
      const created = await settle(rpc('eth_call', [{ data: CANCUN_PROBE }, tag]));
      if (created.value === FORTY_TWO) add('chain.cancun', 'chain', 'pass', 'TSTORE, TLOAD, MCOPY and PUSH0 run (creation call; the state override did not)',
        { method: 'creation call', stateOverride: overridden.failure ?? { returned: overridden.value } });
      else {
        const parts = await Promise.all(Object.entries(OPCODE_PROBES).map(async ([name, probe]) => {
          const answer = await settle(rpc('eth_call', [{ data: probe.code }, tag]));
          return [name, answer.value === probe.returns ? 'runs' : answer.failure ? answer.failure.kind : 'wrong result'];
        }));
        const missing = parts.filter(([, state]) => state !== 'runs').map(([name]) => name);
        const definite = missing.length > 0 && parts.every(([, state]) => ['runs', 'rpc_error', 'reverted', 'wrong result'].includes(state));
        add('chain.cancun', 'chain', definite ? 'fail' : 'unknown', missing.length ? `does not run: ${missing.join(', ')}` : 'the probe failed although each opcode ran',
          { opcodes: Object.fromEntries(parts), stateOverride: overridden.failure ?? null, creationCall: created.failure ?? null });
      }
    }
  }

  {
    const time = head.timestamp + 1n, expected = '0x' + word(time);
    const block = calls => ({ blockStateCalls: [{ blockOverrides: { time: hex(time) }, ...calls }], validation: false });
    const answer = await settle(rpc('eth_simulateV1', [block({ stateOverrides: { [PROBE_ADDRESS]: { code: SIMULATE_PROBE } },
      calls: [{ from: PROBE_SENDER, to: PROBE_ADDRESS, data: '0x01' }, { from: PROBE_SENDER, to: PROBE_ADDRESS, data: '0x' }] }), tag]));
    const results = Array.isArray(answer.value) && answer.value.length === 1 && Array.isArray(answer.value[0]?.calls) ? answer.value[0].calls : null;
    const ok = results?.length === 2 && results[0].status === '0x1' && (results[0].logs ?? []).length === 1 && results[1].status === '0x1' && results[1].returnData === expected;
    if (ok) add('chain.simulateV1', 'chain', 'pass', 'eth_simulateV1: block time override, state from call to call and logs', { calls: 2 });
    else if (answer.failure?.kind === 'unsupported') add('chain.simulateV1', 'chain', 'fail', 'eth_simulateV1 is not served: the V2 plan API and the app simulate with it', { failure: answer.failure });
    else {
      const bare = await settle(rpc('eth_simulateV1', [block({ calls: [{ from: PROBE_SENDER, to: PROBE_SENDER, data: '0x' }] }), tag]));
      const served = Array.isArray(bare.value) && bare.value[0]?.calls?.[0]?.status === '0x1';
      add('chain.simulateV1', 'chain', served ? 'unknown' : answer.failure && !DEFINITE.has(answer.failure.kind) && answer.failure.kind !== 'rpc_error' ? 'unknown' : 'fail',
        served ? 'eth_simulateV1 answers a bare call, but not the stateful probe' : 'eth_simulateV1 did not simulate',
        { failure: answer.failure ?? null, results: results?.map(r => ({ status: r.status, logs: (r.logs ?? []).length, returnData: String(r.returnData).slice(0, 66) })) ?? null,
          bare: bare.failure ?? (served ? 'served' : 'unexpected result') });
    }
  }

  // ---------------------------------------------------------------- infra
  const infraAddresses = [CREATE_X, ARACHNID_PROXY, SAFE_SINGLETON_FACTORY, PERMIT2, MULTICALL3, ...Object.keys(references.safeSingletons),
    ...Object.keys(references.safeProxyFactories)];
  const senders = [...new Set([...Object.values(KEYLESS).map(k => k.deployer), SAFE_FACTORY_DEPLOYER])];
  const [infraCodes, accounts] = await Promise.all([
    Promise.all(infraAddresses.map(async a => [a, await settle(code(a))])).then(Object.fromEntries),
    Promise.all(senders.map(async a => {
      const [nonce, balance] = await Promise.all([settle(rpc('eth_getTransactionCount', [a, tag])), settle(rpc('eth_getBalance', [a, tag]))]);
      return [a, { address: checksummed(a), nonce: nonce.value === undefined ? null : quantity(nonce.value), balanceWei: balance.value === undefined ? null : quantity(balance.value) }];
    })).then(Object.fromEntries)]);
  const account = a => ({ address: accounts[a].address, nonce: accounts[a].nonce?.toString() ?? null, balanceWei: accounts[a].balanceWei?.toString() ?? null });
  const contractFacts = (address, answer) => answer.value === undefined ? { address: checksummed(address), failure: answer.failure }
    : { address: checksummed(address), bytes: bytesOf(answer.value), codehash: hashOf(answer.value) };
  const present = answer => typeof answer.value === 'string' && answer.value !== '0x';
  const canonicalAt = { createx: new Set([references.createxCodeHash]), arachnid: recordedHashes(references, 'arachnid'),
    safeSingletonFactory: recordedHashes(references, 'safeSingletonFactory'), multicall3: recordedHashes(references, 'multicall3') };
  const verified = {};
  /** Present with a code hash the profiles (or deploy.mjs) record: pass; other code: fail; no code: fail and a bootstrap. */
  const identical = (id, key, address, label, expected, onAbsent) => {
    const answer = infraCodes[address];
    if (!expected.size) return add(id, 'infra', 'unknown', 'no profile records its code hash', contractFacts(address, answer));
    if (answer.failure) return add(id, 'infra', statusOf(answer.failure), 'code unreadable', contractFacts(address, answer));
    if (!present(answer)) { absentRow(label, address); onAbsent?.(); return add(id, 'infra', 'fail', 'absent', { ...contractFacts(address, answer), expected: [...expected] }); }
    const ok = expected.has(hashOf(answer.value));
    if (ok) { row(label, address, answer.value); verified[key] = true; }
    return add(id, 'infra', ok ? 'pass' : 'fail', ok ? 'canonical code hash' : 'other code at its address: not the canonical contract',
      { ...contractFacts(address, answer), expected: [...expected] });
  };
  const keylessRoute = (key, presentNow) => {
    const k = KEYLESS[key], nonce = accounts[k.deployer].nonce;
    return { name: k.name, deployer: checksummed(k.deployer), nonce: nonce?.toString() ?? null, contractPresent: presentNow,
      spent: nonce !== null && nonce > 0n && !presentNow, accepted: nonce !== null && nonce > 0n && presentNow, keyless: k.keyless };
  };
  async function keylessBootstrap(key) {
    const k = KEYLESS[key], nonce = accounts[k.deployer].nonce;
    // Arachnid's init code is known exactly; the others are bounded by an incompressible payload of their size.
    const payload = k.rawTransaction ? viem.parseTransaction(k.rawTransaction).data : incompressible(k.initCodeBytes);
    const estimate = nitro ? await l1Estimate(payload, ZERO, true) : null;
    const l1Gas = estimate && !estimate.failure ? estimate.l1Gas : null;
    const variants = k.gasLimits.map(gasLimit => ({ gasLimit: gasLimit.toString(), fundingWei: (gasLimit * k.gasPrice).toString(),
      fundingNative: viem.formatUnits(gasLimit * k.gasPrice, 18),
      fits: l1Gas === null ? (nitro ? null : gasLimit >= k.executionGas) : gasLimit >= k.executionGas + 2n * l1Gas }));
    const usable = variants.find(v => v.fits);
    const possible = nonce === null ? 'unknown' : nonce > 0n ? 'no' : usable ? 'yes' : variants.every(v => v.fits === null) ? 'unknown' : 'no';
    bootstrap.push({ target: k.name, needed: true, possible,
      route: `fund ${checksummed(k.deployer)} with gasLimit x 100 gwei, then broadcast the published presigned transaction (pre-EIP-155, nonce 0)`,
      transactions: [{ from: checksummed(k.deployer), kind: 'presigned legacy transaction, any chain id', variants, ...(k.rawTransaction ? { rawTransaction: k.rawTransaction } : {}) }],
      requires: ['the node accepts unprotected (pre-EIP-155) transactions: see infra.unprotectedTransactions', `the sender's nonce is 0 (now ${nonce ?? 'unknown'})`],
      estimate: { executionGas: k.executionGas.toString(), l1Gas: l1Gas?.toString() ?? null, l1PayloadBytes: bytesOf(payload),
        l1Payload: k.rawTransaction ? 'the presigned init code' : 'incompressible, an upper bound', margin: 'the L1 part counted twice', failure: estimate?.failure ?? null },
      recommendation: nonce !== null && nonce > 0n ? `the sender's nonce 0 is spent: ${k.name} can never be at ${checksummed(k.contract)} on this chain; ask the chain to preinstall it`
        : usable ? `the ${usable.gasLimit}-gas variant: fund ${usable.fundingNative} of the native coin` : l1Gas === null && nitro ? 'unknown: no L1 estimate'
          : 'no published variant covers execution plus L1 gas; ask the chain to preinstall it',
      warnings: ['a variant that runs out of gas spends the nonce for ever: rehearse on a fork of the chain first (anvil --fork-url)',
        'the unspent funding stays with the sender'], source: k.source });
  }

  const keylessAbsent = [];
  identical('infra.createx', 'createx', CREATE_X, 'CreateX', canonicalAt.createx, () => keylessAbsent.push('createx'));
  checks.at(-1).evidence.deployer = account(KEYLESS.createx.deployer);
  identical('infra.arachnid', 'arachnid', ARACHNID_PROXY, 'Arachnid deterministic deployment proxy', canonicalAt.arachnid, () => keylessAbsent.push('arachnid'));
  checks.at(-1).evidence.deployer = account(KEYLESS.arachnid.deployer);
  identical('infra.safeSingletonFactory', 'safeSingletonFactory', SAFE_SINGLETON_FACTORY, 'safeSingletonFactory', canonicalAt.safeSingletonFactory);
  checks.at(-1).evidence.deployer = account(SAFE_FACTORY_DEPLOYER);
  identical('infra.multicall3', 'multicall3', MULTICALL3, 'Multicall3', canonicalAt.multicall3, () => keylessAbsent.push('multicall3'));
  checks.at(-1).evidence.deployer = account(KEYLESS.multicall3.deployer);
  for (const key of keylessAbsent) await keylessBootstrap(key);
  {
    const keyless = Object.keys(KEYLESS).map(key => keylessRoute(key, present(infraCodes[KEYLESS[key].contract])));
    const accepted = keyless.filter(k => k.accepted), proof = accepted.find(k => k.keyless);
    add('infra.unprotectedTransactions', 'infra', accepted.length ? 'pass' : 'unknown',
      accepted.length ? `pre-EIP-155 presigned transactions were mined: ${accepted.map(k => k.name).join(', ')}${proof ? '' : ' (consistent with; their senders\' keys exist)'}`
        : 'no evidence: no keyless sender has sent; contracts present with nonce 0 senders are genesis preinstalls',
      { senders: keyless });
  }

  // Permit2: chain id and domain separator are immutables.
  const permit2Answer = infraCodes[PERMIT2];
  if (present(permit2Answer)) {
    const domain = permit2Domain(chainId), separator = await read(PERMIT2, 'DOMAIN_SEPARATOR()', ['bytes32']);
    const build = sameBuild(permit2Answer.value, [BigInt(chainId), domain], references.profiles.map(p => ({ slug: p.slug, values: [BigInt(p.chainId), permit2Domain(p.chainId)], codehash: p.permit2?.address === PERMIT2 ? p.permit2.codehash : null })));
    const domainOk = separator.value?.[0] === domain, ok = domainOk && build.matches.length > 0;
    if (ok) { row('Permit2', PERMIT2, permit2Answer.value); verified.permit2 = true; }
    add('infra.permit2', 'infra', ok ? 'pass' : separator.failure && !DEFINITE.has(separator.failure.kind) ? 'unknown' : 'fail',
      ok ? `canonical: byte-identical to ${build.matches.join(', ')}'s once its chain id and domain separator are substituted` : !domainOk ? 'DOMAIN_SEPARATOR() is not Permit2\'s for this chain' : 'not the build any profile recorded',
      { ...contractFacts(PERMIT2, permit2Answer), immutables: 'chain id and EIP-712 domain separator: its code hash differs on every chain',
        domainSeparator: separator.value?.[0] ?? separator.failure, expectedDomainSeparator: domain, byteComparison: build });
  } else {
    if (permit2Answer.value === '0x') absentRow('Permit2', PERMIT2);
    add('infra.permit2', 'infra', permit2Answer.failure ? statusOf(permit2Answer.failure) : 'fail', permit2Answer.failure ? 'code unreadable' : 'absent', contractFacts(PERMIT2, permit2Answer));
    if (!permit2Answer.failure) bootstrap.push({ target: 'Permit2', needed: true, possible: verified.arachnid ? 'yes' : 'after the Arachnid proxy',
      route: 'permissionless: Uniswap\'s Permit2 init code through the Arachnid proxy with Uniswap\'s published salt (Uniswap/permit2 script/DeployPermit2.s.sol)',
      transactions: [{ from: 'any funded account', to: checksummed(ARACHNID_PROXY), kind: 'CREATE2 call' }], source: 'https://github.com/Uniswap/permit2' });
  }

  // Safe: singletons and proxy factories, per version.
  const safe = {};
  for (const [address, info] of Object.entries(references.safeSingletons)) {
    const answer = infraCodes[address], version = (safe[info.version] ??= { singletons: [], factories: [] });
    const ok = present(answer) && hashOf(answer.value) === info.codehash;
    if (ok) row(`Safe ${info.version} ${info.l2 ? 'SafeL2' : 'Safe'} singleton`, address, answer.value);
    version.singletons.push({ ...contractFacts(address, answer), l2: info.l2, via: SAFE_SINGLETON_ROUTES[address] ?? null, canonical: ok });
  }
  const factories = await Promise.all(Object.entries(references.safeProxyFactories).map(async ([address, info]) => {
    const answer = infraCodes[address];
    const entry = { ...contractFacts(address, answer), via: info.via, codehashMatches: present(answer) ? hashOf(answer.value) === info.codehash : null, proxy: null };
    if (present(answer)) {
      // The proxy the factory creates, run as a creation call: its runtime hash must be this version's.
      const singleton = Object.entries(references.safeSingletons).find(([, s]) => s.version === info.version)?.[0] ?? '0x' + '0'.repeat(39) + '1';
      const creation = await read(address, 'proxyCreationCode()', ['bytes']);
      if (creation.value) {
        const runtime = await settle(rpc('eth_call', [{ data: viem.concatHex([creation.value[0], viem.encodeAbiParameters([{ type: 'address' }], [singleton])]) }, tag]));
        entry.proxy = runtime.value ? { runtimeCodeHash: hashOf(runtime.value), version: references.safeProxyRuntimeHashes[hashOf(runtime.value)] ?? null } : { failure: runtime.failure };
      } else entry.proxy = { failure: creation.failure };
      if (entry.codehashMatches && entry.proxy.version === info.version) row(`Safe ${info.version} SafeProxyFactory`, address, answer.value);
    }
    return [info.version, entry];
  }));
  for (const [version, entry] of factories) (safe[version] ??= { singletons: [], factories: [] }).factories.push(entry);
  const complete = Object.entries(safe).filter(([version, v]) => v.singletons.some(s => s.canonical) && v.factories.some(f => f.codehashMatches && f.proxy?.version === version))
    .map(([version]) => version).sort();
  const safeUnreadable = Object.values(safe).some(v => [...v.singletons, ...v.factories].some(x => x.failure));
  add('infra.safe', 'infra', complete.length ? 'pass' : safeUnreadable ? 'unknown' : 'fail',
    complete.length ? `canonical Safe ${complete.join(', ')} (singleton and proxy factory): governance can be a Safe` : 'no canonical Safe version is complete: deploy.mjs requires governance to be a canonical Safe',
    { versions: safe, complete });
  if (!verified.safeSingletonFactory && !infraCodes[SAFE_SINGLETON_FACTORY].failure) {
    const nonce = accounts[SAFE_FACTORY_DEPLOYER].nonce;
    bootstrap.push({ target: 'Safe Singleton Factory', needed: complete.length === 0,
      possible: present(infraCodes[SAFE_SINGLETON_FACTORY]) ? 'no: other code holds its address' : nonce === null ? 'unknown' : nonce === 0n ? 'yes, by the Safe team' : 'no: its deployer\'s nonce 0 is spent',
      route: 'open a "new network" request at github.com/safe-global/safe-singleton-factory; Safe\'s bot names the amount to fund '
        + `${checksummed(SAFE_FACTORY_DEPLOYER)}, then the Safe team signs an EIP-155 transaction for this chain id and deploys it (they aim at two weeks)`,
      transactions: [{ from: checksummed(SAFE_FACTORY_DEPLOYER), kind: 'EIP-155 transaction signed by the Safe team', fundingWei: null }],
      requires: ['the chain is listed on chainlist.org'], unlocks: 'Safe 1.4.1 and 1.5.0 (and 1.3.0 eip155)', source: 'https://github.com/safe-global/safe-singleton-factory (README)' });
  }
  for (const version of ['1.3.0', '1.4.1', '1.5.0'].filter(v => !complete.includes(v) && safe[v])) {
    const via = version === '1.3.0' ? 'arachnid' : 'safeSingletonFactory';
    const ready = via === 'arachnid' ? verified.arachnid : verified.safeSingletonFactory;
    const perTransaction = head.baseFeePerGas === null ? null : (MAX_TRANSACTION_GAS * head.baseFeePerGas).toString();
    bootstrap.push({ target: `Safe ${version}`, needed: complete.length === 0,
      possible: ready ? 'yes' : via === 'arachnid' ? 'after the Arachnid proxy' : 'after the Safe Singleton Factory',
      route: via === 'arachnid' ? 'permissionless: CREATE2 through the Arachnid proxy with safe-deployments\' canonical 1.3.0 init code (salt 0)'
        : 'permissionless once the Safe Singleton Factory exists: CREATE2 through it with the release\'s init code (safe-smart-account deployment scripts)',
      transactions: [{ from: 'any funded account', to: checksummed(via === 'arachnid' ? ARACHNID_PROXY : SAFE_SINGLETON_FACTORY), kind: 'CREATE2 call',
        contracts: 'the singleton or SafeL2 singleton and the SafeProxyFactory (the Safe app also uses the fallback handler and MultiSendCallOnly)' }],
      fundingUpperBoundPerTransactionWei: perTransaction, fundingNote: `at most ${MAX_TRANSACTION_GAS} gas each at today's base fee, L1 component included on Nitro`,
      source: 'https://github.com/safe-global/safe-deployments' });
  }

  // -------------------------------------------------------------- uniswap
  const u = uniswap;
  const candidates = { v3Factory: u.v3.factory, v3PositionManager: u.v3.positionManager, quoterV2: u.v3.quoterV2, swapRouter02: u.v3.swapRouter02,
    poolManager: u.v4.poolManager, v4PositionManager: u.v4.positionManager, stateView: u.v4.stateView, v4Quoter: u.v4.quoter, universalRouter: u.universalRouter.address };
  const uniCodes = Object.fromEntries(await Promise.all(Object.entries(candidates).filter(([, a]) => a).map(async ([k, a]) => [k, await settle(code(a))])));
  const getter = (contract, signature) => contract ? read(contract, signature, ['address']) : Promise.resolve(null);
  const [npmFactory, npmWeth, quoterFactory, quoterWeth, routerFactory, routerWeth, routerManager, v4pmPool, v4pmPermit2, v4pmWeth, stateViewPool,
    quoterPool, routerPool] = await Promise.all([
    getter(u.v3.positionManager, 'factory()'), getter(u.v3.positionManager, 'WETH9()'), getter(u.v3.quoterV2, 'factory()'), getter(u.v3.quoterV2, 'WETH9()'),
    getter(u.v3.swapRouter02, 'factory()'), getter(u.v3.swapRouter02, 'WETH9()'), getter(u.v3.swapRouter02, 'positionManager()'),
    getter(u.v4.positionManager, 'poolManager()'), getter(u.v4.positionManager, 'permit2()'), getter(u.v4.positionManager, 'WETH9()'),
    getter(u.v4.stateView, 'poolManager()'), getter(u.v4.quoter, 'poolManager()'), getter(u.universalRouter.address, 'poolManager()')]);
  const answered = r => r?.value ? lower(r.value[0]) : null;
  // The wrapped native: the owner's input, else what the v3 position manager (or v4's) wraps.
  const wrapped = wrappedNative ?? answered(npmWeth) ?? answered(v4pmWeth);
  const wrappedSource = wrappedNative ? 'input' : answered(npmWeth) ? 'NonfungiblePositionManager.WETH9()' : answered(v4pmWeth) ? 'v4 PositionManager.WETH9()' : null;
  /** A getter that must name `expected`. An optional one (`required` false) counts only when it answers and differs. */
  const expectSame = (label, answer, expected, required = true) => {
    const unanswered = required ? undefined : 'skipped';
    if (answer === null) return { getter: label, status: unanswered ?? 'unknown', reason: 'no candidate' };
    if (answer.failure) return { getter: label, status: unanswered ?? statusOf(answer.failure), failure: answer.failure };
    const value = lower(answer.value[0]);
    return { getter: label, value: checksummed(value), expected: expected ? checksummed(expected) : null,
      status: expected === null || expected === undefined ? unanswered ?? 'unknown' : value === expected ? 'pass' : 'fail' };
  };
  const profileValues = key => references.profiles.map(p => ({ slug: p.slug, values: [p[key]?.address], codehash: p[key]?.codehash ?? null }));
  const uniswapCheck = (id, key, label, subs, extra = {}) => {
    const address = candidates[key];
    if (!address) return add(id, 'uniswap', 'unknown', 'no candidate address given');
    const answer = uniCodes[key];
    if (answer.failure) return add(id, 'uniswap', statusOf(answer.failure), 'code unreadable', contractFacts(address, answer));
    if (!present(answer)) return add(id, 'uniswap', 'fail', 'no code at the candidate address', contractFacts(address, answer));
    const status = combine([...subs.map(s => s.status), ...(extra.status ? [extra.status] : [])]);
    if (status === 'pass') { row(label, address, answer.value); verified[key] = true; }
    return add(id, 'uniswap', status, extra.summary ?? subs.map(s => `${s.getter} ${s.status}`).join(', '),
      { ...contractFacts(address, answer), immutables: IMMUTABLES[key], wiring: subs, ...extra.evidence });
  };

  // v3 factory: tiers, and its build (its only immutable is its own address).
  const tiers = {};
  if (u.v3.factory && present(uniCodes.v3Factory ?? {})) {
    const spacing = await Promise.all(Object.keys(STANDARD_TICK_SPACING).map(fee => read(u.v3.factory, 'feeAmountTickSpacing(uint24)', ['int24'], [['uint24', Number(fee)]])));
    Object.keys(STANDARD_TICK_SPACING).forEach((fee, i) => { tiers[fee] = spacing[i].value ? Number(spacing[i].value[0]) : spacing[i].failure; });
  }
  {
    const enabled = Object.entries(tiers).filter(([, s]) => typeof s === 'number' && s > 0);
    const nonstandard = enabled.filter(([fee, s]) => STANDARD_TICK_SPACING[fee] !== s);
    const unreadable = Object.values(tiers).some(s => typeof s === 'object');
    const status = !enabled.length ? (unreadable ? 'unknown' : 'fail') : nonstandard.length ? 'fail' : 'pass';
    const build = present(uniCodes.v3Factory ?? {}) ? sameBuild(uniCodes.v3Factory.value, [u.v3.factory], profileValues('v3Factory')) : null;
    uniswapCheck('uniswap.v3.factory', 'v3Factory', 'UniswapV3Factory', [], { status, summary: `fee tiers ${enabled.map(([f, s]) => `${f}:${s}`).join(' ') || 'none'}`
      + (build?.matches.length ? `; same build as ${build.matches.join(', ')}` : ''), evidence: { feeAmountTickSpacing: tiers, standard: STANDARD_TICK_SPACING, byteComparison: build } });
  }
  uniswapCheck('uniswap.v3.positionManager', 'v3PositionManager', 'NonfungiblePositionManager',
    [expectSame('factory()', npmFactory, u.v3.factory), expectSame('WETH9()', npmWeth, wrapped)], { evidence: { byteComparison: 'not meaningful: per-chain immutables' } });
  {
    const build = present(uniCodes.quoterV2 ?? {}) ? sameBuild(uniCodes.quoterV2.value, [u.v3.factory, wrapped],
      references.profiles.map(p => ({ slug: p.slug, values: [p.v3Factory?.address, p.wrappedNative], codehash: p.quoterV2?.codehash ?? null }))) : null;
    uniswapCheck('uniswap.v3.quoterV2', 'quoterV2', 'QuoterV2', [expectSame('factory()', quoterFactory, u.v3.factory), expectSame('WETH9()', quoterWeth, wrapped)],
      { evidence: { byteComparison: build } });
  }
  uniswapCheck('uniswap.v3.swapRouter02', 'swapRouter02', 'SwapRouter02', [expectSame('factory()', routerFactory, u.v3.factory), expectSame('WETH9()', routerWeth, wrapped),
    expectSame('positionManager()', routerManager, u.v3.positionManager)], { evidence: { byteComparison: 'not meaningful: per-chain immutables' } });
  {
    const pm = u.v4.poolManager, answer = uniCodes.poolManager;
    const build = pm && present(answer ?? {}) ? sameBuild(answer.value, [pm], profileValues('poolManager')) : null;
    uniswapCheck('uniswap.v4.poolManager', 'poolManager', 'PoolManager', [], { status: build ? (build.matches.length ? 'pass' : 'fail') : 'unknown',
      summary: build?.matches.length ? `byte-identical to ${build.matches.join(', ')}'s once its own address is substituted` : 'not the PoolManager build any profile recorded',
      evidence: { byteComparison: build } });
  }
  uniswapCheck('uniswap.v4.positionManager', 'v4PositionManager', 'PositionManager', [expectSame('poolManager()', v4pmPool, u.v4.poolManager),
    expectSame('permit2()', v4pmPermit2, PERMIT2), expectSame('WETH9()', v4pmWeth, wrapped, false)], { evidence: { byteComparison: 'not meaningful: per-chain immutables' } });
  for (const [id, key, label, answer] of [['uniswap.v4.stateView', 'stateView', 'StateView', stateViewPool], ['uniswap.v4.quoter', 'v4Quoter', 'V4Quoter', quoterPool]]) {
    const build = present(uniCodes[key] ?? {}) ? sameBuild(uniCodes[key].value, [u.v4.poolManager], references.profiles.map(p =>
      ({ slug: p.slug, values: [p.poolManager?.address], codehash: p[key]?.codehash ?? null }))) : null;
    uniswapCheck(id, key, label, [expectSame('poolManager()', answer, u.v4.poolManager)], { evidence: { byteComparison: build } });
  }
  uniswapCheck('uniswap.universalRouter', 'universalRouter', 'UniversalRouter', [expectSame('poolManager()', routerPool, u.v4.poolManager)],
    { evidence: { claimedVersion: u.universalRouter.version ?? null, version: 'not readable on chain: Uniswap\'s deployment list or SDK names it',
      byteComparison: 'not meaningful: per-chain immutables' } });

  // --------------------------------------------------------------- tokens
  async function token(address) {
    const [answer, symbol, decimals] = await Promise.all([settle(code(address)), settle(rpc('eth_call', [{ to: address, data: encodeCall('symbol()') }, tag])),
      read(address, 'decimals()', ['uint8'])]);
    let text = null;
    if (symbol.value && symbol.value !== '0x') {
      try { text = viem.decodeAbiParameters([{ type: 'string' }], symbol.value)[0]; } catch {
        if (bytesOf(symbol.value) === 32) text = Buffer.from(symbol.value.slice(2), 'hex').toString('latin1').replace(/\0+$/, '');
      }
    }
    return { answer, facts: { ...contractFacts(address, answer), symbol: text === null ? null : printable(text).slice(0, 32), decimals: decimals.value ? Number(decimals.value[0]) : null,
      failures: { symbol: symbol.failure ?? null, decimals: decimals.failure ?? null } } };
  }
  const tokens = {};
  if (wrapped) {
    const { answer, facts } = await token(wrapped);
    const crossChecked = answered(npmWeth) === wrapped || answered(v4pmWeth) === wrapped;
    const ok = present(answer) && facts.decimals === 18 && facts.symbol !== null;
    const status = !present(answer) ? (answer.failure ? statusOf(answer.failure) : 'fail') : facts.decimals !== null && facts.decimals !== 18 ? 'fail' : ok ? 'pass' : 'unknown';
    tokens.wrapped = { ...facts, crossChecked, source: wrappedSource, verified: status === 'pass' && crossChecked };
    if (tokens.wrapped.verified) row(isSymbol(facts.symbol) ? facts.symbol : 'wrapped native', wrapped, answer.value);
    add('tokens.wrappedNative', 'tokens', status, `${facts.symbol ?? '?'} ${facts.decimals ?? '?'} decimals (from ${wrappedSource})${crossChecked ? ', the periphery\'s WETH9' : ', not cross-checked against a Uniswap periphery'}`,
      { ...tokens.wrapped, schemaSymbol: isSymbol(facts.symbol), note: 'symbols are untrusted text; the profile needs 18 decimals' });
  } else add('tokens.wrappedNative', 'tokens', 'unknown', 'no --wrapped-native and no Uniswap periphery to read WETH9() from');
  if (stable) {
    const { answer, facts } = await token(stable);
    const [s1967, sZos] = await Promise.all([settle(rpc('eth_getStorageAt', [stable, EIP1967_IMPLEMENTATION_SLOT, tag])), settle(rpc('eth_getStorageAt', [stable, ZOS_IMPLEMENTATION_SLOT, tag]))]);
    const implementation = [s1967, sZos].map(s => s.value && BigInt(s.value) !== 0n ? checksummed('0x' + s.value.slice(-40)) : null).find(Boolean) ?? null;
    const status = !present(answer) ? (answer.failure ? statusOf(answer.failure) : 'fail') : facts.decimals !== null && facts.symbol !== null ? 'pass' : 'unknown';
    tokens.stable = { ...facts, upgradeableProxyImplementation: implementation, verified: status === 'pass' };
    if (tokens.stable.verified) row(isSymbol(facts.symbol) ? facts.symbol : 'stable', stable, answer.value);
    add('tokens.stable', 'tokens', status, `${facts.symbol ?? '?'} ${facts.decimals ?? '?'} decimals${implementation ? `, upgradeable proxy of ${implementation}` : ''}`,
      { ...tokens.stable, note: 'the owner\'s choice of rank-1 currency; an upgradeable proxy\'s code hash is the proxy\'s' });
  } else add('tokens.stable', 'tokens', 'unknown', 'no --stable given');

  // ------------------------------------------------------------ liquidity
  let initCodeHash = null;
  if (u.v3.factory && verified.v3Factory && wrapped && stable && Number.isInteger(tokens.wrapped?.decimals) && Number.isInteger(tokens.stable?.decimals)) {
    const fees = Object.entries(tiers).filter(([, s]) => typeof s === 'number' && s > 0).map(([fee]) => Number(fee));
    const pools = await Promise.all(fees.map(async fee => {
      const answer = await read(u.v3.factory, 'getPool(address,address,uint24)', ['address'], [['address', wrapped], ['address', stable], ['uint24', fee]]);
      if (!answer.value) return { fee, failure: answer.failure };
      const pool = lower(answer.value[0]);
      if (pool === ZERO) return { fee, pool: null };
      const [poolCode, liquidity, slot0] = await Promise.all([settle(code(pool)), read(pool, 'liquidity()', ['uint128']),
        read(pool, 'slot0()', ['uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool'])]);
      const [token0, token1] = BigInt(wrapped) < BigInt(stable) ? [wrapped, stable] : [stable, wrapped];
      const create2 = lower(viem.getCreate2Address({ from: u.v3.factory, bytecodeHash: V3_POOL_INIT_CODE_HASH,
        salt: viem.keccak256(viem.encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], [token0, token1, fee])) }));
      const sqrt = slot0.value?.[0] ?? null;
      return { fee, pool: checksummed(pool), code: poolCode, liquidity: liquidity.value?.[0] ?? null, sqrtPriceX96: sqrt, tick: slot0.value ? Number(slot0.value[1]) : null,
        observationCardinality: slot0.value ? Number(slot0.value[3]) : null, create2Matches: create2 === pool,
        price: sqrt ? stablePerBase(sqrt, wrapped, tokens.wrapped.decimals, tokens.stable.decimals, stable) : null, failures: [liquidity.failure, slot0.failure].filter(Boolean) };
    }));
    const found = pools.filter(p => p.pool);
    for (const p of found) if (present(p.code)) {
      rows.set(lower(p.pool), { name: `v3 pool ${isSymbol(tokens.wrapped.symbol) ? tokens.wrapped.symbol : 'wrapped'}/${isSymbol(tokens.stable.symbol) ? tokens.stable.symbol : 'stable'} fee ${p.fee} (getPool == CREATE2(initCodeHash): ${p.create2Matches ? 'True' : 'False'})`,
        address: p.pool, codehash: hashOf(p.code.value) });
    }
    const proof = found[0];
    initCodeHash = proof ? (proof.create2Matches ? 'pass' : 'fail') : 'unknown';
    add('uniswap.v3.poolInitCodeHash', 'uniswap', initCodeHash, proof ? `${proof.create2Matches ? '' : 'NOT '}CREATE2(factory, ${V3_POOL_INIT_CODE_HASH.slice(0, 10)}...) for the fee-${proof.fee} pool getPool names`
      : 'no wrapped-native/stable pool to prove it with', { poolInitCodeHash: V3_POOL_INIT_CODE_HASH, pools: found.map(p => ({ fee: p.fee, pool: p.pool, create2Matches: p.create2Matches })) });
    const liquid = found.filter(p => p.liquidity > 0n && p.sqrtPriceX96 > 0n);
    add('liquidity.v3', 'liquidity', liquid.length ? 'pass' : pools.some(p => p.failure) ? 'unknown' : 'fail',
      liquid.length ? liquid.map(p => `fee ${p.fee}: ${p.price} ${tokens.stable.symbol ?? 'stable'} per ${tokens.wrapped.symbol ?? 'wrapped'}, liquidity ${p.liquidity}`).join('; ')
        : found.length ? 'pools exist but none holds liquidity' : 'no wrapped-native/stable v3 pool',
      { pools: pools.map(p => ({ fee: p.fee, pool: p.pool ?? null, liquidity: p.liquidity?.toString() ?? null, sqrtPriceX96: p.sqrtPriceX96?.toString() ?? null, tick: p.tick ?? null,
        observationCardinality: p.observationCardinality ?? null, stablePerWrapped: p.price ?? null, failure: p.failure ?? p.failures?.[0] ?? null })) });
  } else {
    add('uniswap.v3.poolInitCodeHash', 'uniswap', 'unknown', 'needs a verified v3 factory, the wrapped native and the stable');
    add('liquidity.v3', 'liquidity', 'unknown', 'needs a verified v3 factory, the wrapped native and the stable');
  }
  if (u.v4.stateView && verified.stateView && stable && Number.isInteger(tokens.stable?.decimals)) {
    const bases = [[ZERO, 18], ...(wrapped && Number.isInteger(tokens.wrapped?.decimals) ? [[wrapped, tokens.wrapped.decimals]] : [])];
    const keys = bases.flatMap(([base, decimals]) => Object.entries(STANDARD_TICK_SPACING).map(([fee, spacing]) => {
      const [c0, c1] = BigInt(base) < BigInt(stable) ? [base, stable] : [stable, base];
      return { base, decimals, fee: Number(fee), tickSpacing: spacing, id: viem.keccak256(viem.encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [c0, c1, Number(fee), spacing, ZERO])) };
    }));
    const pools = await Promise.all(keys.map(async key => {
      const slot0 = await read(u.v4.stateView, 'getSlot0(bytes32)', ['uint160', 'int24', 'uint24', 'uint24'], [['bytes32', key.id]]);
      if (!slot0.value || slot0.value[0] === 0n) return { ...key, initialized: slot0.value ? false : null, failure: slot0.failure ?? null };
      const liquidity = await read(u.v4.stateView, 'getLiquidity(bytes32)', ['uint128'], [['bytes32', key.id]]);
      return { ...key, initialized: true, liquidity: liquidity.value?.[0] ?? null, price: stablePerBase(slot0.value[0], key.base, key.decimals, tokens.stable.decimals, stable) };
    }));
    const liquid = pools.filter(p => p.liquidity > 0n);
    add('liquidity.v4', 'liquidity', liquid.length ? 'pass' : pools.some(p => p.failure) ? 'unknown' : 'fail',
      liquid.length ? liquid.map(p => `${p.base === ZERO ? 'native' : 'wrapped'} fee ${p.fee}: ${p.price}`).join('; ') : 'no hookless standard-tier v4 pool with liquidity',
      { pools: pools.map(p => ({ currency: p.base === ZERO ? 'native' : checksummed(p.base), fee: p.fee, tickSpacing: p.tickSpacing, poolId: p.id, initialized: p.initialized,
        liquidity: p.liquidity?.toString() ?? null, stablePerBase: p.price ?? null, failure: p.failure ?? null })), note: 'hooks = 0 only: V2 refuses hooked pools' });
  } else add('liquidity.v4', 'liquidity', 'unknown', 'needs a verified StateView and the stable');

  // ---------------------------------------------------------------- draft
  const v3Verified = ['v3Factory', 'v3PositionManager', 'quoterV2', 'swapRouter02'].every(k => verified[k]) && initCodeHash === 'pass';
  const v4Verified = ['poolManager', 'v4PositionManager', 'stateView', 'v4Quoter'].every(k => verified[k]);
  const enabledTiers = Object.fromEntries(Object.entries(tiers).filter(([, s]) => typeof s === 'number' && s > 0));
  const at = (key, address) => verified[key] ? checksummed(address) : null;
  const wrappedEntry = tokens.wrapped?.verified ? { symbol: isSymbol(tokens.wrapped.symbol) ? tokens.wrapped.symbol : null, address: checksummed(wrapped), decimals: tokens.wrapped.decimals } : null;
  const stableEntry = tokens.stable?.verified ? { rank: 1, symbol: isSymbol(tokens.stable.symbol) ? tokens.stable.symbol : null, address: checksummed(stable), decimals: tokens.stable.decimals } : null;
  const nativeSymbol = pending?.nativeSymbol ?? null;
  const finality = finalLag ? `Measured at block ${head.number}: 'safe' trails the head by ${safeLag?.blocks ?? '?'} blocks (${safeLag?.seconds ?? '?'} s), 'finalized' by ${finalLag.blocks} blocks (${finalLag.seconds} s).`
    + (nitro ? ' On Nitro, \'finalized\' follows the parent chain\'s finality of the batch that carries the block.' : '') : null;
  if (verified.permit2) notes.push('Permit2\'s runtime embeds its chain id and domain separator; with them substituted it is byte-identical to the Permit2 every enabled profile records.');
  if (verified.poolManager) notes.push(`PoolManager is byte-identical to ${checks.find(c => c.id === 'uniswap.v4.poolManager').evidence.byteComparison.matches.join(', ')}'s once its own address (NoDelegateCall) is substituted.`);
  if (blockTimeSeconds !== null) notes.push(`blockTimeSeconds is the average over the last ${widest.blocks} blocks at block ${head.number}, not a nominal value; a quiet chain makes fewer blocks.`);
  if (nitro) notes.push(`ArbOS ${checks.find(c => c.id === 'chain.arbOS').evidence.arbOSVersion} at block ${head.number}. Multicall3.getBlockNumber() returns the parent chain's block estimate on Nitro; use ArbSys.arbBlockNumber().`);
  const draft = {
    schemaVersion: 1, chainId, slug: pending?.slug ?? null, name: pending?.name ?? null, enabled: false, nativeSymbol, stack, blockTimeSeconds,
    uniswap: {
      v3: { factory: at('v3Factory', u.v3.factory), positionManager: at('v3PositionManager', u.v3.positionManager), quoterV2: at('quoterV2', u.v3.quoterV2),
        swapRouter02: at('swapRouter02', u.v3.swapRouter02), poolInitCodeHash: initCodeHash === 'pass' ? V3_POOL_INIT_CODE_HASH : null,
        tickSpacingByFee: verified.v3Factory && Object.keys(enabledTiers).length ? enabledTiers : null },
      v4: { poolManager: at('poolManager', u.v4.poolManager), positionManager: at('v4PositionManager', u.v4.positionManager), stateView: at('stateView', u.v4.stateView),
        quoter: at('v4Quoter', u.v4.quoter) },
      universalRouter: { address: at('universalRouter', u.universalRouter.address), version: null },
    },
    permit2: verified.permit2 ? checksummed(PERMIT2) : null, multicall3: verified.multicall3 ? checksummed(MULTICALL3) : null,
    deployer: verified.createx ? { kind: 'createx', address: checksummed(CREATE_X), codehash: CREATE_X_CODE_HASH } : null,
    wrappedNative: wrappedEntry,
    chargeCurrencies: [stableEntry, nativeSymbol ? { rank: 2, symbol: nativeSymbol, address: ZERO, decimals: 18, native: true } : null,
      wrappedEntry ? { rank: 2, symbol: wrappedEntry.symbol, address: wrappedEntry.address, decimals: wrappedEntry.decimals } : null],
    gasPrice: null,
    bridge: { providers: null, appFeeBps: POLICIES.bridgeAppFeeBps },
    finality,
    verification: { block: Number(head.number), checkedAt: new Date(now * 1000).toISOString().slice(0, 10), contracts: [...rows.values()] },
    notes: [`DRAFT by scripts/v2/qualify-chain.mjs at block ${head.number}: enabled stays false and every null is unverified (the qualification report lists why).`, ...notes],
    sources: [`scripts/v2/qualify-chain.mjs${tool?.commit ? ` (domino ${tool.commit.slice(0, 12)})` : ''}: eth_getCode and eth_call at block ${head.number} (${head.hash}) on ${new Date(now * 1000).toISOString().slice(0, 10)}`,
      'https://github.com/Uniswap/sdks/blob/main/sdks/v3-sdk/src/constants.ts (POOL_INIT_CODE_HASH)', 'https://github.com/pcaversaccio/createx (README: runtime keccak 0xbd8a7ea8...)',
      'https://github.com/safe-global/safe-deployments', ...u.sources],
  };

  // deploy.mjs's own dependency check on the draft (in memory: enabled, the claimed Universal Router version).
  {
    const claimed = u.universalRouter.version ?? null;
    const candidate = { ...draft, enabled: true, uniswap: { ...draft.uniswap, universalRouter: { ...draft.uniswap.universalRouter, version: claimed } },
      chargeCurrencies: draft.chargeCurrencies.filter(Boolean) };
    let shape = null;
    try { dependencyMap(candidate); } catch (error) { shape = error.message; }
    const missing = [shape && 'a verified address for every dependency deploy.mjs reads', !draft.deployer && 'CreateX', !claimed && 'a claimed Universal Router version',
      draft.chargeCurrencies.some(c => !c) && 'every charge currency', !draft.uniswap.v3.poolInitCodeHash && 'the pool init code hash'].filter(Boolean);
    if (missing.length) add('deployTool.dependencies', 'deployTool', 'unknown', `deploy.mjs's dependency check needs ${missing.join(', ')}`, { missing });
    else {
      const outcome = await settle(checkDependencies(candidate, rpc, tag));
      add('deployTool.dependencies', 'deployTool', outcome.failure ? (outcome.failure.kind === 'error' ? 'fail' : statusOf(outcome.failure)) : 'pass',
        outcome.failure ? `deploy.mjs refused the draft: ${outcome.failure.detail}` : 'deploy.mjs\'s checkDependencies accepts the draft: code hashes and cross-references',
        { environment: 'local-test semantics (any chain id); a public preparation also needs this chain in ENABLED_CHAINS', universalRouterVersion: claimed,
          failure: outcome.failure ?? null });
    }
  }

  // The pinned block must still be the chain's.
  {
    const again = await settle(rpc('eth_getBlockByNumber', [tag, false]));
    add('chain.anchor', 'chain', again.value ? (again.value.hash === head.hash ? 'pass' : 'fail') : 'unknown',
      again.value ? (again.value.hash === head.hash ? `block ${head.number} is still canonical` : `block ${head.number} reorged during the run: run again`) : 'block unreadable',
      { failure: again.failure ?? null });
  }

  // ---------------------------------------------------------------- report
  const verdictOf = ids => {
    const blocking = checks.filter(c => ids.includes(c.id) && c.status !== 'pass').map(c => `${c.id} (${c.status})`);
    return { status: combine(checks.filter(c => ids.includes(c.id)).map(c => c.status)), blocking };
  };
  const gaps = schemaGaps({ chainId, nativeSymbol, pending, draft, v3Verified, v4Verified, tiers: enabledTiers, apiSchemas: apiSchemas ?? chainEnumSchemas(chainId) });
  const report = {
    schemaVersion: 1, kind: 'domino-v2-chain-qualification', generatedAt: new Date(now * 1000).toISOString(),
    tool: { path: 'scripts/v2/qualify-chain.mjs', commit: tool?.commit ?? null },
    chain: { chainId, stack, client: checks[0].evidence.client, block: { number: Number(head.number), hash: head.hash, timestamp: Number(head.timestamp) } },
    inputs: { pending: pending?.slug ?? null, expectChainId, stable: stable ? checksummed(stable) : null, wrappedNative: wrappedNative ? checksummed(wrappedNative) : null,
      uniswap: Object.fromEntries(Object.entries(candidates).filter(([, a]) => a).map(([k, a]) => [k, checksummed(a)])), universalRouterVersion: u.universalRouter.version ?? null },
    verdict: { deploy: verdictOf(DEPLOY_REQUIRED), run: verdictOf(RUN_REQUIRED),
      note: 'what the chain allows; enabling it also takes the repository changes in schemaGaps (deploy.mjs, frozen, knows only 4663, 8453 and 42161)' },
    summary: { pass: checks.filter(c => c.status === 'pass').length, fail: checks.filter(c => c.status === 'fail').length, unknown: checks.filter(c => c.status === 'unknown').length },
    checks, bootstrap,
    funding: { dominoDeployment: { transactions: DEPLOY_ORDER.length, gasCapPerTransaction: MAX_TRANSACTION_GAS.toString(),
      maxFeePerGasWei: head.baseFeePerGas === null ? null : (3n * head.baseFeePerGas).toString(),
      upperBoundWei: head.baseFeePerGas === null ? null : (BigInt(DEPLOY_ORDER.length) * MAX_TRANSACTION_GAS * 3n * head.baseFeePerGas).toString(),
      note: 'deploy.mjs\'s default maxFeePerGas is 3 x the base fee; each step\'s limit, L1 component included, is at most the cap' } },
    schemaGaps: gaps,
    unverifiedFields: unverifiedFields(draft, { pending, claimedVersion: u.universalRouter.version ?? null, wrappedCrossChecked: tokens.wrapped?.crossChecked ?? false }),
    rpc: rpc.stats ? rpc.stats() : null,
  };
  return { report: stringifyBigints(report), draft: stringifyBigints(draft) };
}

const stringifyBigints = value => JSON.parse(JSON.stringify(value, (_, x) => typeof x === 'bigint' ? x.toString() : x));

/** The draft's fields the tool could not verify on chain: every null, and what came from an input instead. */
export function unverifiedFields(draft, { pending, claimedVersion, wrappedCrossChecked }) {
  const reasons = {
    gasPrice: 'schema gap: the profile needs gasPrice.chainlinkEthUsd; this tool reads no Chainlink feed, and an ETH/USD feed does not price a non-ETH gas coin',
    'bridge.providers': 'not on chain: whether Relay and Across serve the chain is theirs to say',
    'uniswap.universalRouter.version': `not readable on chain${claimedVersion ? ` (the input claims ${claimedVersion}; the schema admits only 2.1.2)` : ''}: Uniswap's deployment list or SDK names it`,
    slug: 'no pending profile given (--pending)', name: 'no pending profile given (--pending)', nativeSymbol: 'no pending profile given (--pending)',
    stack: 'not an Arbitrum Nitro chain, or ArbSys unreadable', blockTimeSeconds: 'no block sample', finality: "no 'finalized' block",
    deployer: 'CreateX is absent or not canonical', permit2: 'Permit2 is absent or not canonical', multicall3: 'Multicall3 is absent or not canonical',
    wrappedNative: wrappedCrossChecked ? 'the token did not read as an 18-decimal ERC-20' : 'not cross-checked: no Uniswap periphery names it as WETH9()',
    'uniswap.v3.poolInitCodeHash': 'no wrapped-native/stable pool proved it (uniswap.v3.poolInitCodeHash)',
    'uniswap.v3.tickSpacingByFee': 'the v3 factory is not verified', 'chargeCurrencies[0]': 'the stable is not given or not verified',
    'chargeCurrencies[1]': 'no pending profile names the native symbol', 'chargeCurrencies[2]': 'the wrapped native is not verified',
    'wrappedNative.symbol': 'the on-chain symbol does not fit the schema pattern', 'chargeCurrencies[0].symbol': 'the on-chain symbol does not fit the schema pattern',
    'chargeCurrencies[2].symbol': 'the on-chain symbol does not fit the schema pattern',
  };
  const out = [];
  const walk = (value, path) => {
    if (path === 'verification') return; // its rows are evidence; a null code hash there is a checked absence
    if (value === null) out.push({ path, reason: reasons[path] ?? (path.startsWith('uniswap.') ? `the check of ${path} did not pass or no candidate was given` : 'unverified') });
    else if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${path}[${i}]`));
    else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(draft, '');
  if (pending) for (const path of ['slug', 'name', 'nativeSymbol']) out.push({ path, reason: `from the pending profile ${pending.slug}.json: the owner's naming, not a chain fact` });
  if (draft.chargeCurrencies[0]) out.push({ path: 'chargeCurrencies[0]', reason: 'the owner\'s choice of rank-1 stable (its code, symbol and decimals are verified)' });
  if (draft.bridge.appFeeBps !== null) out.push({ path: 'bridge.appFeeBps', reason: 'policy: deploy.mjs POLICIES.bridgeAppFeeBps, not a chain fact' });
  out.push({ path: 'notes', reason: 'generated text' }, { path: 'sources', reason: 'generated: add the chain\'s and Uniswap\'s documents' });
  return out;
}

/** Where today's profile schema (backend/v2_chains.py) and tooling cannot express the chain. Nothing here changes them. */
export function schemaGaps({ chainId, nativeSymbol, pending, draft, v3Verified, v4Verified, tiers, apiSchemas }) {
  const gaps = [
    { field: 'gasPrice.chainlinkEthUsd', where: 'backend/v2_chains.py GasPrice/ChainlinkFeed (required)',
      gap: `the profile must name a Chainlink ETH/USD feed${nativeSymbol && nativeSymbol !== 'ETH' ? `; gas is paid in ${nativeSymbol}, so ETH/USD would not price it, and the chain has no Chainlink feed to name` : ''}` },
    { field: 'uniswap.universalRouter.version', where: "backend/v2_chains.py UniversalRouter.version: Literal['2.1.2']",
      gap: 'only 2.1.2 is admitted and no chain read shows a router\'s version; another version (2.0, 2.2.0) cannot be expressed' },
    { field: 'enabled', where: 'backend/v2_chains.py ChainProfile (enabled: Literal[True]) and PendingChain (chainId: None, no profile fields)',
      gap: 'a complete but disabled profile has no valid shape: never put this draft in api-contracts/v2/chains, where load_registry refuses the whole directory' },
    { field: 'bridge.providers', where: "backend/v2_chains.py Bridge.providers: Literal['relay', 'across']", gap: 'not on chain; a chain served by another bridge cannot be expressed' },
  ];
  if (pending) gaps.push({ field: 'slug', where: `api-contracts/v2/chains/${pending.slug}.json (pending) and load_registry's unique slugs`,
    gap: `an enabled ${pending.slug}-${chainId}.json beside the pending ${pending.slug}.json fails v2_chain_profile_duplicate: replace the placeholder in the same change` });
  if (!draft.deployer) gaps.push({ field: 'deployer', where: "backend/v2_chains.py Deployer.kind: Literal['createx'] and deploy.mjs (CREATE3 through CreateX only)",
    gap: 'without canonical CreateX no deployer can be expressed: CreateX must be bootstrapped first' });
  if (!v3Verified || !v4Verified) gaps.push({ field: 'uniswap.v3 / uniswap.v4', where: 'backend/v2_chains.py Uniswap (both required) and deploy.mjs dependencyMap',
    gap: 'both a v3 and a v4 deployment are required; a chain with one of them only cannot be expressed' });
  if (Object.keys(tiers).length && Object.keys(tiers).length !== 4) gaps.push({ field: 'uniswap.v3.tickSpacingByFee', where: 'backend/tests/test_v2_chain_profiles.py',
    gap: 'the tests pin the four standard tiers on every enabled profile' });
  if (!ENABLED_CHAINS.includes(chainId)) {
    gaps.push({ field: 'chainId', where: 'scripts/v2/deploy.mjs ENABLED_CHAINS (frozen release input, docs/v2/FREEZE.md)',
      gap: `a public preparation admits only ${ENABLED_CHAINS.join(', ')}: deploying on ${chainId} takes a new release candidate of the deployment tool` });
    gaps.push({ field: 'chainId', where: 'backend/tests/test_v2_chain_profiles.py (ENABLED, ETH/WETH ranks)', gap: 'the tests pin the enabled chain set and ETH/WETH as the rank-2 currencies' });
    if (apiSchemas.length) gaps.push({ field: 'chainId', where: apiSchemas.join(', '), gap: `${apiSchemas.length} API schemas enumerate the enabled chain ids without ${chainId}` });
  }
  return gaps;
}

// ------------------------------------------------------------------ CLI

export function summary(report, out) {
  const lines = [`Domino V2 chain qualification: chain ${report.chain.chainId} at block ${report.chain.block.number}`
    + (report.rpc ? ` (${report.rpc.calls} RPC calls${report.rpc.seconds !== undefined ? `, ${report.rpc.seconds} s` : ''})` : '')];
  for (const check of report.checks) lines.push(`${check.status.toUpperCase().padEnd(8)}${check.id.padEnd(32)}${printable(check.summary)}`);
  lines.push(`Verdict: deploy ${report.verdict.deploy.status.toUpperCase()}, run ${report.verdict.run.status.toUpperCase()} (${report.verdict.note})`);
  // A needed bootstrap blocks the deployment; an optional one opens another route (a Safe version, say).
  for (const item of report.bootstrap) {
    lines.push(`Bootstrap${item.needed ? '' : ' (optional)'} ${item.target}: possible ${item.possible}${item.recommendation ? `; ${item.recommendation}` : ''}`);
  }
  lines.push(`Schema gaps: ${report.schemaGaps.length}; unverified profile fields: ${report.unverifiedFields.length}`);
  if (out) lines.push(`Wrote ${join(out, 'report.json')} and ${join(out, 'profile-draft.json')}`);
  return lines.join('\n');
}

const USAGE = 'usage: qualify-chain.mjs (--rpc-env NAME | --rpc-file PATH) --out DIRECTORY [--pending SLUG] [--uniswap FILE] [--stable ADDRESS] '
  + '[--wrapped-native ADDRESS] [--chain-id N] [--max-calls N]';
const OPTIONS = ['rpc-env', 'rpc-file', 'out', 'pending', 'uniswap', 'stable', 'wrapped-native', 'chain-id', 'max-calls'];

/** The output directory, outside this checkout: a report is evidence, not source, and an untracked file under
 * scripts/v2 or api-contracts/v2 would make deploy.mjs refuse a public preparation. */
function outputDirectory(path) {
  const target = resolve(path);
  let existing = target;
  while (!existsSync(existing)) existing = dirname(existing);
  const real = join(realpathSync(existing), relative(existing, target)), root = realpathSync(repoRoot);
  const inside = rel => rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  ensure(!inside(relative(root, real)), 'output_inside_the_checkout: write the qualification outside the repository');
  for (const name of ['report.json', 'profile-draft.json']) ensure(!existsSync(join(target, name)), 'output_exists');
  return target;
}

export async function cli(argv, { env = process.env } = {}) {
  const f = flags(argv);
  ensure(Object.keys(f).every(k => OPTIONS.includes(k)) && typeof f.out === 'string', USAGE);
  const url = rpcUrlFrom(f, env), out = outputDirectory(f.out);
  const profiles = loadProfiles();
  let pending = null;
  if (f.pending !== undefined) {
    ensure(/^[a-z][a-z0-9]{0,31}$/.test(f.pending) && profiles.pending[f.pending], 'unknown_pending_profile');
    pending = profiles.pending[f.pending];
  }
  const integer = (value, name, max) => { ensure(/^[1-9][0-9]{0,15}$/.test(value) && Number(value) <= max, 'invalid_' + name); return Number(value); };
  const expectChainId = f['chain-id'] === undefined ? null : integer(f['chain-id'], 'chain_id', Number.MAX_SAFE_INTEGER);
  const maximumCalls = f['max-calls'] === undefined ? DEFAULT_MAX_CALLS : integer(f['max-calls'], 'max_calls', 10_000);
  const uniswap = f.uniswap === undefined ? null : JSON.parse(readBounded(f.uniswap, 65536));
  let commit = null;
  try { commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a checkout */ }
  const transport = jsonRpc(url), rpc = readOnly(transport, { maximumCalls }), started = Date.now();
  const { report, draft } = await qualifyChain({ rpc, expectChainId, pending, uniswap, stable: f.stable, wrappedNative: f['wrapped-native'],
    references: defaultReferences(profiles.enabled), tool: { commit } });
  report.rpc = { ...rpc.stats(), seconds: Number(((Date.now() - started) / 1000).toFixed(1)) };
  writeJson(join(out, 'report.json'), report);
  writeJson(join(out, 'profile-draft.json'), draft);
  return summary(report, out);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then(message => console.log(message)).catch(error => { console.error(printable(redactUrls(error.message))); process.exitCode = 1; });
}
