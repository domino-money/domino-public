# Public executor E1 implementation evidence

11 September 2026 · [#85](https://github.com/domino-money/domino/issues/85) · candidate `e1-candidate-1`

Base: reviewed plan #84, main `3db825d85422835c05177e24731bece348d207ab`. This increment supplies strict offline identity/action records, exact fee-origin accounting and reproducible candidate vectors. It supplies partial EX-01/EX-02/EX-07 inputs; it does not close deployment, custody, signing, strategy, price-integrity, external-audit or owner-recovery gates.

## Sources and artifacts

- [Identity/plan models](../backend/execution_models.py): chain/owner/vault/manager/sequence/source binding, bounded raw units, membership/custody observations, prospective accrual versus realized credits, original/charged allocations, expiry/version/nonces and typed intent/successor hashes.
- [Accounting](../backend/execution_accounting.py): per-action/source/currency floor, reserved-amount exclusion, exact swap-output attribution and per-source/currency conservation. Converted residuals retain charge status; no second service charge or principal classification.
- [Candidate specification](../docs/execution-v1.md): encoding, minimum on-chain checkpoints, event-to-ledger boundary, terminal nonce recovery requirement, permission-history limitation and downstream responsibilities.
- [Static vectors](../backend/tests/fixtures/execution/e1-vectors.json): SHA-256 **`0b50469446f93f265c5ad22c3d992a33334b35f3439da528f0da2cebcdf8ac61`**. Nine synthetic cases plus wait: self, redirect, new domino, native currency, reversed orientation, second owner, second sequence, alternate manager and converted residual. Addresses/limits are synthetic, not release defaults.
- [Independent Solidity verifier](../contracts/test/ExecutionEncoding.t.sol) reconstructs self/native/reversed complete intent hashes from literal field values, rather than accepting Python intermediate hashes. It also checks signed ticks, uint128 values above uint64, maximum uint128 and ABI array offset/length/order.

The source accounting does not depend on a token symbol, wallet's token holdings or personal bot. Candidate support is deliberately hookless fixed-fee v4, without claiming token/manager/route admission. No existing API schema, frontend, provider configuration, database migration, signer or VM file changed.

## Verification performed

| Check | Result |
| --- | --- |
| `python -m unittest discover -s backend/tests -p 'test_execution*.py' -q` | **43 passed**: 20 identity/action tests and 23 accounting tests, including 200 seeded independent Fraction/conservation samples. |
| `DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1 python -m unittest discover -s backend/tests -q` | **1,221 passed**, zero skipped, 155.252 seconds. Private local PostgreSQL 18 cluster, isolated test databases, pinned local Anvil; no public provider or wallet needed. CI separately exercises PostgreSQL 16. |
| `npm run test:contracts` | **37 Foundry tests passed**, zero skipped, plus three launcher tests. Includes eight new independent encoding tests and existing fee/policy fuzz checks at 512 runs. solc 0.8.26, offline. |
| Candidate vectors | Reproduced exactly by `python backend/tests/execution_cases.py`; digest above records the final liquidity-commitment version. |

Backend tests used the existing pinned Python environment from the APR worktree; all imported product/test modules, node dependencies and PostgreSQL files came from this isolated E1 checkout. Dependency manifests did not change. Frontend visual testing is not relevant to this increment; protected CI still runs the required frontend/repository/backend/contracts checks.

## Independent review and corrections

One delegated implementation supplied accounting and its independent arithmetic fixtures; another built the Solidity verifier from literals. A separate read-only review found and reproduced two invalid candidates: swapping gross amounts before the service cut and accepting active membership above the policy cap. Both are fixed and covered. The review also prompted owner execution with a disabled/unconfigured operator, immutable fee-recipient binding and an explicit signed-liquidity commitment. Final focused review reported no remaining material findings in the offline scope. Delegated review is not native GitHub approval or an external audit.

The candidate checks current root holder/individual approval, but does not pretend these prove continuous permission history. Official v4-periphery transfer/approval/permit behavior and the E2 continuity guard requirement are documented with pinned source links in the specification.

## Remaining work and integration boundary

Independent financial review of E1 is required before E2/E3/E5 rely on these identities. E2 implements real vault/factory initialization, registration/baselines, actual token/NFT custody, permission invalidation and owner-only exits—including terminal state-nonce exhaustion. E3 implements routing/geometry, observation qualification and dynamic economics. E4/E7 implement and reconcile actual fee collection, direct/net paths and bounded swaps. E5 implements durable reservations, a constrained signer, key lifecycle and crash/reorg recovery. E6 implements actual successor minting and source-specific funding.

The approved plan now records #84 review clarifications: beta-gated reads do not need wallet sessions, owner recovery must work without frontend/API/indexer/operator, E5 includes key compromise/revocation/gas-cohort evidence, E3 alone does not qualify a fork and E6/E7 also need independent typed-plan reconstruction.

This delivery does not enable auto-compound or Domino for real users. No production keys, signatures, transactions, deployment, public capability flag or personal operation were touched.
