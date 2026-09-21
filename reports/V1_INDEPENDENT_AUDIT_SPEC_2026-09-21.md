# Domino V1 — independent audit specification

**Prepared on 2026-09-21 for independent review of the public V1 candidate. This is not an audit approval or deployment authorization.**

Public contract names use **V1**. The authenticated implementation, execution
protocol and signing domains remain **version 4**. Uniswap V4 is a separate
dependency designation and is unchanged. A public name change must not silently
rewrite a protocol version, consumer schema, storage field or authenticated domain.

## 1. Review identity and provenance

| Revision | Meaning |
| --- | --- |
| `255fc38b6eb62d630c8354a8dcec870f3c9dee39`, tag `v4-audit-2026-09-21` | Original frozen V4 audit baseline. Preserve it and its reports. |
| `d048b4b8564a7939baff0fafdada5ba67660043e` | M-1/M-2/M-3 remediation candidate, with internal contract names still V4. |
| `73a75ca7ba6815c8670208f0b3354548a05e7edf` | Parent checkout used to start the public V1 naming candidate. |
| Public naming implementation | `6f5d531dbec05a922a8406d27ef9421facaa4419`; subsequent documentation-only commits are identified in the delivery record. |
| Final public V1 freeze | `v1-audit-2026-09-21`, to be created only after green CI for its exact target. Resolve the annotated tag and compare the full commit in the delivery record. |
| Artifact manifest SHA-256 | `d74a6816df586ccc6ee660954df31e673111a7c2b95234330aa3e195cc1c4c57` |
| Exact V1 commit, CI run and delivery checksums | Recorded in `RELEASE.json`, `SHA256SUMS` and the archive sidecar in the final audit delivery; never inferred from this date or branch name. |

The final delivery includes an exact source archive, a Git bundle, seven public
artifacts, explorer compiler input/targets, command logs, a fresh unsigned
proposal and a fork rehearsal. Its `RELEASE.json` pins the full source commit,
CI URL/conclusion and artifact manifest hash. Verify those records and the tag
before treating the package as frozen. The in-repository specification does not
self-embed its own commit hash.

Useful immutable prior references:

