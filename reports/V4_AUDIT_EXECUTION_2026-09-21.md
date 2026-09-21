# V4 audit execution and mainnet preparation — 21 September 2026

**Historical report.** The findings below describe the original `ec2e9aa` freeze. They are preserved as audit evidence; corrected sources, new artifacts and validation are indexed in [V4 remediation](V4_REMEDIATION_2026-09-21.md). Statements such as “currently” below refer to the audited revision.

**Disposition: do not deploy the frozen release as an operational V4 stack.** A mainnet block-domain incompatibility prevents its documented observation/execution flow. The original 228 tests pass, but their ordinary EVM semantics do not reproduce Robinhood Nitro. No mainnet transaction was signed or submitted.

This is an engineering audit performed in this task, not an external certification. It executes the scope in [V4_AUDIT_PACKAGE_2026-09-21](V4_AUDIT_PACKAGE_2026-09-21.md). Review checkout: `7be7820efb2f261f49b688b1ad4e467b7f3725a2`; production-source freeze: `ec2e9aaa4a6f2f87c93553166fb2795171cb2a94`. The twelve production sources, compiler wrapper, lockfile and Foundry profile were unchanged from that freeze. Production sources remain unchanged after this review.

## Findings

### V4-A01 — High: RPC observations cannot pass the frozen contracts on mainnet

`DominoPriceGuardV4.sol:84–88,111–118` and `DominoVaultReadHelper.sol:119–127,149–152` use Solidity `block.number`/`blockhash`, while the publisher/planner supply Robinhood RPC block numbers and hashes. These belong to different domains on Nitro.

Read-only calls to the official mainnet RPC confirmed this at Robinhood block **68,886,586** (`0x41b203a`, hash `0x2e5953a95b6c5fc471393180c25e05b5842eff0848467664f6f74827e49f8951`):

| Read | Result |
| --- | --- |
| RPC child-chain block number | 68,886,586 |
| EVM `NUMBER` | 26,026,629, exactly the header's L1 block number |
| EVM `BLOCKHASH` of preceding RPC child block | zero |
| `ArbSys.arbBlockNumber()` | 68,886,586 |
| `ArbSys.arbBlockHash(previous child block)` | matches the RPC child-block hash |

The guard rejects ordinary recent child-chain observations before accepting their price. The read helper independently rejects execution authority from that same domain. Every action requires an observation; this affects GENERAL, NET, FUND and MINT. Owner recovery paths are separate.

An Anvil fork uses ordinary EVM block opcodes and therefore masks this incompatibility. The bytecode still deploys successfully; passing a deployment rehearsal does not make its automation functional.

**Required correction:** use one explicitly qualified child-chain number/hash source throughout observation validation and checkpoints, align the producers/reconcilers, and test both divergent block domains. Qualify the result against Nitro, then issue a new source freeze, artifact hashes and deployment package. Do not fix this by dropping hash/freshness checks or relabeling child-state observations with L1 hashes.

