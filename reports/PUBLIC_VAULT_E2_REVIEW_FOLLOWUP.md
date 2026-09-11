# E2 review follow-up — recovery and verifiable authority

11 September 2026 · [#101](https://github.com/domino-money/domino/issues/101)

OxDecimal [approved #100](https://github.com/domino-money/domino/pull/100#pullrequestreview-5182910940) at `b78f5b4fc09e888afdb5b9d5813fbf33c4137aca`, with no blockers and fourteen nonblocking notes. That exact head had all four required CI checks and was squash-merged as `d814545c3c8fb141604a091ecafdd95fa22ab418`. That #101 follow-up received its own [independent approval in #103](https://github.com/domino-money/domino/pull/103#pullrequestreview-5183132095); the #100 approval was not reused for new code. The #104 refinement below adds tests/documentation without changing the approved production implementation.

## Review disposition

| #100 note | Disposition in #101 |
| --- | --- |
| 1 — unsubscribe during owner callback | The pinned manager may now invalidate authority during an owner exit, except within the explicit subscribe/rearm transition. This path only removes authority, with no external calls. A native exit plus a separately requested root unsubscribe causes two nonce advances and one generation advance. Missing/out-of-gas notifications still cannot guarantee cached state/events; live `rootPermissionValid()` remains authoritative. |
| 2 — notification gas and mock fidelity | Test the cold clone notification with a conservative 100,000-gas acceptance budget and represent the upstream outer gas guard/pool lock. Require deployed `unsubscribeGasLimit >= 100000` plus actual pinned-manager reproduction before qualification. The synthetic budget is not a claimed minimum or a live deployment measurement; mock modify hooks remain test helpers. |
| 3 — root rescue event | Emit `RootInvalidated(4, generation, stateNonce)` after the rescue's generation update. Reuse its one nonce advance; a failed transfer rolls back the event with the operation. |
| 4 — initial checkpoint preimage | Store `registrationCheckpoint(tokenId)` once at registration; `checkpoint(tokenId)` remains the latest rearm observation. Original identities and sources are unchanged. Independently recompute the original commitment after multiple rearms. |
| 5 — manual collection / future self-modification | Document that manual fee-only collection or liquidity changes disarm the root. E4 must implement a narrow expected-modify context before its own root changes; current modify/burn callbacks still reject entered calls. |
| 6 — owner without ERC721 receiver | Both managed and unmanaged PositionManager NFT exits use owner-requested `transferFrom` to the immutable owner and verify actual resulting holder. A rejecting or absent owner receiver no longer traps its NFT. Adoption still uses a safe transfer into the vault. |
| 7 — taxed/rounding pair-token surplus | Retain exact debit/credit semantics, including untracked pair-token recovery, and exercise rejection with the transfer fee left enabled. Relaxing issuer/rounding behavior is a separate asset-support decision; no silently broadened token admission. |
| 8 — foreign assets | Clarify the target is the pinned PositionManager, not arbitrary NFT collections. Native/pair-token and PositionManager-only recovery remain the explicit boundary. Generic foreign-token/NFT rescue is not implemented. |
| 9 — initial operator | E1 explicitly permits a disabled zero operator and owner-direct authority. Preserve it, omit a zero-to-zero `OperatorChanged`, and test initialization plus owner validation. Additional owner/vault address exclusions were not adopted: no new authority is gained and E1 does not require them. |
| 10 — owner-only evidence | #101 added exact errors and owner positive controls but revoked the operator too early for several checks. The #103 review identified that fixture gap; #104 strengthens it to require an enabled current operator and a distinct non-operator for every helper call. |
| 11 — initialization guards | Cover actual exact error selectors, failed clone/registry/nonce rollback and preserved subscription state. A pre-existing foreign subscriber must remain foreign after rejection, rather than be incorrectly asserted zero. |
| 12 — E1 parity | Independently rebuild sequence, signed-tick core/position, source and checkpoint hashes. Document that reconstructing an E1 policy hash must restore immutable base/quote fields omitted from the E2 limits getter. |
| 13 — transition coverage | Add successful operator/authority controls, nonce assertions, terminal surplus/NFT/pause recovery and `TerminalRecovery` event evidence, and zero-withdrawal rejection. |
| 14 — approval history | Carry the unobserved revoke/reapprove limitation into E4/E5. Require live permission/expiry/version checks and explicit vault revocation epochs; never claim current approval, events, permit bitmap or an expired historical observation detects every external history change. |

## Contract semantics and implementation scope

The production delta is in [DominoVault.sol](../contracts/src/DominoVault.sol). Factory source and immutable target mechanism are unchanged. The new checkpoint getter is an additive candidate ABI change; there is no deployed upgrade or storage migration. All assets still leave only on the fixed owner's instruction and to that owner. No operator asset-withdrawal power, external credit, swap, mint, arbitrary call or financial activation was added.

Native/token receiver reentry cannot spend another balance or NFT. An owner may separately remove root authority during native receipt, and that reduction has its own counter/event transition. Consequently multiple receipts in a transaction can report the same final state nonce; E5 must use receipt-local identity/order and actual state, not treat nonce as a unique receipt key. Native ETH still requires a payable owner; the NFT change does not promise recovery to an immutable rejecting native receiver.

The [current E2 documentation](../docs/PUBLIC_VAULT_E2.md) includes owner instructions, exact callback limitations and the chain-4663 manager qualification checklist. The delivery plan and E1 handoff carry expected-modify, orientation-reconstruction and approval-history requirements forward. No frontend/API fields, activation flags, dependency versions, compiler settings, VM services or personal-bot files changed.

## Verification

### #104 test and documentation refinement

OxDecimal approved #103 at `e94ef193ea89d59b341424cf0068cfc82054c783`; it was integrated as `7b533e02274ddb30f8d52b5fdc7b8a7de8befea4` with its four passing CI checks. The six new nonblocking notes concern test evidence and documentation. #104 leaves every production contract and the published hashes below unchanged.

- Current-operator negatives must actually use an enabled operator on every call; the helper requires that precondition and a distinct non-operator. Rotation/revocation run last, with the current address reread after rotation. The old fixture gap is acknowledged in row 10 above.
- Nested unsubscribe receipts explicitly carry the same final N+2, with `RootInvalidated` emitted first. There is no event for the intermediate N+1. Tests inspect full fields and receipt order rather than infer mutation order from a nonce.
- Entered-state modify/burn callbacks must fail with `UnexpectedCallback` while the native withdrawal succeeds and root ownership/subscription/authority remain intact. The mock retains raw revert bytes to distinguish this guard from an earlier authorization/lock failure.
- Manager-origin reentry is rejected by `Unauthorized`; actual owner reentry from a native receipt into child withdrawal is rejected by `ReentrantCall`. Evidence identifies the guard that was reached.
- Root rescue is exercised after a delivered transfer invalidation and at terminal authority generation. Reason 4 is unconditional on a successful rescue; `TerminalRecovery` carries entry counters, whereas subsequent invalidation/recovery events carry resulting counters.
- The 13,909-gas value below is explicitly a historical local #103 measurement. CI proves the 100k acceptance budget. No workflow, compiler, size limit or production behavior was changed to produce extra logs.

The combined `npm run test:contracts` run passed **122 Foundry tests, 0 failed, 0 skipped**: 55 custody, 30 factory and 37 policy/fee/E1-encoding tests. The **3 launcher regressions** passed; fuzz cases use 512 runs. Repository hygiene checked **1,012 files with 0 findings**, and the whitespace check passed. A delegated read-only review of the test delta found no remaining findings; it is not native approval or a new production audit.

Five temporary production mutations were each compiled successfully, then rejected by the intended new assertion. Each run returned exit code 1; the production file was restored byte-for-byte to the published SHA-256 after every run. No mutation or raw log is included in the branch.

| Temporary mutation | Focused custody test | Assertion that failed |
| --- | --- | --- |
| Broaden `adoptChild` to owner-or-operator | `testEveryOwnerOnlyGuardHasValidStateAndSuccessfulOwnerControl` | `operator did not fail specifically at owner guard` |
| Broaden `withdrawChildPosition` to owner-or-operator | `testEveryOwnerOnlyGuardHasValidStateAndSuccessfulOwnerControl` | `operator did not fail specifically at owner guard` |
| Remove entered guard from `notifyModifyLiquidity` | `testNativeOwnerModifyCallbackRejectedWhileWithdrawalCompletes` | `entered root callback did not fail specifically at callback guard` |
| Remove entered guard from `notifyBurn` | `testNativeOwnerBurnCallbackRejectedWhileWithdrawalCompletes` | `entered root callback did not fail specifically at callback guard` |
| Remove child withdrawal `nonReentrant` | `testNativeOwnerChildExitReentryFailsAtReentrancyGuard` | `owner child exit did not fail specifically at reentrancy guard` |

Each mutant used `node scripts/test-contracts.mjs --match-contract DominoVaultCustodyTest --match-test <exact test name above> -vv`. These are bounded local mutation checks, not a general mutation-coverage claim. The restored-source custody run then passed all 55 tests, followed by the combined suite above.

The backend is unchanged, so the prior local PostgreSQL/EVM evidence below is reused instead of repeating that suite locally; required current-head CI still runs all checks. The follow-up PR records that CI run separately, without treating the historical #103 approval as approval of these new assertions.

### Historical #101 verification

The combined `npm run test:contracts` run passed **116 Foundry tests, 0 failed, 0 skipped**: 49 custody, 30 factory and 37 existing policy/fee/E1-encoding tests. Its **3 launcher regressions** also passed. Fuzz cases use 512 runs. Both delegated test changes were integrated before this run; the first local smoke run exposed the three old receiver-dependent expectations, which were replaced with the intended receiver-independent recovery assertions and manager-failure/reentry coverage.

The cold-clone callback test forwards 100,000 gas. The author measured a 13,909-gas call locally for the #103 synthetic custody harness; this historical local figure is not printed by CI. CI establishes success within the 100k budget, not the exact measurement. The accepted budget is deliberately conservative; this is not an exact production/deployment gas benchmark. Tests separately exercise the manager's outer gas guard and an insufficient 1,000-gas notification that leaves the cached flag stale while live permission fails closed.

The full backend suite passed **1,221 tests in 153.061 seconds, 0 skipped**, with task-local PostgreSQL and the pinned Anvil EVM enabled. The temporary database was stopped afterward. No live RPC, operator signer, private wallet or staging service was used. The prior #100 evidence remains historical in [its report](PUBLIC_VAULT_E2_IMPLEMENTATION.md).

Repository hygiene passed with **1,012 files checked, 0 findings**; the staged whitespace check passed. Current-head GitHub checks and the independent review request are recorded in the follow-up PR. No local test/delegated review is described as native approval or an external audit.

## Local build measurement

Pinned solc `0.8.26+commit.8a97fa7a`, optimizer 200, Cancun, bytecode hash disabled by the existing configuration:

| Artifact | Runtime bytes | Creation bytes | Source SHA-256 |
| --- | ---: | ---: | --- |
| `DominoVault` | 24,113 | 24,809 | `9c1ef47e76368b073c64fc6f37f1ca25696c221da82dce51e509cbbdd438e9ed` |
| `DominoVaultFactory` | 2,535 | 28,225 | `ac194dd9afd4a8ff47e7d9884973664a8ae5dee209cd03887936eaf2148bcd36` |

The vault leaves **463 bytes** below EIP-170. Each clone remains 45 bytes. These are local artifact measurements, not numbers printed by the existing CI workflow. E4 requires a reviewed refactor/new immutable implementation before financial paths; the limit was not raised and no upgrade backdoor was added.

An independent delegated reviewer checked this exact production source delta and matching artifacts, with no remaining material findings. This is not native GitHub approval, an external audit, deployed-manager/token qualification or permission to fund the contract. EX release gates and all public financial execution dependencies remain open.
