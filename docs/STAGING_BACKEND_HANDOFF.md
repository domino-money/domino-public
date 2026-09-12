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

**Installed a5 release** (`a5a855cec1fc5d120d9c1c187a84ff24bc1b02d6`):

| Package | Version | Manifest SHA-256 |
|---|---|---|
| read-v1 | 1.1.0-rc.3 | `6429b5ac93993c6e6e7ecd0016cf9d389f18acab81e7a95a42b04ea3b7bcfcf3` |
| session-v1 | 3.0.0-rc.2 | `ff8c96af41da0a18dd658a90e1a0e17e8361dfffa1ca41ff19416965f891b3d2` |
| onboarding-v1 | 1.0.0 | `197c237cb9bd99bf8ec62fac635b1c17c9116eebca7bb3031778444275d43b76` |
| deposit-v1 | 1.1.0-rc.4 | `9882865f162ab13ede22e3526eadfa84db9ec0a8c1ad85dffe97fb130bc218c0` |

**Reviewed #75 candidate**, not installed: source
`9b844c5208b8e411ed4873ac5a66384718fb56ff`, rebased as
`d66df69f7af2debca4a1706ebc19827077187e6e` with these manifest bytes unchanged.
The subsequent test-only correction
`dd650fa4d755b9f93776eb48ce706a90dab8ea4b` also preserves these pins.

| Package | Version | Candidate manifest SHA-256 |
|---|---|---|
| read-v1 | 1.1.0-rc.3 | `5429900843f60dee12e6d81793ea81f1ab3bedca32a492043b3f1e7f37dd964e` |
| session-v1 | 3.0.0-rc.2 | `278d5fa3f3a6571c92e13e39bddc3e1b9091a8ad82e4b83aa534cc9e83decd42` |
| onboarding-v1 | 1.0.0 | `2f6eb9f02b8cd2d06cddd4352e7db6fdae6b19bd7f2a91577a9ec15039b5d416` |
| deposit-v1 | 1.1.0-rc.4 | `be0e22ddfb5b6ea437a88999c9d924013bb5128af13060bd2af6f28a803848df` |

