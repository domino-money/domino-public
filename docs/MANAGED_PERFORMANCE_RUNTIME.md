# Private managed-performance runtime

This implements enrollment, a resumable collector, and the authenticated numeric
`performance-v2` producer. The [execution policy](EXECUTION_POLICY.md) governs
delivery. V1's financial fields remain required nulls. This delivery neither
publishes Cloudflare configuration nor signs or submits financial transactions.

Apply migrations 016, 017 and 018 as the existing trusted DDL owner. The existing
isolated `domino_performance_collector` role owns no schema and has forced owner
RLS; it writes the enrollment queue and journals. `domino_performance_reader`
reads journals. Price reads use the existing read-only catalogue role, and session
authentication uses the existing SIWE/session store. No role may be a superuser,
bypass RLS, inherit roles, or gain another private tenant role membership.

An operator-owned 0600 profile outside the checkout selects an explicit existing
0600 provider file, database file and 0700 runtime directory. No default provider
or production configuration is loaded. Symlinks and writable non-sticky ancestors
are rejected. The provider file uses existing local-config version2, a single RPC
endpoint and no failovers. The profile schema is:

```json
{
  "version": 1,
  "expiresAt": 1790000000,
  "rpcConfig": "/private/operator/performance-providers.json",
  "databaseConfig": "/private/operator/performance-database.json",
  "runtimeDirectory": "/private/operator/performance-runtime",
  "subjects": [{
    "owner": "0x1111111111111111111111111111111111111111",
    "vault": "0x2222222222222222222222222222222222222222",
    "vaultCodeHash": "0x3333333333333333333333333333333333333333333333333333333333333333"
  }],
  "maxRequestsPerMinute": 512,
  "maxRequestsPerStep": 128
}
```

These addresses/hashes are documentation placeholders, not admitted deployments.
Set `expiresAt` to the actual operator authorization expiry. Profile creation
does not establish provider capacity, deploy a vault, or qualify historical USD
prices. Admission binds owner, exact vault and reviewed vault runtime hash. The
session holder submits the complete active token-ID set; the finalized collector
independently checks owner/custody, membership, manager, range and code identities.

Run two independent singleton processes using the same profile:

```sh
python backend/performance_v2_api.py serve --enable --profile /private/operator/performance.json
python backend/performance_v2_api.py collect --enable --profile /private/operator/performance.json
```

The listener is numeric loopback `127.0.0.1:8900`, one worker, at most two in-flight
requests, total deadline20s, body8KiB, response64KiB. Configure the existing session
origin and abuse secret privately, plus `DOMINO_PERFORMANCE_ACCESS_ISSUER`,
`DOMINO_PERFORMANCE_ACCESS_AUDIENCE`, `DOMINO_PERFORMANCE_ACCESS_SERVICE_ID`.
Session authentication includes wallet admission and reauthorization before
delivery. No raw journal evidence, session credential, provider URL or arbitrary
exception text is emitted. An exact duplicated `CF_Authorization` service assertion
is normalized before JWT verification; unrelated cookies and browser origins are
rejected at the loopback service.

Cloudflare publication stays with OxDecimal by owner instruction. The standalone
BFF entry is `bridge/src/performance-worker.mjs`, path `/api/performance/v2/*`.
It requires `PERFORMANCE_BRIDGE_ENABLED="true"`, `PERFORMANCE_GATEWAY_ORIGIN`,
private `PERFORMANCE_ACCESS_CLIENT_ID`/`PERFORMANCE_ACCESS_CLIENT_SECRET`, and
`APP_ORIGIN`. Its internal tunnel path is `/internal/performance/v2/(epochs|enroll|cards)`.
The same-origin beta gate must preserve the private session cookie until this
BFF extracts it; do not reuse public read cookie-stripping forwarding for these
routes. Other cookies are never forwarded. Existing session CSRF is required.

Enrollment and its opening commit atomically; retry cannot restart measurement.
The owner can list at most eight enrolled vaults and batch at most eight cards.
Only enrollment/list/card activity extends a90s visible lease. Hidden-tab polling
must stop; idle or unenrolled wallets make no collector RPC calls. Each claimed
job has a45s fenced lease, then at most one raw page and one financial step, each
with a15s deadline and1-block raw page. Success schedules30s later; failure60s.
Actual next observation can be later when finality, page backlog or budget delays
work. Cards preserve the actual dated snapshot and return30–60s refresh guidance.

The collector has a60s startup cooldown and one rolling process-wide RPC-item
budget, default512/minute (configured ceiling2048), shared by all owners, steps,
receipt verifiers and failed calls. Step ceiling defaults128 (maximum256). These
are finite defensive ceilings, not account quota qualification or a30s SLA.
There is no unbounded catch-up loop, provider price probe or background wallet
discovery. `--once` reports one bounded tick and respects startup cooldown.

Collection resumes durable raw/financial cursors after restart. Reorg generations
invalidate old calculations; the original raw/financial audit remains. A changed
opening returns `baseline_reorged` and requires a new trusted management epoch,
never a silently moved measurement baseline. Failed reads preserve prior facts.
The existing production pricing registry remains the authority: empty/partial
qualification yields null USD or partial coverage. Only a complete valued rolling
day yields observed APR. Synthetic fixture APR is not live history. Future receipt
formats require their matching financial adapter before earning/cost attribution.
