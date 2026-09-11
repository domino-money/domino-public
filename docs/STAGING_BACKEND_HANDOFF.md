# Backend staging handoff for Decimal

The installed application source is
`a5a855cec1fc5d120d9c1c187a84ff24bc1b02d6`: PR #46 producer
`4d008a8a6fa520d31a915f796374ea1b152764b5` plus the legacy v1 receipt correction
and a test-only deadline correction. The deposit manifest has a new source
digest; wire schemas and versions remain unchanged. This handoff separates the
VM installation from real HTTPS consumer acceptance. VM preparation does not
activate a Worker, session, preview, deposit, wallet grant or financial operation.
The [installation record](VM_STAGING_2026-09-11.md) records what actually ran and
its remaining inputs.

## Producer packages

| Package | Version | Manifest SHA-256 |
|---|---|---|
| read-v1 | 1.1.0-rc.3 | `6429b5ac93993c6e6e7ecd0016cf9d389f18acab81e7a95a42b04ea3b7bcfcf3` |
| session-v1 | 3.0.0-rc.2 | `ff8c96af41da0a18dd658a90e1a0e17e8361dfffa1ca41ff19416965f891b3d2` |
| onboarding-v1 | 1.0.0 | `197c237cb9bd99bf8ec62fac635b1c17c9116eebca7bb3031778444275d43b76` |
| deposit-v1 | 1.1.0-rc.4 | `9882865f162ab13ede22e3526eadfa84db9ec0a8c1ad85dffe97fb130bc218c0` |

Pin the actual producer commit, package version and manifest together. These are
the combined producer digests, not the different standalone manifests. Recheck
them when a later source revision is selected for staging. Existing fixtures and
portable validators are available now for frontend adapter and rendered tests.

## Origin and route contract

Decimal owns Cloudflare, DNS, same-origin Worker routes and the frontend gate.
The exact staging APP_ORIGIN must be confirmed; domino.money is the intended
application domain, not evidence that a proposed internal hostname exists.
Do not point a browser at the private Python reader or enable CORS as a shortcut.

| Browser family | Worker entry | Private Tunnel target | Backend mode |
|---|---|---|---|
| `/api/read/v1/*` | `bridge/src/worker.mjs` | `http://127.0.0.1:8878/internal/read/v1/*` | Disabled gateway; reader is local at 8876 |
| `/api/session/v1/*` | `bridge/src/session-worker.mjs` | `http://127.0.0.1:8879/internal/session/v1/*` | Disabled |
| `/api/onboarding/v1/*` | `bridge/src/onboarding-worker.mjs` | `http://127.0.0.1:8880/internal/onboarding/v1/*` | Disabled |
| `/api/deposit/v1/*` | `bridge/src/deposit-worker.mjs` | `http://127.0.0.1:8881/internal/deposit/v1/*` | Disabled |

This table describes prefix translation, not an unrestricted wildcard proxy.
Only exact paths/methods in the respective Worker dispatch tables are accepted.
Read capabilities is authored locally by the Worker; it is not a Tunnel route.
All nine read operations are POST: token, pools, pool-market, wallet-assets,
nft-positions, catalogue, pool-activity, pool-positions and pool-metrics.
The session Worker translates browser GET me to the internal contract correctly;
configure the Worker rather than forwarding that browser method directly.

Do not publish port 8876, PostgreSQL, health/OpenAPI or unmatched/default paths.
The four internal origins must have distinct Access service identities/audiences.
Workers.dev, preview URLs and other hostnames cannot bypass the reviewed gate.
No router port forward is needed: the connector uses the approved outbound Tunnel.

## Inputs Decimal supplies

Before configuring live ingress, record these non-secret values in the release
coordination issue:

1. Exact HTTPS APP_ORIGIN and the four actual internal HTTPS origin hostnames.
2. Access issuer and separate audience/service identifiers for read, session,
   onboarding and deposits. The Python side validates the real service JWT;
   sending a pair of arbitrary headers is not authentication.
