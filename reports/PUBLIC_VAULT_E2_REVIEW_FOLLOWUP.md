# E2 review follow-up — recovery and verifiable authority

11 September 2026 · [#101](https://github.com/domino-money/domino/issues/101)

OxDecimal [approved #100](https://github.com/domino-money/domino/pull/100#pullrequestreview-5182910940) at `b78f5b4fc09e888afdb5b9d5813fbf33c4137aca`, with no blockers and fourteen nonblocking notes. That exact head had all four required CI checks and was squash-merged as `d814545c3c8fb141604a091ecafdd95fa22ab418`. This follow-up is based on that merge and requires a new independent financial review. The original approval is not reused for the new code.

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
| 10 — owner-only evidence | Test exact `Unauthorized` errors from operator/stranger in valid operation states, then successful owner positive controls, including adoption, child exit and resume. |
| 11 — initialization guards | Cover actual exact error selectors, failed clone/registry/nonce rollback and preserved subscription state. A pre-existing foreign subscriber must remain foreign after rejection, rather than be incorrectly asserted zero. |
| 12 — E1 parity | Independently rebuild sequence, signed-tick core/position, source and checkpoint hashes. Document that reconstructing an E1 policy hash must restore immutable base/quote fields omitted from the E2 limits getter. |
| 13 — transition coverage | Add successful operator/authority controls, nonce assertions, terminal surplus/NFT/pause recovery and `TerminalRecovery` event evidence, and zero-withdrawal rejection. |
| 14 — approval history | Carry the unobserved revoke/reapprove limitation into E4/E5. Require live permission/expiry/version checks and explicit vault revocation epochs; never claim current approval, events, permit bitmap or an expired historical observation detects every external history change. |

## Contract semantics and implementation scope

The production delta is in [DominoVault.sol](../contracts/src/DominoVault.sol). Factory source and immutable target mechanism are unchanged. The new checkpoint getter is an additive candidate ABI change; there is no deployed upgrade or storage migration. All assets still leave only on the fixed owner's instruction and to that owner. No operator asset-withdrawal power, external credit, swap, mint, arbitrary call or financial activation was added.

Native/token receiver reentry cannot spend another balance or NFT. An owner may separately remove root authority during native receipt, and that reduction has its own counter/event transition. Consequently multiple receipts in a transaction can report the same final state nonce; E5 must use receipt-local identity/order and actual state, not treat nonce as a unique receipt key. Native ETH still requires a payable owner; the NFT change does not promise recovery to an immutable rejecting native receiver.

The [current E2 documentation](../docs/PUBLIC_VAULT_E2.md) includes owner instructions, exact callback limitations and the chain-4663 manager qualification checklist. The delivery plan and E1 handoff carry expected-modify, orientation-reconstruction and approval-history requirements forward. No frontend/API fields, activation flags, dependency versions, compiler settings, VM services or personal-bot files changed.

## Verification

The combined `npm run test:contracts` run passed **116 Foundry tests, 0 failed, 0 skipped**: 49 custody, 30 factory and 37 existing policy/fee/E1-encoding tests. Its **3 launcher regressions** also passed. Fuzz cases use 512 runs. Both delegated test changes were integrated before this run; the first local smoke run exposed the three old receiver-dependent expectations, which were replaced with the intended receiver-independent recovery assertions and manager-failure/reentry coverage.

The cold-clone callback test forwards 100,000 gas and records a 13,909-gas call measurement in the synthetic custody harness. The accepted budget is deliberately conservative; this is not an exact production/deployment gas benchmark. Tests separately exercise the manager's outer gas guard and an insufficient 1,000-gas notification that leaves the cached flag stale while live permission fails closed.

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
