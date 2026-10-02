// position-plan-v1: closed schema validation plus the rules the service enforces, recomputed
// from the answer itself: the Domino fee terms (F1b's rule, from the ranks the answer names),
// the routes hash, the intent hash, the exact Permit2 / relayed typed data and digests, the
// direct call data, the minimums (each at the worst price within ±s, with the zap's exact
// liquidity math), the L1 data fee's source and the consent fields. No fetch, wallet or signing.
// What only the chain can prove stays with the app (F7 §2.4): the zap address against the
// pinned manifest, the ranks against the registry or the profile, and a simulation.
import { SCHEMAS, ERRORS, CONSTANTS } from './schema-data.mjs';
import { createContractValidators } from '../shared/closed-schema.mjs';

export const CONTRACT_VERSION = '1.0.0-rc.2';
export const ROUTES = Object.freeze(Object.keys(SCHEMAS));
export const ERROR_STATUS_BY_CODE = Object.freeze({ ...ERRORS });
export const REVERT_NAMES = Object.freeze({ ...CONSTANTS.errors });

const ZERO = '0x' + '0'.repeat(40);
const PERMIT2 = CONSTANTS.permit2.toLowerCase();

// ------------------------------------------------------------------ keccak-256
const MASK = (1n << 64n) - 1n;
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n,
  0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);

function permute(s) {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x][y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
      s[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & MASK & b[((x + 2) % 5) + 5 * y]);
    }
    s[0] ^= RC[round];
  }
}

/** Keccak-256 (Ethereum's, not SHA3-256) of bytes, as a Uint8Array of 32. */
export function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[offset + i * 8 + k]);
      s[i] ^= lane;
    }
    permute(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) out[i * 8 + k] = Number((s[i] >> BigInt(8 * k)) & 0xffn);
  return out;
}

const hex = (bytes) => '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (text) => {
  const body = text.replace(/^0x/u, '');
  if (body.length % 2 || /[^0-9a-fA-F]/u.test(body)) throw new Error('hex');
  return Uint8Array.from(body.match(/../gu) || [], (pair) => parseInt(pair, 16));
};
const utf8 = (text) => new TextEncoder().encode(text);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};
export const keccakHex = (bytes) => hex(keccak256(bytes));

// -------------------------------------------------------------- ABI encoding
function parseType(type) {
  if (type.endsWith('[]')) return { kind: 'array', item: parseType(type.slice(0, -2)) };
  if (type.startsWith('(')) {
    const parts = [];
    let depth = 0, start = 1;
    for (let i = 1; i < type.length - 1; i++) {
      if (type[i] === '(') depth++;
      else if (type[i] === ')') depth--;
      else if (type[i] === ',' && depth === 0) { parts.push(type.slice(start, i)); start = i + 1; }
    }
    parts.push(type.slice(start, type.length - 1));
    return { kind: 'tuple', components: parts.map(parseType) };
  }
  if (type === 'bytes') return { kind: 'bytes' };
  if (type === 'address' || type === 'bool' || type === 'bytes32') return { kind: type };
  const match = type.match(/^(u?)int(\d+)$/u);
  if (match) return { kind: match[1] ? 'uint' : 'int', bits: BigInt(match[2]) };
  throw new Error('abi_type');
}
const dynamic = (t) => t.kind === 'bytes' || t.kind === 'array' || (t.kind === 'tuple' && t.components.some(dynamic));
const word = (value) => {
  let v = BigInt(value);
  if (v < 0n) v = (1n << 256n) + v;
  if (v < 0n || v >= 1n << 256n) throw new Error('abi_range');
  return fromHex(v.toString(16).padStart(64, '0'));
};

function encodeValue(t, value) {
  switch (t.kind) {
    case 'uint': {
      const v = BigInt(value);
      if (v < 0n || v >= 1n << t.bits) throw new Error('abi_range');
      return word(v);
    }
    case 'int': {
      const v = BigInt(value);
      if (v < -(1n << (t.bits - 1n)) || v >= 1n << (t.bits - 1n)) throw new Error('abi_range');
      return word(v);
    }
    case 'address': return word(BigInt(value));
    case 'bool': return word(value ? 1n : 0n);
    case 'bytes32': {
      const bytes = fromHex(value);
      if (bytes.length !== 32) throw new Error('abi_bytes32');
      return bytes;
    }
    case 'bytes': {
      const bytes = fromHex(value);
      const padded = new Uint8Array(Math.ceil(bytes.length / 32) * 32);
      padded.set(bytes);
      return concat(word(bytes.length), padded);
    }
    case 'array': return concat(word(value.length), encodeTuple(value.map(() => t.item), value));
    default: return encodeTuple(t.components, value);
  }
}

