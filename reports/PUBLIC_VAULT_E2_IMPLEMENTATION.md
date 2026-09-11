# E2 owner-bound vault and factory — implementation evidence

11 September 2026 · [#86](https://github.com/domino-money/domino/issues/86)

Historical evidence for the originally approved #100 head. The later [#101 review follow-up](PUBLIC_VAULT_E2_REVIEW_FOLLOWUP.md) supersedes its receiver-dependent NFT exit behavior, mutable checkpoint preimage, callback/event details and runtime measurement. Original test counts and hashes below refer to #100, not the follow-up head.

Base: `b30f8b88838b3e118f951b26ebf7c4c9a55c1e9f`, the approved E1 #98 squash merge. Implementation branch: `codex/86-owner-vault`. This report describes a custody/recovery candidate, not a deployed or financially activated executor. The [E2 contract semantics](../docs/PUBLIC_VAULT_E2.md) document the actual ABI and owner recovery route.

## Delivered behavior

- [DominoVaultFactory](../contracts/src/DominoVaultFactory.sol) creates fixed-target EIP-1167 clones atomically for the caller's immutable owner identity. CREATE2 prediction includes owner and owner nonce; initialization failure rolls back deployment, root subscription and registration. The implementation is initialization-locked, and the factory has no upgrade/admin path.
- [DominoVault](../contracts/src/DominoVault.sol) binds the E1 sequence, original registration and source identities; checks full pool/range and individual root approval; subscribes to the wallet-held root and requires explicit owner rearm after lost continuity. Registration/rearm never credit earnings. Historical sources survive withdrawal or transfer.
- Policy and execution-limit versions, operator registration/revocation, pause/resume, membership and root transitions invalidate prior authority. Counter exhaustion blocks new authority without disabling owner recovery. Owner actions do not require an enabled operator.
- Owner-initiated child adoption proves actual NFT custody before registration. Source/currency/class-bound reserve withdrawals and child exits pay only the immutable owner, with no service cut. Donations stay outside the fee ledger; surplus native/pair currencies and unmanaged NFTs from the fixed PositionManager have bounded owner recovery.
- Protected original/converted credit sinks enforce ledger class, bounds and balance backing. **Backing alone is not earned-fee provenance.** These sinks are internal, unreachable from the public E2 ABI; only the synthetic test harness exposes artificial credits. E4/E7 must prove measured collection and conversion before invoking them.

There is no public compound, liquidity modification, mint, swap, external credit, signing or arbitrary-call method. The draft execution interface remains unimplemented. No API/schema/browser field, dependency, compiler configuration, activation flag, deployed service or personal-bot file changed.

## Acceptance evidence

| Area | Actual tests and boundary |
| --- | --- |
| Owner-bound creation | 15 [factory tests](../contracts/test/DominoVaultFactory.t.sol): two owners/multiple sequences, prediction domains, caller front-running, stale/skipped/exhausted nonces, CREATE2 collision, initialization replay, individual vs global approval, callback reentry, atomic failed-subscription rollback and identical retry, registry/event agreement. |
| Custody and exits | 38 [custody tests](../contracts/test/DominoVaultCustody.t.sol): real local native/ERC20/NFT transfers, owner/operator separation, independent policy/limit updates, root transfer away/back with unsubscribe callback suppressed, explicit rearm checkpoints, root burn, child withdrawal with historical reserve recovery, donations, wrong source/currency, unbacked credit rejection and withdrawal conservation fuzzing. |
| Failure and recovery | Receiver/token reentry and rejected native/NFT/false-return/reverting/taxed-token transfers roll back ledger, balances, custody and nonce. Tests exercise paused/root-invalid owner exits, actual exits with StateView code replaced by an unavailable reader, and terminal state/authority counters. Unsafe root/unknown/withdrawn NFT recovery cannot bypass managed-child accounting or change recipient. |
| Existing rules | Existing fee-accounting, policy and E1 encoding suites remain passing. These retain their synthetic scope and are not upgraded into live fee-provenance evidence by E2. |

The mocks implement the interfaces needed for these cases; they are not fork tests or proof that the currently deployed Robinhood managers behave identically. Test-only setters and artificial credit entry points live in the harness, not the production contract ABI.

## Verification run

Run in the isolated implementation checkout using repository-pinned tools:

```sh
npm run test:contracts
DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1 python -m unittest discover -s backend/tests -q
npm run check:repository
git diff --cached --check
```

- **90 Foundry tests passed, 0 failed, 0 skipped**, including 15 factory, 38 custody and 37 pre-existing tests. Fuzz cases use the repository's 512 runs.
- **3 contract-launcher regression tests passed**, 0 failed/skipped.
- **1,221 backend tests passed, 0 skipped**, with task-local PostgreSQL 18 and the pinned local Anvil EVM enabled; elapsed 154.428 seconds. The Python interpreter came from an existing compatible development venv; tested modules and fixtures came from this branch. This did not query a provider or use wallet credentials.
- Repository hygiene passed with **1,011 files checked and 0 findings**; the staged whitespace check also passed. Current-head CI is recorded in the PR. Local checks do not substitute for the independent financial review.

No live RPC, deployed-manager query, wallet signing, token funding, VM deployment or personal operation was used. The temporary PostgreSQL instance is local test infrastructure, not staging.

## Build identity and size

Pinned compiler: `0.8.26+commit.8a97fa7a`, optimizer 200, Cancun. Existing code-size limits/configuration remain unchanged.

| Artifact | Runtime bytes | Creation bytes | Source SHA-256 |
| --- | ---: | ---: | --- |
| `DominoVault` | 23,582 | 24,278 | `ac58c3d8ec3c7f6768e958a7f055689756d1b215d930e8c4a52c790bd19afe7d` |
| `DominoVaultFactory` | 2,535 | 27,694 | `ac194dd9afd4a8ff47e7d9884973664a8ae5dee209cd03887936eaf2148bcd36` |

Each clone has a 45-byte runtime. The vault leaves **994 bytes below EIP-170's 24,576-byte limit**. E4 must plan a reviewed split/refactor and remeasure a new immutable version before adding financial paths; simply appending compound/swaps is not a viable assumption. No size-limit bypass or upgrade mechanism is introduced.

## Review and remaining boundaries

An independent delegated source/code review verified the factory creation/identity path and vault custody/callback/recovery behavior. It found two trapped-asset cases: native ETH sent to an ERC20/ERC20 vault, and NFTs sent via unsafe `transferFrom`. Both were fixed with owner-only bounded recovery and regression tests. The reviewer reported no remaining blocking findings in that scope. This is not an external audit or native GitHub financial approval.

Callback assumptions were checked against official [v4-periphery](https://github.com/Uniswap/v4-periphery/tree/dce236d4e2057422d0791d9a973a58765eb46f65), including PositionManager/Notifier subscriber clearing and callback behavior. Exact sources are linked in the E2 semantics. This source pin **does not qualify Robinhood's deployed bytecode or token behavior**. A revoke/reapprove-only approval history cannot be reconstructed from current NFT reads; explicit pause/revoke/rearm controls are documented accordingly.

[#99](https://github.com/domino-money/domino/issues/99) preserves #98's derived-model, encoding-vector, receipt-local indexing, unique credit/lot lineage, shortfall and actual minimum-effect review follow-ups before their E3/E4/E5 integrations. E2 does not call the affected Python validators, and this report does not mark those follow-ups complete.

Independent financial review of this PR, deployed-manager/token qualification, actual collection/conversion proofs, planner/executor/receipt integrations, the public UI handoff and a real owner-recovery drill remain release dependencies under EX-01–EX-10. E2 alone does not close the public auto-compound/Domino release gates and must not receive production funds ahead of them.
