# Deposit Nitro composition — rc.3 handoff

This disabled candidate composes PR #43 with deposit recovery PR #41 at
`c2853d1f27dda61c3bc45e559168c8be4ba9e19b`. The public deposit contract moves
from `1.1.0-rc.2` to **`1.1.0-rc.3`**; the previous header is rejected. The
producer, BFF, schemas, types, runtime validators, fixtures and manifest must be
adopted together. Consumer acknowledgement remains pending. No frontend, login,
worker or financial execution is activated by this handoff.

## Required consumer change

Replace `executionFeeRaw` with `grossGasFeeRaw`. Read nullable `l1GasUsedRaw`
and derive no alternate fee totals: `l1FeeRaw` is included in gross gas, while
`totalFeeRaw` is required null because exact Nitro net refunds are unqualified.
Show known-zero poster gas separately from missing poster gas. The receipt
renderer must retain `transaction.selectedLimitsExceeded` beside the observed
result, including a confirmed or reverted wallet replacement above selected
caps. Preparation remains strictly capped.

The recovery contract is preserved: `superseded`, allowance observations,
owner/global quotas, expired never-issued reclamation, sticky cross-nonce
conflicts, observed envelope bounds, reorg evidence and unresolved hashes.
A receipt does not revoke residual allowances or clear another-nonce effect.
Legacy stored receipts are projected from their raw gas operands with null
poster gas when absent, preserving the original private evidence. No SQL
migration or historical rewrite is introduced here; migrations001–014 remain
in order. Session-v1 3.0.0-rc.3 fresh session checks remain in force before and
after provider work and before payload delivery; the admission/generation checks
that accompanied them were removed with the wallet whitelist (issue #182).

## Evidence and release gates

The synthetic HTTP/PostgreSQL recovery tests cover cap-breaching replacements
with absent, zero and nonzero Nitro poster gas; shared Python/JavaScript
validators reject invalid fee operands and observed envelope mismatches.
See the PR handoff for actual combined-suite counts and the generated
`api-contracts/deposit-v1/manifest.json` for exact source/artifact digests.
The read manifest is also regenerated because #43 closes HTTP error resources
in the shared discovery transport; its rc.3 schema and historical RPC behavior
are preserved, including the #27 follow-up and #35 source provenance.

The [fork qualification](../reports/DEPOSIT_FORK_QUALIFICATION.md),
[deployment review](../reports/DEPOSIT_DEPLOYMENT_REVIEW.md) and
[RPC analysis](../reports/DEPOSIT_RPC_QUALIFICATION.md) remain dated September10
observations. This composition did not rerun live qualification, admit proxies
or create a production token manifest. The later token-admission candidate is
a separate contract migration. Before activation obtain the exact version/hash
ACK, verify real frontend receipt rendering and complete independent review
and HTTPS staging gates. Rollback disables the listener/worker and restores
matching packages while preserving issued artifacts, nonces and receipt history.
