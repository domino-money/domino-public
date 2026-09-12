# Local frontend with authenticated development reads (#132)

## Delivery status and owners

This is the **disabled backend candidate and integration handoff**, not an
installed development environment or a completed Windows acceptance. The owner
authorized HTTPS development access in [#132](https://github.com/domino-money/domino/issues/132#issuecomment-5648636897).
No production/preview origin, Worker binding, application flag or provider
qualification changes as a result of running the offline tests in this change.

Rugged owns the development gateway, reader, provider/resource qualification,
VM installation and recovery. OxDecimal owns the Node launcher/proxy, Vite
integration, artifact guards and acceptance on the owner's Windows machine.
Use separate branches/worktrees and agree on interface changes in #132. Keep
#124 / PR #129 and the subsequent coordinated queue paused until this handoff
is accepted. #126 / #131 production acceptance remains complete.

The required path is:

```text
Windows browser
  http://127.0.0.1:5273  (real app/, uncommitted changes and HMR)
        ↓ same-origin /api/read/v1/*
  Node/Vite local launcher (only this process holds the dev Access secret)
        ↓ fixed HTTPS destination, development Service Auth headers
  dev-read.domino.money (separate Access application and connector)
        ↓ fixed origin; no public reader listener
  127.0.0.1:8891 development gateway, authenticated principal and admission
        ↓ fixed loopback HTTP, existing request/response validators
  127.0.0.1:8890 development reader, separate process/cache/cursors/budgets
        ↓ qualified providers and public SQL reads only
```

The hostname is an authorized provisioning target, not evidence that DNS,
Access or its tunnel has been created. Ports 8890/8891 and tunnel metrics 20242
were observed free by the sole VM operator on 2026-09-12 at 20:55:53 UTC; they
must be checked and reserved at installation. Existing production 8876/8878 and
the disabled private/financial listeners are outside this development path.

## Interface and contract notice

Read payloads remain **read-v1 1.1.0-rc.3**. No type, schema, producer fixture,
availability meaning or consumer response validator is changed. The same
`api-contracts/read-v1` requests/validators and `app/` ReadSource pipeline must
be used. Safe diagnostic metadata is a separate development protocol.
Its exact HTTP-200 schema and nine synthetic examples are published in
[`api-contracts/dev-status-v1`](../api-contracts/dev-status-v1/README.md).
Non-200 responses retain the existing finite read-v1 error body.

| Local route | Fixed development upstream | Method |
| --- | --- | --- |
| `/api/read/v1/capabilities` | `/internal/read/v1/capabilities` | GET |
| `/api/read/v1/<enabled family>` | `/internal/read/v1/<enabled family>` | POST |
| Launcher-owned local diagnostics | `/internal/dev/v1/status` | GET |

Exactly seven families are permitted: `token`, `pools`, `pool-market`,
`wallet-assets`, `nft-positions`, `catalogue`, `pool-activity`. The diagnostics
route is authenticated, bounded, and must not become an admin/health proxy.
`pool-positions` and `pool-metrics` are denied. Unknown paths, methods, query
strings, URL destinations, redirects and ambiguous encoded paths are denied.

Reads preserve `X-Domino-Read-Contract`, the existing finite error vocabulary,
safe request IDs and truthful source/snapshot/cache/coverage information. A
development credential failure is distinguished by HTTP status and protected
development diagnostics; do not put a new error string into the read contract.
Capabilities declare admission scope, not positive provider/index coverage.

Record **three different versions** at acceptance: the actual installed reader
and gateway commits, the contract version/manifest digest, and the frontend
checkout commit plus dirty state. The previous production receipt names reader
`0aebebc184355c8168fab67e9241c91765301840` and gateway
`807afe399fd250a6db83a4014aadf64d7e9af543`; frontend main
`7e7173cb31f9ab671693f3fdb01619ade688ab94` is not an installed backend version.
The development receipt must be filled from the reviewed installed artifact.

## Access, local listener and secret placement

Provision a separate Access application/AUD and a developer-specific service
identity with a seven-day renewable lifetime, default deny and a **Service
Auth** policy for that identity only. Do not reuse production credentials,
beta sessions or Pages/Worker bindings. The VM verifier needs the exact issuer,
AUD and service Client ID, not the developer's Client Secret. The local Node
process sends the dedicated `CF-Access-Client-Id` and
`CF-Access-Client-Secret` on each upstream request; it does not retain or replay
an Access cookie/JWT as a replacement for current credential validation.
[Cloudflare service-token documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

Store the local secret outside the checkout, every Vite `fs.allow` root and any
directory reachable through a symlink/junction from those roots. Use a private
user-only file under the owner's Windows configuration directory; document
and test its ACL in the launcher PR. A repository `.gitignore` entry alone
does not prevent Vite `/@fs/` exposure. No secrets in issue/chat, CLI arguments,
URLs, `VITE_*`, browser storage, bundles, sourcemaps or logs. Use synthetic
canaries for artifact tests. The precise secret-free profile example and
Windows command must come with Decimal's launcher implementation, not a
command that this backend-only candidate cannot start.

The local process binds only numeric `127.0.0.1`, one explicit port (default
5273), no automatic fallback. An alternate worktree chooses an explicit other
port; that process accepts only its exact Host and Origin including that port.
Validate raw Host, Origin, Fetch Metadata and WebSocket upgrade before handing
requests to Vite. Reject cross-origin requests including another localhost
port, unsafe CORS, cross-site navigation to API routes, CONNECT, arbitrary
targets and ambiguous paths. Validate body/response size, strict JSON and
contract responses; refuse redirects. An untrusted Host must not select an
upstream or a credential profile. Vite's own defaults are insufficient for
this boundary; use explicit checks and `strictPort`.
[Vite server options](https://v7.vite.dev/config/server-options).

Reconstruct upstream headers rather than forwarding the browser's headers.
Discard Cookie, Authorization, Origin and claimed forwarding/client identity.
The launcher never fabricates `CF-Connecting-IP` or `X-Domino-Client-Id`.
Cloudflare itself may add forwarding headers: the development gateway ignores
them for identity/budgets and does not send them to the reader. Its configured,
verified Access service principal is authoritative. Existing production
gateway/Worker identity semantics remain unchanged.

Use `local-live` only as a serve mode: the real bridge source and normal pool
selection, visibly identified as development, with session/financial execution
off. `vite build --mode local-live` must fail. Normal production builds must
never import the local proxy/profile or its markers. Existing labeled fixture
and bridge-test modes remain supplemental offline tools, not live acceptance.

## VM and provider isolation — activation gates

Independent review is required before activating this new access boundary,
under [REVIEW_POLICY.md](REVIEW_POLICY.md) and the issue's explicit acceptance
condition. Passing unit tests is not approval of an installed namespace,
firewall, SQL role, tunnel mapping or quota allocation.

The operator's read-only inspection found 4 vCPU, approximately 7.06 GiB
available memory and no sampled pressure. This supports preparing a separate
process; it does not establish provider-account capacity. Proposed isolated
UIDs 974/975/976 were free, not allocated. Review the final host inventory
before choosing names/IDs.

The installation plan uses the dedicated root-level `dominodev.slice`, CPU quota
50% (half one vCPU), CPU weight 10, MemoryHigh 768 MiB, MemoryMax 1 GiB,
TasksMax 64 and low I/O priority; proposed child memory limits are 512 MiB
reader, 192 MiB gateway and 128 MiB connector. Verify supported controls and
actual aggregate usage in the installed receipt. Keep production units and
their process slots separate; never point the development gateway at 8876.

Reuse immutable reviewed code/dependencies, with separate runtime/provider
configuration, admission, locks, caches and cursor secrets. Config and
admission directories must be mounted read-only in service namespaces while
the operator can atomically replace the source files outside the namespace.
Bind the directory, not only a file inode. A mode-0600 file owned by a service
UID is not operator-controlled if that service can rewrite it. Provider keys
remain in the reader namespace; the gateway has no provider/DB credentials,
and the connector can reach only its exact gateway origin and required tunnel
endpoints. Review new UID/socket/cgroup/egress/namespace rules together.

Share only public catalogue/activity tables through a distinct read-only SQL
role: CONNECT/USAGE/SELECT explicitly enumerated, no private schemas, role
inheritance, writes or arbitrary SQL API; connection limit 1. Apply per
transaction read-only mode, statement timeout 1000 ms, lock timeout 100 ms,
work_mem 1 MiB and connection timeout 2 s. Existing staging guards require
an exact role/ACL/peer inventory and zero persistent `pg_db_role_setting`
entries. Their reviewed extension must accompany provisioning; do not add a
role or `ALTER ROLE SET` silently and invalidate the existing guard.

Conservative candidate ceilings are one development operation at a time,
6 starts/minute, spacing at least 2 seconds, no reader queue, upstream at
most 15 seconds and gateway total 20 seconds. Bodies are at most 8 KiB and
responses 1 MiB. These ceilings apply across tabs/worktrees; local restart
cannot reset the remote quota. Ambiguous cancellation/timeout does not prove
reader completion, so admission stays bounded and reconciles reader busy
state before a new operation. No extra blind retries or automatic polling.

Count provider work at the actual transport: RPC batch items, identity checks,
fallback attempts and optional inventory all consume budget. Initial
defensive ceilings are 64 logical RPC items per operation, 120/minute,
GeckoTerminal 3 calls/minute and DexScreener 6 calls/minute. A reader restart
must not reset an allowance into an immediate new burst. Inputs remain generic
and validated; a large request may honestly exhaust its budget. Do not claim
all maximum-size requests have been qualified.

**These numeric ceilings are not a provider reservation.** Before activation,
record the Alchemy account's actual throughput/CU limits, Robinhood method
costs, other app consumption and a reserved development share (or genuinely
independent quota). Another API key on the same account is insufficient.
For Gecko, verify the actual shared-IP allowance and other consumers before
claiming that production's 25 plus development's 3 fit. Include restarts and
every provider-using process in that aggregate. For Dex, likewise record other
consumers and the endpoint allowance. Until this evidence and its enforcement
are reviewed, keep development admission disabled and perform only offline
tests. Do not weaken production limits to make the candidate appear live.

## Backend CLI and private profile templates

These are **operator-side** commands for the reviewed installed release; they
are not the Windows launcher. Run under the dedicated service identities and
the reviewed namespaces, never as a shortcut around the installation review.
Without `--enable`, the entrypoints do not admit development reads:

```sh
python backend/dev_read_service.py
python backend/dev_read_gateway.py --profile /etc/domino-dev/gateway/profile.json \
  --runtime-dir /var/lib/domino-dev/dev-read-gateway --port 8891 --reader-port 8890
```

The reader's eventual activation command adds
`--enable --profile /etc/domino-dev/reader/profile.json`; the gateway adds
`--enable`. This requires independently reviewed installation, provider
reservation and populated private profiles, not just an authorization flag.
Paths in this example must match the final reviewed operator mount plan.

Gateway profile, with placeholders that deliberately fail validation until
filled from the private provisioning and installed-release receipt:

```json
{
  "version": 1,
  "issuer": "<exact development Access issuer>",
  "audience": "<development AUD, 64 lowercase hex>",
  "serviceId": "<dedicated development service Client ID>",
  "gatewayPort": 8891,
  "readerPort": 8890,
  "readerCommit": "<installed reviewed reader commit, 40 lowercase hex>",
  "gatewayCommit": "<installed reviewed gateway commit, 40 lowercase hex>",
  "contractManifestSha256": "<verified read-v1 manifest digest, 64 lowercase hex>",
  "requestsPerMinute": 6,
  "burst": 2
}
```

Sibling `admission.json`, replaced atomically by the operator; do not cache
grants in the launcher or gateway:

```json
{"version":1,"enabled":false,"serviceId":"<same dedicated development service Client ID>","expiresAt":0}
```

Reader profile (this file may contain private provider URLs once provisioned,
so it is accessible only to the dedicated reader inside its read-only mount):

```json
{
  "version": 1,
  "kind": "domino-development-reader",
  "enabled": false,
  "runtimeDirectory": "/var/lib/domino-dev/reader",
  "rpcUrls": ["<qualified RPC URL configured privately>"],
  "inventoryUrl": null,
  "catalogue": null,
  "quotaQualification": {
    "approved": false,
    "expiresAt": 0,
    "receiptSha256": "<reviewed quota and isolation receipt digest, 64 lowercase hex>"
  }
}
```

To provide the approved inventory and public SQL coverage, the operator
privately fills the qualified inventory URL and
`catalogue:{"host":"<private Unix socket directory>","port":<reviewed port>,"dbname":"domino_catalogue"}`
after installing the distinct `domino_dev_catalogue_reader` role and grants.
Null configurations explicitly mean that coverage is not configured; they
cannot be used as the final seven-family acceptance receipt.

All profiles use the exact bounded schemas implemented by the entrypoints.
The profile directory and its files must be owned by that component's dedicated
service UID: directory mode 0700, gateway profile/admission mode 0600 (reader
profile 0400 or 0600). Writable runtime directories are separately self-owned
0700. Root-owned ancestor directories such as `/etc` are supported, but a
root-owned profile leaf fails the runtime ownership check. The operator must
therefore combine this ownership with the read-only namespace mounts; mode
bits or ownership alone do not grant operator-exclusive mutation.
Gateway profile and reader provider/qualification configuration are loaded at
startup; changes require a service restart. Gateway `admission.json` is reread
at each request and before read dispatch, so revocation does not wait for a
restart. Reader qualification expiry also stops DB-only reads. Configuration
and runtime directories are distinct and private; never point them into a
code checkout or the production runtime.

The reader enforces a full **60-second startup cooldown**. Do not interpret
an enabled gateway flag as a ready reader. Protected status projects only
validated local reader admission states (including cooldown/unavailable) and
always labels provider health as unprobed. Complete installation warm-up
before Windows acceptance; show a bounded wait/manual Retry if a reader
restarts while the launcher is open. Do not turn that wait into data polling.
Cheap authenticated status/capability checks have a separate bounded control
budget (30/minute, burst 5), so a startup handshake cannot spend the two-token
data burst. Reader data admission remains the stricter global six-start
rolling-minute envelope; a gateway token-bucket rate is not a provider quota.

## Revocation, renewal and recovery

1. Operator disables the development admission file first. Every new request,
   including one with an already issued valid assertion, must fail closed.
   Remove/stop the dev connector/gateway if an immediate transport shutdown
   is required; never reopen production ingress as a fallback.
2. Disable/delete the dedicated Access service token and confirm both a new
   authentication attempt and an already established client's next request
   fail. Account for a read already admitted before revocation: it may finish
   within its existing deadline, but cannot admit another operation.
3. Renewal/rotation is dev-only: deliver the replacement privately, update
   the verifier principal if the Client ID changes, invalidate old admission,
   confirm old credential rejection, then run the bounded acceptance probe.
   Do not assume a signed JWT becomes invalid just because a key was rotated.
4. Stop the local launcher with Ctrl+C; close Vite/HMR, pending local requests
   and upstream connections. Operator rollback removes only the new dev
   route/unit/profile after recording admission disabled. Confirm the prior
   production manifest/processes and access gates remain intact.

Report downtime/expiry/rate-limit/contract-mismatch in #132 to Rugged with UTC,
safe request ID and installed version only. Decimal owns Windows launcher
recovery. Do not publish provider bodies, URLs with keys or private-address
payloads. There is no public administrative health endpoint or uptime SLA
implied by this candidate. UI retry must remain bounded and explicit.

## Required Windows acceptance receipt

The owner and Decimal complete this on the actual Windows development machine
after independent review and installation, with Rugged observing sanitized
VM counters. A remote smoke test or credentials alone is not completion.

1. Record Windows/Node versions, local checkout SHA/dirty state, exact loopback
   port, installed reader/gateway SHAs, contract/manifest and enabled routes.
   The documented launcher checks auth/readiness and starts Vite/HMR without
   Python, Docker, a second database, production cookies or provider keys on
   Windows. If WSL is intentionally used instead, document and test it.
2. Edit visible wording or styling without a commit; confirm HMR reflects it
   while that same normal UI screen obtains real backend data. Record the
   local diff and a sanitized screenshot/read receipt. No push, PR, cloud
   preview or publication is required for this edit/test cycle.
3. Exercise generic token, pool search/selection, public wallet assets,
   catalogue and supported NFT/activity UI. Record actual HTTP/read states,
   source, block, age and coverage; leave empty/unindexed/disabled and untested
   positive pagination/history explicit. Use the public examples below, never
   copy personal bot or tenant data.
4. Test missing/expired/revoked access, already-open client after revocation,
   renewal, wrong Host/Origin and HMR Origin, another local port, cross-site
   API requests, query/encoded paths, arbitrary destination/redirect, oversize
   input/output, cancellation and two tabs/worktrees plus reload bursts.
   Count actual provider work and ensure production slots/quotas are protected.
5. Prove a synthetic local secret cannot be read through Vite `/@fs/` or
   symlinks/junctions and is absent from production assets/sourcemaps. Confirm
   local-live cannot build, and existing release/preview guards and required
   CI pass without development profiles or secrets.
6. Record the owner's explicit acceptance of the real design/data workflow,
   remaining coverage limits and a tested stop/revocation/rollback receipt.
   Then close #132 and resume the agreed next priority. Do not mark this
   receipt complete using offline fixtures or a server-only request.

## Maintained public examples and coverage

These are public chain inputs, not personal accounts. They are drawn from the
[four-family production UI receipt](https://github.com/domino-money/domino/issues/126#issuecomment-5648120992),
[three-family production UI receipt](https://github.com/domino-money/domino/issues/126#issuecomment-5648518228),
`app/src/config/selectedPools.ts` and
`reports/ALPHA_MARKET_REQUALIFICATION_2026-09-11.md`. Those historical responses
are examples of interpretation, not frozen expectations for the new service.

| Input | Public value |
| --- | --- |
| Chain | 4663 |
| WETH ERC20 | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` |
| USDG ERC20 | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` |
| MARLIN ERC20 | `0xab35d04e1ee39c789c4a65d522417b3c7f2e4723` |
| WETH/USDG pool, 200 pips, spacing 4 | `0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6` |
| USDG/MARLIN pool, 50000 pips, spacing 500 | `0xdb922f0619e11b0c1e6c3a142798f0243060b8a4331ea4f4e7de80e898cc02e7` |
| Public position NFT | `2235738` (decimal string) |
| Public wallet probe / separate native currency selector | `0x0000000000000000000000000000000000000000` |

The zero address as a wallet query does not identify the owner or a connected
wallet, and does not imply a zero native balance. The same literal in a token
list means native ETH; it is not WETH. NFT 2235738 had zero liquidity in the
recorded snapshot, but its current state must be reread. Public ownership at
a block never proves wallet control or authority to transact.

| Family | Normal UI and representative request | Observed coverage to preserve |
| --- | --- | --- |
| capabilities | Local startup; GET without body | Seven enabled reads when admitted, chain 4663 and contract rc.3; wallet/private/transactions/automation false. Not a provider-health assertion. |
| token | `#/pools` token dialog, Check address; `{"token":"0x0bd7d308f8e1639fab988df18a8011f41eacad73"}` | WETH was available at block 61387684. Validate new address/chain/snapshot, not a historical block equality. |
| pools | Apply the token; same request as token, optional explicit USDG `pairedToken` | Receipt returned 30 discovery candidates and 8 verified v4 pools at block 61387913. Counts can change. Discovery is partial; Dex figures are attributed; APR is unavailable. |
| pool-market | Landing's selected pools; `{"poolId":"0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6","includePriceHistory":false}` | Both maintained pools had available Gecko observations. Preserve retrieval age, cache state, snapshot, null APR and provider attribution; this does not qualify charts/history. |
| wallet-assets | Token dialog → List tokens from a public address; `{"wallet":"0x0000000000000000000000000000000000000000","tokens":["0x0000000000000000000000000000000000000000","0x0bd7d308f8e1639fab988df18a8011f41eacad73"],"autoDiscover":true}` | Native ETH plus explicit zero WETH returned at block 61390266, page 1 terminal. Test automatic inventory without explicit tokens separately. Neither proves broad funded-wallet inventory or a second page. |
| nft-positions | `#/app` → Positions → Public chain lookup; `{"tokenIds":["2235738"]}` | Receipt had one zero-liquidity card at block 61345052, USD unavailable, owner only at snapshot. Preserve a changed/nonexistent current outcome honestly. |
| catalogue | Token dialog → More sources → Load catalogue candidates; `{"token":"0x0bd7d308f8e1639fab988df18a8011f41eacad73","limit":20}` | HTTP 200 with zero candidates in interval 58736592–not yet indexed. This does not mean no pools exist. Positive pagination/revision restart remains untested with live data. |
| pool-activity | Open a selected pool's figures; same `poolId` request without price options | Both pools returned `activity_pool_not_registered` (503). This is absent indexed coverage, not zero activity or a broken credential. |
| pool-positions / pool-metrics | No development forwarding | Disabled, regardless of the existence of response models. Public NFT lookup does not need pool-positions enabled. |

Generic addresses/pool IDs remain supported within the existing schema bounds:
up to 20 requested pools, 10 explicit PoolIds, 10 explicit token addresses,
10 unique NFT strings and catalogue page size up to 100. Catalogue continuation
requires the matching revision. These maxima are contract bounds, not a claim
that each maximal request completes under the conservative development budget.
Live positive pagination, populated catalogue/history and broad inventory
coverage are still unqualified; labeled synthetic tests may cover their UI.

## Future capability/dependency map

| Future flow | Existing contract | Separate work required before real local use |
| --- | --- | --- |
| Wallet login/private account | `session-v1` 3.0.0-rc.2 | Dedicated dev session ingress/audience, admitted test account, SIWE consent, origin/cookie/CSRF design. The chosen read-only HTTP loopback does not automatically solve Secure `__Host-` session cookies. Access service authentication does not identify a wallet owner or supply private portfolio/settings APIs. |
| Swap/LP onboarding previews | `onboarding-v1` 1.0.0 | Reviewed dev session/CSRF, server-derived owner, provider qualification/quotas, validity/unit checks and frontend contract ACK. Preview does not authorize spending; its routes are absent from this read allowlist. |
| Deposit preparation/reconciliation | `deposit-v1` 1.1.0-rc.4 | Separate financial/access review, test accounts or isolated fork, durable state, exact-step expiry and owner authorization. No approval/signature/swap/mint/production execution under #132. |
| Missing private/financial screens | #124 / PR #129 | Resume only in the coordinated queue, with contract/pin/fixture and consumer notices. Do not import that candidate into the development read boundary or present fixtures as real balances. |

These contract references are dependency pointers, not a claim that their
historical disabled candidates are currently deployed. #132 grants only the
explicit seven public read families. No personal bot/runtime, signer, fee
switch/buyback/burn, compounding or transaction execution enters this path.
