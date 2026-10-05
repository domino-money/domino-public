/**
 * Domino V2's side of the test wallets (spec F7 §1.8 last row, §7.5): EIP-712 signatures and EIP-5792 capabilities per
 * chain. tests/support/mock-wallet.mjs hands every allowed request for one of V2_METHODS to `answerV2` (after its own
 * permission and next-refusal checks) and answers the rest itself.
 *
 * What a test wallet may declare for V2, beside mock-wallet.mjs's own fields:
 *   - `chains: [4663, 8453, 42161]`: the chains it knows (V2_WALLET_CHAINS). The default stays [4663, 1], so a wallet
 *     that declares nothing still refuses Base and Arbitrum with 4902, as before.
 *   - `capabilities: { '0x2105': { atomic: { status: 'supported' } } }`: what wallet_getCapabilities answers, keyed by
 *     hex chain id. A wallet that declares none answers {} for every chain (today's behaviour: it batches nothing).
 *
 * Signing uses the same public anvil development keys as mock-wallet.mjs: they hold nothing on any real network, and
 * what they sign here is test typed data that no contract on any chain will ever see.
 */

/** The chains a V2 test wallet knows: Robinhood Chain, Base and Arbitrum One. */
export const V2_WALLET_CHAINS = Object.freeze([4663, 8453, 42161]);

/** The methods `answerV2` answers (always, with a result or an error); mock-wallet.mjs answers every other one. */
export const V2_METHODS = new Set(['eth_signTypedData_v4', 'wallet_getCapabilities']);

const fail = (code, message) => ({ error: { code, message } });
const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** A chain id as a wallet may write it (number, decimal or hex string), as a number; NaN when it is none. */
function chainNumber(value) {
  try {
    if (typeof value === 'number') return Number.isSafeInteger(value) ? value : Number.NaN;
    if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) return Number(BigInt(value));
  } catch {
    // Falls through to NaN.
  }
  return Number.NaN;
}

/**
 * eth_signTypedData_v4 as MetaMask answers it: params `[from, typedDataJson]`. Refused with 4100 unless the site is
 * permitted and `from` is the wallet's account; refused when the typed data's `domain.chainId` is not the wallet's
 * current chain (MetaMask's own check, in its words); otherwise signed by the account, EIP712Domain derived from the
 * domain as wallets do, and recorded in `state.signedTyped`.
 */
async function signTypedData(wallet, account, params, state) {
  const [from, raw] = Array.isArray(params) ? params : [];
  if (!wallet.permitted || !sameAddress(from, account.address)) return fail(4100, 'Unauthorized');
  let typed;
  try {
    typed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return fail(-32602, 'Invalid typed data: not JSON.');
  }
  if (!typed || typeof typed !== 'object' || typeof typed.types !== 'object' || typeof typed.primaryType !== 'string' || typeof typed.domain !== 'object' || typeof typed.message !== 'object') {
    return fail(-32602, 'Invalid typed data.');
  }
  if (typed.domain.chainId !== undefined && typed.domain.chainId !== null) {
    const asked = chainNumber(typed.domain.chainId);
    if (asked !== wallet.chainId) return fail(-32603, `Provided chainId "${String(typed.domain.chainId)}" must match the active chainId "${wallet.chainId}"`);
  }
  await state.beforeSign?.();
  const { EIP712Domain: _domain, ...types } = typed.types;
  void _domain;
  const signature = await account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message });
  state.signedTyped.push({ id: wallet.id, from, primaryType: typed.primaryType, domain: typed.domain, message: typed.message, signature });
  return { result: signature };
}

/**
 * wallet_getCapabilities (EIP-5792): params `[address, chainIds?]`. A wallet that declares no capabilities answers {}
 * (today's behaviour, whatever is asked). One that declares some answers for the permitted account only (4100
 * otherwise), and only the chains the request names, keyed by lowercase hex chain id; every declared chain when it
 * names none.
 */
function capabilities(wallet, account, params) {
  if (!wallet.capabilities) return { result: {} };
  const [owner, asked] = Array.isArray(params) ? params : [];
  if (!wallet.permitted || !sameAddress(owner, account.address)) return fail(4100, 'Unauthorized');
  const declared = new Map(Object.entries(wallet.capabilities).map(([key, value]) => [chainNumber(key), value]));
  const wanted = Array.isArray(asked) ? asked.map(chainNumber) : [...declared.keys()];
  const result = {};
  for (const chainId of wanted) {
    if (declared.has(chainId)) result[`0x${chainId.toString(16)}`] = declared.get(chainId);
  }
  return { result };
}

/**
 * The V2 answer to one request, or undefined when the method is not one V2 changes (mock-wallet.mjs answers it then).
 * `wallet` is mock-wallet.mjs's wallet state, `account` its current viem account, `state` the shared state.
 */
export async function answerV2(wallet, account, method, params, state) {
  switch (method) {
    case 'eth_signTypedData_v4':
      return signTypedData(wallet, account, params, state);
    case 'wallet_getCapabilities':
      return capabilities(wallet, account, params);
    default:
      return undefined;
  }
}
