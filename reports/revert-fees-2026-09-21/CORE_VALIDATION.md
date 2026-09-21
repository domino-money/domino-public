# Mode tariff implementation validation

21 September 2026. Core implementation: `0ad5c6f` (integrated by the parent as `7321c5b`). The follow-up changes only fuzz coverage, the deterministic gas baseline and this validation record.

The stored tariff is the mode discriminator without changing the Policy ABI: 200 bps means simple root-only compounding with capacity one; 400 bps means Domino for every recipe. The accounting basis remains consumed original earned fees, with owner-favoring integer floors, never principal. Previously charged converted reserves stay exempt when the owner changes mode. No new swap surcharge or treasury auto-refill is implemented.

## Results

| Check | Actual result |
| --- | --- |
| Authored Solidity suites | **260 passed across 20 suites**, zero skipped in the selected final results |
| Backend discovery without EVM/PG opt-ins | **2,225 discovered/run; 568 gated skips; 1,657 executed successfully** |
| Focused tariff/model/planner/accounting Python tests | **84 passed** |
| Canonical receipt tests on local Anvil | **9 passed**, including both tariffs, child-exit prerequisite for downgrade, stale-plan rejection and real consumption of a previously 2%-charged converted reserve after upgrade to 4% |
| Durable V4 executor and recovery tests | **25 passed**, using disposable PostgreSQL and local Anvil |
| Gas baseline/hygiene tool tests | **7 passed** |
| Contract source hygiene | Clean |
| Generated execution API and E1 vectors | Both checked against generated output |
| Production artifact source validation and size limits | All 7 artifacts passed; vault runtime 23,694 bytes, engine 21,899 bytes |

The backend discovery was captured before the final mode-specific EVM additions. The explicitly enabled 9 receipt and 25 runner tests above validate those affected paths; the 568 skips are not claimed as executed tests. PostgreSQL is a disposable private Unix-socket fixture. The local chain uses the repository's explicit ArbSys emulator and is not evidence of Nitro execution gas or live production transactions.

## Solidity run and gas provenance

The complete sequential launcher passed its first 15 suites. Its official integration fixture still encoded 200 bps with a four-position cap, which the new guard correctly rejected. That fixture was corrected to Domino/400 bps with matching inverse-fee expectations, and the remaining five suites passed. Only the two arithmetic suites were then rerun after widening fuzz seeds to the full 0..400 arithmetic domain. The selected final results cover all 20 discovered authored suites exactly once; each suite's header count, `[PASS]` count and successful summary were checked against one another. [Suite results](suite-results.json) records those counts, current test-source hashes, production creation/runtime-template hashes and log hashes.

The committed `contracts/.gas-snapshot` is derived from those same successful Forge outputs, using the deterministic `Suite:test() (gas: N)` entries. Fuzz/invariant averages are excluded, matching `scripts/gas-baseline.mjs`; parsing and formatting were round-trip checked. A separate complete `forge snapshot` run was deliberately avoided because these are the same deterministic test gas measurements.

[Gas changes](gas-baseline-delta.json) records **241 deterministic entries**, 90 increases, one decrease, five added entries and one removed entry. The removed exhaustive test became two disjoint exhaustive tests covering 0..200 and 201..400; splitting the work prevents test-memory exhaustion while retaining every rate. The remaining new entries cover the 4% floor and strict mode/downgrade validation.

The gas changes are intentional: policy, membership and source guards add work, and the integration fixtures now use 400-bps arithmetic. The largest existing-test increase is **62,894 gas** in an integration test that also deploys the entire stack. It includes deployment/bytecode costs and multiple calls; it is not a quote for one operator execution. No claim is made that synthetic Anvil gas or the historical gas-price samples are a live fee estimate.

## Commands and scope

`node scripts/test-contracts.mjs` invokes pinned Forge and offline solc 0.8.26 sequentially. The retained final runs used its `--match-path` option for the corrected final five suites and the two expanded fuzz suites. `node scripts/check-contract-hygiene.mjs` passed.

Python used the installed backend venv with `PYTHONPATH=backend` (and `backend/tests` for named module invocation):

```text
python -m unittest discover -s backend/tests
python -m unittest test_automation_tariff test_execution_models test_execution_planner test_execution_accounting
DOMINO_TEST_EVM=1 python -m unittest discover -s backend/tests -p test_execution_v4_receipts_evm.py
DOMINO_TEST_EVM=1 DOMINO_TEST_POSTGRES=1 python -m unittest test_execution_runner_v4_evm test_execution_runner_evm
python scripts/export-execution-contract.py --check
python backend/tests/execution_cases.py --check
```

The API response schema now admits a historical receipt rate through 400 bps while current policy validation admits exactly 200 or 400. The unapplied candidate `backend/schema.sql` is updated for new sequence policy configuration, not receipt history; there is no runtime database migration in this change. Staging bundles must use the new source checksum. Consumer profile/pin compatibility and coordinated release artifacts are handled by the parent integration.
