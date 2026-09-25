/**
 * Browser wallets for the tests: EIP-1193 providers announced through
 * EIP-6963, backed by one Node-side state shared by every tab of a browser
 * context, the way a real extension is.
 *
 * Signing uses viem local accounts from the public anvil development keys.
 * They are published in every Foundry install, hold nothing on any real
 * network, and sign test sign-in messages only.
 *
 * Only the methods the app is allowed to use are answered. Anything else is
 * refused with 4200 and recorded, and the tests fail on any such record.
 */
import { hexToString } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
];
export const ACCOUNTS = KEYS.map((key) => privateKeyToAccount(key));

// Changed on purpose (2026-09-25): Review's Create position asks a connected wallet what it can batch (EIP-5792
// wallet_getCapabilities; docs/plans/2026-09-25-eip5792-batches-design.md), to offer one signature beside the steps.
// A read that opens nothing in the wallet; these wallets answer that they batch nothing, so every flow here is the steps.
const ALLOWED = new Set([
  'wallet_getCapabilities',
  'eth_requestAccounts',
  'eth_accounts',
  'eth_chainId',
  'personal_sign',
  'wallet_switchEthereumChain',
  'wallet_requestPermissions',
  'wallet_revokePermissions',
]);

const DEFAULT_WALLETS = [
  { id: 'a', name: 'Test Wallet A', rdns: 'test.wallet.a', uuid: '8f2a7d1c-0000-4000-8000-00000000000a' },
  { id: 'b', name: 'Test Wallet B', rdns: 'test.wallet.b', uuid: '8f2a7d1c-0000-4000-8000-00000000000b' },
];

/** Runs in the page before any of its scripts. Self-contained: no closures over Node. */
function inject(wallets) {
  const handlers = new Map();
  // A plausible EIP-6963 icon. The app must never use it as an image.
  const icon = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E';
  for (const wallet of wallets) {
    const events = new Map();
    handlers.set(wallet.id, events);
    const provider = {
      async request({ method, params }) {
        const reply = await window.__dominoWalletRequest(wallet.id, method, params ?? []);
        if (reply.error) {
          const error = new Error(reply.error.message);
          error.code = reply.error.code;
          throw error;
        }
        return reply.result;
      },
      on(event, listener) {
        if (!events.has(event)) events.set(event, new Set());
        events.get(event).add(listener);
        return provider;
      },
      removeListener(event, listener) {
        events.get(event)?.delete(listener);
        return provider;
      },
    };
    const detail = Object.freeze({ info: Object.freeze({ uuid: wallet.uuid, name: wallet.name, icon, rdns: wallet.rdns }), provider });
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  }
  Object.defineProperty(window, '__dominoWalletEmit', {
    value: (id, event, payload) => {
      for (const listener of handlers.get(id)?.get(event) ?? []) listener(payload);
    },
  });
  // Any CSP violation on any page is a test failure. Reported to Node at once,
  // so a reload cannot wipe the record.
  document.addEventListener('securitypolicyviolation', (event) => {
    window.__dominoCspViolation?.(`${event.violatedDirective} ${event.blockedURI}`);
  });
}

export async function installWallets(context, wallets = DEFAULT_WALLETS) {
  const state = {
    wallets: new Map(wallets.map((wallet) => [wallet.id, { ...wallet, account: 0, chainId: 4663, permitted: false, chains: new Set([4663, 1]), reject: new Set() }])),
    log: [],
    refused: [],
    signed: [],
    csp: [],
    beforeSign: null,
  };

  async function emit(id, event, payload) {
    for (const page of context.pages()) {
      await page.evaluate(([wallet, name, value]) => window.__dominoWalletEmit?.(wallet, name, value), [id, event, payload]).catch(() => {});
    }
  }

  async function request(id, method, params) {
    const wallet = state.wallets.get(id);
    state.log.push({ id, method, params });
    const fail = (code, message) => ({ error: { code, message } });
    if (!ALLOWED.has(method)) {
      state.refused.push(`${id}: ${method}`);
      return fail(4200, `${method} is not supported`);
    }
    if (wallet.reject.delete(method)) return fail(4001, 'User rejected the request.');
    const account = ACCOUNTS[wallet.account];
    switch (method) {
      case 'wallet_getCapabilities':
        return { result: {} };
      case 'eth_requestAccounts':
        wallet.permitted = true;
        return { result: [account.address] };
      case 'wallet_requestPermissions':
        wallet.permitted = true;
        return { result: [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [account.address] }] }] };
      case 'wallet_revokePermissions':
        wallet.permitted = false;
        return { result: null };
      case 'eth_accounts':
        return { result: wallet.permitted ? [account.address] : [] };
      case 'eth_chainId':
        return { result: `0x${wallet.chainId.toString(16)}` };
      case 'wallet_switchEthereumChain': {
        const chainId = Number.parseInt(params[0].chainId, 16);
        if (!wallet.chains.has(chainId)) return fail(4902, 'Unrecognized chain ID');
        wallet.chainId = chainId;
        setTimeout(() => emit(id, 'chainChanged', params[0].chainId), 0);
        return { result: null };
      }
      case 'personal_sign': {
        const [data, from] = params;
        if (!wallet.permitted || from.toLowerCase() !== account.address.toLowerCase()) return fail(4100, 'Unauthorized');
        await state.beforeSign?.();
        const signature = await account.signMessage({ message: { raw: data } });
        state.signed.push({ id, from, message: hexToString(data), signature });
        return { result: signature };
      }
    }
  }

  await context.exposeFunction('__dominoWalletRequest', request);
  await context.exposeFunction('__dominoCspViolation', (text) => state.csp.push(text));
  await context.addInitScript(inject, wallets);

  const walletOf = (id) => state.wallets.get(id);
  return {
    state,
    address: (index) => ACCOUNTS[index].address,
    /** The wallet's user picks another account; open pages hear about it. */
    async switchAccount(id, index, { silently = false } = {}) {
      const wallet = walletOf(id);
      wallet.account = index;
      if (!silently && wallet.permitted) await emit(id, 'accountsChanged', [ACCOUNTS[index].address]);
    },
    /**
     * The wallet's user connects this site from the wallet itself, with no
     * request from the page (MetaMask's "Connect to this site"): the wallet
     * grants access and tells the page its account.
     */
    async connectFromWallet(id) {
      const wallet = walletOf(id);
      wallet.permitted = true;
      await emit(id, 'accountsChanged', [ACCOUNTS[wallet.account].address]);
    },
    /** The wallet's user picks another network. */
    async switchChain(id, chainId) {
      walletOf(id).chainId = chainId;
      await emit(id, 'chainChanged', `0x${chainId.toString(16)}`);
    },
    forgetChain(id, chainId) {
      walletOf(id).chains.delete(chainId);
    },
    rejectNext(id, method) {
      walletOf(id).reject.add(method);
    },
    calls: (method) => state.log.filter((entry) => entry.method === method),
  };
}
