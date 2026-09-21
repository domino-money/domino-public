# V4 audit remediation — 21 September 2026

The corrected production-source freeze is
`aaf33947e7aeccf902b311c6d2282a742a929c2b`: 13 sources, 2,630 lines. This replaces
the operational candidate at `ec2e9aa`; the [original audit findings](V4_AUDIT_EXECUTION_2026-09-21.md)
remain historical evidence. No mainnet transaction was signed or broadcast and
no live execution profile was enabled.

## Corrections

| Finding | Implemented result | Evidence |
| --- | --- | --- |
| V4-A01: Nitro block-domain incompatibility | PriceGuard observations, vault checkpoints and execution freshness use strict ArbSys L2 number/hash reads on chain 4663. Missing, reverting or malformed replies fail; no opcode fallback. The shared observation window is 255 L2 blocks. | Seven divergent-domain regressions; [compiled mainnet probe](v4-remediation-2026-09-21/mainnet-preflight-latest.json). |
| V4-A02: coupled Setup refunds | Owner-only `recoverCurrency` debits one escrow independently. Partial recovery preserves remaining claims and permanently blocks swap/mint. Exact escrow debit and reentrancy protection remain; receipt events disclose observed owner balances. | 11 recovery tests, official-pool recovery and native-return-data regressions; SDK/Anvil and browser checks; [recovery semantics](../docs/OWNER_SETUP_AND_RECOVERY.md). |
| V4-A03: invalid economic measurements | Fork evidence records actual identity-bound `FeesConverted` output and `BudgetApplied` inputs. Each recipe uses its matching honest control. Historical missing outputs are unavailable, not inferred receipts. | [Corrected historical report](EXECUTION_FORK_SANDWICH_2026-09-20.md), immutable originals and separately named derived records; focused metric/provenance tests. |
| V4-A04: unsupported per-vault threshold | Removed the $500 safety interpretation. Shared pool/window exposure can amortize manipulation cost across many executions. | [Economic qualifications](v4-remediation-2026-09-21/ECONOMIC_AND_ROLE_NOTES.md). No universal profitable-attack threshold or on-chain aggregate cap is claimed. |
| Release artifact mismatch risk | Seven artifacts are checked against current source hashes/compiler settings. Verification requires explicit expected dependency runtime hashes and checks deployer/operator/publisher/guardian EOA code. | [Artifact manifest](v4-remediation-2026-09-21/artifact-verification.json); actual eight-step local deployment and verifier tests. |
| Unsupported role/coverage claims | Guardian rotation is correctly described as two calls, without independent-key enforcement. Mutation tooling validates all suite summaries and exit status; missing historical batches are identified honestly. | New committed mutation batches and [verdict evidence](v4-remediation-2026-09-21/mutation-results.json). |
| Incomplete or irreproducible test runs | Fork reports checkpoint each completed scenario atomically, bound scenario RPC work and return failure for incomplete evidence. The default Solidity launcher runs each authored suite separately to avoid whole-tree compiler memory exhaustion. | Focused checkpoint, timeout, cache and launcher regressions; fresh fork reports below. |
| Publisher rotation/profile mismatch | Explicit `verify --price-publisher` re-admits the finalized current EOA while preserving original deployment transactions, immutable bindings, role separation and profile expiry. Ordinary verification still requires the original publisher. | Actual Anvil proposal/acceptance, CLI output and SDK parsing; rejects pre-acceptance, wrong/conflicting/code-bearing addresses and altered original manifests. |

The Setup operation tuple and ordinary cancellation event remain unchanged.
The SDK reads the separate recovery flag, offers independent refunds, binds
recovery receipts after reload, and keeps verified Setup recovery usable after
profile expiry or loss of external manager/read services. Transfer restrictions
on the selected token itself can still prevent that token's recovery.

## Artifact and chain qualification

The corrected runtime templates are 6,858 bytes for the read helper, 3,516 for
the price guard, and 13,239 for Setup. Factory, routing, engine and vault runtime
templates are unchanged. All seven runtime/initcode limits pass. Runtime
template hashes exclude constructor-populated immutable values by construction;
the deployment verifier separately checks actual code and all immutable bindings.

