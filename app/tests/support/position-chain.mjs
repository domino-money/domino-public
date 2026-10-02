/**
 * A browser wallet on Robinhood Chain that is also the chain behind it, for the owner's position actions
 * (src/finance/position.ts, components/positions/PositionActions.tsx) and the refund of a held setup deposit
 * (components/positions/HeldDeposits.tsx). Used directly as a wallet by tests/position-actions.test.mjs and announced
 * to the page as an EIP-6963 wallet by tests/position-actions.browser.test.mjs.
 *
 * Uniswap's PositionManager and StateView sit at their real addresses with their real runtime code
 * (./uniswap-v4-code.json), so the client checks its pinned code hashes against real code. Their answers are this
 * fake's: each position NFT with its pool key, packed PositionInfo, liquidity, the pool's price, and fee growth.
 * `modifyLiquidities` is simulated and, once sent, applied the way the v4 periphery does for DECREASE_LIQUIDITY +
 * TAKE_PAIR: the caller must be the owner (NotApproved), the deadline must not have passed (DeadlinePassed), an
 * empty position cannot be touched (CannotUpdateEmptyPosition), and the principal removed must meet the minimums
 * (MinimumAmountInsufficient) — each refused with the contract's own revert data, which the wallet passes on.
 * The principal is worked out with the app's twin of the v4 math in lib/create and lib/read (pinned to
 * finance/position.ts's copy by the unit tests), and what is paid is recorded in `paid`.
 *
 * A DominoSetupV1 at a fake address holds `deposits`, each under the owner's operation id, and answers the reads,
 * the simulation and the inclusion of `cancel` as the setup contract does. `release` is its deployment profile.
 *
 * Every transaction handed over is included in its own block; `decline()` makes the wallet refuse the next one with
 * 4001, `revert()` includes the next one with status 0, `move()` moves a pool's price as a swap would, `failNext()`
 * fails the next ask of a method as a wallet's node does now and then. `speedUp()` and `cancelInWallet()` (2026-10-01,
 * audit C14) replace the next one in the wallet: mined under another hash, or its nonce taken by a 0-ETH self-transfer.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { concatHex, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, numberToHex, zeroAddress } from 'viem';

const require = createRequire(import.meta.url);
const position = require('../../.test-build/app/src/finance/position.js');
const { setupAbi, operationIdParameters } = require('../../.test-build/app/src/finance/setup.js');
const { amount0ForLiquidity, amount1ForLiquidity } = require('../../.test-build/app/src/lib/create/pairAmount.js');
const { sqrtPriceAtTick } = require('../../.test-build/app/src/lib/read/screens/poolRange.js');

export const CODE = JSON.parse(readFileSync(new URL('./uniswap-v4-code.json', import.meta.url), 'utf8'));
export const POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7';
export const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
const at = (byte, bytes = 20) => `0x${byte.toString(16).padStart(2, '0').repeat(bytes)}`;
const lower = (value) => String(value).toLowerCase();
const SETUP = at(0x71), POOL_MANAGER = at(0x72), FEE_RECIPIENT = at(0x75);
const SETUP_CODE = '0x6071', POOL_MANAGER_CODE = '0x6072';
const FIRST_SENT_BLOCK = 0x1001;

/** Revert data as the contract writes it: selector and ABI-encoded arguments. */
const revertData = (selector, types = [], values = []) => (types.length ? concatHex([selector, encodeAbiParameters(types.map((type) => ({ type })), values)]) : selector);
export const REVERTS = {
  notApproved: (caller) => revertData('0x0ca968d8', ['address'], [caller]),
  deadlinePassed: (deadline) => revertData('0xbfb22adf', ['uint256'], [deadline]),
  minimum: (minimum, received) => revertData('0x12816f22', ['uint128', 'uint128'], [minimum, received]),
  empty: () => revertData('0xaefeb924'),
  notMinted: () => revertData('0x08c379a0', ['string'], ['NOT_MINTED']),
};
class Revert extends Error {
  constructor(data) { super('execution reverted'); this.data = data; }
}

