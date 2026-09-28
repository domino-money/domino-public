/**
 * A recorded fees case (case-chain.mjs) held by a Domino sequence vault, for the automation-impact tests and prints
 * (2026-09-27, the owner: show what Auto-compound did, and when). The case's own chain answers everything it did;
 * on top of it:
 *
 * - the NFT's PositionManager subscriber is `vault`, which the factory made, whose root is the NFT, whose policy has
 *   the automation's service fee (200 bps Auto-compound, 400 Domino-compound) and which still holds its permission
 *   (functions/_lib/automation.ts scanAutomation reads exactly these);
 * - the vault's ExecutionCompleted logs (contracts/src/DominoVaultV4.sol) sit in the recorded transactions named in
 *   `executions` ({ tx, action, destination }), as an operator's execute() would have left them: an automatic
 *   compound in the recording's own collect-and-increase transactions;
 * - an execution with `net: true` is a NET compound (action 1, as the owner's first one on NFT 3325113): its
 *   transaction's collect (the NFT's ModifyLiquidity of 0) is left out of every log answer, so its increase settles
 *   the fees itself, in one call;
 * - each execution paid its service fee as ERC-20 transfers from the vault to a fee recipient, sized as the contract
 *   charges it, on the gross it consumed: `feeBps` / (10,000 - `feeBps`) of what its increase put back (the tokens
 *   its liquidity was worth at the pool's price just before it), next to its payment of those tokens to the
 *   PoolManager, which is no fee (`paid` holds the fees per transaction, `readded` the tokens put back);
 * - with no `vault`, the recording stays a plain position (nothing subscribed);
 * - `owner`: the NFT's holder is this address instead of the recording's (its mint Transfer and ownerOf), so no real
 *   person's wallet shows in a test's prints;
 * - `range`: [tickLower, tickUpper] instead of the recording's, for the page's own read only (the history, whose logs
 *   name the recorded range, then cannot be drawn): a range at the pool's limits, say.
 *
 * Not a suite of its own. `fetch(url, init)` takes a POST body as the page sends it, as case-chain.mjs's does.
 */
import { createRequire } from 'node:module';
import { decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, numberToHex, pad, parseAbi } from 'viem';
import { caseChain } from './case-chain.mjs';
import { fees as feesLib, multicallAbi, owned } from './fake-chain.mjs';
import { logLimitError } from '../log-limits.mjs';

const require = createRequire(import.meta.url);
const automation = require('../../../.test-build/app/functions/_lib/automation.js');
const { EXECUTION_COMPLETED } = require('../../../.test-build/app/src/lib/automationImpact.js');
const { principalAt } = require('../../../.test-build/app/src/components/positions/visual/value.js');

const pmAbi = parseAbi(['function subscriber(uint256) view returns (address)']);
const factoryAbi = parseAbi(['function isVault(address) view returns (bool)']);
const vaultAbi = parseAbi([
  'struct Policy { uint16 serviceFeeBps; uint16 triggerDistanceBps; uint16 maxOverlapBps; uint32 minimumIntervalSeconds; uint8 maxPositions; uint64 version; bool paused; }',
  'function rootTokenId() view returns (uint256)',
  'function policy() view returns (Policy)',
  'function rootPermissionValid() view returns (bool)',
]);
const ok = (abi, functionName, result) => ({ success: true, returnData: encodeFunctionResult({ abi, functionName, result }) });
const word = (n) => pad(numberToHex(BigInt(n)), { size: 32 });

