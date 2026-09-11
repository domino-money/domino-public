# Issue #25: bounded reads and pending API notice

This change is part of the disabled, unreleased `read-v1` 1.1.0-rc.3 candidate. It
does not activate the frontend adapter, public Worker, wallet signing or the
personal bot. The error vocabulary must be included in the first coordinated
release; existing consumer acknowledgement must not be assumed to cover it.

## Exact observable changes

- `ReadRpc` raises the per-call computation ceiling from 150,000 to 500,000 gas,
  with no automatic retry or escalation. Request/deadline limits are unchanged.
- Two finite errors are added: `rpc_call_gas_limit` and `rpc_call_reverted`.
  If a required pool/manager read fails with either, the HTTP response is 503
  with the existing `{ "error": "..." }` envelope.
- Token metadata gas exhaustion uses existing `asset.kind: "unknown"`,
  `asset.readStatus: "unavailable"`, `asset.reason: "rpc_call_gas_limit"`,
  null decimals/symbol, and empty `metadataIssues`. No success field is renamed,
  added or assigned a different unit.
- Optional metadata reverts remain partial, with `metadataIssues.decimals` or
  `metadataIssues.symbol` equal to `rpc_call_reverted` when explicitly identified.
- Wallet asset gas exhaustion uses existing `unavailableAssets[].reason` and
  preserves unrelated asset balances. Gas/revert errors do not switch provider
  or invalidate an otherwise coherent block snapshot.
- The same classified failures in stored fee, position or capital work remain
  explicit HTTP503 errors on historical reads, including a failed position
  dependency of capital metrics. They never become ordinary ledger progress or
  a qualified partial financial value. Operator diagnostics remain unchanged.
- Provider text, credentials, URLs and revert bytes never enter these codes.
  Ambiguous nested proxy failures remain generic or reverted; no guess is made.

The error enum additions require a coordinated pre-release migration under
[API_COMPATIBILITY.md](API_COMPATIBILITY.md). Regenerated schemas, OpenAPI,
TypeScript/runtime validation and manifest belong in the same reviewed package.
Producer fixtures include `token.call-gas-limit`, `token.metadata-reverted` and
`wallet-assets.call-gas-limit`; all error fixtures run through the shared
consumer validator. Rendering the unavailable/partial states and both 503 codes
is frontend work for the receiving adapter owner.

## Release and rollback

Keep live flags disabled until the integration issue records the exact reviewed
backend commit and manifest digest, updated shared fixtures, consumer rendering
results and OxDecimal acknowledgement. The 1.1.0-rc.3 number here identifies an
unreleased candidate, not compatibility with a previously deployed package.
Publish this delta with the first release notice. If a different candidate was
deployed in the meantime, use a coordinated version migration before replacing
it. Roll back producer, gateway and their shared contract together; do not leave
an older strict validator in front of the expanded error vocabulary.

## Offline evidence

`test_read_call_budget.py` covers explicit gas errors, ambiguous provider errors,
revert precedence, finite profiles, no extra attempts, safe error mapping,
unavailable/partial distinctions and isolation between wallet assets. Its
`DOMINO_TEST_EVM=1` case compiles a synthetic metadata implementation and proxy,
deploys only to ephemeral local Anvil and proves old-limit failure/new-limit
success. It neither queries nor qualifies any real token.
