/**
 * A wallet's list with a recorded position in it (2026-09-27, round 6, the Your positions table's APR): the public RPC
 * as two fakes answer it together. `recorded` is a recorded case (case-chain.mjs, or automated-chain.mjs for one held
 * by a sequence vault) whose NFT the page replays for real; `base` is a browserChain (browser-chain.mjs) at the same
 * head and time that holds the wallet's other positions, its SetupMinted logs (one for the recorded NFT too, so the
 * wallet's list names it), its deposits and its tokens.
 *
 * Every read goes to the fake that holds what it asks: a Multicall3 sub-call by its target and arguments (the recorded
 * NFT's id, its pool, its currencies, its vault), the SetupMinted logs to `base`, every other log to `recorded` (the
 * fees logs of a position `base` holds are then simply not there: its history is not read, as for a position whose
 * mint cannot be found). The block number and the block times are the recording's. `log` is `base`'s and `recorded`'s
 * calls together, in order. Not a suite of its own.
 */
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, encodeFunctionResult, parseAbi } from 'viem';
import { multicallAbi, owned } from './fake-chain.mjs';

const factoryAbi = parseAbi(['function isVault(address) view returns (bool)']);
const IS_VAULT = encodeFunctionData({ abi: factoryAbi, functionName: 'isVault', args: ['0x0000000000000000000000000000000000000000'] }).slice(0, 10);

/**
 * `recorded`: the recorded case's chain; `vault` its sequence vault, if any; `base`: a browserChain built with the
 * recording's `head` and `timestamp` (listChain checks both).
 */
export function listChain({ recorded, base, vault = null }) {
  const position = recorded.fixture.state.positions[0];
  const id = BigInt(position.tokenId);
  const poolId = position.poolId.toLowerCase();
  const tokens = new Set([position.poolKey.currency0, position.poolKey.currency1].map((address) => address.toLowerCase()));
  const lowerVault = vault ? vault.toLowerCase() : null;
  if (base.head !== recorded.head || base.timestamp !== recorded.fixture.state.timestamp) throw new Error('the base chain must stand at the recording’s head and time');
  const chain = { head: recorded.head, recorded, base, log: [], refused: [] };

  /** Whether a Multicall3 sub-call is the recording's to answer. */
  function recordedCall(target, data) {
    if (target === owned.MULTICALL3) return true;
    if (target === lowerVault) return true;
    if (tokens.has(target)) return true;
    if (target === owned.POSITION_MANAGER) {
      // ownerOf, getPositionLiquidity, getPoolAndPositionInfo and subscriber all name the NFT first.
      return BigInt(`0x${data.slice(10, 74)}`) === id;
    }
    if (data.startsWith(IS_VAULT)) return lowerVault !== null && `0x${data.slice(34, 74)}` === lowerVault;
    // StateView's reads name the pool first.
    return data.length >= 74 && `0x${data.slice(10, 74)}` === poolId;
  }

  async function ask(target, body) {
    const reply = await (await target.fetch(owned.RPC_URL, { method: 'POST', body: JSON.stringify(body) })).json();
    return reply;
  }

  async function one(call) {
    const [filter] = call.params ?? [];
    if (call.method === 'eth_getLogs') {
      const setup = String(filter.address).toLowerCase() === owned.SETUP_CONTRACT && filter.topics?.[0] === owned.SETUP_MINTED_TOPIC;
      return ask(setup ? base : recorded, call);
    }
    if (call.method === 'eth_getBlockByNumber') {
      const reply = await ask(recorded, call);
      return reply.result ? reply : ask(base, call);
    }
    if (call.method === 'eth_blockNumber') return ask(recorded, call);
    if (call.method === 'eth_call' && call.params[0]?.to?.toLowerCase() === owned.MULTICALL3 && call.params[0].data.startsWith('0x82ad56cb')) {
      const { args } = decodeFunctionData({ abi: multicallAbi, data: call.params[0].data });
      const parts = args[0].map((sub) => ({ sub, mine: recordedCall(sub.target.toLowerCase(), sub.callData) }));
      const results = new Array(parts.length);
      for (const [target, mine] of [[recorded, true], [base, false]]) {
        const picked = parts.map((part, index) => ({ ...part, index })).filter((part) => part.mine === mine);
        if (picked.length === 0) continue;
        const data = encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3', args: [picked.map((part) => part.sub)] });
        const reply = await ask(target, { ...call, params: [{ ...call.params[0], data }, call.params[1]] });
        if (!reply.result) return reply;
        const answered = decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', data: reply.result });
        picked.forEach((part, i) => (results[part.index] = answered[i]));
      }
      return { jsonrpc: '2.0', id: call.id, result: encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: results }) };
    }
    return ask(base, call);
  }

  chain.fetch = async (url, init) => {
    if (url !== owned.RPC_URL) throw new Error(`not the RPC: ${url}`);
    const body = JSON.parse(init.body);
    const calls = Array.isArray(body) ? body : [body];
    const replies = [];
    for (const call of calls) {
      const reply = await one(call);
      chain.log.push({ method: call.method, params: call.params, at: Date.now(), bytes: JSON.stringify(reply).length });
      if (reply.error) chain.refused.push(call.method);
      replies.push(reply);
    }
    return new Response(JSON.stringify(Array.isArray(body) ? replies : replies[0]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  /** How many times the wallet's SetupMinted logs were asked for `owner` (browserChain's own count). */
  chain.scans = (owner) => base.scans(owner);
  return chain;
}
