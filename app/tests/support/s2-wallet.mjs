/**
 * The browser wallet for the S2 browser suite (tests/v2-browser/s2*.test.mjs): one EIP-6963 provider, "S2 Test Wallet",
 * for the public anvil account #1, on a chain it can be switched between (Robinhood Chain, Base, Arbitrum One, Ethereum,
 * Optimism by default). It answers what connecting and S2's reads ask (accounts, chain, switch, capabilities, balances,
 * an ERC-20's balanceOf and decimals), records every request, and refuses everything else with 4200, recorded.
 * `eth_sendTransaction` is refused too and recorded in `sends`: the suite asserts it stays empty, since a fixture quote
 * must never reach the wallet. Nothing here signs anything or touches a network.
 *
 * Added 2026-10-06 (rugged's answer of 6 Oct: approval and deposit in one batch): `origin`, a fake ORIGIN chain
 * (./s2-origin-chain.mjs createOriginChain) the wallet sends on. While the wallet is on that chain, what S2's closed sender
 * asks to send there (the nonce, the fee, the estimate, the send, the allowance, receipts and blocks, and EIP-5792's
 * capabilities and batch) is that chain's answer, and so is a batch's status on any chain (its id names none). Without
 * `origin`, exactly as before.
 */
import { numberToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** Anvil's public development account #1: holds nothing on any real network. */
export const S2_ACCOUNT = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
export const S2_OWNER = S2_ACCOUNT.address.toLowerCase();

const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const lower = (value) => String(value).toLowerCase();
/** What the origin chain answers while the wallet is on it (`origin`); the allowance is its only eth_call. */
const ORIGIN_METHODS = new Set(['eth_getTransactionCount', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_estimateGas', 'eth_sendTransaction', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'wallet_getCapabilities', 'wallet_sendCalls']);
const ALLOWANCE = '0xdd62ed3e';

/**
 * `chainId`: where the wallet starts. `chains`: the chains it knows (others answer 4902). `native`: chainId → wei.
 * `tokens`: `${chainId}:${address}` → { balance, decimals }. `nonces`: chainId → { latest, pending } (0 and 0 by default).
 */
export async function installS2Wallet(context, { chainId = 4663, chains = [4663, 8453, 42161, 1, 10], native = {}, tokens = {}, nonces = {}, origin = null } = {}) {
  const state = { chainId, chains: new Set(chains), native: { ...native }, tokens: { ...tokens }, nonces: { ...nonces }, permitted: false, log: [], sends: [], refused: [] };
  const fail = (code, message) => ({ error: { code, message } });
  /** The origin chain's own answer, as a provider gives it. */
  async function fromOrigin(method, params) {
    try {
      return { result: await origin.wallet.request(method, params) };
    } catch (error) {
      return { error: { code: error.code ?? -32603, message: error.message, data: error.data } };
    }
  }

  async function emit(event, payload) {
    for (const page of context.pages()) await page.evaluate(([name, value]) => window.__s2WalletEmit?.(name, value), [event, payload]).catch(() => {});
  }

  async function request(method, params) {
    state.log.push({ method, params, chainId: state.chainId });
    if (origin && (method === 'wallet_getCallsStatus' || (state.chainId === origin.state.chainId && (ORIGIN_METHODS.has(method) || (method === 'eth_call' && lower(params?.[0]?.data).startsWith(ALLOWANCE)))))) return fromOrigin(method, params);
    switch (method) {
      case 'eth_requestAccounts':
      case 'wallet_requestPermissions':
        state.permitted = true;
        return method === 'eth_requestAccounts'
          ? { result: [S2_ACCOUNT.address] }
          : { result: [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [S2_ACCOUNT.address] }] }] };
      case 'wallet_revokePermissions':
        state.permitted = false;
        return { result: null };
      case 'eth_accounts':
        return { result: state.permitted ? [S2_ACCOUNT.address] : [] };
      case 'eth_chainId':
        return { result: numberToHex(state.chainId) };
      case 'wallet_getCapabilities':
        return { result: {} };
      case 'wallet_switchEthereumChain': {
        const next = Number.parseInt(params?.[0]?.chainId, 16);
        if (!state.chains.has(next)) return fail(4902, 'Unrecognized chain ID');
        state.chainId = next;
        setTimeout(() => void emit('chainChanged', numberToHex(next)), 0);
        return { result: null };
      }
      case 'eth_getTransactionCount': {
        const counts = state.nonces[state.chainId] ?? { latest: 0, pending: 0 };
        return { result: numberToHex(BigInt(params?.[1] === 'pending' ? counts.pending : counts.latest)) };
      }
      case 'eth_getBalance':
        return { result: numberToHex(BigInt(state.native[state.chainId] ?? 0)) };
      case 'eth_call': {
        const [{ to, data }] = params;
        const token = state.tokens[`${state.chainId}:${lower(to)}`];
        const selector = lower(data).slice(0, 10);
        if (token && selector === '0x70a08231') return { result: word(token.balance ?? 0) };
        if (token && selector === '0x313ce567' && token.decimals !== undefined) return { result: word(token.decimals) };
        return { error: { code: 3, message: 'execution reverted', data: '0x' } };
      }
      case 'eth_sendTransaction':
        state.sends.push(params);
        return fail(4200, 'eth_sendTransaction is not supported by this test wallet');
      default:
        state.refused.push(method);
        return fail(4200, `${method} is not supported`);
    }
  }

  await context.exposeFunction('__s2WalletRequest', request);
  await context.addInitScript(() => {
    const listeners = new Map();
    const provider = {
      async request({ method, params }) {
        const reply = await window.__s2WalletRequest(method, params ?? []);
        if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code, data: reply.error.data });
        return reply.result;
      },
      on(event, listener) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(listener);
        return provider;
      },
      removeListener(event, listener) {
        listeners.get(event)?.delete(listener);
        return provider;
      },
    };
    Object.defineProperty(window, '__s2WalletEmit', {
      value: (event, payload) => {
        for (const listener of listeners.get(event) ?? []) listener(payload);
      },
    });
    const detail = Object.freeze({
      info: Object.freeze({ uuid: '8f2a7d1c-0000-4000-8000-000000000052', name: 'S2 Test Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E', rdns: 'test.wallet.s2' }),
      provider,
    });
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  });

  return {
    state,
    /** The wallet's user picks another network. */
    async switchChain(next) {
      state.chainId = next;
      await emit('chainChanged', numberToHex(next));
    },
    calls: (method) => state.log.filter((entry) => entry.method === method),
  };
}