function encodeTuple(types, values) {
  if (types.length !== values.length) throw new Error('abi_arity');
  const heads = [], tails = [];
  let headSize = 0;
  for (const t of types) headSize += dynamic(t) ? 32 : staticSize(t);
  let offset = headSize;
  types.forEach((t, i) => {
    const encoded = encodeValue(t, values[i]);
    if (dynamic(t)) { heads.push(word(offset)); tails.push(encoded); offset += encoded.length; }
    else heads.push(encoded);
  });
  return concat(...heads, ...tails);
}
const staticSize = (t) => (t.kind === 'tuple' ? t.components.reduce((n, c) => n + staticSize(c), 0) : 32);

/** abi.encode(values) for ABI type strings, as bytes. */
export const abiEncode = (types, values) => encodeTuple(types.map(parseType), values);

// ------------------------------------------------------------- plan tuples
const POOL = '(uint8,address,address,uint24,int24,address)';
const LEG = '(uint8,address,address,address,uint128,uint128,bytes)';
const INTENT = `(uint8,${POOL},uint256,int24,int24,uint128,uint16,address,bytes32,address,uint256,uint64)`;
const PLAN_TYPES = {
  create: `(${INTENT},(address,uint128)[],${LEG}[],uint128,uint128,uint160)`,
  increase: `(${INTENT},(address,uint128)[],${LEG}[],uint128,uint128)`,
  changeRange: `(${INTENT},uint128,uint128,uint128,${LEG}[],uint128,uint128,bool)`,
  exit: `(${INTENT},uint128,uint128,uint128,${LEG}[],bool)`,
};
const poolTuple = (p) => [p.dex, p.currency0, p.currency1, p.fee, p.tickSpacing, p.hooks];
const legTuple = (l) => [l.kind, l.router, l.tokenIn, l.tokenOut, l.amountIn, l.minAmountOut, l.data];
const intentTuple = (i) => [i.action, poolTuple(i.pool), i.tokenId, i.tickLower, i.tickUpper, i.minLiquidity, i.feeBps,
  i.feeToken, i.routesHash, i.recipient, i.nonce, i.deadline];

function planTuple(action, plan) {
  const legs = plan.legs.map(legTuple), intent = intentTuple(plan.intent);
  if (action === 'create' || action === 'increase') {
    const base = [intent, plan.inputs.map((x) => [x.token, x.amount]), legs, plan.amount0Max, plan.amount1Max];
    return action === 'create' ? [...base, plan.initSqrtPriceX96] : base;
  }
  const head = [intent, plan.liquidityToRemove, plan.amount0MinRemoved, plan.amount1MinRemoved, legs];
  return action === 'changeRange' ? [...head, plan.amount0Max, plan.amount1Max, plan.burnOld] : [...head, plan.burn];
}

/** keccak256(abi.encode(SwapLeg[])): DominoV2Types.routesHash. */
export const routesHash = (legs) => keccakHex(abiEncode([`${LEG}[]`], [legs.map(legTuple)]));

/** The direct call's data: selector ‖ abi.encode(plan). */
export function callData(action, plan) {
  return CONSTANTS.functions[action].direct.selector + hex(abiEncode([PLAN_TYPES[action]], [planTuple(action, plan)])).slice(2);
}

/** msg.value of a direct create or increase: the native inputs. */
export const directValue = (plan) => (plan.inputs || []).filter((x) => x.token === ZERO)
  .reduce((sum, x) => sum + BigInt(x.amount), 0n);

// ------------------------------------------------------------------ EIP-712
const typehash = (name) => fromHex(CONSTANTS.eip712.typehashes[name]);
const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
const PERMIT2_DOMAIN_TYPE = 'EIP712Domain(string name,uint256 chainId,address verifyingContract)';
const TOKEN_PERMISSIONS_TYPE = 'TokenPermissions(address token,uint256 amount)';

const hashPool = (p) => keccak256(abiEncode(['bytes32', 'uint8', 'address', 'address', 'uint24', 'int24', 'address'],
  [hex(typehash('PoolRef')), ...poolTuple(p)]));

