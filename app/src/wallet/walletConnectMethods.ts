/**
 * The wallet requests the page forwards to a phone's wallet over WalletConnect (2026-10-01, audit C3), and the session
 * asks the wallet to carry: the sign-in message, the transactions the money screens already offer (each reviewed in
 * the wallet before it is signed), the network switch, and the EIP-5792 batch requests. This module only names them;
 * WalletConnect's transport (./walletConnectProvider.ts, and ./walletConnectFake.ts in test builds) forwards what the
 * wallet port and the money clients ask, and composes nothing itself. Every other request is a read of the chain, which
 * is refused at once (lib/walletReads.ts readOnChain, RPC-SPEC D6: the site serves no read; a batch's simulation alone
 * goes to its fixed route, D7). tests/session.source-guard.test.mjs pins this list.
 *
 * Changed on purpose 2026-10-04 (rugged97's delta of 4 Oct §5, D15 for WalletConnect): eth_signTypedData_v4, the EIP-712
 * signature V2 asks in three places (the Permit2 witness, RelayedPositionAction, ExitMandate). finance/v2/typedData.ts
 * is still the only module that asks it; this list only forwards it to the phone's wallet, where it is reviewed.
 */
export const FORWARDED: readonly string[] = Object.freeze([
  'personal_sign',
  'eth_sendTransaction',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'wallet_getCapabilities',
  'wallet_sendCalls',
  'wallet_getCallsStatus',
  'eth_signTypedData_v4',
])
