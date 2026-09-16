# Native local real-data development (#132)

This is a review candidate, **not an activated development service**. It is
independent of production/preview Pages, Workers, cookies and the existing
production tunnel. It depends on the canonical `api-contracts/dev-status-v1`
package delivered in PR #134 and the operator's independently reviewed
development gateway, provider reservations and dedicated Access identity.

## Once the new development boundary has been reviewed and provisioned

Use the existing supported Node installation (Node 24 LTS recommended); no
Python, database, Docker or WSL is needed on Windows. Install locked packages:

```powershell
npm --prefix web ci
npm --prefix app ci
```

The owner provisions a dedicated **development** Service Auth credential in a
private Cloudflare session. The approved arrangement is a one-year underlying
Cloudflare credential, with gateway admission and reader qualification expiring
after seven days. The longer token lifetime does not extend backend access.
Do not generate a production
token or reuse beta/session cookies. Never send a token in chat, issue, PR,
terminal command arguments, environment variables, VITE variables, clipboard
logs, browser storage or a source file. The development gateway operator gets
only the agreed non-secret verifier identity, never the Client Secret.

In your own private terminal, run this script and paste the dedicated Client ID
and Client Secret into its **hidden interactive prompts**:

```powershell
powershell -NoProfile -File app/scripts/setup-local-live.ps1
```

This writes only `%LOCALAPPDATA%/Domino/local-live/access.json`, outside all
checkouts and served roots, with an owner-only, non-inherited Windows ACL. It
refuses existing files, nonempty or non-private directories, and ancestor
reparse points. After a cancelled or mistyped prompt, an empty owner-only
directory can be reused safely without overwriting or deleting anything. It does not
activate or contact any service. The launcher independently checks location,
ownership/ACLs, links, file size and the closed credential format before Vite
starts. Current `cfast_` and legacy credentials are accepted. Local admins and
other code running as the same Windows user are outside this process boundary.

```powershell
npm --prefix app run dev:live
# Explicit alternate port for another worktree; no automatic fallback:
npm --prefix app run dev:live -- --port 5280
```

Open `http://127.0.0.1:5273/#/pools` (or the explicit port). `localhost` and other
hostnames deliberately fail. Click **Check connection** for safe, validated
diagnostics; it does not poll or probe providers. The normal components use
the existing ReadSource, validators, scheduling and real selected pool IDs.
No mock response or financial/session capability is enabled. Edit normal
frontend files and Vite updates the local page. Ctrl+C stops HTTP, HMR and
upstream operations. Nothing here pushes, merges or publishes frontend code.

Only the fixed `https://dev-read.domino.money` target is possible. The proxy
maps exactly read-v1's ten read POSTs and its capabilities GET, read-v2's
capabilities GET and pool-market POST, plus a separate development status GET.
It cannot reach sessions, deposits, arbitrary paths/URLs/queries or redirects.
Access headers are added server-side; browser cookies, authorization, Origin and
client-IP headers never go upstream. Responses must match canonical contracts;
only contract/request-ID/retry headers and validated JSON can return.

Exact Host/Origin/Fetch Metadata admission runs before Vite and HMR. A
request-time canonical file guard also covers public files and links created
after startup, where Vite's ordinary filesystem deny list is insufficient.
Dotenv loading and VITE environment inputs are disabled in this launcher.

Admission is bounded locally: eight pending readers, no queue, one actual
upstream operation; identical overlapping bytes may coalesce under the first
deadline. Requests are at most 8 KiB, replies at most 1 MiB, total deadline
20 seconds. No proxy retries or polling. The existing browser scheduler keeps
its reviewed bounded retry behavior. The remote verified developer identity
owns authoritative quotas across tabs/worktrees/restarts; no spare provider
capacity is assumed by this launcher. A cancelled transport occupies its slot
until settled, rather than assuming the remote reader already stopped.

## Diagnostics, renewal and limits

- Access rejected: expired, missing, wrong or revoked dedicated access can
  look alike. Coordinate with Rugged; do not enter a production password.
- Unavailable: service/network/readiness may be down. A manual retry is
  available; no empty data is fabricated.
- Incompatible: version/schema/header or response validation failed. Report
  the agreed versions and safe request ID, not response bodies/secrets.
- Busy/cooldown/qualification disabled/expired: inspect the separate reader
  state and respect operator budgets. Enabled reads do not prove readiness.
- Backend SHA/manifest is labeled **operator-attested profile metadata**, not
  runtime measurement. Status always says provider health is **not probed**.

Coordinate backend admission/qualification renewal before seven-day expiry.
For credential rotation, revoke old gateway admission as
well as its Access token, then arrange a private replacement and verify old
credentials fail. This setup intentionally refuses blind overwrite; review
the exact old private file before a controlled replacement. Never change
production identity or tunnel to recover local access.

Catalogue may be empty, activity unindexed, APR unavailable and inventory
partial. These are data states, not failed credentials. Maintained public
examples and the private/financial dependency map belong to the canonical
`docs/LOCAL_LIVE_DEVELOPMENT.md` runbook. The owner must still validate an
uncommitted visible HMR edit together with real normal-UI reads on Windows,
plus remote revocation and bounded concurrent use, before #132 is complete.

## Offline verification

`npm --prefix app run test:local-live` runs boundary, build, real-browser HMR,
strict proxy, canonical status and synthetic secret-leak tests. They also run
through the existing `npm test`/`check:app` path. These use no real credentials
and no live backend. `npm --prefix app run build` still makes the unchanged
deployable mode; `vite build --mode local-live` is forbidden for every output.
Release/build scans reject local-only markers and credential header names.

**Still gated separately:** independent app boundary review/current CI, exact
dedicated Access provisioning and seven-day backend admission, VM installation/qualification/activation,
Windows real-data/HMR acceptance, revocation/rotation, and owner approval.