/** DominoV2Types.hashPositionIntent. */
export function hashIntent(i) {
  return keccak256(abiEncode(['bytes32', 'uint8', 'bytes32', 'uint256', 'int24', 'int24', 'uint128', 'uint16', 'address',
    'bytes32', 'address', 'uint256', 'uint64'], [hex(typehash('PositionIntent')), i.action, hex(hashPool(i.pool)),
    i.tokenId, i.tickLower, i.tickUpper, i.minLiquidity, i.feeBps, i.feeToken, i.routesHash, i.recipient, i.nonce,
    i.deadline]));
}

const dominoDomain = (chainId, zap) => keccak256(abiEncode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
  [keccakHex(utf8(DOMAIN_TYPE)), keccakHex(utf8('Domino')), keccakHex(utf8('2')), chainId, zap]));
const permit2Domain = (chainId) => keccak256(abiEncode(['bytes32', 'bytes32', 'uint256', 'address'],
  [keccakHex(utf8(PERMIT2_DOMAIN_TYPE)), keccakHex(utf8('Permit2')), chainId, PERMIT2]));
const digest = (separator, struct) => keccakHex(concat(Uint8Array.of(0x19, 0x01), separator, struct));

/** The intent hash every receipt event and FeeCharged.ref carry. */
export const intentHash = (chainId, zap, intent) => digest(dominoDomain(chainId, zap), hashIntent(intent));

/** Permit2's PermitBatchWitnessTransferFrom digest with the intent as witness. */
export function permit2Digest(chainId, spender, permit, intent) {
  const permissions = concat(...permit.permitted.map((p) => keccak256(abiEncode(['bytes32', 'address', 'uint256'],
    [keccakHex(utf8(TOKEN_PERMISSIONS_TYPE)), p.token, p.amount]))));
  const struct = keccak256(abiEncode(['bytes32', 'bytes32', 'address', 'uint256', 'uint256', 'bytes32'],
    [CONSTANTS.eip712.permit2FullTypehash, keccakHex(permissions), spender, permit.nonce, permit.deadline,
      hex(hashIntent(intent))]));
  return digest(permit2Domain(chainId), struct);
}

/** The RelayedPositionAction of a change of range or an exit (an exit signs both caps as zero). */
export function relayedFields(action, plan) {
  const caps = action === 'changeRange' ? [plan.amount0Max, plan.amount1Max] : ['0', '0'];
  return { intent: plan.intent, liquidityToRemove: plan.liquidityToRemove, amount0MinRemoved: plan.amount0MinRemoved,
    amount1MinRemoved: plan.amount1MinRemoved, amount0Max: caps[0], amount1Max: caps[1],
    burn: action === 'changeRange' ? plan.burnOld : plan.burn };
}

export function relayedDigest(chainId, zap, r) {
  const struct = keccak256(abiEncode(['bytes32', 'bytes32', 'uint128', 'uint128', 'uint128', 'uint128', 'uint128', 'bool'],
    [hex(typehash('RelayedPositionAction')), hex(hashIntent(r.intent)), r.liquidityToRemove, r.amount0MinRemoved,
      r.amount1MinRemoved, r.amount0Max, r.amount1Max, r.burn]));
  return digest(dominoDomain(chainId, zap), struct);
}

const copyTypes = (names) => Object.fromEntries(names.map((n) => [n, CONSTANTS.eip712.types[n].map((f) => ({ ...f }))]));

/** eth_signTypedData_v4 for the Permit2 path, as the service builds it. */
export function permit2TypedData(chainId, spender, permit, intent) {
  return {
    types: { EIP712Domain: CONSTANTS.eip712.permit2DomainFields.map((f) => ({ ...f })),
      ...copyTypes(['PermitBatchWitnessTransferFrom', 'TokenPermissions', 'PositionIntent', 'PoolRef']) },
    primaryType: 'PermitBatchWitnessTransferFrom',
    domain: { name: 'Permit2', chainId, verifyingContract: CONSTANTS.permit2 },
    message: { permitted: permit.permitted.map((p) => ({ token: p.token, amount: p.amount })), spender,
      nonce: permit.nonce, deadline: permit.deadline, witness: intent },
  };
}

export function relayedTypedData(chainId, zap, relayed) {
  return {
    types: { EIP712Domain: CONSTANTS.eip712.dominoDomainFields.map((f) => ({ ...f })),
      ...copyTypes(['RelayedPositionAction', 'PositionIntent', 'PoolRef']) },
    primaryType: 'RelayedPositionAction',
    domain: { name: 'Domino', version: '2', chainId, verifyingContract: zap },
    message: relayed,
  };
}

