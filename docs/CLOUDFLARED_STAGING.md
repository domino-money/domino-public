# Cloudflared staging unit candidate

This is reviewable installation material for the Tunnel portion of
[Decimal's HTTPS handoff](https://github.com/domino-money/domino/issues/45#issuecomment-5634619206).
It has not been installed, started or validated on the VM. The unit has no
`[Install]` section and permits IP traffic only to localhost. **That egress policy
cannot operate a Cloudflare Tunnel.** A separately approved egress drop-in,
network probes, credential delivery and remote configuration are required before
the first start. No file here creates DNS, Access applications, Tunnel mappings,
Worker bindings/routes or listener flags.

Starting the Tunnel and enabling application capabilities are separate steps.
The first connector start belongs to the coordinated HTTPS acceptance window
(the H-window) in the [handoff](STAGING_BACKEND_HANDOFF.md#remaining-inputs-and-backend-candidate):
agree the participants, selected commits/pins, mapping/Access review, frontend
perimeter evidence, probe plan and stop/rollback owner before starting. Keep all
Worker/listener flags false. The first start does not authorize reads, wallet
admission or deposits.
The installed application remains `a5a855cec1fc5d120d9c1c187a84ff24bc1b02d6`.
The [staging backend handoff](STAGING_BACKEND_HANDOFF.md) records the installed and
candidate pins separately. Documentation updates do not change the installed
application or establish new VM evidence.

## Exact binary and provenance

The candidate pins **cloudflared 2026.9.0, Linux amd64 only**. On 2026-09-11,
Cloudflare's official GitHub release metadata reported:

| Field | Expected value |
| --- | --- |
| Asset | `cloudflared-linux-amd64` |
| Bytes | `39838050` |
| SHA256 | `53b7a7a5420d188758d24341294acb0d1bca54296548ac05e38811a694ac6134` |
| Published | `2026-09-09T18:38:16Z` |
| Source commit | `b749dfd998f4bced81f48727b9c971cfc3056865` |
| Annotated tag object | `011bbe7bbe0b753fef5aba9b7b4dc3aec6123b50` |

Use the [official release](https://github.com/cloudflare/cloudflared/releases/tag/2026.9.0),
[asset](https://github.com/cloudflare/cloudflared/releases/download/2026.9.0/cloudflared-linux-amd64)
and [release API metadata](https://api.github.com/repos/cloudflare/cloudflared/releases/tags/2026.9.0),
also recorded in [release.json](../scripts/cloudflared/release.json).
The tag API reported an unsigned tag. The asset digest establishes correspondence
to Cloudflare's GitHub publication; it is not an independent signed binary
attestation or a reproducible-build proof. Recheck that provenance before a later
installation. Stop if metadata/digest/architecture differ; do not substitute
`latest`, another platform, a package-manager update or a silently refreshed binary.
No binary was downloaded or executed when preparing this candidate.

The pinned [run implementation](https://github.com/cloudflare/cloudflared/blob/b749dfd998f4bced81f48727b9c971cfc3056865/cmd/cloudflared/tunnel/subcommands.go#L767)
reads and trims the token file. Official [run parameters](https://developers.cloudflare.com/tunnel/advanced/run-parameters/)
document file-based tokens from 2025.4.0 onward. The unit pins `--no-autoupdate`,
info logging, a loopback-only metrics address and disabled management-service diagnostics.
Its 20-second graceful shutdown fits inside systemd's 30-second stop timeout.

`--management-diagnostics=false` disables the additional diagnostics exposed by
the management service, not all local diagnostics or management functions.
[Pinned management handlers](https://github.com/cloudflare/cloudflared/blob/b749dfd998f4bced81f48727b9c971cfc3056865/management/service.go#L78-L92).
The loopback server on `127.0.0.1:20241` also serves `/config`, `/diag/*`,
`/debug/pprof/`, `/debug/requests`, `/debug/events`, `/metrics`, `/ready`,
`/healthcheck` and `/quicktunnel`; some depend on configured handlers. These can
expose runtime/configuration information and must never become origin mappings,
reverse-proxy targets or port forwards. The pinned version explicitly returns
403 for `/debug/pprof/cmdline`.
[Metrics handlers](https://github.com/cloudflare/cloudflared/blob/b749dfd998f4bced81f48727b9c971cfc3056865/metrics/metrics.go#L62-L97),
[diagnostic handlers](https://github.com/cloudflare/cloudflared/blob/b749dfd998f4bced81f48727b9c971cfc3056865/diagnostic/handlers.go#L58-L62).

## Credential and process boundary

The existing `domino-tunnel` OS user/group must be distinct and non-root, have no
`domino-db` membership, and retain the previously verified denial of PostgreSQL
and application runtime access. Do not add groups or SQL roles.

The Tunnel owner delivers only an encrypted file to the operator's key. Decrypt
it locally as root into an absent target using the command in step 3. Never send the token through
chat, GitHub, a prompt, shell argument, environment variable, journal, screenshot
or test output. Do not run `cloudflared service install` or `tunnel login`.

The plaintext source is a single regular, non-symlink, single-link file at
`/etc/domino/credentials/cloudflared-token`, owned root:root, mode0600, under a
root:root0700 directory with root-controlled parents. Preserve these properties
through rotation. The token source must not be readable by `domino-tunnel`.

`LoadCredential` lets systemd read that source and expose a separate read-only
copy to the service UID. The command references only
`${CREDENTIALS_DIRECTORY}/cloudflared-token`; the token value never enters argv.
`/usr/bin/env -i` clears inherited token/proxy/override variables after systemd
expands that path. The source directory, PostgreSQL socket and application release
roots are inaccessible inside the service's filesystem namespace.
[systemd v255 credential semantics](https://github.com/systemd/systemd/blob/v255/man/systemd.exec.xml#L3323).

The credential copy is necessarily readable by the tunnel process and root while
running. This is not protection against a compromised tunnel process or host root.
Do not inspect credential contents in diagnostics. Journals may contain connection,
hostname or remote configuration metadata even at info level; preserve private
access and sanitize evidence before publication.

## Installation after review, without starting

These steps are for the operator on the intended Ubuntu24.04/systemd255 host;
they were not executed for this change. Use a separately reviewed checkout and
the exact asset. Confirm Linux/x86_64 first; another architecture needs a revised
pin and review. Confirm that no existing `cloudflared`/`domino-tunnel` service,
drop-in, enablement link, binary directory or private credential conflicts with
this initial installation. Never overwrite an existing installation as an upgrade.

1. Obtain the asset from the official release, record metadata privately, and
   verify its size and hash **before any execution**:

   ```sh
   test "$(uname -s):$(uname -m)" = Linux:x86_64
   test "$(wc -c < cloudflared-linux-amd64 | tr -d ' ')" = 39838050
   sha256sum --check <<'CHECKSUM'
   53b7a7a5420d188758d24341294acb0d1bca54296548ac05e38811a694ac6134  cloudflared-linux-amd64
   CHECKSUM
   ```

2. Record existing file metadata/configuration and create only absent targets.
   Install the verified binary as root:root0555 at
   `/opt/domino/cloudflared/2026.9.0/cloudflared`; install the reviewed
   [connector.yml](../scripts/cloudflared/connector.yml) as root:root0444 alongside
   it. Parent directories must be root-controlled and not writable by service
   users; the version directory should be0555 after staging files. The explicit
   empty config prevents discovery of unrelated local defaults. It contains no
   ingress rules; remotely managed routing remains an independent control plane.

3. In the private operator session, replace the two quoted placeholder paths
   below. After verifying the directory/parent ownership above, refuse any
   existing target, including a dangling symlink, and decrypt directly as root:

   ```sh
   sudo sh -c '
     umask 077
     test ! -e /etc/domino/credentials/cloudflared-token &&
     test ! -L /etc/domino/credentials/cloudflared-token &&
     age -d -i "<operator-key-file>" \
       -o /etc/domino/credentials/cloudflared-token "<tunnel-token.age>"
   '
   ```

   Stop if decryption fails; do not start the service or overwrite/retry an
   existing target automatically. Check `lstat` file type, link count, UID/GID, directory
   metadata and effective access without opening/printing the token. Confirm
   other service UIDs cannot read it. Record pass/fail metadata only.

4. Install [domino-tunnel.service](../scripts/cloudflared/domino-tunnel.service)
   as root:root0644 at `/etc/systemd/system/domino-tunnel.service`. Verify the
   installed unit/config/binary against their reviewed source and asset hashes.
   Run `systemd-analyze verify /etc/systemd/system/domino-tunnel.service`, then
   `systemctl daemon-reload`. Inspect `systemctl cat/show` for unexpected drop-ins,
   execution hooks, environment, capabilities, writable paths or dependencies.
   It must remain inactive and static, with no automatic start dependency.

Do not start yet, and do not add an `[Install]` section or run enable. A later
automatic-start policy requires its own explicit operational decision. Unit
syntax validation alone does not prove credential loading, BPF or connectivity.

## Egress and first-start gate

The supplied unit's `IPAddressDeny=any` plus `IPAddressAllow=localhost` is an
inactive candidate boundary. It is **not a functional Tunnel configuration**.
Before first start, approve and archive a root-owned
`/etc/systemd/system/domino-tunnel.service.d/20-reviewed-egress.conf` based on the
actual resolver, transport and current [official Tunnel destinations](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/).
No external IP allowlist is invented or installed by this change.

The candidate leaves Cloudflare's supported automatic QUIC/HTTP2 selection in
place; the reviewed policy must account for UDP/TCP7844 and actual DNS resolution.
Additional443 destinations, if required by the accepted Access/configuration
design, must be separately justified. Keep the default deny; never replace it
with unrestricted egress. systemd IP filters do not restrict destination ports,
and localhost permission includes local DNS/other loopback services. Record those
limits and any separately approved port controls. This change makes no host
firewall, DNS or network-policy mutation.

Startup connectivity prechecks remain enabled. If the reviewed drop-in permits
DNS and the approved edge transport but denies `api.cloudflare.com:443`, expect
that API precheck row to fail and the summary to report degraded transport.
The pinned implementation treats that API failure as diagnostic, not a startup
gate. Autoupdate is already disabled; this row is not a reason to add 443 egress.
It does not excuse DNS/edge failures or replace the required connection and
negative probes. Distinguish the failing component when assessing the summary.
[Pinned precheck target](https://github.com/cloudflare/cloudflared/blob/b749dfd998f4bced81f48727b9c971cfc3056865/prechecks/probes.go#L24-L41),
[summary classification](https://github.com/cloudflare/cloudflared/blob/b749dfd998f4bced81f48727b9c971cfc3056865/prechecks/result.go#L80-L151),
[diagnostic-only startup](https://github.com/cloudflare/cloudflared/blob/b749dfd998f4bced81f48727b9c971cfc3056865/cmd/cloudflared/tunnel/cmd.go#L514-L516).

Before starting the real connector, run a credential-free probe under the same
effective service UID, address families and proposed egress filter: required DNS
and approved edge destinations must succeed, an unrelated external destination
must fail, required loopback origins must connect, and PostgreSQL/runtime access
must remain denied. Prove cgroup BPF enforcement on this host. A probe without
the same effective restrictions is not evidence for this unit. Missing positive
or negative results keep first start blocked.

Only after those gates and the remote mapping/Access review below, manually start
`domino-tunnel.service` with all application flags false. Within a bounded window,
verify the process uses the pinned binary and intended UID; credential source is
still root-only; argv/environment reveal no token; metrics bind only to
127.0.0.1:20241; and the expected Tunnel connection establishes. `Type=exec`
success means process launch, not Tunnel readiness. Stop on timeout or mismatch;
do not respond by weakening policy or increasing log level. Repeat the disabled
HTTPS acceptance after a controlled connector restart.
Record boolean/count results from local process inspection; do not dump argv,
environment, credentials or raw journals into an assistant session or issue.
Verify `/debug/pprof/cmdline` locally without retaining its response body:

```sh
probe_status="$(curl --disable --noproxy '*' --proto '=http' --connect-timeout 2 --max-time 4 \
  --silent --show-error --output /dev/null --write-out '%{http_code}' \
  http://127.0.0.1:20241/debug/pprof/cmdline)" && test "$probe_status" = 403
```

Also inspect effective listeners/mappings/forwards to prove nothing exposes
port 20241 beyond loopback. A 403 from one path does not protect the other local
handlers; do not retrieve their bodies for public evidence.

## Remote mappings and denial contract

The following three mappings are the requested initial scope, pending creation
and review, **not currently active mappings**:

| Host | Only intended origin paths | Loopback service |
| --- | --- | --- |
| `vm-read.domino.money` | `/internal/read/v1/*` | `http://127.0.0.1:8878` |
| `vm-session.domino.money` | `/internal/session/v1/*` | `http://127.0.0.1:8879` |
| `vm-onboarding.domino.money` | `/internal/onboarding/v1/*` | `http://127.0.0.1:8880` |

`vm-deposit.domino.money` is reserved/deferred: no Tunnel mapping, Access app or
service token yet. Its Worker/binding may be deployed disabled without secrets
as agreed in #45; this unit does not deploy them. Do not infer an active fourth
route from older examples. Never expose the reader at8876, metrics, PostgreSQL,
SSH, arbitrary local URLs, private-network routes or a wildcard hostname.

Require remote rules that limit each host to its own intended internal path
prefix and terminate unmatched host/path routing with `http_status:404`. The
empty local config does not enforce this remotely managed fallback: inspect the
actual remote configuration and test unknown hosts, cross-service paths, `/health`,
metrics and the deferred deposit hostname. Each initial origin must have its
own reviewed Access service-auth audience/policy and matching application gateway
credential. No Access bypass or general allow rule substitutes for that boundary.
Archive only non-secret mapping identifiers/audiences and sanitized evidence.

Web ingress is `https://domino.money` → the reviewed `domino-app` Pages `/api`
forwarder → service-bound Workers → Access/Tunnel → local listeners. No zone
Worker routes, workers.dev, preview URLs or Worker custom domains are introduced.
Only the reviewed Pages caller may bind to the bridges. Beta perimeter, production
host allowlist, security headers and authentic connecting-IP propagation remain
separate frontend acceptance. This file does not ACK their implementation.

With flags false, the authorized browser check follows beta gate → Pages binding
→ Worker and verifies the disabled response plus exact contract/security headers.
The disabled Worker makes no origin request; that check alone cannot prove the
Tunnel or the listener's response headers. Worker Access client secrets stay in
Cloudflare and never move to the operator, browser or a direct curl command.
Direct `vm-*` probes are limited to denial markers with no service credentials;
missing identity, cross-service paths and deferred/unmatched routes must fail.
Retain separate connection/mapping evidence for the Tunnel and local disabled
listener checks. Real origin JWT/audience and `no-transform`/identity behavior
through Cloudflare still need the separately reviewed service-path acceptance;
do not claim the flags-false browser result proves them. Do not grant a wallet
or send a financial request to establish connectivity.

## Rollback and rotation

For first-start failure, stop `domino-tunnel.service`; preserve a sanitized report
and inspect the effective policy without changing flags. For an exposed-HTTPS
rollback, first set Worker flags false and disable the Pages binding forwards
under the separate reviewed ingress procedure, then stop the connector and
withdraw the three mappings/service-auth access as coordinated with Decimal.
There are no zone Worker routes to remove. Deposit remains deferred.

Confirm the connector is inactive and expected HTTPS origins no longer reach
local services. Leave reviewed binaries, units and audit evidence in place for
inspection; do not erase application runtime or restore financial state. A token
rotation is performed only through Cloudflare's reviewed operator procedure and
a new privately delivered file, followed by metadata/hash verification of the
unchanged unit/binary and a controlled restart. Never print or paste the new
token, and never roll back to a revoked token. Delivery encryption and systemd
credential loading do not replace offsite backup or issued-transaction recovery.

## Local checks and remaining host proof

```sh
python3 -B -m unittest discover -s scripts/cloudflared/tests -v
```

The committed tests validate the fixed unit/manifest/config and reject weakened
secret transport, identity, egress, logging, metrics, pinning and start hooks.
They are parser/fixture checks, not a general systemd interpreter. They perform
no subprocess, network, token read, installation or service start. Run the
native systemd255 verifier and actual host checks above before use. Local macOS
has no `systemd-analyze`; no native unit validation or VM qualification is claimed
from those tests. Required repository CI remains separate from operational approval.

Additional syscall/proc/hostname/IPC/memory-execution hardening is deferred to a
separate VM-qualified change; it can affect the pinned Go binary and diagnostics.
This follow-up adds no unit directive or address family. In particular, do not
add `AF_NETLINK` merely to improve an ICMP source-selection diagnostic; private
network/ICMP routing is outside the approved HTTP-origin scope.