- [Original independent-audit spec](https://github.com/domino-money/domino/blob/9f88aceb6211bb1938a176b64ea566debb072a15/reports/V4_INDEPENDENT_AUDIT_SPEC_2026-09-21.md)
- [M-1/M-2/M-3 remediation report at d048b4b](https://github.com/domino-money/domino/blob/d048b4b8564a7939baff0fafdada5ba67660043e/reports/V4_M123_REMEDIATION_2026-09-21.md)

## 2. Public deployment targets and internal bases

| Public V1 target | Internal base retained |
| --- | --- |
| `src/DominoVaultFactoryV1.sol:DominoVaultFactoryV1` | `DominoVaultFactoryV4` |
| `src/DominoVaultReadHelperV1.sol:DominoVaultReadHelperV1` | `DominoVaultReadHelper` |
| `src/DominoRoutingHelperV1.sol:DominoRoutingHelperV1` | `DominoRoutingHelperV4` |
| `src/DominoPriceGuardV1.sol:DominoPriceGuardV1` | `DominoPriceGuardV4` |
| `src/DominoExecutionEngineV1.sol:DominoExecutionEngineV1` | `DominoExecutionEngineV4` |
| `src/DominoVaultV1.sol:DominoVaultV1` | `DominoVaultV4` |
| `src/DominoSetupV1.sol:DominoSetupV1` | `DominoSetup` |

The new contracts use direct inheritance and forward the same constructor
arguments. They must introduce no storage, behavior overrides, administrative
powers, proxy/delegatecall layer, or external call between constructor arguments
and the base constructor. The source scope includes all inherited production
sources: 20 own Solidity files plus four imported upstream math/revert libraries.

The public build compares each alias against its base in **creation bytecode,
runtime template, full canonical ABI and all immutable offsets**. It does not
mask differing executable bytes. Only ABI top-level entry ordering and compiler
AST identifiers for immutable ranges are normalized. Parameter/tuple ordering,
types, names, mutability, indexed flags and duplicate ABI entries remain bound.

Local public build has reported **7/7 exact matches** and passing size reserves;
the relevant log is `evidence/public-build.log` in the delivery. Independent
recompilation reproduced all seven artifacts, and the committed manifest check
passed. Sixty focused Node tests and six disposable-EVM release tests passed
with no skips on the naming implementation. The d048b4b CI run
[35664507560](https://github.com/domino-money/domino/actions/runs/35664507560)
passed all five jobs, including 278 Solidity tests in 22 suites and the gas
baseline. These dated results do not replace the exact final candidate CI and
fork evidence recorded in the delivery.

## 3. Security deltas carried into V1

Review the implementation changes from the original frozen baseline to d048b4b,
then verify that the V1 aliases introduce no further financial behavior.

- **M-1:** service fees accumulate per currency during the engine operation and
  are paid only after the PoolManager unlock has closed. The vault's reentrancy
  and exact debit/receipt guards remain active during those payments. Verify
  atomic rollback and two executions in the same transaction, including clearing
  transient fee totals and avoiding duplicate payment.
- **M-2:** every actual swap output must fund the same action under its matching
  source/currency budget. The engine adds actual output to both maximum and
  minimum charged allocations; unconsumed output, including one unit, causes
  rejection. This applies to original, charged and mixed input funding. Existing
  charged balances remain fee-exempt; the mitigation must not double-charge them.
- **M-3:** `prepare` and `verify` require artifacts authenticated against the
  committed independently reproduced manifest. Verify creation/runtime bytecode,
  ABI, immutable ranges, all imported sources and build inputs. Changing an
  artifact with authentic-looking metadata, changing the neighboring manifest,
  or committing only a manifest over dirty compiler inputs must fail closed.

The artifact gate's trust root is the explicitly reviewed Git revision plus its
pinned compiler installation. It is not protection against replacing the trusted
repository or compiler environment itself.

## 4. Version separation and configuration

Require the artifact manifest, unsigned package, verification result and
preflight to state `publicReleaseVersion: 1`, `implementationVersion: 4` and the
seven public names in `contractNames`. The on-chain getter remains
`implementationVersion() == 4`. Consumer `contractVersion` values, technical
`schemaVersion` values and authenticated plan/signature domains are unchanged.

| Parameter | Approved value |
| --- | --- |
| Chain | Robinhood Chain mainnet, `4663` |
| Simple automation fee | `200` bps, on consumed original earned fees |
| Domino automation fee | `400` bps for every recipe in the mode |
| Additional internal automation swap fee | None |
| Assisted Setup swap fee | `65` bps; tariff version `1` |
| PriceGuard band | Immutable `50` sqrt-price bps, approximately −0.9975%/+1.0025% in price |
| Initial treasury gas funding | Manual; operator and publisher pay their respective transaction gas |

The public proposal in the delivery preserves the already reviewed role
addresses, deployer nonce `255`, expiry `1792609290`, individual gas caps, maximum
fee `200000000` wei/gas, priority fee `0`, total cap and reserve. The rehearsal
may replace only `sourceCommit` with the final V1 commit. It must fail if the
live/pending deployer nonce differs; it must not automatically advance nonce,
renew expiry, increase caps or supply a synthetic balance.

These are dated operational inputs, not authorization to sign or a guarantee
that their values remain deployable when an auditor reads this specification.

## 5. Reproduction workflow

Use the final Git revision, Node 24, Python 3.14, the repository lockfiles and the
pinned Forge/Anvil 1.7.1 and solc 0.8.26. The Solidity profile is Cancun,
optimizer 200, viaIR, metadata hash `none`, FFI disabled. Install dependencies as
documented in the original spec; the artifact archive alone is insufficient for
Git-authenticated release checks.

From the repository root:

```sh
npm ci --no-audit --no-fund
npm --prefix app ci --no-audit --no-fund
npm --prefix web ci --no-audit --no-fund
npm run test:contracts
npm run check:contract-gas
node scripts/build-public-release.mjs
node scripts/check-contract-size.mjs --public-release
node scripts/release-artifact-manifest.mjs --check
```

The default size checker covers the internal base artifacts. The explicit
`--public-release` check covers the V1 targets with the same reserves. Do not
update a manifest or gas baseline merely to make an unexpected difference pass.

Run release qualification against a disposable Anvil, without real wallet keys:

```sh
DOMINO_TEST_EVM=1 node --test \
  scripts/prepare-financial-release.test.mjs \
  scripts/prepare-financial-release-rpc.test.mjs \
  scripts/release-artifact-manifest.test.mjs \
  scripts/build-public-release.test.mjs \
  scripts/check-contract-size.test.mjs \
  scripts/audit-v4-mainnet-preflight.test.mjs
```

Run the complete backend/PostgreSQL/EVM suite, frontend/browser checks, fuzzing,
invariants and committed mutation campaigns described by the original audit
spec on the **final V1 checkout**. Attribute results to the exact command and
revision; do not recast prior V4/M123 results as new V1 runs. Preserve named skips
and the distinction between CI campaigns and optional live-RPC/fork studies.

## 6. Own-node fork rehearsal

The delivery includes `simulate-candidate-deployment.mjs`. It must run only
after the final V1 commit and its committed manifest exist. It
requires `--source-commit` equal to the candidate checkout's actual HEAD.

Its mainnet source is the project's own node through the existing
`domino-host` SSH connection to host loopback `8547`. Both direct reads and the
Anvil fork's upstream requests pass an explicit read-only allowlist. Every write
goes to the newly launched private Anvil; `web3_clientVersion` must identify
Anvil before each write. There is no key loader or balance override.

Outputs go to a new timestamped directory under this candidate output folder.
They include a new unsigned proposal, copied parameters, local transaction
hashes, local verification evidence and gas observations. No available
application profile is exported. Keep `readyForSigning=false`,
`mainnetTransactionsSent=false` and `executionAvailable=false`.

The previous M123 rehearsal at d048b4b is historical evidence only: eight local
transactions passed, using 19,535,036 Anvil gas. The fresh V1 rehearsal and its exact source commit, block, hashes and
measurements are recorded separately in the final delivery. Do not substitute
the historical rehearsal for those records.

## 7. Findings and remaining boundaries

Each finding should include the exact commit/file/line, violated property,
prerequisites, a reproducible minimal witness, expected/actual result and impact.
Distinguish an executable exploit from a coverage omission, release-policy
enhancement, intentionally retained trust assumption or documentation error.

The public naming change does not qualify an independent price source,
publication-to-execution latency, actual inclusion economics, gas replenishment
automation, or every token/pool. Hooked pools remain unsupported. Transfer/trading
fees are route-specific and are not absorbed by the PriceGuard band. Real-pool
NET/FUND and production publisher/executor qualification remain separate from
deploying the contracts. No claim of universal security follows from bytecode
equality or a green test suite.

The [post-deployment automatic-cycle demand](../docs/V4_AUTOMATION_CYCLE_POST_DEPLOY.md)
records the external planning/publication integration still to implement.
Contract deployment alone does not activate that cycle.

The delivery must state every pending item explicitly. Preserve the original
frozen tag and historical audit reports; public V1 is a separately identified
candidate that carries the M1/M2/M3 changes and needs their independent review.