// ---------------------------------------------------------------- fee rule
const PLACES = ['input', 'output', 'hop'];

/** DominoFeeRules.assistedSwapFeeToken: [token, place] from the legs and a rank lookup. */
export function feeToken(legs, rank) {
  if (!legs.length) throw new Error('fee_rule_empty_route');
  let best = null, token = null, place = null;
  const placeOf = (i, t, asInput) => {
    if (asInput) return legs.slice(0, i).some((l) => l.tokenOut === t) ? 'hop' : 'input';
    return legs.slice(i + 1).some((l) => l.tokenIn === t) ? 'hop' : 'output';
  };
  for (const at of PLACES) {
    legs.forEach((leg, i) => {
      for (const [candidate, asInput] of [[leg.tokenIn, true], [leg.tokenOut, false]]) {
        if (placeOf(i, candidate, asInput) !== at) continue;
        const r = rank(candidate);
        if (r !== 0 && (best === null || r < best)) [best, token, place] = [r, candidate, at];
      }
    });
  }
  return token === null ? [legs[0].tokenIn, 'fallback'] : [token, place];
}

/** DominoFeeRules.swappedAmount. */
export function swappedAmount(legs, outs, token) {
  let spent = 0n, delivered = 0n;
  legs.forEach((leg, i) => {
    if (leg.tokenIn === token) spent += BigInt(leg.amountIn);
    if (leg.tokenOut === token) delivered += BigInt(outs[i]);
  });
  return spent > delivered ? spent : delivered;
}

// ---------------------------------------------------- liquidity math (exact)
// TickMath, SqrtPriceMath and LiquidityAmounts as the zap computes them (v4-core, v4-periphery).
const Q96 = 1n << 96n;
const Q128 = 1n << 128n;
const U256 = (1n << 256n) - 1n;
const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;
const TICK_FACTORS = [
  0xfffcb933bd6fad37aa2d162d1a594001n, 0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n, 0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n, 0xfe5dee046a99a2a811c461f1969c3053n, 0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n, 0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n, 0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n, 0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n, 0x48a170391f7dc42444e8fa2n];
const ceilDiv = (n, d) => (n + d - 1n) / d;

/** TickMath.getSqrtPriceAtTick. */
export function sqrtAtTick(tick) {
  if (!Number.isInteger(tick) || tick < -887272 || tick > 887272) throw new Error('tick_out_of_bounds');
  const abs = BigInt(Math.abs(tick));
  let ratio = Q128;
  TICK_FACTORS.forEach((factor, bit) => { if (abs & (1n << BigInt(bit))) ratio = (ratio * factor) >> 128n; });
  if (tick > 0) ratio = U256 / ratio;
  return ceilDiv(ratio, 1n << 32n);
}

/** Integer square root (floor): Newton's method from a power of two above the root. */
export function isqrt(n) {
  if (n < 0n) throw new Error('isqrt_negative');
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** SqrtPriceMath.getAmount0Delta / getAmount1Delta. */
function amountDelta(a, b, liquidity, currency, up) {
  if (a > b) [a, b] = [b, a];
  const [n, d] = currency === 0 ? [(liquidity << 96n) * (b - a), a * b] : [liquidity * (b - a), Q96];
  return up ? ceilDiv(n, d) : n / d;
}

/** DominoPositionMath.amountsForLiquidity: what removing (down) pays, as [amount0, amount1]. */
export function amountsForLiquidity(sqrtPrice, sqrtA, sqrtB, liquidity, up) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (liquidity === 0n) return [0n, 0n];
  if (sqrtPrice <= sqrtA) return [amountDelta(sqrtA, sqrtB, liquidity, 0, up), 0n];
  if (sqrtPrice < sqrtB) return [amountDelta(sqrtPrice, sqrtB, liquidity, 0, up), amountDelta(sqrtA, sqrtPrice, liquidity, 1, up)];
  return [0n, amountDelta(sqrtA, sqrtB, liquidity, 1, up)];
}

