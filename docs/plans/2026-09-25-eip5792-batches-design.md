# EIP-5792 batches for Create position (EIP-7702 phase 2)

Validated with the owner on 25 Sep 2026. Phase 1 (#212, #216) admitted
EIP-7702 accounts and asks before funding an unrecognized delegate. Phase 2
lets a wallet that can execute a batch atomically create a position with
**one signature**: exact approvals, the deposit, the assisted swap and the
mint. Today that takes 3 to 6. The case study measured the batch on a fork of
the deployed V1 contracts (E2, E2b) with no contract change.

## Who gets the batch

When Review shows Create position for a connected wallet, the app reads
`wallet_getCapabilities` for chain `0x1237` through that wallet, before any
press, because the offer below sits beside the steps. It is a read, and opens
nothing in the wallet:

| `atomic` status | Behavior |
| --- | --- |
| `supported`: the account is already a smart account | Create position sends the batch. Review shows one wallet step: approve, deposit and create the position. |
| `ready`: the wallet can upgrade the account, e.g. MetaMask on a plain EOA | Create position stays step by step. Beside it, **Sign all steps at once** says that the wallet will ask to turn on its smart account (EIP-7702), that the address stays the same and that the key stays in control. |
| Absent, `unsupported`, or the read fails | Today's flow. The batch is never mentioned. |

A wallet that refuses the batch as unsupported falls back to step by step on
its own. The phase-1 check of an unrecognized delegate runs first in every
path.

## Preparing the batch

- **Reads.** The reads of today, done once:
  - the deployment verified through the wallet;
  - the delegate check;
  - the native-ETH probe, since the mint pays back unused ETH;
  - balances and `depositPlan`;
  - allowances;
  - `nextOperationId(owner)`, the operation id the batch will open.

  `DominoSetup.open` accepts only that id. If anything opens an operation
  first, the whole batch reverts.
- **Calls, in order:**
  - an allowance reset to 0 where a short allowance exists;
  - the exact approval of each token, never unlimited;
  - `open(id, key, amount0, amount1)`, carrying the ETH as its value when token 0 is native;
  - `swap`, only for a one-token deposit;
  - `mint`.
- **Sizing without a step in between.**
  - The swap is sized from V4Quoter's quotes, as the one-token preflight does today (`sizeSwap` with `quoteWithin`, the assisted fee off the gross).
  - `minOutput` is the quote less the owner's slippage.
  - The mint is sized for the worst case, the swap paying exactly `minOutput`, at the price the quotes say the swap leaves, inside the owner's band.
  - Whatever the swap pays above the minimum returns with the mint, which closes the operation and refunds the rest.
- **Simulation.**
  - The whole batch is simulated with `eth_simulateV1` before the wallet is asked. State carries from one call to the next, and each call is from the owner, as the account's own execution is.
  - It goes through the wallet first, then through the chain's public RPC that the page already reads.
  - Both the public RPC and the own node answered it on 25 Sep.
  - If neither answers, the batch is not offered for that press.
- **Limits.** The batch's gas has the same room and ceiling as today's steps. The swap's and the mint's deadline is the signing window plus inclusion.

## Sending, tracking, confirming by effect

- **Send.** `wallet_sendCalls` with `version: '2.0.0'`, `chainId: '0x1237'`, `from: owner` and `atomicRequired: true`. The wallet returns a batch id.
- **Latch.** A latch like the nonce journal (localStorage with a cross-tab lock), keyed by owner and predicted operation id, keeps the batch id.
  - It is released on a wallet refusal (4001) or a batch the wallet did not include (400).
  - A lost answer keeps it.
  - The latch only avoids two prompts. The contract already refuses a second batch for the same id.
- **Track.** `wallet_getCallsStatus` every 2 s, for up to 5 minutes. Its receipts are informative only, because the envelope depends on how the wallet executed the batch: a 7702 self-call or a 4337 bundler.
- **Confirm by effect.** On status 200, read `operation(predicted id)`:
  - this owner's, closed, with a token id: the position exists, and Review shows it as today;
  - owner zero: the batch did not execute;
  - funded and not closed, which an atomic batch cannot leave: the held-deposit path that exists today (mint or refund).
- **Failures, each with its own sentence:**
  - 4001: declined in the wallet, nothing deposited.
  - 5750: the person declined turning on the smart account; step by step is offered.
  - 5760, 5700, 5710, 4200: the wallet cannot batch; step by step runs on its own.
  - 500: the batch reverted on chain; nothing was deposited, only gas was spent.
  - Wait exhausted: still waiting, nothing is sent twice, and the next press reads the chain first.

## Tests

- **Unit tests** against a wallet that speaks EIP-5792. They cover:
  - the capability matrix;
  - batch composition (reset and exact approvals, `open` with value, the swap only for one token, the mint in the worst case);
  - a simulation failure sending nothing;
  - the latch;
  - each status and each error code;
  - confirmation by effect.
- **Browser tests.** The finance suite's fake chain executes a batch atomically and rolls back on failure. Scenarios:
  - a smart account creates the position with one signature;
  - a `ready` wallet shows both choices with the notice;
  - a declined upgrade (5750) says so, and step by step still works;
  - a wallet without EIP-5792 keeps today's flow. The existing tests stay as they are.
- **EVM test** on Anvil with the prague hardfork: the real Setup and Uniswap v4 contracts, and the owner delegated to Simple7702Account's real code (`app/tests/support/eip7702-delegates.code.json`). The batch the app builds runs as the owner's own `executeBatch`: one transaction creates the position, including a one-token deposit with its swap, and the leftover returns. It follows `test_setup_sdk_evm.py`.
- **Mutation** on every guard of the batch.
- **Repository guards.** `wallet_sendCalls`, `wallet_getCallsStatus` and `wallet_getCapabilities` are allowed only in `finance/setup.ts`. Login and consumer code still refuse them. The financial bundle ceiling is raised by the minimum, measured on CI. PR 2 moved them to `finance/batch.ts`, which both clients share, and the guard follows.

## The vault batch (PR 2)

A sequence's creation takes two signatures today: the root NFT's approval to
the predicted clone, then `createVault`. PR 2 puts both into one batch, on the
same machinery. `finance/batch.ts` holds what both clients share: the
capability read, the whole-batch simulation, the offer behind the latch and the
wallet's status.

- **Calls.** `approve(predicted vault, root)` on the position manager, left out
  when the root is already approved to that vault, then
  `createVault(params, ownerNonce)` on the factory: paused, with the same
  policy, limits and fee consent as the steps.
- **Checks.** The same reads and guard as the step-by-step creation: root
  ownership, pool, range, the owner's next nonce and the approval. Then the
  batch is simulated whole, as for Create position, and its gas and the
  owner's ETH are checked against the budget.
- **Latch.** It is keyed by the sequence id the factory derives from the owner
  and the nonce. That id is the next one, so a batch found latched for it has
  created nothing yet, as far as the chain says. The next preparation asks
  the wallet once:
  - 400, 500 or 5730: the latch is freed;
  - pending, 200 on a node that is still behind, a failed read, or an answer
    that never came: `batch_already_offered`, and nothing is offered twice.
- **Confirming by effect.** The clone's code stands at the predicted address.
  `isVault` agrees, the vault is this owner's, and `vaultForSequence(id)`
  names it.
- **Screen.** As in Create position: the batch is the default for
  `supported`. For `ready`, **Sign both steps at once** sits beside the steps
  with the same note. A wallet that refuses the batch as unsupported, or a
  batch that neither the wallet nor the chain's RPC can simulate, goes step by
  step in the same press.
- **EVM test.** Prague, with the owner delegated to Simple7702Account's real
  code. The batch is one self-transaction that approves and creates, for the
  ERC-20 and the native pair. A lost answer and a batch the wallet still holds
  keep the latch; 400, 500 and 5730 free it. A review the chain moved under is
  refused before the wallet, and a batch sent again at a used nonce reverts
  whole.

## Scope

1. **PR 1 (#217):** Create position's batch, for `supported` and as the offer for `ready`.
2. **PR 2:** the vault batch (the root NFT's approval and `createVault`) on the same machinery.

Out of scope:
- the advanced funding form, which stays step by step;
- the deposit-v1 lab, which has no wallet handoff;
- gas sponsorship (`paymasterService`), phase 3, postponed on 25 Sep: no wallet in reach supported it on 4663 ([decision](2026-09-25-gas-sponsorship-design.md)).

## Audit, 28 Sep 2026: which wallets batch on 4663

The owner asked whether Rabby now supports EIP-7702, and for Review to show
fewer wallet steps whenever a wallet can batch.

**What the wallets do.**

| Wallet | EIP-5792 | EIP-7702 | On 4663 |
| --- | --- | --- | --- |
| Rabby (extension v0.94.10, 23 Sep 2026) | None: no `wallet_getCapabilities`, `wallet_sendCalls` or `wallet_getCallsStatus` handler in its provider controller. It answered -32601 on 25 Sep. | Detects delegations, and revokes them from its own approvals page. 4663 (`hood`) is in its revoke list. It refuses any 7702 transaction a site asks for (`'not support 7702'`). | Step by step. A Rabby account delegated elsewhere signs plain transactions, one per step. |
| MetaMask | Version 2: `atomic` `supported`/`ready`, EIP-7702 upgrade to its EIP7702StatelessDeleGator. | Upgrades accounts only on the networks it lists. Its help centre does not list Robinhood Chain; its Smart Accounts Kit 2.0.0 lists it, and the delegator's code is on 4663. | Not measured: the probe says. |
| Base Account / Coinbase | Version 2 for the smart wallet. | EIP7702Proxy, whose code is on 4663. | Base Account does not list 4663. |
| Ambire | Version 2, with version 1's `atomicBatch` beside `atomic`. One hex key for every network it knows, user-added ones included. The chain filter is ignored. | EOA7702 accounts always say `supported`. AmbireAccount7702's code is on 4663. | Can batch if Robinhood Chain is added to it: the probe says. |
| OKX | Closed source. | Upgrade from its own app menu. | Not measured: the probe says. |

No wallet batches through anything but EIP-5792. A 7702 account could run a
batch as one transaction to itself (`executeBatch` on its own delegate), but
that depends on each delegate's ABI. MetaMask refuses a site's transaction to
the user's own account with data, and no wallet shows such a call clearly.
It is not built.

**What changed in the app (feat/eip7702).**

- `atomicStatusOf` reads the reply under any key that names 4663: hex in
  either case, a leading zero, or decimal, as viem's `getCapabilities` reads
  keys (`Number(key)`).
- With no `atomic` there, it reads `0x0`, which EIP-5792 reserves for
  capabilities on every chain.
- Two keys that disagree count as the weaker. Version 1's shape stays
  unsupported.
- A wallet that refuses the chain filter (-32602) is asked once more without
  it, within the same five seconds.
- Review's list of wallet steps is one step before the press for a
  `supported` wallet. The step is named after what it holds: "Approve,
  deposit, swap and create the position", without "Approve" when only ETH goes
  in. Before, the list showed every step until the press ran.
- `ready` keeps the steps and the offer. The offer's note no longer says
  "(EIP-7702)" (beginner first).
- A latch the wallet never settled is freed 25 minutes after its claim. That
  covers an answer that never came and an error other than a refusal (-32603,
  say). Before, it held every later press of a `supported` wallet for good,
  each ending "could not be read".
  - Why it is safe: the batch ends with the mint, and the contract refuses a
    deadline more than 1,200 s past the block. The batch was simulated whole
    against the newest block just before it was offered. So 1,200 s after the
    claim, nothing of it can execute; `BATCH_LATCH_EXPIRY_S` adds five minutes.
  - The claim time sits beside the latch (`domino.offered-batch-at.v1.<hash>`).
    A latch from before this change starts its clock when first found.
- The finance suite covers `0x0`, a decimal `ready`, a Rabby-shaped wallet
  (-32601) on a delegated account, and a latch that is still live and one
  that has expired.

**Fewer steps for Rabby needs a contract change.** The setup contract has no
multicall, so without a batch the deposit, the swap and the mint stay separate
transactions. Two ways to shorten them, both owner decisions for the
contracts:

- one entry point that opens, swaps and mints in one call (approve + 1);
- Permit2 signatures, where the approvals become free signatures.

**Measuring.** `C:/dwt/eip7702/probe.js` reads a connected wallet and sends
nothing: `eth_accounts`, `eth_chainId`, `eth_getCode`, `wallet_getCapabilities`,
and `wallet_getCallsStatus` for an id that does not exist, to see whether the
method exists. It then says what the site will do with that wallet.

Sources: [EIP-5792](https://eips.ethereum.org/EIPS/eip-5792);
[Rabby's provider controller](https://github.com/RabbyHub/Rabby/blob/develop/src/background/controller/provider/controller.ts)
and [its 7702 revoke chains](https://github.com/RabbyHub/Rabby/blob/develop/src/constant/eip7702.ts);
[Rabby #3102](https://github.com/RabbyHub/Rabby/issues/3102);
[MetaMask batches](https://docs.metamask.io/wallet/how-to/send-transactions/send-batch-transactions/);
[MetaMask's refusal of data to an own account](https://github.com/MetaMask/core/blob/main/packages/transaction-controller/src/utils/validation.ts);
[MetaMask smart account networks](https://support.metamask.io/configure/accounts/switch-to-or-revert-from-a-smart-account/);
[Smart Accounts Kit networks](https://docs.metamask.io/smart-accounts-kit/get-started/supported-networks/);
[Ambire's capabilities](https://github.com/AmbireTech/extension/blob/main/src/common/modules/provider/ProviderController.ts);
[OKX 7702](https://web3.okx.com/help/okx-wallet-to-support-eip-7702).
