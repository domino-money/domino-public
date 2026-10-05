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
import { V2_METHODS, answerV2 } from './mock-wallet-v2.mjs';

const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
];
export const ACCOUNTS = KEYS.map((key) => privateKeyToAccount(key));

// Changed on purpose (2026-09-25): Review's Create position asks a connected wallet what it can batch (EIP-5792
// wallet_getCapabilities; docs/plans/2026-09-25-eip5792-batches-design.md), to offer one signature beside the steps.
// A read that opens nothing in the wallet; these wallets answer that they batch nothing, so every flow here is the steps.
// Changed on purpose (2026-10-01, audit C1, the owner's OK): a wallet that does not know Robinhood Chain is asked to add
// it (wallet_addEthereumChain), with the network's details fixed in src/wallet/chain.ts, before it switches.
const ALLOWED = new Set([
  'wallet_getCapabilities',
  'eth_requestAccounts',
  'eth_accounts',
  'eth_chainId',
  'personal_sign',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'wallet_requestPermissions',
  'wallet_revokePermissions',
  // Changed on purpose (2026-10-02, Domino V2 spec F7 §1.8): V2 signs EIP-712 typed data (src/finance/v2/typedData.ts), answered by mock-wallet-v2.mjs.
  'eth_signTypedData_v4',
]);

const DEFAULT_WALLETS = [
  { id: 'a', name: 'Test Wallet A', rdns: 'test.wallet.a', uuid: '8f2a7d1c-0000-4000-8000-00000000000a' },
  { id: 'b', name: 'Test Wallet B', rdns: 'test.wallet.b', uuid: '8f2a7d1c-0000-4000-8000-00000000000b' },
];

/**
 * Runs in the page before any of its scripts. Self-contained: no closures over Node.
 *
 * 2026-10-01 (the audit's wallet-compat scenarios, H5): a wallet may also be `legacy` (only window.ethereum, never
 * announced through EIP-6963) or announce itself `lateMs` after the page loads.
 */
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
          if (reply.error.data !== undefined) error.data = reply.error.data;
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
    if (wallet.legacy) {
      window.ethereum = provider;
      continue;
    }
    const detail = Object.freeze({ info: Object.freeze({ uuid: wallet.uuid, name: wallet.name, icon, rdns: wallet.rdns }), provider });
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    const start = () => {
      window.addEventListener('eip6963:requestProvider', announce);
      announce();
    };
    if (wallet.lateMs) setTimeout(start, wallet.lateMs);
    else start();
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
    wallets: new Map(wallets.map((wallet) => [wallet.id, { account: 0, chainId: 4663, permitted: false, ...wallet, chains: new Set(wallet.chains ?? [4663, 1]), reject: new Set(), added: [] }])),
    log: [],
    refused: [],
    signed: [],
    signedTyped: [],
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
    if (V2_METHODS.has(method)) return answerV2(wallet, ACCOUNTS[wallet.account], method, params, state);
    const account = ACCOUNTS[wallet.account];
    // A connection prompt the person never answers (hidden behind another window), or one already open (-32002).
    const asking = method === 'eth_requestAccounts' || method === 'wallet_requestPermissions';
    if (asking && wallet.connect === 'hang') return new Promise(() => {});
    // A prompt the person finds and approves later (fix round 1, 2026-10-01): held until the test calls approveHeld.
    if (asking && wallet.connect === 'held') {
      return new Promise((done) => {
        wallet.approve = () => {
          wallet.connect = undefined;
          done(request(id, method, params));
        };
      });
    }
    if (asking && wallet.connect === 'pending') return fail(-32002, `Request of type '${method}' already pending. Please wait.`);
    // A wallet that fails the request for a reason of its own, and says nothing more (no refusal, nothing waiting).
    if (asking && wallet.connect === 'broken') return fail(-32603, 'Internal JSON-RPC error.');
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
        if (wallet.revoke === 'unsupported') return fail(4200, 'The requested method is not supported by this Ethereum provider.');
        wallet.permitted = false;
        return { result: null };
      case 'wallet_addEthereumChain': {
        if (wallet.addError) return fail(wallet.addError, 'The wallet could not add the network.');
        const chainId = Number.parseInt(params[0].chainId, 16);
        wallet.added.push(params[0]);
        wallet.chains.add(chainId);
        // As MetaMask does: adding a network offers to switch to it, and the person accepts.
        if (wallet.addSwitches !== false) {
          wallet.chainId = chainId;
          if (!wallet.silentSwitch) setTimeout(() => emit(id, 'chainChanged', params[0].chainId), 0);
        }
        return { result: null };
      }
      case 'eth_accounts':
        return { result: wallet.permitted ? [account.address] : [] };
      case 'eth_chainId':
        return { result: `0x${wallet.chainId.toString(16)}` };
      case 'wallet_switchEthereumChain': {
        const chainId = Number.parseInt(params[0].chainId, 16);
        // A switch request already open in the wallet (-32002), or one the wallet fails for a reason of its own.
        if (wallet.switchError === 'pending') return fail(-32002, "Request of type 'wallet_switchEthereumChain' already pending. Please wait.");
        if (wallet.switchError === 'broken') return fail(-32603, 'Internal JSON-RPC error.');
        if (!wallet.chains.has(chainId)) {
          // MetaMask Mobile wraps its 4902 in a -32603 (data.originalError), as wagmi documents.
          if (wallet.switchError === 'wrapped') return { error: { code: -32603, message: 'Internal JSON-RPC error.', data: { originalError: { code: 4902, message: 'Unrecognized chain ID' } } } };
          return fail(4902, 'Unrecognized chain ID');
        }
        wallet.chainId = chainId;
        // Some wallets switch without saying so (no chainChanged event).
        if (!wallet.silentSwitch) setTimeout(() => emit(id, 'chainChanged', params[0].chainId), 0);
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
    /** The person approves, now, a connection prompt held open (`connect: 'held'`). */
    approveHeld(id) {
      const wallet = walletOf(id);
      if (!wallet.approve) throw new Error(`${id} holds no prompt`);
      const approve = wallet.approve;
      wallet.approve = null;
      approve();
    },
    /** What a wallet was asked to add, in order (wallet_addEthereumChain's parameters). */
    added: (id) => walletOf(id).added,
    wallet: walletOf,
    calls: (method) => state.log.filter((entry) => entry.method === method),
  };
}
