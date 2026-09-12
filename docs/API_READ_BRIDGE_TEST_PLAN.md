# Read bridge acceptance and test plan

This is the implementation acceptance plan for [API_READ_BRIDGE.md](API_READ_BRIDGE.md).
The design PR alone supplied no runtime evidence. The implementation candidate
now records completed offline checks and remaining deployment/frontend cases in
[READ_BRIDGE_IMPLEMENTATION.md](../reports/READ_BRIDGE_IMPLEMENTATION.md).
Use synthetic providers/identities in CI; staging service-identity tests require
a separate deployment and no production credentials or wallet funds.

## Contract and consumer tests

| ID | Scenario | Required result |
| --- | --- | --- |
| C01 | Generate request and response schemas from actual producer models | Committed schema matches; correct success, error and 422 bodies |
| C02 | Pass real-service/fake-provider responses through shared schema and frontend adapter | Both producer and consumer accept the same fixture corpus |
| C03 | Delete/rename `reportedLiquidityUsd`; change a raw amount to a number or alter nullability | Contract checks fail; consumer reports incompatible data instead of showing zero |
| C04 | New major, missing version header, changed enum or unknown capability | No new live render/actions; old timestamped data remains visibly old |
| C05 | Zero decimals, missing decimals, null/zero USD, rejected market, not-requested history and schema-valid malicious metadata | Distinct UI states; chain/address identity retained; text escaped and no automatic metadata URL fetch |
| C06 | Optional compatible field on old consumer | Old consumer passes; schema diff and minor-version notice recorded |
| C07 | Display same pool with opposite provider chart orientation | Chart uses actual currency address; no symbol/token0 inference |
| C08 | Deployed frontend old/new × backend old/new during upgrade and rollback | Every supported combination passes; incompatible combinations fail explicitly |

## Boundary and abuse tests

| ID | Scenario | Required result |
| --- | --- | --- |
| B01 | Allowed exact method/path versus encoded traversal, extra suffix, URL/query relay, JSON URL, unknown chain and RPC method | Only fixed map reaches fixed upstream; all other requests cause zero provider calls |
| B02 | Direct origin/reader access, missing/invalid/expired Access assertion, wrong issuer/audience/algorithm/key/service identity | Denied; no provider call, no login redirect fallback |
| B03 | Key rotation and expired JWKS cache, attacker-controlled `jku`/`x5u` | Fixed key host only; bounded refresh; unknown/unverifiable key denied |
| B04 | Foreign/sibling/null/missing POST Origin, conflicting Host/forwarded headers, cross-site Fetch Metadata | Rejected before upstream; valid same-origin GET without Origin remains usable |
| B05 | Browser sends Access, Authorization, Cookie, Origin, X-Forwarded or client-budget headers | BFF replaces identities; gateway reconstructs only allowed local request headers |
| B06 | Chunked body over 8 KiB, slow upload, compressed request, wrong JSON type, duplicate sensitive headers | Deterministic rejection within bounds; no secret/input echo |
| B07 | Upstream HTML/redirect, malformed/oversized JSON, arbitrary 5xx text, Set-Cookie | Sanitized bounded JSON error; no redirects/cookies/provider text reach browser |
| B08 | Concurrent/rapid reads from multiple edge workers and a single IP/account; key-table exhaustion | Global and per-key limits hold, bounded memory and Retry-After; no queue |
| B09 | Browser disconnect, one slow RPC and deadline just before another RPC | No deadline reset or duplicate retry; admission follows actual work completion |
| B10 | Limiter/service identity unavailable, credential rotation/revocation | Fail closed with safe availability state; no direct-RPC/CORS bypass |
| B11 | Non-allowlisted routes including health, OpenAPI, internal capabilities and all write selectors | No upstream dispatch; practice routes retain their behavior |
| B12 | Gateway and local-reader middleware together | Authenticated relay succeeds while direct browser localhost access still returns 403 |

## Freshness and pagination tests

| ID | Scenario | Required result |
| --- | --- | --- |
| D01 | Provider success then refresh failures at original retrieval ages 59, 60, 300 and 301 seconds | Fresh <60; stale fallback <=300 only after failure; unavailable >300; failures/retries never reset age |
| D02 | Chain verification fails while provider cache remains populated | Whole read fails; cached provider metric does not claim a current verified snapshot |
| D03 | Late response after wallet/token/pool/chart change | New selection cannot receive old response; cache keys separate contexts |
| D04 | Failed live read and local practice data both exist | No fallback from live to mock values under a live label |
| D05 | Compare producer and browser cursor fixtures, decode browser handle, swap wallet/normalized fallback list, tamper, replay after expiry or restart | Internal cursor substituted before output; no provider pagination state disclosed; wrong/stale context produces 400 |
| D06 | Retry and repeated cursor wrapping near internal expiry | TTL never extends; at-capacity allocation fails explicitly; no active entry eviction |
| D07 | Catalogue revision changes between pages | 409; restart same pair at first page, preserve partial/old coverage distinctly |
| D08 | Wallet/NFT requests made by two anonymous users | No shared HTTP-cache leakage; no private-owner assertion or private account access |
| D09 | Enable multiple gateway/reader processes by mistake | Deployment validation rejects unsupported topology before traffic |
| D10 | Pool unknown to local catalogue | Bounded on-demand provider read, never lifetime backfill; missing data remains unavailable |

