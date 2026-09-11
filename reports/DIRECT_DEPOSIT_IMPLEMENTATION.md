# Resumable owner-signed direct deposits — implementation evidence

10 September 2026. Issue: [#40](https://github.com/domino-money/domino/issues/40).
This backend candidate implements direct deposits into existing admitted
Robinhood Uniswap v4 pools. A user can recover an interrupted operation without
the service blindly issuing another approval or mint. Every transaction is
signed and submitted by the user's wallet; the server holds no signing key and
exposes no broadcast method. Listener and worker default to disabled.

## Scope and review base

The feature is stacked on [#39](https://github.com/domino-money/domino/pull/39),
branch `codex/38-onboarding-api`, at
`5a1baa6741ad987b702da8697363bf18ed356bac`. Review this slice against that commit.
The parent and main branches were not modified. There are no frontend source,
real configuration, personal-bot, signing or deployment changes.

- A separate forced-RLS PostgreSQL schema records immutable owner selections,
  idempotency, bounded operation history, exact issued effects, owner-wide nonce
  reservations, replacement hints and reconciliation evidence. Concurrency,
  restart, restore and reorg behavior are tested.
- Preparation reuses Uniswap composition, checks canonical deployment/token
  admission, pool identity, both selected budgets, balances and allowances,
  then simulates and estimates exactly one bounded wallet step. Revalidation
  precedes durable issuance and delivery. No new liquidity math is introduced.
- Receipt reconciliation independently verifies transaction effect, canonical
  receipt/log identity, finalized-head evidence and the new NFT's owner/pool/
  range. Bounded nonce scans recover missing hashes. Ambiguous cancellation or
  replacement never silently releases a reservation or rearms a completed mint.
- A closed `deposit-v1` 1.0.0 API/worker package supplies schemas, raw-string
  quantities, TypeScript types, finite errors, narrow ABI checks and fixtures.
  The existing SIWE cookie/CSRF boundary, post-work revocation checks and durable
  quotas are reused. Shared authenticated HTTP transport is regression tested.

The [runbook](../docs/DIRECT_DEPOSITS.md) documents all seven routes, deadlines,
resource bounds, cancellation, admission/configuration, receipt limits and
rollback. The [consumer package](../api-contracts/deposit-v1/README.md) defines
the frontend handoff. Initial principal carries `serviceFeeBps:0`; this does not
select or implement the separate assisted-swap tariff or automation fee.

## Contract identities

SHA-256 of `api-contracts/deposit-v1/manifest.json`:
`c8f25521a5eed9e2ccd409795e0604749aea96c31236da3542c9ceb8cad96a96`.

The onboarding payload/version is unchanged. Its manifest records a changed
`uniswap_position.py` source hash because the existing composition is now shared
with internal deposit preparation. Its updated manifest SHA-256 is
`e4dfb8adf7f53e22ac1724a4c1bf089391a8706be2163ee7e3d44c7e4b38e6aa`.
Read/session packages and read OpenAPI have no drift.

## Local validation

| Check | Result |
| --- | --- |
| Full Python suite, PostgreSQL and EVM enabled | 755 passed; zero skipped |
| Complete bridge suite and syntax checks | 517 passed; zero skipped |
| Read, session, onboarding and deposit export checks | Passed |
| Read OpenAPI export check | Passed |
| Strict TypeScript contracts and consumer compilation | Passed |

Reproduction from the repository root after the documented dependency setup:

```sh
backend/.venv/bin/python backend/dev_postgres.py prepare-tests
DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1 backend/.venv/bin/python -m unittest discover -s backend/tests -q
backend/.venv/bin/python backend/dev_postgres.py stop
npm --prefix bridge run check
backend/.venv/bin/python scripts/export-deposit-contract.py --check
node web/node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext api-contracts/deposit-v1/types.ts api-contracts/deposit-v1/runtime.d.mts api-contracts/deposit-v1/consumer.typecheck.mts
```

The slice adds 106 backend tests and 14 bridge tests to the parent baseline.
Seven new HTTP flows use the real SIWE/session/deposit stores and listeners with
synthetic provider responses. They verify owner isolation and idempotency,
persist-before-handoff, hints versus confirmation, terminal mint behavior,
logout/CSRF rotation, post-persistence delivery loss and cancellation hints.
External HTTP is blocked in these flows.

An ephemeral Anvil chain executes synthetic ERC20/Permit2 approvals and a mock
position mint through successive preparations, including a delayed next step.
A separate receipt test verifies actual local transaction/log/gas fields. These
catch ABI, allowance-expiry and receipt-timing errors, but do not exercise the
full mainnet Uniswap deployment or qualify arbitrary token behavior.

Store tests cover role isolation, concurrent issuances, immutable selections,
hash replacement history, canonical versus provisional results, reorgs after
later issuance, cancellation proofs, limits, pagination and dump/restore.
Receipt tests include altered effects/owners, gas-only replacements, bounded
recovery, orphaned receipts, unavailable finality and exact cost arithmetic.
Malformed provider values remain generic failures; legitimate balance/fee/gas
and pending-wallet conditions receive finite actionable errors.

Independent agent reviews covered preparation, receipt, storage, auth/service
and HTTP/worker boundaries. Identified edge cases were corrected and tested.
These implementation reviews are not an external security audit or another
collaborator's GitHub approval. Task-local PostgreSQL was stopped after checks.
No real provider key, wallet funds or personal-bot runtime was used.

## Remaining integration gates

OxDecimal can build the wallet journey against the versioned package and
fixtures. The explicit frontend notice must carry both manifest digests; consumer
acknowledgement is still pending. Real browser hooks must validate account/chain,
selection, raw quantities, calldata and expiration, and reconcile issued work
after reload. Actual wallet/HTTPS/Cloudflare tests remain separate from these
offline checks. Credentials for `domino.money` are still deferred.

The signing candidate admits plain EOAs and existing hookless fixed-fee pools
only. A locally reviewed, expiring code-hash manifest is required before live
preparation; no token is admitted by default. Current token policy requires
standard transfers, no rebasing and no upgradeability. Proxy tokens require a
new reviewed guard; generic discovery does not imply signing eligibility.
Actual Robinhood contracts/tokens still need qualification and independent
execution review before activation.

The RPC's `finalized` tag is disclosed evidence, not independent consensus
verification. Missing L1/data fees keep complete network cost null. Native net
deposit/refund remains null without admitted traces; block-level balances do
not prove one transaction's transfer. Current NFT ownership is an observation
at a disclosed block, not authorization. Expiration or disabling the app does
not revoke an already signed transaction or ERC20 allowance.

Assisted swaps and their tariff, new-pool initialization, vault automation,
Domino scheduling, frontend implementation and deployment remain separate
deliverables. This PR completes the scoped backend candidate, not public launch.

## Primary references

- [Uniswap v4 minting](https://developers.uniswap.org/docs/sdks/v4/guides/managing-liquidity/position-minting).
- [Permit2 allowance transfer](https://developers.uniswap.org/docs/protocols/permit2/concepts/allowance-transfer).
- [Official v4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments).
- Exact source revisions for receipt semantics are recorded in
  `backend/deposit_receipt.py`; the local EVM fixture is explicitly synthetic.
