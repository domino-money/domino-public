/**
 * A fake ORIGIN chain for S2's closed sender (src/finance/v2/crosschain.ts): one wallet that is also its chain, on any
 * EVM chain id (Optimism by default: not a V2 chain), answering exactly the requests the sender makes and recording
 * every one. ERC-20 reads (allowance, balanceOf, decimals) come from its own tables; an exact approval it mines sets
 * the allowance; the page's nonce journal is an in-memory one with V1's rules (claim once, release a claim only by its
 * token, settle a latch older than the limit). Nothing here touches a network.
 */
import { numberToHex } from 'viem';

const lower = (value) => String(value).toLowerCase();
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const ALLOWANCE = '0xdd62ed3e';
const BALANCE_OF = '0x70a08231';
const DECIMALS = '0x313ce567';
const APPROVE = '0x095ea7b3';

export function createOriginChain({
  owner,
  chainId = 10,
  nonce = 3,
  balance = 10n ** 18n,
  gasPrice = 50_000_000n,
  tip = 2_000_000n,
  estimate = 100_000n,
  finalizedTag = true,
  mine = 'instant',
} = {}) {
  const state = {
    chainId,
    latest: nonce,
    pending: nonce,
    balance,
    gasPrice,
    tip,
    estimate,
    finalizedTag,
    mine,
    current: true,
    accounts: [owner],
    allowances: new Map(),
    tokenBalances: new Map(),
    decimals: new Map(),
    sent: [],
    asked: [],
    /**
     * The next send: 'refuse' (4001), 'ledger' (a hardware wallet's words), 'unknown' (a -32603, nothing broadcast), 'hang'
     * (no answer), 'broadcast-lost' (broadcast, then a -32603), 'broadcast-garbled' (broadcast, then not a hash).
     */
    nextSend: null,
    /** Moves the wallet to this chain right after a nonce is claimed (between the claim and the last chain read). */
    chainAfterClaim: null,
    revertEstimate: false,
    head: 100n,
    finalized: 100n,
  };
  const txs = new Map();
  const receipts = new Map();
  const claims = new Map();
  let ids = 0;
  const key = (token, holder, spender) => `${lower(token)}|${lower(holder)}|${lower(spender)}`;
  const hashOf = (i) => `0x${(0xa0 + i).toString(16).padStart(64, '0')}`;
  const blockHash = (n) => `0x${(0xb0000n + n).toString(16).padStart(64, '0')}`;

  function includeTx(hash) {
    const tx = txs.get(hash);
    if (!tx || receipts.has(hash)) return;
    state.head += 1n;
    const blockNumber = state.head;
    const ok = !tx.reverts;
    receipts.set(hash, { transactionHash: hash, from: tx.from, blockHash: blockHash(blockNumber), blockNumber: numberToHex(blockNumber), status: ok ? '0x1' : '0x0', logs: [] });
    state.latest += 1;
    if (ok && lower(tx.data).startsWith(APPROVE)) {
      const spender = `0x${tx.data.slice(10 + 24, 74)}`;
      const amount = BigInt(`0x${tx.data.slice(74, 138)}`);
      state.allowances.set(key(tx.to, tx.from, spender), amount);
    }
  }

  async function request(method, params = []) {
    state.asked.push(method);
    switch (method) {
      case 'eth_accounts':
        return state.accounts;
      case 'eth_chainId':
        if (state.chainAfterClaim !== null && claims.size > 0) state.chainId = state.chainAfterClaim;
        return numberToHex(state.chainId);
      case 'eth_call': {
        const [{ to, data }] = params;
        const selector = lower(data).slice(0, 10);
        if (selector === ALLOWANCE) {
          const holder = `0x${data.slice(10 + 24, 74)}`;
          const spender = `0x${data.slice(74 + 24, 138)}`;
          return word(state.allowances.get(key(to, holder, spender)) ?? 0n);
        }
        if (selector === BALANCE_OF) return word(state.tokenBalances.get(lower(to)) ?? 0n);
        if (selector === DECIMALS) {
          if (!state.decimals.has(lower(to))) throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' });
          return word(state.decimals.get(lower(to)));
        }
        throw Object.assign(new Error('execution reverted'), { code: 3 });
      }
      case 'eth_gasPrice':
        return numberToHex(state.gasPrice);
      case 'eth_maxPriorityFeePerGas':
        return numberToHex(state.tip);
      case 'eth_estimateGas':
        if (state.revertEstimate) throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' });
        return numberToHex(state.estimate);
      case 'eth_getBalance':
        return numberToHex(state.balance);
      case 'eth_getTransactionCount':
        return numberToHex(params[1] === 'pending' ? state.pending : state.latest);
      case 'eth_sendTransaction': {
        const next = state.nextSend;
        state.nextSend = null;
        if (next === 'refuse') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        if (next === 'ledger') throw Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603, data: { message: 'Ledger device: Condition of use not satisfied (denied by the user?) (0x6985)' } });
        if (next === 'unknown') throw Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 });
        if (next === 'hang') return new Promise(() => {});
        const tx = { ...params[0] };
        const hash = hashOf(ids++);
        state.sent.push(tx);
        txs.set(hash, { ...tx, hash, reverts: state.revertNextSend === true });
        state.revertNextSend = false;
        state.pending += 1;
        if (state.mine === 'instant') includeTx(hash);
        // The wallet broadcast it, then its answer was lost (a time-out, a dropped connection): the page never gets the hash.
        if (next === 'broadcast-lost') throw Object.assign(new Error('Request timed out.'), { code: -32603 });
        if (next === 'broadcast-garbled') return '0xnot-a-hash';
        return hash;
      }
      case 'eth_getTransactionByHash': {
        const tx = txs.get(lower(params[0]));
        return tx ? { hash: tx.hash, from: tx.from, to: tx.to, input: tx.data, value: tx.value, nonce: tx.nonce } : null;
      }
      case 'eth_getTransactionReceipt':
        return receipts.get(lower(params[0])) ?? null;
      case 'eth_getBlockByNumber': {
        if (params[0] === 'finalized') {
          if (!state.finalizedTag) throw Object.assign(new Error('Unknown block tag'), { code: -32602 });
          return { number: numberToHex(state.finalized), hash: blockHash(state.finalized) };
        }
        const n = BigInt(params[0]);
        return n <= state.head ? { number: params[0], hash: blockHash(n) } : null;
      }
      default:
        throw Object.assign(new Error(`${method} is not answered here`), { code: 4200 });
    }
  }

  let tokens = 0;
  const wallet = {
    owner,
    current: () => state.current,
    chainId: () => state.chainId,
    request,
    nonceOffered: (chain, n) => claims.has(`${chain}|${n}`),
    async claimNonce(chain, n) {
      const k = `${chain}|${n}`;
      if (claims.has(k)) throw new Error('wallet_nonce_already_offered');
      const token = `claim-${++tokens}`;
      claims.set(k, { token, at: Date.now() / 1000 });
      return token;
    },
    async releaseRejectedNonce(chain, n, token) {
      const k = `${chain}|${n}`;
      if (claims.get(k)?.token === token) claims.delete(k);
    },
    async settleNonce(chain, n, now, maxAge) {
      const k = `${chain}|${n}`;
      const claim = claims.get(k);
      if (!claim) return true;
      if (now - claim.at <= maxAge) return false;
      claims.delete(k);
      return true;
    },
    /** V1's forget: the person's word lets the latch go, whoever holds it. */
    async forgetNonce(chain, n) {
      return claims.delete(`${chain}|${n}`);
    },
  };

  return {
    state,
    wallet,
    claims,
    receipts,
    /** Mines a sent transaction now (manual mining). */
    include: (hash) => includeTx(lower(hash)),
    /** Makes the next sent transaction revert once mined. */
    revertNext() {
      state.revertNextSend = true;
    },
    /** Every request since the last mark. */
    mark() {
      const from = state.asked.length;
      return () => state.asked.slice(from);
    },
  };
}

/** An in-memory Storage (localStorage's shape) that records what is written. */
export function memoryStorage() {
  const map = new Map();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}
