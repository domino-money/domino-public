# Domino V4 — independent audit specification

Prepared on **21 September 2026**, after the complete CI succeeded. This is the
review request, frozen scope and reproducibility guide. Independent audit
conclusions are pending. No transaction from this release has been sent to
mainnet, and production automation remains disabled.

## 1. Canonical freeze and handoff

| Item | Frozen value |
| --- | --- |
| Repository | [domino-money/domino](https://github.com/domino-money/domino) |
| Annotated tag | [`v4-audit-2026-09-21`](https://github.com/domino-money/domino/tree/v4-audit-2026-09-21) |
| Full checkout commit | `255fc38b6eb62d630c8354a8dcec870f3c9dee39` |
| Git tree | `15fea131d90091c7341dc9ca2f72653656afbd73` |
| CI for that exact commit | [35645990350 — success, all five jobs](https://github.com/domino-money/domino/actions/runs/35645990350) |
| Last production-source change | `abe25808da712de13b7f90b1c2089b08dffc0a94` |
| Machine-readable identity | [freeze.json](v4-independent-audit-2026-09-21/freeze.json) |
| Full CI job/step record | [ci.json](v4-independent-audit-2026-09-21/ci.json) |
| Public deployment proposal | [public-deployment.proposed.json](v4-independent-audit-2026-09-21/public-deployment.proposed.json) |

The full checkout includes the API-manifest/bundle remediation and the backend
fixture correction for the 4% Domino tariff. Production sources, compiler
profile, compiler wrapper and locked compiler dependencies are unchanged from
the artifact build at `abe2580…`. The latest CI is authoritative for this
checkout; older failed runs retain their original results.

This specification and its manifests were written **after** the green freeze.
They are delivered by a subsequent documentation commit. Historical reports
inside the frozen checkout can therefore still say that the price band was
pending. The approved configuration in section 3 supersedes those statements.
Do not move the tag or silently substitute a later `main` checkout.

Acquire the complete tracked tree, including all tests, fixtures, local Uniswap
references, licenses, lockfiles and mutation inputs:

```sh
git clone https://github.com/domino-money/domino.git domino-v4-audit
cd domino-v4-audit
git switch --detach 255fc38b6eb62d630c8354a8dcec870f3c9dee39
test "$(git rev-parse HEAD)" = 255fc38b6eb62d630c8354a8dcec870f3c9dee39
test "$(git rev-parse v4-audit-2026-09-21^{commit})" = "$(git rev-parse HEAD)"
git status --short
```

The local delivery archive also contains the 2,101 tracked files, seven compiled
artifacts, public unsigned deployment/rehearsal records and SHA-256 checksums.
Its `source/` tree preserves all frozen Git files byte for byte. This post-freeze
specification and its three manifests are added under `source/reports/`, outside
the frozen tracked inventory. It excludes `.git`, dependencies installed by
package managers, private configuration and credentials. Prefer the
Git checkout above for commands that require Git, including mutation `--head`
and release preparation/verification. Package-manager dependencies must be
installed before executing the suite.

## 2. Review scope

Primary scope is **all 13 authored Solidity files, 2,670 lines**, and their
interaction with the pinned dependencies. Line counts include comments/blank
lines and are not a security-coverage metric.

| Source under `contracts/src/` | Lines | Review responsibility |
| --- | ---: | --- |
| `DominoVaultV4.sol` | 774 | Owner custody, ledger, authority, callbacks, exits |
| `DominoExecutionEngineV4.sol` | 360 | Typed execution, settlement, NET and conversion accounting |
| `DominoSetup.sol` | 307 | Owner escrow, assisted swap, mint and independent recovery |
| `DominoVaultReadHelper.sol` | 271 | Identity, pool, checkpoint and price validation |
| `DominoRoutingHelperV4.sol` | 219 | Recipe eligibility, successor geometry and price arithmetic |
| `DominoVaultTypes.sol` | 158 | Shared data, limits and manager interfaces |
| `DominoVaultFactoryV4.sol` | 139 | Owner-bound clone creation and one-shot finalization |
| `DominoPriceGuardV4.sol` | 127 | Publication admission, observation lifetime and role rotation |
| `DominoExecutionTypes.sol` | 93 | Plan wire and authenticated execution interface |
| `IDominoVaultDraft.sol` | 83 | Shared Policy struct; not the complete V4 vault ABI |
| `PolicyValidation.sol` | 65 | Modes, policy versioning and active-position limits |
| `FeeAccounting.sol` | 43 | Mode tariffs and integer fee/net splits |
| `DominoL2Block.sol` | 31 | Qualified Robinhood ArbSys block domain |

Review the deployment/verification boundary in
`scripts/prepare-financial-release.mjs`,
`scripts/audit-v4-mainnet-preflight.mjs`,
`scripts/check-contract-size.mjs` and their tests. Backend V4 encoding, admission
and receipt reconciliation are integration context, especially
`backend/execution_v4.py` and its EVM tests. The complete backend/frontend suites
are available, but a comprehensive application, infrastructure, key-custody or
economic audit is additional scope; their passing tests do not certify them.

Vendored dependencies are review dependencies, not Domino-authored code.
`contracts/test/reference/official-v4/provenance.json` pins every one of the 98
source/license files; its verifier passed with zero findings. These are upstream
test references, **not the exact original source builds deployed on Robinhood**.
See [runtime dependency qualification](v4-remediation-2026-09-21/DEPENDENCY_QUALIFICATION.md)
for reconstruction, source gaps and transitive-dependency limits.

## 3. Approved deployment and fee policy

| Parameter | Approved value and basis |
| --- | --- |
| Network | Robinhood Chain mainnet, chain ID `4663` |
| Simple Auto-compound | `serviceFeeBps = 200`: 2% on consumed original earned fees |
| Domino-compound | `serviceFeeBps = 400`: 4% for every recipe in this mode |
| Automated internal swaps | Included in the mode fee; no additional swap surcharge |
| Assisted owner swap in Setup | `setupFeeBps = 65`: 0.65% of the consumed gross input budget |
| Setup tariff version | `1` |
| PriceGuard publication band | `priceGuardDeviationBps = 50`, immutable sqrt-price bps |
| Gas treasury | Manual ETH funding initially; automatic conversion/refill is not implemented |

Simple mode is root-only, `maxPositions = 1`, with GENERAL/NET and its own fee
sources. Domino's 4% applies even to a same-position reinvestment; the action
number does not select a lower tariff. An owner policy update selects the mode
and invalidates prior plans through the nonce. Previously charged converted lots
remain charged across a mode change. Automation does not charge principal,
unconsumed fees or a converted lot for a second time.

Setup has a distinct owner-authorized budget that may come from initial funding.
Its swap takes `floor(grossInput * 65 / 10000)` as the service fee and quotes the
remaining input. Direct deposit/mint without that swap has no Setup percentage
charge. A reverted swap cannot collect the service fee, although gas can be
spent. A successful Setup swap is a separate transaction: its fee remains paid
if a later mint is cancelled. See [pricing policy](../PRICING_POLICY.md).

### Publication band and execution limits

For current pool `sqrtPrice = S`, publication accepts attested value `A` when:

```text
S * 9950 <= A * 10000 <= S * 10050
```

Both endpoints are inclusive. In the same token1/token0 price orientation,
`P = sqrtPrice²`, this is **−0.9975% / +1.0025%** relative to spot at publication.
The 50-bps value is a constructor parameter, not a constant in the source.
Guardian/publisher rotation cannot change it.

This band is checked by `publish()`. `referencePrice()` checks identity,
revocation, canonical block and age; it does **not** reapply the publication
band against current spot. Execution independently applies the owner's
`maxPriceImpactBps` in ordinary-price units and the plan's min/max sqrt prices,
including before/after swap checks. Audit the combination; do not interpret
50 sqrt-bps as a universal execution-slippage or loss cap.

The guard uses the pool's own spot, so a price already manipulated before the
observation can satisfy the band. Reading `slot0` over RPC does not automatically
include hook fees, transfer behavior or an independent fair-price source. The
approved publication policy is on demand for an eligible execution; the live
acquisition/publication/refresh/execution pipeline still needs implementation
and qualification.

### Public roles

| Role | Initial public address | Authority and funding |
| --- | --- | --- |
| Deployer | `0x706627e3e75b0603c4b6f9a1ebbfc635da712747` | Seven deployments and one factory finalization; no later upgrade/admin power |
| Fee recipient | `0x1488c84dafc03f7f4c4fb986f83ba99fd530c6f4` | Receives fees in the consumed currency; no vault authority |
| Initial operator | `0x2320ea29fcf7b827e1a4039ed46244be4d4b29da` | Pays execution gas; executes admitted plans and can pause |
| Price publisher | `0x4d6f91d3101569bb8c710bc332f621600e429e7b` | Pays publication gas; publishes/revokes observations |
| Price guardian | `0x5e57fded90c4635648eb7b3ba29705ff0769d103` | Proposes a publisher and revokes observations; requires its own ETH when acting |

Each user's owner role is separate. The proposed operator is a shared initial
service address, but authorization is per vault and revocable by that vault's
owner. Publisher/guardian are shared for the deployed guard; fee-recipient and
component addresses are fixed in the deployed stack.

The guardian sends `guard.proposePublisher(next)`; `next` sends
`guard.acceptPublisher()`. The guardian may nominate itself or another key it
controls. Two calls do not establish independent custody. Old observations
survive rotation until revocation or expiry. The guardian itself is immutable;
the contract has no guardian-recovery administrator. Release profiles must
explicitly re-admit the new publisher before honest services resume.

The release verifier requires EOAs for deployer, operator, publisher and guardian;
fee recipient may be a contract wallet. Initial separation is enforced by release
tooling and must not be confused with every on-chain rotation rule. No auditor
needs any of these wallets' private keys.

### Dependency identity and deployment proposal

| Dependency | Address | Expected live runtime Keccak-256 |
| --- | --- | --- |
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | `0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626` |
| PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` | `0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | `0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6` |

Deployment order is factory, read helper, routing helper, price guard, engine,
vault implementation, Setup, then `factory.finalizeImplementation(implementation)`.
Finalization is one-shot; vaults are fixed EIP-1167 clones with no upgrade path.

The unsigned proposal uses deployer nonce **255** and the approved 50-bps band.
Its rehearsal on the project's own RPC fork at block **69,032,280**, hash
`0x460d6d089c558492f40b8c6049b0b3b935eae328a5df45d9c3c719bc6c0d065d`,
passed all eight transactions and release verification using the existing fork
balance. It used 19,504,419 Anvil gas. This is not a current Nitro total-cost quote.
The rehearsal's source commit is `abe2580…`; full transaction objects and
predicted addresses remain unchanged in the `255fc38…` proposal.

Gas ceilings, profile expiry and the observed nonce are **operational proposals
and dated evidence**. Recheck them, balances, dependency code and finalized
receipts for an actual deployment. The artifact runtime hashes are templates
before constructor immutable values, not pre-deployment predictions of complete
live runtimes. [Release procedure](../docs/FINANCIAL_RELEASE.md) describes the
immutable-slot, dependency, receipt, profile and partial-failure checks.

## 4. Architecture and properties to review

The owner retains the root NFT under individual approval/subscription. Children
mint into the vault. The vault forwards a typed plan to its fixed engine; the
engine enters a PoolManager unlock, authenticates its callback and asks the
vault to perform bounded PositionManager operations. It cannot choose an
arbitrary router, asset recipient, wallet pull or principal decrease.

| Recipe | Required behavior |
| --- | --- |
| GENERAL (0) | Collect admitted fees, retain their source identity, add to the same parent and settle actual debt |
| NET (1) | Use freshly realized fees from one position, without old allocations/charged input/swap; reconcile nominal residual before taking it |
| FUND (2) | Use eligible sources to fund an admitted active same-sequence destination under routing rules |
| MINT (3) | Create one actual successor with bounded geometry, correct ownership, capacity and fresh identities |

Prioritize these invariants and adversarial boundaries:

1. **Principal and consent.** Automated collection decreases liquidity by zero;
   additions are positive. Root ownership, approval, subscription and checkpoint
   identity must remain valid. No plan can acquire unrestricted user-wallet
   spending power. Source budgets are unique/ordered, capped at 16 collections
   and 32 source/currency budgets, with exact allocation floors enforced.
2. **Conservation and one charge.** For each admitted source/currency, the vault
   checks `originalAfter + grossConsumed = originalBefore + realized`,
   `chargedAfter + chargedConsumed = chargedBefore`, and
   `liquidityAdded + serviceFee = grossConsumed + chargedConsumed`. Charges are
   differences of cumulative integer floors for that source/currency/state nonce.
   Converted output retains lineage and its charged classification. Donations
   and unallocated reserves must not become authorized spendable income.
3. **NET residual accounting.** `_net` reads nominal PositionManager credit after
   the increase, calculates `realized - nominalResidual`, then calls the separate
   NET-only `executionTake()`. Actual vault credit must equal the nominal residual.
   Recipient-side loss must never become apparent added liquidity or a larger
   Domino fee. Also review the independent liquidity checkpoints.
4. **Callbacks and transient state.** Only a registered exact clone enters the
   fixed engine; PoolManager callback sender, commitment and single consumption
   are checked. Vault callbacks authenticate the engine codehash and active
   phase. Manager/engine currency deltas begin and end at zero. EIP-1153 slots
   persist for a transaction, so examine multiple calls in one transaction,
   reentry, unexpected subscriber events and cleanup after success/revert.
5. **Replay and chain domain.** Plan identity binds chain, vault, sequence,
   authority, nonce, source preimages and deadline. On chain 4663, ArbSys at
   `0x64` supplies L2 number/hash with strict reply validation and no fallback to
   native `NUMBER/BLOCKHASH`. Observations require a strictly past canonical
   block, age **1–255 L2 blocks**, plus expiry/age limits. These checks do not
   require finalization. Timestamp is publisher-attested, not independently
   authenticated against a historical header timestamp.
6. **Owner exits and terminal state.** `withdrawChildPosition`,
   `recoverUnmanagedPosition`, `withdrawFeeReserves` and
   `recoverUntrackedCurrency` must work without engine/publisher/read-helper
   availability. They still depend on the relevant token/manager transfers.
   Withdrawn-child reserves remain claimable; known membership cannot be
   silently reused. Saturated counters deny new authority while preserving
   recovery without wraparound. Owner recipients remain fixed.
7. **Setup escrow.** Separate users/operations/currencies must remain isolated.
   A first independent `recoverCurrency()` disables subsequent swap/mint for
   that operation and preserves the other currency's claim. Recovery checks
   exact escrow debit while observing actual owner receipt. A restricted token
   must not strand the healthy counterasset. Inspect callback forwarding,
   reentry, no-return/false-return tokens and swap-success/mint-cancel behavior.
8. **Price and economic trust.** Review publication and execution bands together,
   swap output floors, partial-fill rejection, add ceilings, rounding, range
   geometry and per-pool aggregate exposure. `maxGasCostWei` and
   `forecastHorizonSeconds` are validated configuration fields, not on-chain
   measurements/enforcement of profitability or total gas cost. The honest
   planner's economic admission is a separate dependency.

Financial transfers generally require exact credit/debit for their specific
stage; owner recovery deliberately permits reduced recipient receipt while
requiring exact vault/escrow debit. Do not infer generic support for transfer-tax,
rebasing or arbitrary-hook tokens from either rule. In particular, the NET
recipient-credit check alone does not qualify a token that debits the PoolManager
extra while crediting the nominal amount to the vault.

## 5. Known evidence limits and token qualification

- The spot-based publication check does not prove independent fair value or a
  universal loss bound. No per-pool aggregate exposure cap is demonstrated.
  Compromised operator/publisher scenarios must be assessed across multiple
  vaults sharing a pool and observation window.
- The 10-minute read-only band study sampled 1,200 snapshots in seven pools,
  yielding 8,400 price reads. It did not measure a production publisher's
  inclusion latency. In that sample, block expiry affected 6.12% of references
  at 20 seconds and 92.11% at 30 seconds; widening a band does not fix expiry.
  See [measurement and replay](PRICE_BAND_QUALIFICATION_2026-09-21.md).
- GENERAL/swap/MINT and lifecycle evidence on a real pool does not establish
  real-pool NET/FUND qualification. NET/FUND run in local official-source
  fixtures. Anvil's explicitly installed ArbSys stand-in is not Nitro.
- Operator and publisher use prefunded native ETH. Fee revenue arrives at the
  treasury in its consumed currency; it does not automatically refill either
  gas wallet. Actual failed/replaced transactions also have operating costs.
- QUOTRON `0x5a86828efd322bfb16d93cfed16ee9bc14940d7f` showed a **3% hook trading
  charge on WETH** for the sampled state/account, rather than an ERC20 haircut
  in the tested wallet/vault routes. Its direct PoolManager routes have
  authorization restrictions. This is not a claim about all launch states or
  ERC404 NFT-boundary transfers.
- HASH `0xca75082b85bb7bec8325d513f615b16bda260020` showed exact ERC20 transfers
  on all four tested routes. Its official hooked pool charged **5% on the ETH
  leg** at the sampled block. An alternative hookless pool has a combined
  **2.098%** LP/protocol trading fee and only preliminary structural qualification.
  The official hook source/control rules were not fully qualified. Do not ban or
  approve every HASH pool from one pool's behavior.
- Hooked pools remain outside current Domino routes. The band is not a budget
  for 3%/5% trading costs; a route quote/simulation must include all applicable
  costs. [Token evidence and NET correction](TOKEN_FEES_AND_NET_ACCOUNTING_2026-09-21.md)
  records pinned blocks, runtime identities, eight fork transfer cases and limits.
- The eight committed mutation cases have historical caught results at an earlier
  revision. Their text applies to the frozen sources, but the actual mutation
  batches were not rerun after the NET change. Historical 39/15-clause batch
  inputs were never recovered and cannot be offered as reproducible coverage.
- Three source comments retain old descriptions: `DominoVaultTypes.sol:6`
  mentions V3/no swaps; `DominoPriceGuardV4.sol:11` calls the publisher immutable;
  its guardian comment understates indirect publishing authority. The actual
  V4 behavior is as described above. These are documentation errata, not claims
  about a different implementation. `IDominoVaultDraft` supplies Policy, not the
  current vault's complete event/ABI surface.

## 6. Toolchain and exact artifact checks

Use macOS, Linux or WSL2. Native Windows is unsupported. Select Node **24** from
`.nvmrc`, Python **3.14** from `.python-version`, PostgreSQL **16+** (CI uses 16),
and an installed Chrome/Chromium/Edge for browser tests. Patch versions of
Node/Python are not pinned. Most browser harnesses accept `DOMINO_BROWSER_PATH`;
some discover an installed browser channel. Missing browsers are failures.

```sh
npm ci --no-audit --no-fund
npm --prefix app ci --no-audit --no-fund
npm --prefix web ci --no-audit --no-fund
python3.14 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-api.lock
```

The root lockfile provides native Forge/Anvil **1.7.1** and solc **0.8.26**.
Compile through the repository launcher/wrapper: compiler
`0.8.26+commit.8a97fa7a`, Cancun, optimizer 200, viaIR, metadata bytecode hash
`none`, FFI disabled. Compilation is offline after package installation.
Do not use one whole-tree `forge test`/`build`: that solc-js compilation can OOM.

```sh
python3 contracts/test/reference/verify_official_reference.py
npm run test:contracts
npm run check:contract-gas
node scripts/check-contract-size.mjs
```

The launcher discovers all authored suites sequentially, including `audit_*`,
official integration and transfer-retention cases. It excludes vendored projects'
own suites. `test:contracts` also runs the tooling/hygiene checks. Gas comparison
uses **250 deterministic entries**, excluding fuzz/invariant averages. Do not
use `--update` to hide a discrepancy; report it and its cause. New/removed entries
are informational in the existing gas checker.

After building, independently compare source metadata and bytecode to the
manifest already present in the frozen checkout:

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadArtifacts, toolsFor } from './scripts/prepare-financial-release.mjs';
const v = toolsFor(process.cwd());
const actual = loadArtifacts(process.cwd(), v);
const expected = JSON.parse(readFileSync('reports/transfer-tax-2026-09-21/artifact-verification.json'));
for (const source of expected.sources) {
  assert.equal(v.keccak256('0x' + readFileSync(source.file).toString('hex')), source.keccak256);
}
for (const entry of expected.artifacts) {
  assert.equal(actual[entry.component].creationCodeHash, entry.creationCodeHash);
  assert.equal(actual[entry.component].runtimeTemplateHash, entry.runtimeTemplateHash);
}
console.log('13 source hashes and seven creation/runtime templates match.');
JS
```

The size gate checks compiler profile/ABI/size; `loadArtifacts` additionally
checks every referenced metadata source against the checkout. Artifact JSON
SHA-256 values identify the supplied files; creation/runtime hashes are the
bytecode comparison for a fresh rebuild. Engine runtime is **22,335 bytes**
(2,241 bytes of EIP-170 headroom); vault runtime is **24,002 bytes** (574 bytes).
Both retain their existing required reserves of 2,048 and 313 bytes respectively.
The [artifact manifest](transfer-tax-2026-09-21/artifact-verification.json)
contains all seven sizes, creation hashes, runtime templates and source hashes.

## 7. Complete suite inventory and reproduction

All counts below are test functions/cases, not individual fuzz executions.
The exact green CI passed **269 Solidity tests in 21 authored suite files**, zero
skips; **2,229 backend tests**, zero skips; and **12 release/RPC tests**, zero
skips. The frontend job passed **1,401 tests with six explicit skips**, zero
failures. The six skips are the existing read-screen browser cases; do not
describe that job as zero-skip coverage. All five jobs, including preview,
completed successfully.

### Solidity files

Paths below are relative to `contracts/`:

| Suite | Cases |
| --- | ---: |
| `test/DominoCompoundHelper.t.sol` | 12 |
| `test/DominoL2Block.t.sol` | 7 |
| `test/DominoPriceGuardV4.t.sol` | 16 |
| `test/DominoRoutingArithmetic.t.sol` | 9 |
| `test/DominoVaultFactoryV4.t.sol` | 5 |
| `test/DominoVaultFactoryV4Creation.t.sol` | 30 |
| `test/DominoVaultV4Architecture.t.sol` | 7 |
| `test/DominoVaultV4Custody.t.sol` | 68 |
| `test/DominoVaultV4Invariants.t.sol` | 6 |
| `test/ExecutionEncoding.t.sol` | 13 |
| `test/FeeAccounting.t.sol` | 10 |
| `test/PolicyValidation.t.sol` | 22 |
| `test/audit_anchor/AnchorExecutionEvidence.t.sol` | 1 |
| `test/audit_custody/SetupRefundIsolation.t.sol` | 3 |
| `test/audit_engine/EngineFeeConservationAudit.t.sol` | 4 |
| `test/reference/OfficialDominoExecutionV4.t.sol` | 20 |
| `test/reference/OfficialFeeOnTransferRoutes.t.sol` | 8 |
| `test/reference/OfficialV4Compound.t.sol` | 5 |
| `test/setup/DominoSetup.t.sol` | 9 |
| `test/setup/OwnerReturnData.t.sol` | 3 |
| `test/setup/SetupRecovery.t.sol` | 11 |
| **Total** | **269** |

Default fuzzing is 512 runs; invariants use 32 runs/depth 24 with
`fail_on_revert=false`. Five invariants cover backing, source/ledger equality,
membership, monotonic nonce and terminal child recovery. A separate handler
self-test establishes that the operations actually reach the vault.
No historical fixed seed was recorded. For a new reproducible campaign:

```sh
node scripts/test-contracts.mjs --fuzz-seed 0x01 --fuzz-runs 512
FOUNDRY_FUZZ_SEED=0x01 FOUNDRY_INVARIANT_RUNS=64 FOUNDRY_INVARIANT_DEPTH=48 \
  node scripts/test-contracts.mjs --match-path test/DominoVaultV4Invariants.t.sol
```

Run the real targeted mutation batches separately, in the Git checkout:

```sh
node scripts/mutate-contracts.mjs contracts/mutations/security-guards-2026-09-21.json --head
node scripts/mutate-contracts.mjs contracts/mutations/setup-recovery-2026-09-21.json --head
```

The runner mutates disposable copies. Eight cases cover owner custody, terminal
authority, publisher authentication, ArbSys chain, escrow ownership/debit,
terminal recovery phase and reentry. CI tests the mutation runner; it does not
run these actual batches. `NO BUILD` and `NOT APPLIED` are not caught mutations.
Record the seed, baseline result, applied change and actual verdict.

### Backend, real local PostgreSQL and EVM

Run after Solidity artifacts and app dependencies are available. The helper
creates isolated local clusters/databases; `DOMINO_PG_BIN` selects the installed
PostgreSQL binaries. Both test flags are required to avoid opt-in skips.

```sh
(
  set -eu
  trap 'backend/.venv/bin/python backend/dev_postgres.py stop' EXIT
  backend/.venv/bin/python backend/dev_postgres.py prepare-tests
  DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1 \
    backend/.venv/bin/python -m unittest discover -s backend/tests -v
)
```

This includes planning/admission, private stores, signer/runner refusal cases,
receipt/reorg reconciliation, performance, Setup/Sequence SDKs and local EVM
integrations. EVM tests use disposable Anvil accounts, not production keys.
For a targeted integration rerun, use the same disposable database setup and:

```sh
DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1 PYTHONPATH=backend:backend/tests \
  backend/.venv/bin/python -m unittest -v \
  test_execution_v4_receipts_evm test_performance_v4_history_evm \
  test_execution_runner_v4_evm test_execution_runner_evm \
  test_sequence_sdk_evm test_setup_sdk_evm
```

The earlier focused 17/17 result covered the first three modules only; it is not
the count for this longer command or a substitute for the 2,229-case CI suite.

### Release, API, browser and repository checks

```sh
DOMINO_TEST_EVM=1 node --test \
  scripts/prepare-financial-release.test.mjs \
  scripts/prepare-financial-release-rpc.test.mjs \
  scripts/audit-v4-mainnet-preflight.test.mjs

backend/.venv/bin/python backend/tests/execution_cases.py --check
for schema in read read-v2 read-v3 session onboarding deposit performance performance-v2 execution; do
  backend/.venv/bin/python "scripts/export-${schema}-contract.py" --check
done
backend/.venv/bin/python scripts/export-read-openapi.py --check
backend/.venv/bin/python scripts/check-read-v3-parity.py
npm run check:read-bridge
npm run check:repository
npm run check:web
npm run check:app
node --test api-contracts/read-v2/consumer.browser.test.mjs
backend/.venv/bin/python -m unittest discover \
  -s reports/price-band-2026-09-21 -p test_analyze.py -v
```

The 12/12 CI release count refers to `prepare-financial-release.test.mjs` and
`prepare-financial-release-rpc.test.mjs`; the command above also exposes the
separate preflight test file. Deployment tests send transactions only to a
disposable EVM. Browser suite requirements and its six deliberate skips remain
visible. The unchanged gzip ceiling is 150,000 bytes; CI measured 149,090 for
the production bundle and 149,589 for the wallet test bundle.

The complete CI matrix is [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
at the frozen commit. It additionally enumerates shared TypeScript consumer
checks, staging/egress/systemd/public-data/read-path tests and four disposable
staging PostgreSQL tests. Those four use `DOMINO_TEST_STAGING_POSTGRES=1`, a
separate opt-in. Follow the matrix for exact ancillary commands. Its gated
preview upload requires the repository's deployment access; reviewing contracts
and running the local suites do not require that credential or a deployment.

## 8. External RPC and fork campaigns

These are separate from offline CI. Use the project's qualified own RPC through
an authorized loopback connection, or deliberately select a public provider.
Do not read a sibling bot's configuration or signer. Source availability and
state retention must be recorded, including snapshot block/hash and whether
it is finalized. [Local RPC procedure](../docs/LOCAL_RPC_SOURCE.md) applies.

```sh
backend/.venv/bin/python backend/qualify_execution_fork.py \
  --source-url "${DOMINO_FORK_SOURCE_URL:?qualified loopback RPC required}" \
  --pool weth-usdg --band 50 --width 200 \
  --rounds 40 --moves 50,90,110,500,2000 \
  --scenario-seconds 180 --lifecycle \
  --output /tmp/domino-audit-fork-narrow.json
```

Repeat with `--width 2000` and a separate output for a wide range. `--band`
uses sqrt-price bps; `--moves` uses ordinary-price bps. **Pass `--band 50`
explicitly**: the harness retains a historical default of 2000. Always provide
`--source-url` or `--public-rpc` to avoid local configuration discovery.
Historical scenarios with other bands are not measurements of this 50-bps
deployment policy.

The harness has bounded per-scenario/global time and request budgets, preserves
partial results and uses synthetic accounts/balances/volume plus explicit ArbSys
emulation. Pruned-provider failure is not an economic rejection. Do not reuse
historical gas or fork results as proof of profitability, Nitro execution or
unexercised recipes.

Live read-only dependency/L2 preflight is distinct:

```sh
node scripts/audit-v4-mainnet-preflight.mjs \
  --repo "$PWD" --rpc "${DOMINO_FORK_SOURCE_URL:?qualified RPC required}" \
  --snapshot finalized --out /tmp/domino-audit-preflight.json
```

Do not silently substitute `latest` when finalized state is unavailable. Missing
role inputs or runtime profiles must remain missing. The historical token replay
and guard-replay scripts are included as evidence tools, but some depend on
project SSH access, pinned historical blocks or historical paths. They are not
advertised as portable current-release commands; adapt and document their
environment before rerunning, and preserve the original evidence files.

## 9. Requested independent deliverable and change control

For every finding, provide severity, exact frozen file/line, affected invariant,
prerequisites/roles, reproducible local test, observable impact, recommended fix
and verification criteria. Separate exploitable behavior, liveness/custody risks,
economic assumptions, documentation errors and untested hypotheses. Report
positive coverage and untested paths as well as failures; test counts alone do
not establish security.

Prioritize fee/source conservation, NET residual handling, owner recovery,
callback/transient discipline, clone/dependency pinning, publisher/guardian
authority and aggregate price-manipulation exposure. Reproduce the existing
findings from [the corrected audit package](V4_AUDIT_PACKAGE_2026-09-21.md)
and its evidence instead of assuming their disposition is independently proven.

Record every command, tool version, seed, timeout and skip. Preserve baseline
logs and identify actual replay blocks. A clean result must state its limits.

Preserve tag `v4-audit-2026-09-21` and full commit identity. Any later change to
contract sources, compiler profile, linked dependencies or constructor policy
must be an explicitly identified candidate with a diff, renewed artifact checks
and relevant regression results. Documentation or a later `main` commit does not
replace the frozen code. Audit findings can justify a new candidate; they do not
retroactively change what this freeze or its CI tested.

After review, mainnet deployment still requires current nonce/funding/gas inputs,
reviewed transactions and finalized bytecode/receipt verification. Production
price-source and publisher/executor qualification remain separate before live
automation is enabled.