export function automatedChain(id, { vault = null, feeBps = 200, executions = [], owner = null, paused = false, range = null } = {}) {
  // No vault: the recording as a plain position (nothing subscribed), with `owner` its holder.
  const lower = vault ? vault.toLowerCase() : '0x0000000000000000000000000000000000000000';
  const tokenId = BigInt(id);
  let recorded = null;
  const chain = caseChain(id, { edit: (position) => { recorded = position.owner; return { ...position, ...(owner ? { owner: owner.toLowerCase() } : {}), ...(range ? { tickLower: range[0], tickUpper: range[1] } : {}) }; } });
  const blockOf = new Map(chain.fixture.expect.events.map((event) => [event[2].toLowerCase(), event[1]]));
  // The vault's logs, one per execution, in the recorded transaction's block, after its own ModifyLiquidity logs.
  const vaultLogs = executions.map((execution, index) => {
    const block = blockOf.get(execution.tx.toLowerCase());
    if (block === undefined) throw new Error(`${execution.tx} is not one of NFT ${id}'s recorded settlements`);
    return {
      address: lower,
      topics: [EXECUTION_COMPLETED, word(0xa11ce + index), word(0xb0b + index)],
      data: encodeAbiParameters([{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint64' }], [execution.action ?? (execution.net ? 1 : 0), tokenId, BigInt(execution.destination ?? id), BigInt(index + 3)]),
      blockNumber: numberToHex(block),
      logIndex: numberToHex(900 + index),
      transactionHash: execution.tx.toLowerCase(),
      blockHash: `0x${'cd'.repeat(32)}`,
      transactionIndex: '0x0',
      removed: false,
    };
  });
  // The service fee each execution paid, as the contract charges it: on the gross it consumed, so the fee is
  // feeBps / (10,000 - feeBps) of what went back into the position (2026-09-27, review: sized on the fees settled, the
  // prints showed 3.2 %). What went back: the tokens the recorded increase's liquidity was worth at the pool's price
  // just before it (its last Swap), which the vault pays the PoolManager (no fee).
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const RECIPIENT = pad('0x1488c84dafc03f7f4c4fb986f83ba99fd530c6f4');
  const recorded0 = chain.fixture.state.positions[0];
  const currencies = [recorded0.poolKey.currency0, recorded0.poolKey.currency1].map((c) => c.toLowerCase());
  const logs = [...Object.values(chain.fixture.swaps).flat(), ...Object.values(chain.fixture.pool).flat(), ...Object.values(chain.fixture.swapBefore).filter(Boolean)];
  const swaps = logs.filter((log) => log[2] === 3);
  const wordsOf = (data) => data.slice(2).match(/.{64}/g).map((w) => BigInt(`0x${w}`));
  /** The pool's price just before (block, index): the last Swap's sqrtPriceX96 and tick. */
  const priceBefore = (block, index) => {
    const last = swaps.filter((log) => log[0] < block || (log[0] === block && log[1] < index)).sort((a, b) => a[0] - b[0] || a[1] - b[1]).at(-1);
    const words = wordsOf(last[5]);
    return { sqrt: words[2], tick: Number(BigInt.asIntN(24, words[4])) };
  };
  const modifies = logs.filter((log) => log[2] === 1);
  chain.paid = new Map();
  chain.readded = new Map();
  const transferLogs = executions.flatMap((execution, index) => {
    const tx = execution.tx.toLowerCase();
    const increase = chain.fixture.expect.events.find((event) => event[2].toLowerCase() === tx && event[0] === 'increase');
    const at = modifies.find((log) => log[3].toLowerCase() === tx && BigInt.asIntN(256, wordsOf(log[5])[2]) > 0n && wordsOf(log[5])[3] === tokenId);
    const price = increase && at ? priceBefore(at[0], at[1]) : null;
    const readded = price ? principalAt(BigInt(increase[4]), price.sqrt, price.tick, recorded0.tickLower, recorded0.tickUpper) : [0n, 0n];
    const fee = readded.map((amount) => (amount * BigInt(feeBps)) / BigInt(10_000 - feeBps));
    chain.paid.set(tx, fee);
    chain.readded.set(tx, readded);
    const block = numberToHex(blockOf.get(tx));
    const transfer = (side, to, amount, n) => ({ address: currencies[side], topics: [TRANSFER, pad(lower), to], data: word(amount), blockNumber: block, logIndex: numberToHex(800 + index * 8 + n), transactionHash: tx, blockHash: `0x${'cd'.repeat(32)}`, transactionIndex: '0x0', removed: false });
    return [transfer(0, pad(feesLib.POOL_MANAGER), readded[0], 0), transfer(1, pad(feesLib.POOL_MANAGER), readded[1], 1), transfer(0, RECIPIENT, fee[0], 2), transfer(1, RECIPIENT, fee[1], 3)];
  });
  // A NET compound's transaction holds no collect: the NFT's ModifyLiquidity of 0 in it is left out of every answer.
  const netTxs = new Set(executions.filter((execution) => execution.net).map((execution) => execution.tx.toLowerCase()));
  const collectOfNet = (log) => {
    if (!netTxs.has(String(log.transactionHash).toLowerCase()) || log.topics?.[0] !== feesLib.TOPIC.ModifyLiquidity) return false;
    const words = wordsOf(log.data);
    return words[2] === 0n && words[3] === tokenId;
  };
  const recordedFetch = chain.fetch;
  chain.vaultAsked = [];

  /** One sub-call of an aggregate3, answered here or by the recording. */
  async function sub(call, block) {
    const target = call.target.toLowerCase();
    if (target === owned.POSITION_MANAGER && call.callData.startsWith('0x16a24131')) {
      const { args } = decodeFunctionData({ abi: pmAbi, data: call.callData });
      return ok(pmAbi, 'subscriber', args[0] === tokenId ? lower : '0x0000000000000000000000000000000000000000');
    }
    if (target === automation.SEQUENCE_FACTORY && vault) {
      const { args } = decodeFunctionData({ abi: factoryAbi, data: call.callData });
      return ok(factoryAbi, 'isVault', args[0].toLowerCase() === lower);
    }
    if (target === lower && vault) {
      const { functionName } = decodeFunctionData({ abi: vaultAbi, data: call.callData });
      if (functionName === 'rootTokenId') return ok(vaultAbi, functionName, tokenId);
      if (functionName === 'rootPermissionValid') return ok(vaultAbi, functionName, true);
      return ok(vaultAbi, functionName, { serviceFeeBps: feeBps, triggerDistanceBps: 500, maxOverlapBps: 2000, minimumIntervalSeconds: 3600, maxPositions: feeBps === 200 ? 1 : 3, version: 1n, paused });
    }
    // Anything else, as the recording answers it: an aggregate3 of this one call.
    const data = encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3', args: [[{ target: call.target, allowFailure: true, callData: call.callData }]] });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: owned.MULTICALL3, data }, block] });
    const reply = await (await recordedFetch(owned.RPC_URL, { method: 'POST', body })).json();
    return decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', data: reply.result })[0];
  }

  async function one(call) {
    // 2026-09-28: the RPC's gateway refuses a range past its limits (tests/support/log-limits.mjs), as it does live.
    const limited = call.method === 'eth_getLogs' ? logLimitError(call.params[0]) : null;
    if (limited) return { jsonrpc: '2.0', id: call.id, error: limited };
    if (vault && call.method === 'eth_getLogs' && String(call.params[0].address).toLowerCase() === lower) {
      const { fromBlock, toBlock, topics } = call.params[0];
      chain.vaultAsked.push({ fromBlock: Number(fromBlock), toBlock: Number(toBlock) });
      const first = [topics?.[0]].flat();
      const hits = vaultLogs.filter((log) => Number(log.blockNumber) >= Number(fromBlock) && Number(log.blockNumber) <= Number(toBlock) && (topics?.[0] == null || first.includes(log.topics[0])));
      return { jsonrpc: '2.0', id: call.id, result: hits };
    }
    if (vault && call.method === 'eth_getLogs' && call.params[0].topics?.[0] === TRANSFER && String(call.params[0].topics?.[1]).toLowerCase() === pad(lower)) {
      const { address, fromBlock, toBlock } = call.params[0];
      chain.vaultAsked.push({ transfers: true, address, fromBlock: Number(fromBlock), toBlock: Number(toBlock) });
      const asked = [address].flat().map((one) => one.toLowerCase());
      return { jsonrpc: '2.0', id: call.id, result: transferLogs.filter((log) => asked.includes(log.address) && Number(log.blockNumber) >= Number(fromBlock) && Number(log.blockNumber) <= Number(toBlock)) };
    }
    if (call.method === 'eth_call' && call.params[0]?.to === owned.MULTICALL3 && call.params[0].data.startsWith('0x82ad56cb')) {
      const { args } = decodeFunctionData({ abi: multicallAbi, data: call.params[0].data });
      const results = [];
      for (const each of args[0]) results.push(await sub({ target: each.target, callData: each.callData }, call.params[1]));
      return { jsonrpc: '2.0', id: call.id, result: encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: results }) };
    }
    const reply = await (await recordedFetch(owned.RPC_URL, { method: 'POST', body: JSON.stringify(call) })).json();
    if (netTxs.size > 0 && call.method === 'eth_getLogs' && Array.isArray(reply.result)) reply.result = reply.result.filter((log) => !collectOfNet(log));
    // The recording's holder, wherever its Transfer logs name it, is `owner`.
    if (owner && recorded && call.method === 'eth_getLogs' && Array.isArray(reply.result)) {
      const from = pad(recorded.toLowerCase());
      for (const log of reply.result) log.topics = log.topics.map((topic) => (topic.toLowerCase() === from ? pad(owner.toLowerCase()) : topic));
    }
    return reply;
  }

  chain.fetch = async (url, init) => {
    if (url !== owned.RPC_URL) throw new Error(`not the RPC: ${url}`);
    const body = JSON.parse(init.body);
    const replies = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
    return new Response(JSON.stringify(replies), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return chain;
}