## Session tests for the later session slice

| ID | Scenario | Required result |
| --- | --- | --- |
| S01 | Wrong domain/URI/chain/address/message/context, old/future timestamp, unexpected fields | SIWE rejected; no session |
| S02 | Two concurrent valid verifications, timeout after consume, reused signature after logout | At most one session; consumed challenge cannot be reused |
| S03 | Attacker creates a challenge and sends the victim its message | Pre-login browser binding prevents login CSRF/session substitution |
| S04 | Invalid signature spam, attempt exhaustion, distributed IP/address probes, oversized/slow/compressed auth body and overlong message/signature | Central limits and streamed body/deadline/parser bounds enforced without account-existence leak |
| S05 | Plain EOA, code-bearing/delegated EIP-7702 account, ERC-1271 and counterfactual signatures, failed code read, code changes after login | Only qualified plain EOA path admitted initially; changed code revokes session; unknown code denies private request; public reads remain usable |
| S06 | Cookie theft/fixation simulation, missing/wrong CSRF, sibling-origin logout/write, bootstrap during login | Session rotates; exact Origin/CSRF required; bootstrap cannot reset authenticated session |
| S07 | Absolute/idle expiry boundaries, shared-store logout, server restart, failed session store | Server-side expiry/revocation; no authentication bypass or stale positive cache |
| S08 | Wallet changes account/network without server notification | UI clears private data; server still binds only existing session identity, never client-supplied owner |
| S09 | Cross-owner record IDs/tenant fields; reader role attempts auth-table access | Denied; public owner lookup or cursor cannot authenticate a private record |
| S10 | Inspect logs, telemetry, browser storage, cookies and error reports | No signatures/secrets/session tokens/raw payloads; cookie attributes and retention policy verified |

## Release evidence and rollback drill

[Execution policy](EXECUTION_POLICY.md) supersedes historical owner, ACK and
approval procedures here. Any authorized collaborator or agent may implement
and operate within scope, recording results alongside or after execution.
Technical controls, compatibility evidence and wallet consent still apply.

Validate C01–C08, B01–B12 and D01–D10 for real data and record the evidence
with backend/frontend commits, contract digest, environment, enabled routes
and any review findings alongside or after delivery. Catalogue/history cases may
remain blocked only while those routes stay disabled. Sessions stay disabled
until S01–S10 and private-schema isolation tests pass in their later slice.

Perform a staging drill using a separate Access identity: missing/rotated token,
provider outage, incompatible backend deployment and live-read flag rollback.
Check that the separate tester-access gate protects both app pages and API
paths, with no alternate hostname bypass and no confusion between tester,
backend service and wallet identities.
Verify the actual edge origin, cookie/log behavior and hidden origin access;
unit tests cannot establish deployed network isolation. Record results without
credentials or user wallet identifiers. Load-test the selected route mix against
the proposed limits before expanding the cohort; do not infer capacity from the
two-pool developer probe.

Record producer/consumer compatibility under API_COMPATIBILITY.md; no other
collaborator's acknowledgement is required to execute the scoped work.
Confirm that rollback disables real reads visibly, preserves old timestamps,
does not relabel practice data and leaves existing wallet/chain authority alone.

## Issue #5 acceptance mapping

| Requirement | Specification / evidence plan |
| --- | --- |
| Same origin, deployment separation, allowed requests, service identity | Bridge deployment and route sections; B01–B05, B10–B12 |
| Public reads versus private owner configuration | Decision, pagination and session sections; D08, S08–S09 |
| Replay, expiry, logout, per-user/per-IP controls | Session design and budget tables; B08, S01–S09 |
| Bounds, freshness, errors, fixed providers | Browser contract and failure sections; C01–C08, B06–B09, D01–D10 |
| Secrets, caching, outages, audit | Observability and rollout; B07/B10, D01–D04, S10, staging drill |
| Keep localhost/browser restrictions | Existing Origin/Host boundary retained; authenticated gateway + reader integration tested; deployed isolation pending |
| Notice of fields or real-data changes alongside or after delivery | API_COMPATIBILITY.md; compatibility evidence and C08 release matrix |