Pin the actual producer commit, package version and manifest together. These are
the combined producer digests, not the different standalone manifests. Recheck
them when a later source revision is selected for staging. Existing fixtures and
portable validators are available now for frontend adapter and rendered tests.
The candidate table is dated review evidence, not a moving alias for `main`;
recompute the selected release's pins after any subsequent provenance change,
including the later [OpenAPI follow-up #77](https://github.com/domino-money/domino/pull/77).

For each `scripts/staging/check_disabled_http.py` run, archive its JSON and the
installed commit from `/var/backups/domino-disabled/<commit>/installed.json` together
with a passing `check_filesystem.py --commit <commit> --archive <source.tar>
--archive-sha256 <sha256>` result using the independently verified release archive.
Treat `installed.json` as historical: its `upgrade-state.json`, when present, must
not have phase `rolled_back`, and exact current unit references plus independently verified
source identity must match the chosen installed commit; see
[upgrade state and rollback](VM_DISABLED_UPGRADE.md#interrupted-operation-and-rollback).
Record the checker source commit separately if it differs. HTTP output intentionally names the
observed header policy, not a release: responses alone cannot identify installed
code. The private-listener smoke requires both cache directives but does not
require their set to be exactly `{no-store, no-transform}`; this compatibility
choice does not weaken identity-encoding, duplicate-header or body checks.

The offline configuration inventory rejects alternate Wrangler filenames in
`bridge/` and the repository root, including case variants, named JSON/JSONC
files and `.wrangler/deploy/config.json` redirections. This is a repository
inventory, not a complete model of CLI resolution outside the repository.
Always select the reviewed file explicitly with
`--config bridge/wrangler.<service>.toml`; do not rely on default/upward discovery
or a generated redirect when deploying these candidates.

## Origin and route contract

Decimal owns Cloudflare, DNS, the Pages forwarder/service bindings and the
frontend gate. The [11 September handoff decision](https://github.com/domino-money/domino/issues/45#issuecomment-5634619206)
selects `APP_ORIGIN=https://domino.money` and the internal origins below. This is
configuration agreement, not evidence that DNS, Workers, Access or Tunnel exists.
Do not point a browser at the private Python reader or enable CORS as a shortcut.

The selected ingress is **Internet → `domino-app` Pages Function → private Worker
service binding → Access/Tunnel → loopback listener**. The Pages beta gate and
host checks run before dispatch. Verify the deployed Pages `_routes.json` includes the entire
application/API perimeter (an exclusion takes precedence over an inclusion), and
configure exhaustion/error handling to fail closed rather than serve ungated
static files. Workers Paid before enable does not replace these route checks.
Its API branch preserves `no-store`, JSON CSP
and the read family's cookie stripping. There are **no zone Worker routes,
custom Worker domains, workers.dev or Worker preview URLs**. The four concrete
`bridge/wrangler.{read,session,onboarding,deposit}.toml` candidates disable those
endpoints, logging and all four capability flags; they contain no credentials.
They configure Workers only. Decimal's separate frontend PR owns the forwarder
and, after the four Workers are deployed disabled, the Pages service bindings.

| Browser family | Worker / internal HTTPS origin | Private listener target | Initial ingress phase |
|---|---|---|---|
| `/api/read/v1/*` | `domino-read-bridge` / `https://vm-read.domino.money` | `http://127.0.0.1:8878/internal/read/v1/*` | Candidate; disabled |
| `/api/session/v1/*` | `domino-session-bridge` / `https://vm-session.domino.money` | `http://127.0.0.1:8879/internal/session/v1/*` | Candidate; disabled |
| `/api/onboarding/v1/*` | `domino-onboarding-bridge` / `https://vm-onboarding.domino.money` | `http://127.0.0.1:8880/internal/onboarding/v1/*` | Candidate; disabled |
| `/api/deposit/v1/*` | `domino-deposit-bridge` / `https://vm-deposit.domino.money` | `http://127.0.0.1:8881/internal/deposit/v1/*` | Worker/binding disabled; **no Access app, service token or Tunnel mapping yet** |

This table describes prefix translation, not an unrestricted wildcard proxy.
Only exact paths/methods in each Worker's dispatch table are accepted. Read
capabilities is local to the Worker; it is not a Tunnel route. All nine read
operations are POST: token, pools, pool-market, wallet-assets, nft-positions,
catalogue, pool-activity, pool-positions and pool-metrics. The session Worker
translates browser GET me to its internal contract; do not forward that browser
method directly. Port 8876, PostgreSQL, health/OpenAPI and unmatched/default paths
remain private; unmatched Tunnel traffic must return a fixed denial.

There are four distinct service identities/audiences in the eventual design,
but only read/session/onboarding are candidates for the first Tunnel phase.
Deposit must not borrow any of those identities. Its fourth Access app, service
token and mapping are deferred until its own admission/recovery gates pass.
Deploying its disabled Worker without secrets does not require early provisioning
of that fourth identity. No router port forwarding is needed.

### Web gate and trusted client identity

The owner-selected shared beta password already recorded in
`app/functions/_lib/gate.ts` is the invited-staging perimeter. This reconciles the
older web-origin Access requirement in `API_READ_BRIDGE.md`; it does **not**
replace the separate backend Access Service Auth applications. The password must
be generated with at least 100 bits of randomness and shared only with the named
tester list; record its count, never the password, in the release issue. The
existing 16-character code minimum alone does not prove that entropy. A shared
credential gives no per-tester authentication or individual revocation. Its
rotation is a global invitation revocation, separate from wallet grant/session
revocation. This policy is limited to invited staging, not public activation.

Before connecting bindings, enforce the production host allowlist and prove that
pages.dev, branch aliases and deployment-hash URLs cannot reach the application
or API. A new deployment does not update the gate in old deployments. Rotation
therefore includes redeploy and removal or proven denial of **every** superseded
reachable deployment and its bindings. Cloudflare may refuse deletion of a
branch's latest deployment; such a deployment is a release blocker until its
access/bindings are demonstrably removed. Do not claim deletion alone is a
complete rollback or revocation strategy. See
[Pages preview deployment behavior](https://developers.cloudflare.com/pages/configuration/preview-deployments/).

Only the reviewed `domino-app` production Function may bind to the Workers;
inventory all callers, preview deployments and routes before enabling anything,
and restrict/audit deployment, API-token and CI permissions that can grant a new
binding. The Wrangler public-URL flags do not enforce caller exclusivity.
A service binding is a capability held by its caller, not an end-user identity.
It does not by itself prove `CF-Connecting-IP` is the browser's IP. In particular,
another Worker can call the public app over HTTP without holding a bridge binding;
same-zone subrequests can influence the effective IP. Exclude those paths at the
trusted Cloudflare ingress using verified platform metadata/rules (for example
`cf.worker.upstream_zone`), scoped to the app host so legitimate BFF-to-origin
requests remain possible; never use a browser-supplied `CF-Worker` or forwarding
header. Test the actual Pages → binding path, including direct client spoofed
headers, same-/cross-zone Worker subrequests, IPv4/IPv6 and any client-IP transform
settings. The current header adapter is acceptable only after those conditions
are proven; otherwise the ingress needs a separately reviewed identity fix. See
[HTTP binding semantics](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/),
[Cloudflare client-IP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)
and the [upstream-zone field](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/cf.worker.upstream_zone/).

## Remaining inputs and backend candidate

Origins are selected above. Before starting the Tunnel or configuring live
ingress, Decimal records these non-secret values in the release issue:

1. Actual Access issuer, distinct audience/service identifiers and tested Service
   Auth policies for each service being connected; the fourth deposit identity
   follows only at its later gate. The Python side validates the real JWT.
2. Exact Tunnel mapping, transport/egress requirements, default denial, deployed
   Worker and Pages commits, binding inventory and alternate-host denial proof.
3. Trusted client-IP/framing behavior, log redaction/retention, named tester count,
   rotation procedure and the coordinated HTTPS acceptance window. Workers Paid
   must be in place before the first capability enable.

Connector credentials reach the operator only through the agreed private file
provisioning channel (encrypted to the operator's key), never GitHub, chat or a
shell argument. No key or credential is requested by this repository workflow.
Worker Access client secrets stay in Cloudflare. The listeners do not need copies
of those client secrets. The proposed systemd unit and its version/credential,
egress and start gates are documented in [Cloudflared staging](CLOUDFLARED_STAGING.md).
Starting the Tunnel for **disabled HTTPS acceptance** is distinct from enabling
any Worker/listener capability; all four flags remain false during that start.

The backend candidate adds `Cache-Control: no-store, no-transform` to the four
private listeners so intermediaries are instructed not to encode/transform their
identity JSON. The Workers retain their encoding rejection and byte bounds;
verify actual response headers/bytes through Cloudflare before enable. Neither
a header directive nor a local test proves the edge configuration obeys it.
This source update is not installed on the historical a5 VM: select one combined
reviewed release and refresh all changed package provenance pins before rollout.

Backend then supplies the matching VM configuration and installed build evidence.
The read gateway receives `DOMINO_ACCESS_*` and `DOMINO_BRIDGE_READS`; the other
listeners receive distinct `DOMINO_SESSION_ACCESS_*`, `DOMINO_ONBOARDING_ACCESS_*`
or, later, `DOMINO_DEPOSIT_ACCESS_*` settings. Private listeners share the exact
session origin and persistent server-side abuse secret. Provider credentials and
token admission are separate private provisioning. No signing key belongs on this VM.

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

Rollback removes/disables the four Pages binding forwards, sets the corresponding
Worker and listener flags false, and stops the affected service/Tunnel units while
preserving all database/private runtime evidence. There are no zone Worker routes
to disable in this ingress. Confirm superseded Pages deployments cannot retain a
working forwarder; keep a gate/host denial available during rollback.
Do not drop migrations, erase reservations/receipts or restore an old wallet
allowlist to make a rollback pass. Restoring a snapshot requires the release's
admission and deposit reconciliation procedure before re-enabling private ingress.
The initial empty-database backup/restore exercise does not certify recovery of
future issued wallet transactions, external NAS/offsite backups or power resilience.