/** LiquidityAmounts.getLiquidityForAmounts. */
export function liquidityForAmounts(sqrtPrice, sqrtA, sqrtB, amount0, amount1) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const for0 = (a, b) => (amount0 * ((a * b) / Q96)) / (b - a);
  const for1 = (a, b) => (amount1 * Q96) / (b - a);
  if (sqrtPrice <= sqrtA) return for0(sqrtA, sqrtB);
  if (sqrtPrice < sqrtB) { const l0 = for0(sqrtPrice, sqrtB), l1 = for1(sqrtA, sqrtPrice); return l0 < l1 ? l0 : l1; }
  return for1(sqrtA, sqrtB);
}

// The points of the ±s band the minimums are taken at (1 + step × s / 2).
export const BAND_STEPS = Object.freeze([-2, -1, 0, 1, 2]);

/** The sqrt price of the price × (1 + step × s / 2); at ±2 the Uniswap SDK's ratiosAfterSlippage. */
export function bandSqrtPrice(sqrtPrice, slippageBps, step) {
  const value = isqrt((sqrtPrice * sqrtPrice * BigInt(20000 + step * slippageBps)) / 20000n);
  return value <= MIN_SQRT ? MIN_SQRT + 1n : value >= MAX_SQRT ? MAX_SQRT - 1n : value;
}

/** The plan's minimums at the worst price within ±s (1.0.0-rc.2), as the service's plan_minimums. */
export function planMinimums(d) {
  const { action, zapPlan: plan, pool, position } = d;
  const s = d.request.slippageBps, intent = plan.intent;
  const chain = CONSTANTS.chains[String(d.chainId)];
  const wraps = pool.dex === 3 && [pool.currency0, pool.currency1].includes(chain.wrappedNative.toLowerCase());
  const fold = (t) => (wraps && t === ZERO ? chain.wrappedNative.toLowerCase() : t);
  const band = (sqrt) => ({ lowerSqrtPriceX96: String(bandSqrtPrice(sqrt, s, -2)), upperSqrtPriceX96: String(bandSqrtPrice(sqrt, s, 2)) });
  const out = { liquidity: null, amount0Removed: null, amount1Removed: null, mintBand: null, removalBand: null };
  let oldA, oldB, poolSqrt, remove;
  if (action === 'changeRange' || action === 'exit') {
    [oldA, oldB] = [sqrtAtTick(position.tickLower), sqrtAtTick(position.tickUpper)];
    poolSqrt = BigInt(pool.sqrtPriceX96); remove = BigInt(plan.liquidityToRemove);
    out.amount0Removed = amountsForLiquidity(bandSqrtPrice(poolSqrt, s, 2), oldA, oldB, remove, false)[0];
    out.amount1Removed = amountsForLiquidity(bandSqrtPrice(poolSqrt, s, -2), oldA, oldB, remove, false)[1];
    out.removalBand = band(poolSqrt);
  }
  if (action === 'exit') { out.liquidity = BigInt(plan.liquidityToRemove); return out; }
  const held = new Map([[pool.currency0, 0n], [pool.currency1, 0n]]);
  const add = (t, v) => held.set(fold(t), (held.get(fold(t)) || 0n) + v);
  for (const item of plan.inputs || []) add(item.token, BigInt(item.amount));
  for (const leg of plan.legs) { add(leg.tokenIn, -BigInt(leg.amountIn)); add(leg.tokenOut, BigInt(leg.minAmountOut)); }
  if (plan.legs.length) {
    const ranks = Object.fromEntries(d.fee.ranks.map((x) => [x.token, x.rank]));
    const [token] = feeToken(plan.legs, (t) => ranks[t] || 0);
    add(token, -(swappedAmount(plan.legs, plan.legs.map((l) => l.minAmountOut), token) * 65n) / 10000n);
  }
  const [sqrtA, sqrtB] = [sqrtAtTick(intent.tickLower), sqrtAtTick(intent.tickUpper)];
  const mintSqrt = BigInt(d.expected.sqrtPriceX96After);
  let least = null;
  for (const step of BAND_STEPS) {
    let amount0 = held.get(pool.currency0), amount1 = held.get(pool.currency1);
    if (action === 'changeRange') {
      const [w0, w1] = amountsForLiquidity(bandSqrtPrice(poolSqrt, s, step), oldA, oldB, remove, false);
      amount0 += w0 + BigInt(position.feesOwed0Raw); amount1 += w1 + BigInt(position.feesOwed1Raw);
    }
    const l = amount0 < 0n || amount1 < 0n ? 0n : liquidityForAmounts(bandSqrtPrice(mintSqrt, s, step), sqrtA, sqrtB, amount0, amount1);
    least = least === null || l < least ? l : least;
  }
  out.liquidity = least;
  out.mintBand = band(mintSqrt);
  return out;
}