Evidence: [exact read-only requests/results](../contracts/test/audit_anchor/anchor-mainnet-block-domain.json), [review and primary references](audit-2026-09-21/anchor-review.md). Robinhood documents the difference in [Differences from Ethereum](https://docs.robinhood.com/chain/differences-from-ethereum/); [Arbitrum's block documentation](https://docs.arbitrum.io/arbitrum-essentials/arbitrum-vs-ethereum/block-numbers-and-time) describes the child-chain alternatives.

### V4-A02 — Medium: one restricted Setup token locks the healthy counterasset too

`DominoSetup.sol:144` sends cancellation through `_close`; lines 212–215 zero both escrows and transfer both currencies atomically. If either token starts rejecting transfers after a successful deposit, the entire cancellation reverts, including the other currency's refund. There is no owner withdrawal for just one currency.

The reproduction deposits a normal token plus 1 ETH, then pauses the token. Cancellation leaves both balances escrowed; unpausing the token alone makes cancellation succeed. The same coupling persists with the manager/read services unavailable. A separate reproduction checks a token changing recipient-credit behavior. These are synthetic tokens demonstrating the coupling, not a claim that a particular deployed issuer has frozen this contract.

Issuer freeze risk is already acknowledged by `REVIEWED_TOKEN_ADMISSION.md`; the additional defect is its propagation into independent, transferable owner funds. Depending on the issuer's restriction, swap/mint can also be unusable. Those paths are not an independent recovery mechanism.

**Required correction before including Setup in a release accepting these assets:** add owner-only recovery of each available escrow currency independently, preserving the outstanding claim for the restricted asset. Specify closure/event/accounting semantics and test partial recovery, later recovery and cross-owner isolation. Keep economic-operation exact-transfer checks separate from recovery semantics.

Evidence: [three passing behavior reproductions](../contracts/test/audit_custody/SetupRefundIsolation.t.sol). A passing reproduction means the reported problematic behavior was observed, not that the release is safe.

### V4-A03 — Medium: sandwich report does not measure the swap shortfall it claims

The committed fork records omit actual swap output. The reported zero shortfalls for successful post-observation moves are differences against the unchanged anchor, not actual proceeds at the moved execution price. Additionally, `qualify_execution_fork.py` compares swap cases with the non-swap honest control even though it computes a distinct swap-honest control.

The raw records reproduce the control mismatch: the narrow-range swap-honest control is already **0.088853 USDG** above the general honest control before manipulation. A new official-contract fixture records actual `FeesConverted.amountOut` and demonstrates that an allowed post-observation move lowers the successful swap output.

**Correction:** capture actual conversion outputs, compare each scenario with its corresponding control, and regenerate the economic tables. This does not by itself demonstrate a profitable attack; it invalidates the stated measurement basis.

Evidence: [analysis and recalculation](audit-2026-09-21/anchor-review.md), [official-pool proof](../contracts/test/audit_anchor/AnchorExecutionEvidence.t.sol), [offline record checker](../contracts/test/audit_anchor/verify_fork_evidence.py).

### V4-A04 — Medium: the ~$500 figure is not a per-vault safety threshold

The package directs the reader to compare a sampled manipulation cost with the reserve sold in one compound. A price observation is reusable across vaults, and nonce/interval checks are per vault. Several eligible vaults may execute against the same moved pool before one restoration. The attack cost must therefore be evaluated against aggregate exposed sales in that pool/window, including their cumulative impact.

**Correction:** remove the per-vault safety interpretation. Qualify aggregate executions and reserve sizes if the service relies on an economic exposure bound. The already-disclosed pre-observation risk remains; the one-victim samples do not prove a universal minimum profitable trade size.

Evidence: [anchor review](audit-2026-09-21/anchor-review.md), `DominoPriceGuardV4.referencePrice` and the engine's pool-level anchor use.

## Trust-model and reproducibility corrections

- The guardian can choose a publisher it controls, including itself after deployment; the on-chain rotation is two calls, not necessarily two independent keys. Initial address separation does not persist as an on-chain invariant through all rotations. The honest backend's admission check is a separate defense.
- The release verifier currently checks operator/publisher EOA code, but not guardian EOA code (`prepare-financial-release.mjs:214–215`). The audit package overstates that check. The new predeployment checker explicitly inspects the guardian too.
- Existing dependency runtime hashes are captured and compared to component immutables, not compared with independently pinned expected dependency hashes. The runbook describes capture accurately; audit-package wording implies a stronger check.
- The published 39-clause and 15-clause mutation batch JSON inputs are not committed. The mutation runner exists and its tests pass, but the exact historical batches and their reported counts were not independently rerun here. They must not be described as reproduced by this execution.

## Validation performed

| Check | Result |
| --- | --- |
| Clean pinned dependency installation | completed |
| Original Solidity suites, one dependency closure at a time | **228 passed, 0 failed, 0 skipped; 15 suites** |
| Independent fee-conservation properties | **4 passed**, including 3 fuzz properties with 512 cases each |
| Official-pool actual swap-output proof | **1 passed** |
| Setup refund coupling proofs | **3 passed** |
| Launcher, size, hygiene, gas and mutation-tool unit tests | **28 passed** |
| Unsigned release / read-only RPC tooling | **11 passed**, including all eight deployments and verification on isolated Anvil |
| Read-only mainnet preflight tests | **8 passed**; transport, block-domain, role, snapshot selection and canonicality checks |
| Deterministic gas comparison | no regressions; new audit tests reported separately |
| Seven artifact sizes and runtime template hashes | all limits pass; all seven match the audit package |
| Live mainnet block-domain probe | mismatch confirmed without deployment or transaction |

The twelve files contain 2,536 lines as stated. [Suite results](audit-2026-09-21/suite-results.json) and [artifact verification](audit-2026-09-21/artifact-verification.json) retain machine-readable evidence. Raw logs are included in the local preparation bundle. No new broad fork sandwich/lifecycle campaign, exact historical mutation batches, backend/PostgreSQL suite or frontend suite was run. The service around the contracts remains outside this audit's scope.

Host environment: macOS, Node 25.2.1 and Python 3.14.3; Forge 1.7.1 and solc 0.8.26 are lockfile-pinned. Node differs from the README's recommended 24 LTS; all seven rebuilt runtime template hashes nevertheless match the frozen package exactly.

The reusable preflight independently reproduced the block mismatch at L2 block 68,890,616, using block-hash-pinned current-state reads. All three existing dependency code reads and both PoolManager links succeeded there. Their hashes are captured, not independently admitted expected hashes. The public RPC supplied a finalized header but could not answer the attempted finalized-state reads; that unavailable result is retained separately. Explicit `--snapshot latest` produced the current-state evidence and does not turn it into finalized deployment verification. See [current-state preflight](audit-2026-09-21/mainnet-preflight-latest.json) and [finalized-state attempt](audit-2026-09-21/mainnet-preflight.json).

No new loss/conservation defect was confirmed in the reviewed engine, NET/GENERAL accounting, fee charge-once rules, transient execution guards, or vault owner-exit paths. This is a bounded review result, not proof that all defects are absent; see [engine review](audit-2026-09-21/engine-review.md).

## Deployment preparation status

The frozen artifacts are reproducible and the existing eight-step deployment tooling passes its local rehearsal. They are retained as audit evidence, **not an approved deployable candidate**. Mainnet calls were read-only. No role addresses were inferred from personal-bot files or existing wallet admissions, no private keys were generated/read, and no public deployment profiles were enabled.

Before constructing the real unsigned transactions: correct V4-A01, resolve V4-A02 for the intended Setup scope, refreeze and revalidate artifacts, supply the five explicit role assignments, choose the price deviation band/Setup tariff/profile lifetime and cost cap, then read the deployer nonce/balance and estimate the exact sequential batch on a qualified source. All calldata and predicted addresses depend on these final choices.