/** The principal removing `liquidity` pays at the pool's price, as v4-core's Pool.modifyLiquidity branches on the tick. */
function principal(pool, tickLower, tickUpper, liquidity) {
  const lowerPrice = sqrtPriceAtTick(tickLower), upperPrice = sqrtPriceAtTick(tickUpper);
  if (pool.tick < tickLower) return [amount0ForLiquidity(lowerPrice, upperPrice, liquidity), 0n];
  if (pool.tick < tickUpper) return [amount0ForLiquidity(pool.sqrtPriceX96, upperPrice, liquidity), amount1ForLiquidity(lowerPrice, pool.sqrtPriceX96, liquidity)];
  return [0n, amount1ForLiquidity(lowerPrice, upperPrice, liquidity)];
}
const owed = (now, last, liquidity) => (((now - last) & ((1n << 256n) - 1n)) * liquidity) >> 128n;

/**
 * `positions`: [{ tokenId, key, tickLower, tickUpper, liquidity, sqrtPriceX96, tick, growthLast: [a, b], growthNow: [a, b], hasSubscriber?, owner? }]
 * `deposits`: [{ key, balance0, balance1 }] held for `owner` in the setup contract, in operation order.
 * `ownerCode`: the owner's own code, as an EIP-7702 designator gives it; `refusesEth`: that code reverts a plain ETH
 * payment (the one-wei probe the app sends before any step that pays native ETH out).
 */