// ------------------------------------------------------------------ rules
const ACTIONS = { create: 1, increase: 2, changeRange: 3, exit: 4 };
const LEG_KINDS = { universal_router: 1, v3_pool: 2, v4_pool: 3 };
const PLAN_KEYS = {
  create: ['intent', 'inputs', 'legs', 'amount0Max', 'amount1Max', 'initSqrtPriceX96'],
  increase: ['intent', 'inputs', 'legs', 'amount0Max', 'amount1Max'],
  changeRange: ['intent', 'liquidityToRemove', 'amount0MinRemoved', 'amount1MinRemoved', 'legs', 'amount0Max', 'amount1Max', 'burnOld'],
  exit: ['intent', 'liquidityToRemove', 'amount0MinRemoved', 'amount1MinRemoved', 'legs', 'burn'],
};
const floorBy = (amount, bps) => (BigInt(amount) * BigInt(10000 - bps)) / 10000n;
// Deep equality of JSON values, object keys in any order (the fixtures sort them).
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v !== null && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',')}}`
    : JSON.stringify(v));
const same = (a, b) => canonical(a) === canonical(b);

function checkRequest(r) {
  const present = ['pool', 'position', 'tickLower', 'tickUpper', 'inputs', 'liquidityToRemove', 'burn', 'receive',
    'initialPrice'].filter((k) => r[k] !== undefined && r[k] !== null);
  const needed = { create: ['pool', 'tickLower', 'tickUpper', 'inputs'], increase: ['position', 'inputs'],
    changeRange: ['position', 'tickLower', 'tickUpper', 'liquidityToRemove', 'burn'],
    exit: ['position', 'liquidityToRemove', 'burn', 'receive'] }[r.action];
  const optional = r.action === 'create' ? ['initialPrice'] : [];
  if (!needed.every((k) => present.includes(k)) || !present.every((k) => needed.includes(k) || optional.includes(k))) return false;
  const consents = ['create', 'increase'].includes(r.action) ? ['direct', 'permit2'] : ['direct', 'relayed'];
  if (!consents.includes(r.consent)) return false;
  if (r.pool && r.pool.currency0.toLowerCase() >= r.pool.currency1.toLowerCase()) return false;
  if (r.inputs && new Set(r.inputs.map((x) => x.token.toLowerCase())).size !== r.inputs.length) return false;
  if (r.tickLower !== undefined && r.tickLower !== null && r.tickLower >= r.tickUpper) return false;
  if (r.receive && ((r.receive.mode === 'converted') !== (r.receive.token !== undefined && r.receive.token !== null))) return false;
  return true;
}

/** Every rule of a plan answer; throws with the rule's name. */
export function checkPlan(d) {
  const fail = (what) => { throw new Error('position_plan_rule_' + what); };
  const r = d.request, plan = d.zapPlan, intent = plan.intent, slippage = r.slippageBps;
  if (!checkRequest(r)) fail('request');
  if (r.chainId !== d.chainId || r.action !== d.action || r.consent !== d.consent || r.owner !== d.owner) fail('request');
  if (!(d.requestedAt <= d.retrievedAt && d.retrievedAt < d.expiresAt && d.expiresAt === d.requestedAt + CONSTANTS.quoteLifetimeSeconds
    && Number(d.deadline) === d.requestedAt + CONSTANTS.deadlineSeconds)) fail('times');
  if (!same(Object.keys(plan).sort(), [...PLAN_KEYS[d.action]].sort())) fail('plan_shape');
  if (intent.action !== ACTIONS[d.action] || intent.recipient !== d.owner || intent.deadline !== d.deadline) fail('intent');
  const pool = d.pool;
  if (!same(intent.pool, { dex: pool.dex, currency0: pool.currency0, currency1: pool.currency1, fee: pool.fee,
    tickSpacing: pool.tickSpacing, hooks: pool.hooks }) || pool.hooks !== ZERO) fail('pool');
  // Target
  if (d.action === 'create') {
    const asked = Object.fromEntries(Object.entries(r.pool).map(([k, v]) => [k, typeof v === 'string' ? v.toLowerCase() : v]));
    if (d.position !== null || intent.tokenId !== '0' || !same(asked, intent.pool)) fail('create_target');
    if (intent.tickLower !== r.tickLower || intent.tickUpper !== r.tickUpper) fail('ticks');
    const initial = d.initialPrice;
    if ((initial === null) !== (r.initialPrice === null || r.initialPrice === undefined) || pool.initialized !== (initial === null)
      || plan.initSqrtPriceX96 !== (initial ? initial.sqrtPriceX96 : '0')) fail('initial_price');
  } else {
    const p = d.position;
    if (p === null || d.initialPrice !== null || intent.tokenId !== p.tokenId || p.tokenId !== r.position.tokenId) fail('position');
    const ticks = d.action === 'changeRange' ? [r.tickLower, r.tickUpper] : [p.tickLower, p.tickUpper];
    if (intent.tickLower !== ticks[0] || intent.tickUpper !== ticks[1]) fail('ticks');
    if (d.action !== 'increase') {
      const remove = plan.liquidityToRemove;
      if (remove !== p.liquidityToRemove || remove !== (r.liquidityToRemove === 'all' ? p.liquidity : r.liquidityToRemove)) fail('liquidity_to_remove');
      const burn = d.action === 'changeRange' ? plan.burnOld : plan.burn;
      if (burn !== r.burn || (burn && remove !== p.liquidity)) fail('burn');
    }
  }
  // Nonce
  const nonce = d.readiness.nonce;
  if (d.consent === 'direct') { if (intent.nonce !== '0' || nonce !== null) fail('nonce'); }
  else if (nonce === null || nonce.kind !== d.consent || nonce.nonce !== intent.nonce
    || ((BigInt(nonce.word) << 8n) | BigInt(nonce.bit)) !== BigInt(intent.nonce)) fail('nonce');
  // Legs
  const legs = plan.legs, views = d.legs;
  const routes = routesHash(legs);
  if (routes !== intent.routesHash || routes !== d.routesHash || legs.length !== views.length) fail('routes_hash');
  legs.forEach((leg, i) => {
    const v = views[i];
    if (leg.kind !== LEG_KINDS[v.kind] || leg.tokenIn !== v.tokenIn || leg.tokenOut !== v.tokenOut || leg.amountIn !== v.amountInRaw
      || leg.minAmountOut !== v.minAmountOutRaw || leg.tokenIn === leg.tokenOut) fail('legs');
    if ((leg.router === ZERO) !== (leg.kind !== 1)) fail('leg_router');
    if (leg.kind === 1 && leg.router !== (CONSTANTS.chains[String(d.chainId)] || {}).universalRouter) fail('leg_router');
    const floor = floorBy(v.expectedOutRaw, slippage);
    if (BigInt(leg.minAmountOut) !== (floor > 0n ? floor : 1n)) fail('leg_minimum');
  });
  // Fee
  const fee = d.fee;
  const seen = [];
  legs.forEach((l) => [l.tokenIn, l.tokenOut].forEach((t) => { if (!seen.includes(t)) seen.push(t); }));
  if (!same(fee.ranks.map((x) => x.token), seen)) fail('fee_ranks');
  if (!legs.length) {
    if (fee.bps !== 0 || fee.token !== ZERO || fee.place !== 'none' || fee.basisRaw !== '0' || fee.amountRaw !== '0'
      || intent.feeBps !== 0 || intent.feeToken !== ZERO) fail('fee');
  } else {
    const ranks = Object.fromEntries(fee.ranks.map((x) => [x.token, x.rank]));
    const [token, place] = feeToken(legs, (t) => ranks[t] || 0);
    if (fee.bps !== 65 || fee.token !== token || fee.place !== place || intent.feeBps !== 65 || intent.feeToken !== token) fail('fee');
    const basis = swappedAmount(legs, views.map((v) => v.expectedOutRaw), token);
    if (fee.basisRaw !== String(basis) || fee.amountRaw !== String((basis * 65n) / 10000n)) fail('fee_amount');
  }
  // Minimums: each at the worst price within ±s (1.0.0-rc.2)
  const m = d.minimums, e = d.expected;
  if (m.slippageBps !== slippage || m.liquidity !== intent.minLiquidity) fail('minimums');
  let want;
  try { want = planMinimums(d); } catch { fail('minimums'); }
  if (BigInt(intent.minLiquidity) !== want.liquidity || (d.action !== 'exit' && want.liquidity === 0n)) fail('minimums');
  if (!same(m.mintBand, want.mintBand) || !same(m.removalBand, want.removalBand)) fail('minimum_bands');
  if (d.action === 'changeRange' || d.action === 'exit') {
    for (const side of ['0', '1']) {
      const value = String(want[`amount${side}Removed`]);
      if (plan[`amount${side}MinRemoved`] !== value || m[`amount${side}RemovedRaw`] !== value) fail('removal_minimums');
    }
  } else if (m.amount0RemovedRaw !== null || m.amount1RemovedRaw !== null || e.principal0Raw !== null) fail('removal_minimums');
  // Inputs
  if (d.action === 'create' || d.action === 'increase') {
    const wanted = r.inputs.map((x) => ({ token: x.token.toLowerCase(), amount: x.amountRaw }));
    if (!same(plan.inputs, wanted)) fail('inputs');
    if (d.consent === 'permit2' && plan.inputs.some((x) => x.token === ZERO)) fail('permit2_native');
  }
  // Call
  const call = d.call, fn = CONSTANTS.functions[d.action][d.consent];
  if (!fn || call.function !== fn.name || call.selector !== fn.selector || call.to !== d.zap) fail('call');
  if (d.consent === 'direct') {
    if (call.data !== callData(d.action, plan) || call.valueRaw !== String(directValue(plan))) fail('call');
  } else if (call.data !== null || call.valueRaw !== '0') fail('call');
  // Signature
  const sig = d.signature;
  if (d.consent === 'direct') { if (sig !== null) fail('signature'); }
  else if (sig === null || sig.kind !== d.consent) fail('signature');
  else if (d.consent === 'permit2') {
    const permit = { permitted: plan.inputs, nonce: intent.nonce, deadline: intent.deadline };
    if (!same(sig.permit, permit)) fail('permit');
    if (!same(sig.typedData, permit2TypedData(d.chainId, d.zap, permit, intent))
      || sig.digest !== permit2Digest(d.chainId, d.zap, permit, intent)) fail('typed_data');
  } else {
    const relayed = relayedFields(d.action, plan);
    if (sig.permit !== null || !same(sig.typedData, relayedTypedData(d.chainId, d.zap, relayed))
      || sig.digest !== relayedDigest(d.chainId, d.zap, relayed)) fail('typed_data');
  }
  if (d.intentHash !== intentHash(d.chainId, d.zap, intent)) fail('intent_hash');
  // Readiness
  const account = d.readiness.account, steps = d.readiness.steps;
  if (!account.consents.includes(d.consent) || (account.kind !== 'eoa' && !same(account.consents, ['direct']))) fail('consent');
  const last = steps[steps.length - 1];
  if (last.kind !== 'send_action' || last.to !== d.zap || last.valueRaw !== call.valueRaw || last.data !== null) fail('steps');
  for (const step of steps.slice(0, -1)) {
    if (step.kind.startsWith('sign_')) { if (step.kind !== 'sign_' + d.consent || step.to !== null || step.data !== null) fail('steps'); }
    else if (step.valueRaw !== '0' || step.data === null || !step.data.startsWith('0x095ea7b3')) fail('steps');
  }
  // L1 data fee
  const l1 = d.l1DataFee;
  if (l1.block !== d.block.number || l1.source !== CONSTANTS.chains[String(d.chainId)].l1DataFeeSource) fail('l1_data_fee');
  if (l1.status === 'ok' && l1.source === 'nitro_node_interface'
    && BigInt(l1.weiRaw) !== BigInt(l1.l1GasUnits) * BigInt(l1.l2BaseFeeWei)) fail('l1_data_fee');
  // Simulation
  const s = d.simulation;
  if (s.status === 'ok' && (s.result === null || s.error !== null || s.method === null || s.reason !== null)) fail('simulation');
  if (s.status === 'reverted' && (s.result !== null || s.method === null || (s.error !== null) === (s.reason !== null))) fail('simulation');
  if (s.status === 'not_run' && (s.result !== null || s.error !== null || s.reason === null || s.method !== null || s.gasUnits !== null)) fail('simulation');
  return true;
}

/** The name of a revert's selector, from F7 §2.12's table, or null. */
export const revertName = (data) => (typeof data === 'string' && data.length >= 10 ? REVERT_NAMES[data.slice(0, 10).toLowerCase()] || null : null);

function semantic(name, value) {
  try {
    if (name === 'PlanRequest') return checkRequest(value);
    if (name === 'PlanResponse') return checkPlan(value.plan);
    return true;
  } catch { return false; }
}

export const { validateRequest, validateResponse, validateError } = createContractValidators(SCHEMAS, ERRORS, semantic);
