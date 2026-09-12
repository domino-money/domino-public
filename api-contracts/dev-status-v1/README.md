# Development status v1 — local tooling only

`schema.json` is the exact closed JSON Schema for HTTP 200 from the authenticated
`GET /internal/dev/v1/status` introduced in #132. `fixtures.json` contains nine
explicitly synthetic success responses, including unavailable/cooldown states.
Repeated-letter release hashes and the all-zero request ID are examples, not
an installed release receipt. Never import this fixture file into production
frontend assets. This separate metadata protocol does not change read-v1.

The Node launcher may consume this schema and validate the response before
projecting safe diagnostics into its local-only UI. All success fields are
required in v1; unknown fields/states or a different `schemaVersion` are an
incompatible diagnostic response, not a reason to guess optional release data.
No credential, cookie, provider URL, SQL configuration or private payload is
part of this protocol.

- `readEnabled`/`enabledReads` describe the gateway flag/scope. They do not
  establish reader readiness, provider health or positive indexed coverage.
- `readerConnection.state` is `ready`, `cooldown`, `qualification_disabled`,
  `qualification_expired`, `unavailable` or `incompatible`. A ready local
  admission can still have `busy:true`. A provider was not contacted by status.
- Cooldown has a positive `retryAfterSeconds` up to 60; other qualified-shape
  states have zero. Unavailable/incompatible carry only `state`.
- `gatewayAdmission` describes the gateway token bucket and separate control
  bucket. Reader admission is the stricter six starts per rolling minute,
  minimum two seconds, one actual operation; it is not an Alchemy CU allowance.
- `readerCommit`, `gatewayCommit` and `contractManifestSha256` are required
  **operator-attested** installed-release metadata. The installer must verify
  them. `releaseMetadataSource:operator_profile` prevents treating them as a
  runtime code measurement, frontend commit or provider proof.

Non-200 responses use the existing finite read-v1 error body, not this success
schema. In particular, 403 means dedicated development access is rejected
(missing/wrong/expired/revoked); do not prompt for the production beta password
or claim which of those causes occurred from that status alone. 429 means
bounded admission/capacity and carries Retry-After. Transport/contract errors
must remain separate from empty/unindexed data returned by the read routes.
Safe IDs are in `X-Domino-Request-Id`; read compatibility is in
`X-Domino-Read-Contract`. No new automatic data retry/polling is authorized.

Status is a bounded local health/admission observation, not a public admin
endpoint. The launcher forwards only this fixed path server-side and exposes
its sanitized result behind the same strict local Host/Origin boundary as the
rest of its tooling. Owner/reviewer ACK and a fixture/schema update are needed
before a future metadata change reaches the app's development consumer.

See [the complete handoff](../../docs/LOCAL_LIVE_DEVELOPMENT.md) for installation,
revocation, isolated quotas and the Windows HMR/real-data acceptance checklist.
