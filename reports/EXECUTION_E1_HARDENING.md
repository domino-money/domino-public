# E1 derived-record and receipt-boundary hardening

12 September 2026 · issue [#99](https://github.com/domino-money/domino/issues/99)
· base `710b52f13ef06b77ddc122fcbbadb19d2c29f7be`

This increment resolves the E1 follow-ups from
[the #98 review](https://github.com/domino-money/domino/pull/98#pullrequestreview-5182557729)
at the offline model/accounting boundary. It adds no database migration,
provider call, browser contract, signer, deployed vault or financial permission.
The [execution specification](../docs/execution-v1.md) defines the remaining
E4/E5 integration obligations.

## Implemented checks

| Review boundary | Result and focused evidence |
| --- | --- |
| Derived instances | `validate_candidate` rebuilds both complete trees. Copied/constructed duplicates, cross-owner nested sources, terminal counters, invalid liquidity and scalar coercion fail. |
| JSON process ingress | `parse_execution_json` rejects duplicate keys at all depths, including escaped-equivalent names, before strict JSON-mode validation. This is a helper for future ingress; there is no new HTTP parser/endpoint. |
| Membership | Nonzero NFT identities; all direct parents validated before an indexed iterative graph walk. Missing ancestors produce validation errors instead of truncating `map` with `StopIteration`. A 1,025-member lineage and cycle are covered without recursion or repeated ancestry scans. Collection lookup uses a digest map. |
| Credit identity | `eventIndex` means the ordinal among all logs within one transaction's receipt. Re-inclusion changes block-scoped log indices/block evidence while retaining the credit ID, including native-fee events. |
| Duplicate entitlement | One remaining lot per reconciliation origin; changing lot ID, currency or charge label cannot create a second balance row for that origin. Independent credits from one source remain distinct before per-action floor grouping. |
| Converted lineage | Explicit source/transaction/receipt-event/output-currency identity plus exact input-allocation evidence. Changing allocation evidence retains the stable origin ID; duplicate/relabelled fragments are rejected. This establishes identity only, not actual output or spendability. |
| Minimum-output budgets | A plan with a 500 minimum-output budget accepts a 500 minimum addition and rejects 501; automatic netting and swaps remain mutually exclusive. |
| Plan/effect reconciliation | A separate checker compares supplied starting/ending source ledgers, actual charges and swap legs to the projection; binds plan/receipt/destination and exact positive liquidity; rejects mutations of independent before/after values, duplicate credits, wrong source/recipient/transaction, exact-input/output breaches and zero/all-residual reinvestments. |
| Collection outcomes | Excess realization remains original/uncharged above the consumed cap. An actual shortfall that cannot meet the exact swap or minimum additions fails; no principal/donation/foreign-source/external-wallet top-up exists. A rounded fee can make a slightly lower gross realization sufficient, which is tested explicitly. |

`reconcile_consumption` remains an arithmetic projection, including useful
swap-only calculations. Its conservation equation is derived from its inputs;
the primary arithmetic guards are net-input disposition and output overspend.
Only the new plan/effect checker rejects such a projection as an unsuccessful
reinvestment. Neither helper establishes that supplied measurements happened on
chain. E4 must measure/enforce the same bounds atomically, and E5 must verify and
persist canonical effects under unique constraints before applying balances or
charges. A reverted/ambiguous transaction is never a successful receipt.

`validate_balance_lineage` binds supplied original credits and converted origin
identities. Converted lineage contains no verified output amount or atomic input
debit; E5 must keep converted origins nonreservable until E4/E7 effect verification
exists. Persist one stable lot-to-origin mapping with spent/withdrawn tombstones,
reconcile changed re-inclusion evidence against that mapping, and independently
check historical input allocation, actual output and current remaining amounts.
There is no claim that an identity digest or a caller's canonicality flag grants
spending authority.

## Encoding compatibility and new evidence

The E1 domain remains `e1-candidate-1`; validation revision is
`e1-hardening-99`. Every existing field/value/hash of all nine prior fixture
cases, every prior type string and the domain version compare unchanged against
the base. No existing Record ABI field changed. Added evidence includes:

- Three complete cases: nonempty accrual/collection with general direct,
  general enabled swap, and separate net/no-swap paths.
- `FeeCreditId`, `SuccessorId` and `ConvertedLotId` identity type strings in the
  encoding inventory.
- An explicit converted allocation lineage record and stable ID.
- Independent Solidity reconstruction of those records and complete
  redirect/Domino/successor plans from literals, without importing Python hashes
  as intermediate inputs. Only final expected hashes are fixture constants.

Fixture SHA-256:

```text
base: 0b50469446f93f265c5ad22c3d992a33334b35f3439da528f0da2cebcdf8ac61
new:  24756977e76c7ccd109e88ca9f325251451eb6e6d44935751cdabb73cfa51333
```

## Verification

- Focused execution Python suite: **60 tests passed**, including 200 existing
  independent arithmetic/conservation samples; no network or database involved.
- `npm run test:contracts`: **127 Foundry tests passed**, zero skipped, including
  **13 ExecutionEncoding tests**, plus **3 launcher regressions passed**.
- Prior fixture fields/hashes/type strings compared against the base: unchanged.
- Repository hygiene: **1,091 files checked, zero findings**; `git diff --check`
  passed and the fixture generator reported no drift.
- Complete backend regression with `DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1`:
  **1,312 tests passed**, zero skipped, against isolated local PostgreSQL and
  Anvil. This includes the existing ledger, migration, reorg and EVM regressions.

Reproduce focused checks:

```sh
backend/.venv/bin/python -m unittest discover -s backend/tests -p 'test_execution*.py' -v
backend/.venv/bin/python backend/tests/execution_cases.py
npm run test:contracts
```

No public financial activation, real receipt qualification or E4 atomic shortfall
revert is claimed by this report. Those remain separately implemented and tested
against actual admitted manager/token paths before release.