export function createPositionChain(owner, { positions = [], deposits = [], eth = 10n ** 18n, finality = 'final', timestamp = Math.floor(Date.now() / 1000), positionManagerCode = CODE.positionManager, connected = false, ownerCode = null, refusesEth = false } = {}) {
  owner = lower(owner);
  const code = { [POSITION_MANAGER]: positionManagerCode, [STATE_VIEW]: CODE.stateView, [SETUP]: SETUP_CODE, [POOL_MANAGER]: POOL_MANAGER_CODE };
  if (ownerCode !== null) code[owner] = ownerCode;
  const nfts = new Map(), pools = new Map();
  for (const p of positions) {
    const key = { ...p.key, currency0: lower(p.key.currency0), currency1: lower(p.key.currency1), hooks: lower(p.key.hooks ?? zeroAddress) };
    const poolId = keccak256(encodeAbiParameters(position.poolIdParameters, [key]));
    pools.set(poolId, { sqrtPriceX96: p.sqrtPriceX96, tick: p.tick, growthNow: [...p.growthNow] });
    nfts.set(BigInt(p.tokenId), { key, poolId, owner: lower(p.owner ?? owner), tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: p.liquidity, growthLast: [...p.growthLast], hasSubscriber: Boolean(p.hasSubscriber) });
  }
  const operationId = (nonce) => keccak256(encodeAbiParameters(operationIdParameters, [4663n, SETUP, owner, nonce]));
  const operations = new Map(deposits.map((d, i) => [operationId(BigInt(i)), { owner, key: { ...d.key, hooks: d.key.hooks ?? zeroAddress }, balance0: d.balance0, balance1: d.balance1, swapped: false, closed: false, tokenId: 0n }]));
  const NONE = { owner: zeroAddress, key: { currency0: zeroAddress, currency1: zeroAddress, fee: 0, tickSpacing: 0, hooks: zeroAddress }, balance0: 0n, balance1: 0n, swapped: false, closed: false, tokenId: 0n };
  const log = [], calls = [], refused = [], missing = [], sends = [], declined = [], paid = [];
  let refuseNext = false, revertNext = false, permitted = connected;
  // 2026-10-01 (audit C14): the next send replaced in the wallet. "Speed up": the same call mined under another hash than
  // the one the page is given. "Cancel": a 0-ETH transfer to the account itself takes the nonce (`burned`), and the call
  // never happens.
  let speedNext = false, cancelNext = false, burned = 0;
  const reverted = new Set();
  const latest = () => ({ number: numberToHex(0x1000 + sends.length), timestamp: numberToHex(timestamp + 2 * sends.length), hash: at(0xa0 + sends.length, 32) });
  const blockOf = (index) => ({ number: numberToHex(FIRST_SENT_BLOCK + index), hash: at(0xb0 + index, 32) });
  const hashOf = (index) => at(0xc0 + index, 32);

  /** DECREASE_LIQUIDITY + TAKE_PAIR from `from`: what it removes and pays, or the contract's refusal. */
  function modify(from, data) {
    const { args: [unlockData, deadline] } = decodeFunctionData({ abi: position.positionManagerAbi, data });
    const [actions, params] = decodeAbiParameters(position.unlockParameters, unlockData);
    if (actions !== '0x0111' || params.length !== 2) throw new Error(`unexpected actions ${actions}`);
    const [tokenId, liquidity, minimum0, minimum1, hookData] = decodeAbiParameters(position.decreaseParameters, params[0]);
    const [currency0, currency1, recipient] = decodeAbiParameters(position.takePairParameters, params[1]);
    const nft = nfts.get(tokenId);
    if (!nft) throw new Revert(REVERTS.notMinted());
    if (deadline < BigInt(latest().timestamp)) throw new Revert(REVERTS.deadlinePassed(deadline));
    if (lower(from) !== nft.owner) throw new Revert(REVERTS.notApproved(from));
    if (nft.liquidity === 0n) throw new Revert(REVERTS.empty());
    if (liquidity > nft.liquidity || hookData !== '0x') throw new Error('unexpected decrease');
    if (lower(currency0) !== nft.key.currency0 || lower(currency1) !== nft.key.currency1) throw new Error('TAKE_PAIR names other currencies');
    const pool = pools.get(nft.poolId);
    const removed = principal(pool, nft.tickLower, nft.tickUpper, liquidity);
    if (removed[0] < minimum0) throw new Revert(REVERTS.minimum(minimum0, removed[0]));
    if (removed[1] < minimum1) throw new Revert(REVERTS.minimum(minimum1, removed[1]));
    const fees = [owed(pool.growthNow[0], nft.growthLast[0], nft.liquidity), owed(pool.growthNow[1], nft.growthLast[1], nft.liquidity)];
    return { nft, tokenId, liquidity, recipient: lower(recipient), amounts: [removed[0] + fees[0], removed[1] + fees[1]], pool };
  }

  function view(from, to, data) {
    if (to === owner && data === undefined) {
      calls.push('probe');
      if (refusesEth) throw new Revert('0x');
      return '0x';
    }
    if (to === POSITION_MANAGER) {
      const { functionName, args } = decodeFunctionData({ abi: position.positionManagerAbi, data });
      calls.push(functionName);
      if (functionName === 'modifyLiquidities') { modify(from, data); return '0x'; }
      const nft = nfts.get(args[0]);
      if (!nft) {
        if (functionName === 'ownerOf') throw new Revert(REVERTS.notMinted());
        if (functionName === 'getPositionLiquidity') return encodeFunctionResult({ abi: position.positionManagerAbi, functionName, result: 0n });
        return encodeFunctionResult({ abi: position.positionManagerAbi, functionName, result: [{ currency0: zeroAddress, currency1: zeroAddress, fee: 0, tickSpacing: 0, hooks: zeroAddress }, 0n] });
      }
      if (functionName === 'ownerOf') return encodeFunctionResult({ abi: position.positionManagerAbi, functionName, result: nft.owner });
      if (functionName === 'getPositionLiquidity') return encodeFunctionResult({ abi: position.positionManagerAbi, functionName, result: nft.liquidity });
      if (functionName === 'getPoolAndPositionInfo') {
        const packed = ((BigInt(nft.poolId) >> 56n) << 56n) | (BigInt.asUintN(24, BigInt(nft.tickUpper)) << 32n) | (BigInt.asUintN(24, BigInt(nft.tickLower)) << 8n) | (nft.hasSubscriber ? 1n : 0n);
        return encodeFunctionResult({ abi: position.positionManagerAbi, functionName, result: [nft.key, packed] });
      }
      throw new Error(`unexpected ${functionName} on the position manager`);
    }
    if (to === STATE_VIEW) {
      const { functionName, args } = decodeFunctionData({ abi: position.stateViewAbi, data });
      calls.push(functionName);
      const pool = pools.get(args[0]);
      if (!pool) throw new Error(`unknown pool ${args[0]}`);
      if (functionName === 'getSlot0') return encodeFunctionResult({ abi: position.stateViewAbi, functionName, result: [pool.sqrtPriceX96, pool.tick, 0, 3000] });
      if (functionName === 'getFeeGrowthInside') return encodeFunctionResult({ abi: position.stateViewAbi, functionName, result: pool.growthNow });
      if (functionName === 'getPositionInfo') {
        const [, manager, tickLower, tickUpper, salt] = args;
        const nft = lower(manager) === POSITION_MANAGER ? nfts.get(BigInt(salt)) : undefined;
        const match = nft && nft.poolId === args[0] && nft.tickLower === tickLower && nft.tickUpper === tickUpper;
        return encodeFunctionResult({ abi: position.stateViewAbi, functionName, result: match ? [nft.liquidity, nft.growthLast[0], nft.growthLast[1]] : [0n, 0n, 0n] });
      }
      throw new Error(`unexpected ${functionName} on the state view`);
    }
    if (to === SETUP) {
      const { functionName, args = [] } = decodeFunctionData({ abi: setupAbi, data });
      calls.push(functionName);
      // What the setup client verifies the deployment profile against, on every step.
      const identity = { manager: POOL_MANAGER, positions: POSITION_MANAGER, stateView: STATE_VIEW, feeRecipient: FEE_RECIPIENT, assistedFeeBps: 30, tariffVersion: 1n };
      if (functionName in identity) return encodeFunctionResult({ abi: setupAbi, functionName, result: identity[functionName] });
      if (functionName === 'operation') return encodeFunctionResult({ abi: setupAbi, functionName, result: operations.get(args[0]) ?? NONE });
      if (functionName === 'recoveryStarted') return encodeFunctionResult({ abi: setupAbi, functionName, result: false });
      if (functionName === 'cancel') {
        const op = operations.get(args[0]);
        if (!op || op.closed || lower(from) !== op.owner) throw new Revert('0x');
        return '0x';
      }
      throw new Error(`unexpected ${functionName} on the setup contract`);
    }
    throw new Error(`unexpected call to ${to}`);
  }

  function include(tx) {
    const to = lower(tx.to);
    if (to === POSITION_MANAGER) {
      const { nft, liquidity, recipient, amounts, pool } = modify(tx.from, tx.data);
      nft.liquidity -= liquidity;
      nft.growthLast = [...pool.growthNow];
      paid.push({ to: recipient, currencies: [nft.key.currency0, nft.key.currency1], amounts });
      return;
    }
    if (to === SETUP) {
      const { functionName, args } = decodeFunctionData({ abi: setupAbi, data: tx.data });
      if (functionName !== 'cancel') throw new Error(`unexpected ${functionName} sent`);
      const op = operations.get(args[0]);
      paid.push({ to: op.owner, currencies: [lower(op.key.currency0), lower(op.key.currency1)], amounts: [op.balance0, op.balance1] });
      operations.set(args[0], { ...op, balance0: 0n, balance1: 0n, closed: true });
      return;
    }
    throw new Error(`unexpected transaction to ${to}`);
  }

  const hooks = new Map(), failing = new Map();
  async function request(method, params = []) {
    const fails = failing.get(method) ?? 0;
    if (fails > 0) {
      // A passing failure of the wallet's own node, as MetaMask words it: the method answers again at the next ask.
      failing.set(method, fails - 1);
      log.push(method);
      return { error: { code: -32603, message: 'Internal JSON-RPC error.' } };
    }
    const reply = await answer(method, params);
    const hook = hooks.get(method);
    if (hook) { hooks.delete(method); hook(); }
    return reply;
  }
  async function answer(method, params) {
    log.push(method);
    try {
      switch (method) {
        case 'eth_requestAccounts': permitted = true; return { result: [owner] };
        case 'wallet_requestPermissions': permitted = true; return { result: [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [owner] }] }] };
        case 'wallet_revokePermissions': permitted = false; return { result: null };
        case 'eth_accounts': return { result: permitted ? [owner] : [] };
        case 'eth_chainId': return { result: '0x1237' };
        case 'wallet_switchEthereumChain': return { result: null };
        case 'eth_getCode': return { result: code[lower(params[0])] ?? '0x' };
        case 'eth_gasPrice': return { result: '0x5f5e100' };
        case 'eth_getTransactionCount': return { result: numberToHex(sends.length + burned) };
        case 'eth_estimateGas': view(lower(params[0].from ?? zeroAddress), lower(params[0].to), params[0].data); return { result: '0x30d40' };
        case 'eth_getBalance': return { result: numberToHex(eth) };
        case 'eth_call': return { result: view(lower(params[0].from ?? zeroAddress), lower(params[0].to), params[0].data) };
        case 'eth_sendTransaction': {
          if (refuseNext) { refuseNext = false; declined.push(params[0]); return { error: { code: 4001, message: 'User rejected the request.' } }; }
          if (cancelNext) { cancelNext = false; burned += 1; return { result: at(0xd0 + burned, 32) }; }
          if (speedNext) { speedNext = false; const index = sends.length; include(params[0]); sends.push(params[0]); return { result: at(0xe0 + index, 32) }; }
          const index = sends.length;
          if (revertNext) { revertNext = false; reverted.add(index); } else include(params[0]);
          sends.push(params[0]);
          return { result: hashOf(index) };
        }
        case 'eth_getTransactionByHash': case 'eth_getTransactionReceipt': {
          const index = sends.findIndex((_, i) => hashOf(i) === lower(params[0]));
          if (index === -1) return { result: null };
          const sent = sends[index], block = { blockHash: blockOf(index).hash, blockNumber: blockOf(index).number };
          return { result: method === 'eth_getTransactionByHash'
            ? { hash: hashOf(index), from: sent.from, to: sent.to, input: sent.data, value: sent.value, nonce: sent.nonce, ...block }
            : { transactionHash: hashOf(index), from: sent.from, to: sent.to, status: reverted.has(index) ? '0x0' : '0x1', ...block } };
        }
        case 'eth_getBlockByNumber': {
          if (params[0] === 'latest') return { result: latest() };
          if (params[0] === 'finalized') return { result: { number: finality === 'lagging' ? '0x1' : '0x100000', hash: at(0xbf, 32) } };
          const index = Number(BigInt(params[0])) - FIRST_SENT_BLOCK;
          return { result: index >= 0 && index < sends.length ? blockOf(index) : null };
        }
      }
    } catch (error) {
      if (error instanceof Revert) return { error: { code: 3, message: 'execution reverted', data: error.data } };
      missing.push(String(error));
      return { error: { code: -32000, message: String(error) } };
    }
    refused.push(method);
    return { error: { code: 4200, message: `${method} is not supported` } };
  }

  const release = { contractVersion: '1.0.0-rc.1', chainId: 4663, available: true, deployment: {
    setup: SETUP, setupCodeHash: keccak256(SETUP_CODE), poolManager: POOL_MANAGER, positionManager: POSITION_MANAGER, stateView: STATE_VIEW,
    poolManagerCodeHash: keccak256(POOL_MANAGER_CODE), positionManagerCodeHash: keccak256(CODE.positionManager), stateViewCodeHash: keccak256(CODE.stateView),
    feeRecipient: FEE_RECIPIENT, feeBps: 30, tariffVersion: '1', expiresAt: Math.floor(Date.now() / 1000) + 86_400 } };

  return {
    owner, log, calls, refused, missing, sends, declined, paid, request, release, setup: SETUP, operationId, operations,
    nft: (tokenId) => nfts.get(BigInt(tokenId)),
    /** The block the next read sees: its timestamp is what a deadline is measured from. */
    latest,
    decline() { refuseNext = true; },
    revert() { revertNext = true; },
    /** The person speeds the next send up in the wallet: it is mined, under another hash than the page was given. */
    speedUp() { speedNext = true; },
    /** The person cancels the next send in the wallet: a 0-ETH transfer to the account takes its nonce, and it never happens. */
    cancelInWallet() { cancelNext = true; },
    /** Nonces the cancels took. */
    burned: () => burned,
    /** Runs `then` once, right after the wallet next answers `method`: a price that moves between two reads. */
    once(method, then) { hooks.set(method, then); },
    /** The next `times` asks of `method` fail as a wallet's node does now and then (-32603); later asks answer. */
    failNext(method, times = 1) { failing.set(method, (failing.get(method) ?? 0) + times); },
    /** Moves the pool of `tokenId` to another price, as a swap would. */
    move(tokenId, sqrtPriceX96, tick) { Object.assign(pools.get(nfts.get(BigInt(tokenId)).poolId), { sqrtPriceX96, tick }); },
    /** Fee growth inside the range of `tokenId` now. */
    grow(tokenId, growthNow) { pools.get(nfts.get(BigInt(tokenId)).poolId).growthNow = [...growthNow]; },
  };
}

/** The chain above as a WalletRpc for finance/ clients in node: errors thrown as a provider throws them. */
export function walletOf(chain, { current = () => true, claims = [] } = {}) {
  return {
    owner: chain.owner,
    current,
    request: async (method, params) => {
      const reply = await chain.request(method, params);
      if (reply.error) throw Object.assign(new Error(reply.error.message), reply.error);
      return reply.result;
    },
    nonceOffered: () => false,
    claimNonce: async (nonce) => { claims.push(['claim', nonce]); return `claim-${nonce}`; },
    releaseRejectedNonce: async (nonce, token) => { claims.push(['release', nonce, token]); },
  };
}
