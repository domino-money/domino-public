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
- **Repository guards.** `wallet_sendCalls`, `wallet_getCallsStatus` and `wallet_getCapabilities` are allowed only in `finance/setup.ts`. Login and consumer code still refuse them. The financial bundle ceiling is raised by the minimum, measured on CI.

## Scope

1. **PR 1:** Create position's batch, for `supported` and as the offer for `ready`.
2. **PR 2:** the vault batch (the root NFT's approval and `createVault`) on the same machinery.

Out of scope:
- the advanced funding form, which stays step by step;
- the deposit-v1 lab, which has no wallet handoff;
- gas sponsorship (`paymasterService`), which is phase 3.
