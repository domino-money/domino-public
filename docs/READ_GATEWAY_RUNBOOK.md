# Read gateway candidate runbook

This candidate implements public-data reads only. The selected application origin
is `https://domino.money`. Cloudflare credentials, DNS, Access, Tunnel and public
activation are deferred; these instructions do not imply they exist. The example
`https://vm-read.domino.money` is a proposed separate backend hostname.

## Local preparation

Use the repository's pinned Python dependencies and Node 24. Work in the product
checkout, never in a sibling personal bot or its runtime. Local provider keys
belong to this backend's ignored configuration. Offline tests use fake providers,
ephemeral RSA keys and a disposable public-catalogue database; no funds are needed.

```sh
backend/.venv/bin/python -m pip install -r backend/requirements-api.lock
backend/.venv/bin/python scripts/export-read-contract.py --check
backend/.venv/bin/python scripts/export-read-openapi.py --check
npm run check:read-bridge
```

Run the reader in one terminal, explicitly using the bridge's shorter budget:

```sh
backend/.venv/bin/python backend/read_api.py --port 8876 --read-budget 15
```

Run the gateway in another terminal, disabled by default:

```sh
backend/.venv/bin/python backend/read_gateway.py --port 8878 --reader-port 8876
```

The disabled gateway returns 404 for read requests and performs no provider work.
Both listeners bind to `127.0.0.1`; neither is a public development server. Stop
each with Ctrl+C. Port 8765 is excluded from the gateway and its reader target.
The gateway holds `backend/runtime/read-gateway.lock` until exit; do not delete
that file to bypass a running process. The OS releases the lock on process exit.

One reader and one gateway are supported. Their CLI pins one worker and rejects
conflicting `WEB_CONCURRENCY`/`UVICORN_WORKERS`. A deployment supervisor must also
prevent independent reader replicas. Do not enable autoscaling: admission,
provider cache, IP budgets and opaque cursor storage are in memory. Restarting
either process invalidates outstanding wallet pagination; restart at page one.

## Service identity and activation configuration

After the separate staging infrastructure is ready, provision these gateway
environment values locally or through its service's secret/config store:

| Name | Meaning |
| --- | --- |
| `DOMINO_ACCESS_ISSUER` | Exact `https://<team>.cloudflareaccess.com` issuer |
| `DOMINO_ACCESS_AUDIENCE` | Exact Access application audience, 64 lowercase hex |
| `DOMINO_ACCESS_SERVICE_ID` | Exact admitted BFF service client ID |
| `DOMINO_BRIDGE_READS` | Comma-separated subset of the nine read suffixes |

Only then does the gateway's explicit `--enable` flag admit authenticated reads.
No browser or request field can supply these settings. The gateway requires the
signed `Cf-Access-Jwt-Assertion` from Access; merely possessing a client header
does not authenticate an incoming request. It verifies RS256, fixed issuer and
audience, expiry, service `common_name`, `type: app` and empty `sub`. These service
claims follow the [Access application-token contract](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).
Real staging must confirm the actual claim shape and test rotation/revocation.

Cloudflare Access may also forward `Cookie: CF_Authorization=<assertion>` on the
service request. The gateway accepts this transport duplicate only when it is
the sole cookie and its value exactly equals `Cf-Access-Jwt-Assertion`; the full
signed service-identity verification remains mandatory. A cookie alone never
authenticates a request. Other cookies, duplicate cookie headers, mismatched
assertions, Origin and Authorization headers remain rejected. The gateway never
forwards cookies to the reader or sets a browser cookie.

When the tunnel's ingress uses `originRequest.access.required=true`, cloudflared
also fetches the issuer's `/cdn-cgi/access/certs` before forwarding. Its service
identity therefore needs the issuer's approved HTTPS destinations in addition to
the tunnel edge transport and local gateway. A Healthy tunnel by itself does not
prove this authenticated path; verify the real token POST end to end.

The BFF receives its separate Access client ID/secret through Worker secrets.
See [bridge/README.md](../bridge/README.md) and its disabled example configuration.
Mount only `/api/read/v1/*` at the application origin, with an independent tester
Access gate protecting app pages and API paths. Disable alternate preview routes.
The backend Tunnel must expose only the fixed gateway read paths and deny all
unmatched ingress. Never expose the reader, database, health or OpenAPI directly.

## Bounds and failure recovery

- BFF total budget: 20 seconds; upload: 5 seconds; upstream: at most 15 seconds.
- Gateway body: 8 KiB; response: 1 MiB. One admitted operation, one start/second,
  authoritative per-IP 30/minute with burst 5; no pending read queue.
- The gateway uses numeric loopback without DNS or environment proxies. It sends
  the remaining reader budget after TCP connection, reserving 50 ms for return.
- The reader shares one monotonic budget across nested provider requests. Socket
  connects, TLS, headers, chunk framing and body reads consume the same deadline;
  idle traffic cannot renew it. No automatic retries are added.
- OS DNS resolution in external provider transport is still cooperative: a
  stalled system resolver cannot be forcibly interrupted in this process. The
  reader retains admission until work actually exits. After HTTP timeout, the
  gateway reads local health and refuses new work while the reader is busy.
  A timeout never justifies starting a duplicate provider operation.
- Unknown/malformed/provider errors are sanitized; missing values remain missing,
  and cached observations preserve original retrieval age. The bridge does not
  synthesize APR, renew freshness or start historical backfills.
- Opaque inventory handles contain 256 random bits, expire no later than the
  internal cursor (at most 300 seconds), and bind wallet, normalized fallback
  tokens and reader generation. No provider pagination state reaches the browser.

The candidate emits no application payload/access logs and returns a random
request ID. Operational counters, alert routing, log retention/redaction and
correlation across actual ingress must be configured and tested before staging
activation; there is no production monitoring claim.

## Release and rollback

[Execution policy](EXECUTION_POLICY.md) supersedes historical owner, ACK and
approval procedures here. Any authorized collaborator or agent may implement
and operate within scope, recording results alongside or after execution.
Technical controls, compatibility evidence and wallet consent still apply.

Keep live flags disabled until Cloudflare isolation, service identity, trusted
client IP, provider outage, capacity and rollback drills pass. Record evidence
against [the acceptance plan](API_READ_BRIDGE_TEST_PLAN.md), including the pinned
schema/fixture digest and actual adapter tests. Any authorized collaborator can
implement and validate the real-data consumer without another person's ACK.
A shared-validator test is not a component test.

Rollback sets `READ_BRIDGE_ENABLED=false`: capabilities reports disabled and no
read POST is forwarded. Disabling the gateway as well removes internal admission.
Frontend rollback must preserve old timestamps and show unavailability; it must
not label practice values as live. Sessions, private accounts, signatures, swaps,
minting and automation remain false throughout this candidate.