At pinned mainnet L2 block **68,904,226**, the compiled production-library probe
returned the exact RPC L2 height and preceding L2 hash. The native `NUMBER`
opcode returned L1 block 26,026,774 and native `BLOCKHASH` returned zero for that
L2 parent, as diagnosed in the original audit. The preflight now treats those
legacy opcodes as diagnostics and verifies the corrected compiled path.

The explicit [finalized-state attempt](v4-remediation-2026-09-21/mainnet-preflight-finalized.json)
remains unavailable on the public endpoint. It is preserved independently and
never falls back to `latest`. Deployment verification still requires finalized
state and canonical finalized receipts on an endpoint retaining that state.

The three external dependency pins were independently qualified from official
Uniswap address records and Sourcify runtime reconstruction, then compared with
current mainnet bytes. See [qualification and limitations](v4-remediation-2026-09-21/DEPENDENCY_QUALIFICATION.md).
The local vendored sources are authentic upstream code but do not reproduce the
exact deployed dependency build; no such equivalence is claimed.

Local Anvil tests and real-pool forks install an explicit ArbSys emulator. Their
funding, impersonation, finality and block semantics are synthetic. They test
execution/accounting against local EVM state; the separate live read-only probe
qualifies Nitro block semantics.

## Validation

| Check | Result |
| --- | --- |
| Application unit suites | 1,134 passed |
| Financial browser suite | 13 passed; the updated recovery-state browser case also passed individually |
| Application typecheck, lint and production build | passed |
| Backend with isolated PostgreSQL and EVM enabled | 2,209 passed, no skipped tests |
| Final fork metric/provenance/checkpoint module | 17 passed after the final harness updates; this focused rerun follows the full backend run above |
| Release/RPC tooling | 12 passed, including all eight unsigned transactions deployed and verified, publisher rotation/re-admission and consumer parsing on isolated Anvil |
| Corrected preflight | 17 passed and live current-state compiled probe passed |
| Mutation tooling | 11 passed |
| Combined contract tooling suites | 42 passed; contract source hygiene clean |
| New targeted mutations | 8/8 caught; passing baselines, zero build/application failures or surviving mutations |
| Solidity suites | **256 passed in 20 suites**, none failed/skipped; [per-suite results](v4-remediation-2026-09-21/suite-results.json) |
| Gas baseline | Deliberately updated for qualified ArbSys reads and recovery protection; [measured changes](v4-remediation-2026-09-21/gas-changes.json) |
| Corrected real-pool forks | Wide: 20/20 requested scenarios completed; narrow: 20 completed, four 20% scenarios and the lifecycle unavailable because of upstream state/receipt failures. [Measurements and limits](v4-remediation-2026-09-21/FORK_RESULTS.md). |

The local checkout path exceeded PostgreSQL's Unix-socket length limit. The
initial database tests failed on that environment condition; the full successful
rerun used a short private task-owned socket, with no TCP or shared database.
The source tree and production configuration were not changed to work around it.

The historical mutation batches with 39 and 15 clauses were not recoverable.
The eight new mutations are a named regression sample, not replacement claims
of exhaustive coverage. Source, batch hashes, baselines and per-mutation failing
test counts are recorded. Compiler crashes, missing edits and incomplete runs
fail the mutation command instead of being counted as caught guards.

## Gas funding and remaining deployment inputs

The owner pays setup/manual transactions. Automated execution gas comes from
the operator's prefunded native ETH; the publisher independently funds its own
observations. The simulator supplies fake ETH using `anvil_setBalance`.
Neither the contract nor the signer automatically sells assets to refill these
wallets. The signer rejects insufficient native gas balance. The 2% service cut
on consumed earned fees is paid to the immutable recipient in the consumed
currency and does not itself convert revenue or top up the operator.

The remaining production inputs are public role addresses, price deviation
band, Setup tariff/version, profile expiry, current deployer nonce/balance and
reviewable gas/cost caps. The [current preparation checklist](v4-remediation-2026-09-21/MAINNET_PREPARATION.md)
and [public parameter template](v4-remediation-2026-09-21/public-deployment.template.json)
preserve those gaps explicitly. Contract correctness evidence does not activate
the signer/publisher, qualify their funding, or authorize user vaults.

Publisher rotation now has an explicit read-only profile re-admission path.
It preserves the original expiry and cannot renew expired profiles. Until the
new verified profile is configured, the signer refuses a publisher mismatch;
verification itself does not activate the services or qualify the new price source.
