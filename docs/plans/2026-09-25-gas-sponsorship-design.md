# Gas sponsorship (EIP-7702 phase 3): postponed

Decided with the owner on 25 Sep 2026, after measuring. Phases 1 and 2
admitted EIP-7702 accounts (#212, #216) and let a wallet that batches
atomically create a position (#217) and a sequence (#221) with one signature
([design](2026-09-25-eip5792-batches-design.md)). Phase 3 would have let Domino
pay that batch's gas.

## What phase 3 was

The app passes a paymaster web service URL in `wallet_sendCalls`
(`paymasterService`, ERC-7677). The wallet asks that service to pay for the
batch it submits as an ERC-4337 UserOperation. The case study rated this
optional: onboarding gas costs about US$ 0.22 on 4663, so the value is in
admitting people who hold no ETH, not in saving it.

## Why it is postponed

Sponsorship works only in a wallet that implements `paymasterService` on 4663.
On 25 Sep none in reach did.

- **The owner's wallets, measured on domino.money** with the read-only script
  below:

  | Wallet | Account | `wallet_getCapabilities` |
  | --- | --- | --- |
  | Rabby | plain EOA | -32601, no handler |
  | Keplr | plain EOA | 4200, unsupported method |
  | Ronin | plain EOA | -32600, unsupported method |
  | Phantom | plain EOA | -32601, does not exist |
  | Compass | — | no answer |

  None of them supports EIP-5792 at all.
- **MetaMask** documents only the `atomic` capability for `wallet_sendCalls`.
  Its own gas sponsorship is paid by MetaMask on Monad, SEI and Solana, and
  dapps cannot configure it. The networks it lists for batches do not include
  4663.
- **Coinbase Smart Wallet**, the reference ERC-7677 wallet, does not list 4663.
- **The providers are ready.** Pimlico and Alchemy offer paymasters on 4663
  (`reports/gas-funding-2026-09-21/ECOSYSTEM.md`). The wallets are what is
  missing.

A paymaster built now would reach almost no one. It would still cost a paid
provider account and a public endpoint that spends Domino's budget.

## What this says about phase 2

Every wallet measured is answered with the step-by-step flow, as designed:
`atomicStatus` treats any error, Ronin's -32600 included, as `unsupported`.
The one-signature path reaches wallets that implement EIP-5792 on 4663.
MetaMask was not measured.

## When to resume

- A wallet used on 4663 answers `wallet_getCapabilities` for `0x1237` with
  `paymasterService: { supported: true }`. The script below measures it.
- Or the owner decides to admit people without ETH another way, such as a
  small ETH drop to admitted accounts. That is a separate design: a hot wallet,
  a budget and abuse controls.

When it resumes, the shape discussed was:

- a Worker route that forwards ERC-7677 `pm_getPaymasterStubData` and
  `pm_getPaymasterData` to Pimlico or Alchemy, holding the provider key as a
  secret;
- a policy that sponsors only Domino's calls (the setup contract, the factory,
  and the root NFT's approval), with limits per account;
- the URL offered only to a wallet that announces `paymasterService` for
  `0x1237`, from `offerBatch` in `app/src/finance/batch.ts`.

Costs follow the gas-funding study: Pimlico charges 10% over the EntryPoint's
`actualGasCost` plus API credits, and Alchemy 8%.

## Measuring again

Open https://domino.money with the wallets installed, open the console, and
paste this. It reads only: `eth_accounts` (and a connection request for a
wallet not yet connected), `wallet_getCapabilities`, and `eth_getCode` from
the chain's public RPC. It sends nothing, asks for no signature and prints
shortened addresses.

```js
(async () => {
  const CHAIN = '0x1237', RPC = 'https://rpc.mainnet.chain.robinhood.com';
  const within = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) =>
    setTimeout(() => reject(Object.assign(new Error(`${label}: no answer in ${ms / 1000} s`), { code: 'timeout' })), ms))]);
  const found = [], onAnnounce = (event) => {
    if (!found.some((f) => f.info.uuid === event.detail.info.uuid)) found.push(event.detail);
  };
  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  window.removeEventListener('eip6963:announceProvider', onAnnounce);
  if (!found.length && window.ethereum) found.push({ info: { name: 'window.ethereum', rdns: 'legacy' }, provider: window.ethereum });
  console.log(`Wallets found: ${found.map(({ info }) => info.name).join(', ') || 'none'}`);
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '(none)');
  const codeOf = async (account) => {
    const { result: code } = await within(fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [account, 'latest'] }) }).then((r) => r.json()), 10000, 'eth_getCode');
    if (code === '0x') return 'plain EOA';
    if (typeof code === 'string' && code.length === 48 && code.startsWith('0xef0100')) return `7702 -> 0x${code.slice(8)}`;
    return `code, ${(String(code).length - 2) / 2} bytes`;
  };
  const rows = [];
  for (const { info, provider } of found) {
    const row = { wallet: `${info.name} (${info.rdns})` };
    const step = (text) => console.log(`${info.name}: ${text}`);
    try {
      step('reading the connected account');
      let [account] = await within(provider.request({ method: 'eth_accounts' }), 10000, 'eth_accounts');
      if (!account) {
        step('asking to connect: approve or reject in the wallet (60 s)');
        [account] = await within(provider.request({ method: 'eth_requestAccounts' }), 60000, 'eth_requestAccounts');
      }
      row.account = short(account);
      step(`account ${row.account}: reading its code on 4663`);
      row.onChain = await codeOf(account).catch((e) => `read failed: ${e.message}`);
      step('wallet_getCapabilities for 0x1237');
      try {
        const here = (await within(provider.request({ method: 'wallet_getCapabilities', params: [account, [CHAIN]] }), 15000, 'wallet_getCapabilities'))?.[CHAIN] ?? {};
        row.atomic = here.atomic?.status ?? '(absent)';
        row.paymasterService = here.paymasterService?.supported ?? '(absent)';
        row.capabilities4663 = JSON.stringify(here);
      } catch (e) { row.capabilities4663 = `error ${e.code}: ${e.message}`; }
      step('wallet_getCapabilities for every chain');
      try {
        row.chainsReported = Object.keys((await within(provider.request({ method: 'wallet_getCapabilities', params: [account] }), 15000, 'wallet_getCapabilities')) ?? {}).join(' ');
      } catch (e) { row.chainsReported = `error ${e.code}: ${e.message}`; }
    } catch (e) { row.error = `${e.code}: ${e.message}`; }
    console.log(`${info.name}: done`, row);
    rows.push(row);
  }
  console.table(rows);
  const json = JSON.stringify(rows, null, 1);
  if (typeof copy === 'function') copy(json);
  console.log(json);
})();
```

## Sources

- [ERC-7677: Paymaster Web Service Capability](https://eips.ethereum.org/EIPS/eip-7677)
- [MetaMask: send batch transactions](https://docs.metamask.io/wallet/how-to/send-transactions/send-batch-transactions/)
- [MetaMask: understanding gas sponsorship](https://support.metamask.io/manage-crypto/transactions/gas-sponsorship/)
- [ERC-7677 wallets](https://www.erc7677.xyz/ecosystem/wallets)
- `reports/gas-funding-2026-09-21/ECOSYSTEM.md` and `ECONOMICS.md`