3. Reviewed Tunnel mapping, outbound transport requirements, default denial and
   alternate-host/preview behavior. Provide connector credentials only through
   the agreed private provisioning channel, never GitHub/chat/shell arguments.
4. Worker build/commit, exact package manifests and route flags initially false.
   Worker Access client secrets stay in Cloudflare's environment-specific secret
   store. The listeners do not need copies of those client secrets.
5. Trusted client-IP behavior (including subrequest exclusions), request framing,
   log redaction/retention, frontend beta-gate behavior and the integration window.

Backend then supplies the matching VM configuration and installed build evidence.
The read gateway receives `DOMINO_ACCESS_*` and `DOMINO_BRIDGE_READS`; the other
listeners receive their distinct `DOMINO_SESSION_ACCESS_*`,
`DOMINO_ONBOARDING_ACCESS_*` or `DOMINO_DEPOSIT_ACCESS_*` settings. The private
listeners share the exact session origin and persistent server-side abuse secret.
Provider configuration belongs to the backend and is provisioned separately:
RPC/inventory as needed, Uniswap credentials for real previews, and a reviewed
token admission file before a deposit handoff. No signing key belongs on this VM.

## What Decimal can finish before the Tunnel

Issue #1 can implement all nine read adapters and actual rendered state tests
using the published gateway fixtures. Public blockchain reads do not require a
wallet session; beta-gate 401/503 is handled before producer validation. Keep exact
raw strings, identity, unknown/stale/partial state and opaque pagination.

Issue #14 can implement wallet discovery, SIWE client flow, account/network
listeners, reload/two-tab handling and fixtures for denial/expiry/revocation.
A real backend is needed to validate actual cookies, CSRF and revocation across
HTTP. Shared consumer tests alone are not that end-to-end evidence.

Previews and deposit screens can likewise be built with fixtures. Deposit rc.4
preserves durable nonce/conflict evidence, observed limit breaches and Nitro gas;
nullable token quantities require their amount-basis fields. A mock cannot
activate spending or certify a successful live operation.
Unresolved reported hashes and off-nonce conflicts require support. The frontend
must not present them as ordinary retries or imply that cancellation, expiry or
creating another intent releases the reservation.

## Acceptance and rollback

Record a consumer ACK naming the frontend commit, actual producer commit, all
versions/digests, affected hooks/screens and the tests actually performed.
Distinguish fixture acceptance, backend-local verification and HTTPS staging.
The coordinated staging exercise must cover exact origins/Access identities,
client-IP/framing, cookie/CSRF/replay/account switching, revoke/regrant, outage
behavior and preservation of issued operations. Any controlled enable step uses
explicit reviewed flags/configuration; disabled source installation is not that
release decision.

Source issue closure does not replace the remaining activation qualifications.
Validate actual provider error formats, failover and measured capacity for the
affected read/preview routes; the accepted bounded study is not production
capacity calibration (#25 and the read-bridge qualification). Before enabling
deposits, review an audited, evidence-preserving operator procedure for unknown
transaction hashes and off-nonce conflicts, including the unobserved original
hash followed by a wallet speed-up (#41). No database edit or archive operation
is an implicit resolution path. Keep current token-admission reviews, manifest
ACKs and private operation archives, including owner-history/allowance lookup
after archival. The disabled VM checks do not qualify these procedures.

Rollback disables the four Worker routes and corresponding private listeners,
stops the service units and preserves all database/private runtime evidence.
Do not drop migrations, erase reservations/receipts or restore an old wallet
allowlist to make a rollback pass. Restoring a snapshot requires the release's
admission and deposit reconciliation procedure before re-enabling private ingress.
The initial empty-database backup/restore exercise does not certify recovery of
future issued wallet transactions, external NAS/offsite backups or power resilience.
