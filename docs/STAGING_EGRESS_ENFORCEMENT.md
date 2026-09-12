# One-window staging egress candidate

Status: offline generator and regression tests, with a native nftables syntax
check of a synthetic candidate. No firewall, systemd unit, VM, credential or
connector is changed by this implementation. Independent review, validation of
the actual private artifacts and cgroup/packet qualification remain required
before enforcement. The connector must stay stopped until the agreed
window; all bridge/application capability flags remain false. This is a bounded
qualification tool, not an unattended DNS refresher or an uptime solution.

`scripts/staging/egress_policy.py` reads at most 64 KiB of credential-free JSON
from stdin and writes a JSON bundle of candidate file contents to stdout. It
does not resolve names, call processes, read configuration, write files, apply
rules, renew a window, change flags or start a service. The CLI has no options.
Every output reports `applied: false` and `policyQualified: false`.

```sh
umask 077
python3 scripts/staging/egress_policy.py < /private/review/snapshot.json > /private/review/bundle.json
python3 -m unittest discover -s scripts/staging/tests -p 'test_egress_policy.py' -v
```

The private paths above are operator-chosen placeholders, not repository files.
Keep actual inventory, DNS observations and generated artifacts outside Git.
The tests use synthetic account IDs and unrelated public IPs; their fixtures
must never be applied as a real policy.

## Input contract

The top-level object has exactly these fields:

| Field | Required value |
| --- | --- |
| `version` | Integer `1` |
| `resolver` | `127.0.0.53` |
| `observedAt`, `expiresAt` | UTC timestamps with exact seconds, `YYYY-MM-DDTHH:MM:SSZ` |
| `identities` | Exact role keys: `read`, `gateway`, `auth`, `onboarding`, `deposit`, `tunnel`, `write`, `operator`, `admin` |
| `https` | 2–6 source records described below |
| `edges` | Exactly one source record for each of the two official global edge regions |

For example, an **illustrative identity only** is:

```json
{
  "user": "domino-read",
  "realUid": 2000,
  "effectiveUid": 2000,
  "gid": 3000,
  "supplementaryGids": [4000],
  "unit": "domino-read.service",
  "cgroup": "/system.slice/domino-read.service"
}
```

Every present identity must contain exactly those fields. UIDs must match and
be distinct across accounts; numeric IDs must be positive integers below
2³¹, excluding `nobody`/65534 and root. Record all actual supplementary GIDs,
including the primary GID if the host reports it there; no duplicate entries,
at most 16. Shared supplementary groups are recorded, not treated as network
authorization. The generator does not prove that an account, UID or group
exists or that membership is safe: the independent inventory must do that.

Each service uses its exact `domino-<role>.service` unit and expected
`/system.slice/domino-<role>.service` cgroup. Root, user-slice, empty, traversal,
alternate and mismatched paths are rejected. A stopped service's path is an
expected identity until a test process actually runs there; merely submitting
the path does not prove cgroup membership. `write`, `operator` and `admin` have
`unit: null` and `cgroup: null`: no jobs are installed for them and no drop-in
is generated, but their UIDs receive complete network denial. Only `admin`
may be explicitly `null` if the operator verifies that account is absent.
Any additional Domino account or newly installed job requires an inventory and
schema review before proceeding; do not silently omit it.

Each HTTPS source has exactly `role`, `kind`, `hostname`, `addresses`,
`observedAt`, `expiresAt`. Allowed purposes:

| Role | Kind | Hostname authorization |
| --- | --- | --- |
| `read` | `rpc` | 1–4 exact, independently approved configured RPC hostnames; no implicit fallback |
| `read` | `analytics` | Optional one `api.geckoterminal.com` |
| `gateway` | `jwks` | Exactly one `<team>.cloudflareaccess.com`, matching the reviewed issuer |

RPC hostnames are operator-supplied candidates, not proof of a provider's
identity, chain support or actual configured use. Review each against the
sanitized configuration inventory. Only canonical lower-case DNS names are
accepted: no URL scheme, path, query, key, userinfo, wildcard or IP literal.
Do not supply a hostname containing a credential in a DNS label. Each source
contains 1–64 unique, canonical, globally routable IPv4 literals. IPv6, CIDRs,
private/link-local/shared/documentation/reserved/multicast addresses and
duplicates within a source are rejected. Addresses shared across approved
sources are deduplicated within that role's set.

An edge source has exactly `hostname`, `addresses`, `observedAt`, `expiresAt`.
The only hostnames are `region1.v2.argotunnel.com` and
`region2.v2.argotunnel.com`. Each nonempty address subset must belong to that
specific region's exact official global IPv4 inventory pinned in the generator
on 2026-09-11. No prefix grants, alternate Cloudflare region, optional update
endpoint or TCP443 tunnel exception is accepted. Changed official inventory
requires a reviewed code change; live observations must still be supplied.

Resolve outside the Domino service identities using the authorized resolver
procedure. Inspect the complete answer/CNAME chain, bound traversal to eight
hops and 64 final A records, and derive each source expiration from the lowest
remaining TTL across that chain. The generator consumes this sanitized
evidence; it does not reconstruct DNS or verify the operator's claimed TTL.
Source observations must be no later than the snapshot observation and no more
than 600 seconds older. The window must end no later than **every** source's
expiration, and at most 600 seconds after the snapshot observation. At least
10 full seconds must remain when rendering. This is an artifact handoff margin,
not a TTL floor or approval of the operational test budget. Requiring 60 seconds
remaining would reject an ordinary 60-second DNS TTL as soon as collection or
transport consumed any time. With the 10-second threshold, a 60-second source
observed five seconds earlier renders with 55 seconds left; neither its declared
expiration nor its absolute nft deadline moves. Timeouts still round down.
DNS churn, fewer than 10 seconds remaining or insufficient time for the agreed
tests means stop and collect fresh evidence. Short windows require fresh
operator-reviewed replacement artifacts while services are drained; never
extend a TTL, reuse expired evidence or enable an automatic renewal process.

Unknown fields, duplicate JSON keys, nonfinite numbers, deep JSON, invalid
identities and stale/future/overlong windows fail with a fixed error code.
Errors never echo submitted values. No credential validation or secret
redaction service is implied: the input must already be credential-free.

## Exact network scope

The bundle contains one `domino-egress-window.nft` candidate and six drop-ins,
one for each known service. The nft script starts with `create table inet
domino_egress_window`, which fails if that table exists. It contains no flush,
delete, include or changes to other tables. Apply the whole file as one nft
transaction, never individual lines. Its output base chain has priority 10
and accepts unrelated UIDs; each listed Domino socket UID jumps to a dedicated
chain ending in a named `denied_<role>` counter and `drop`.

| Role | New connections during the window |
| --- | --- |
| Reader | Its IPv4 HTTPS set, TCP443; stub DNS TCP/UDP53 |
| Gateway | Its own JWKS IPv4 set, TCP443; stub DNS TCP/UDP53; `127.0.0.1:8876` TCP |
| Tunnel | Its official IPv4 edge set, TCP/UDP7844; stub DNS TCP/UDP53; `127.0.0.1:8878/8879/8880` TCP |
| Auth, onboarding, deposit | No new network connections, including DNS |
| Write, operator, admin | No network connections |

The tunnel cannot reach reader8876 directly or deposit8881. Local-origin rules
are exact loopback address/port rules in conntrack's original direction, not
a generic localhost grant. The six listener services may reply to legitimate
loopback clients from their own fixed TCP listener ports; the tunnel diagnostic
listener is `127.0.0.1:20241`. Those reply rules require the associated socket
UID, loopback interface, exact source/destination `127.0.0.1`, fixed source
port, `ct direction reply` and established conntrack state. Binding a source
port on a new client socket does not satisfy the reply-direction condition.
Reply rules survive expiry so existing local clients can receive a disabled
response; they grant no external egress and no new client connections.

All other permissions require the window's absolute UNIX timestamp lower and
upper bounds. Each external packet also needs a live element in its per-role
IPv4 set. Set elements expire after the remaining whole seconds at rendering.
There is **no blanket established/related accept**, so existing TCP/QUIC
connections cannot bypass set expiry or the absolute deadline. A relative set
timeout alone would restart at installation; the absolute upper bound prevents
that from extending a delayed artifact's window. No automatic TTL renewal,
packet-path set update or grace period is implemented. Kernel garbage
collection may remove expired elements later; expired elements must already
be unmatchable, which the actual-host expiry test must demonstrate.

Drop-ins clear inherited `IPAddressAllow` and `IPAddressDeny`, then set
`IPAddressDeny=any`. They allow only the listener's `127.0.0.1/32`, the stub
`127.0.0.53/32` for the three enabled roles, and that role's exact external
IPv4 `/32` candidates. No IPv6 allowance is emitted, including `::1`.
These systemd cgroup filters are bidirectional address restrictions, not port
or timer enforcement. They retain IP permissions until removed; **nft is the
expiry layer**. Neither layer alone establishes the complete policy.
AF_UNIX PostgreSQL connections and other non-IP IPC are unchanged.

## Assumptions to qualify before enforcement

Use the actual Linux/systemd/nft versions; current VM expectations are Ubuntu
24.04, systemd255 and a unified cgroup-v2 hierarchy. During preparation, a
synthetic candidate passed `nft --check --debug netlink --file` with nftables
1.0.9, without applying the policy. This is native syntax/check evidence, not
a kernel packet, attached BPF or expiry test. Those did not run as part of the
offline suite. Validate each actual private artifact on the target host too;
syntax acceptance alone does not establish enforcement.

Verify all nine account cases, real/effective UIDs, primary/supplementary GIDs,
the expected cgroup, static User/Group settings and complete effective drop-in
configuration. Require no other workload sharing these UIDs, no DynamicUser,
socket activation or inherited/passed cross-UID network sockets, no alternate
network namespace, and no route/NAT/conntrack-notrack/helper rule that defeats
the documented direction/address assumptions. Existing service hardening must
retain no network-admin/raw/setuid capabilities, restricted address families,
namespace restrictions and `NoNewPrivileges`. This is a socket-UID policy,
not protection against root, hostile privileged host software, changing UIDs
or passing an authorized socket to another identity. Root/SSH/Tailscale,
systemd-resolved and PostgreSQL are not granted or filtered by this table.

Verify the host UTC clock is synchronized and will not move backwards during
the window. Absolute guards depend on that trusted clock; monotonic set
timeouts provide a separate cap after installation. Reboot persistence and
boot ordering are not implemented: services must stay stopped and disabled
across reboot, otherwise address-only drop-ins could run without nft. Never
delete or flush the expiry table while these service identities can run.

IP allowlisting does not isolate an FQDN on a shared CDN. Applications must
still validate the expected TLS hostname/certificate and configured endpoint,
and enforce Access JWT issuer/audience/client checks. Stub-only DNS limits the
resolver destination, not question names or DNS exfiltration. A constrained
DNS proxy and unattended refresh are separate work, not claims of this tool.

## Review, apply and rollback procedure

These are operator steps for a reviewed candidate; this document does not
authorize starting the connector before the agreed window.

1. Independently review the code and the private inventory. Confirm all flags
   false, no public/deposit routes, connector stopped, and a separate working
   SSH/Tailscale recovery session. Record active services and existing firewall
   tables, drop-ins and hashes privately; do not print secrets or environment
   files. Stop and runtime-mask the six service units before installing either
   layer; quiesce jobs/sessions for write/operator/admin. Retain those masks
   until qualification/rollback is complete. Check no processes/sockets of the
   listed UIDs remain. Confirm the named nft table is absent.
2. Collect fresh sanitized DNS/identity evidence, render, and review the exact
   seven artifact contents and expiration. Copy only these fixed filenames
   from the JSON bundle into a private root-owned review directory. Do not
   execute JSON, shell-interpolate values, or apply repository test fixtures.
   Require at least the independently agreed test budget still remaining;
   generation's 10-second handoff minimum is not an operational start approval.
3. On the target host, run `sudo nft --check --file
   /private/review/domino-egress-window.nft` while the table is absent. Validate
   the exact unit/drop-in combinations with `systemd-analyze verify`; inspect
   effective unit settings for later drop-ins that could override this file.
   On any incompatibility, stop here. Do not weaken the output to force success.
4. While units remain drained/masked, install only the six reviewed
   `40-egress-window.conf` files under the matching `/etc/systemd/system/`
   unit directories, root-owned, and run `systemctl daemon-reload`. Apply the
   complete nft file once with `sudo nft --file
   /private/review/domino-egress-window.nft`. Confirm the whole transaction
   succeeded, table/rules/UIDs match, and unrelated tables are unchanged.
   Reapplying the file must fail on the existing table, not accumulate grants.
5. Qualify with harmless, bounded socket/TLS probes in each **actual service
   cgroup**, with exact UID/GID/group identity and identical hardening. Keep
   application/connector commands stopped: a separately reviewed temporary
   ExecStart probe override can exercise the same unit identity. A differently
   named transient unit or `sudo -u` shell does not prove the service's cgroup
   BPF layer. Inspect attached/effective cgroup programs with `bpftool cgroup
   show /sys/fs/cgroup/system.slice/<exact-unit> effective`, and prove behavior
   through positive and negative controls below. Drop-in text alone is not
   evidence of attached/enforcing BPF. UID-only accounts need separate exact
   identity probes; they have no service/BPF claim.
6. Save sanitized counter deltas, identities, attach evidence, timestamps and
   probe outcomes. Stop/mask probe units before removing overrides. The first
   window must include expiry tests; do not promote a partially tested window
   into a connector start. A later connector window needs fresh evidence,
   another reviewed artifact and explicit coordination; this generator does
   not refresh or start it.

Rollback is fail-closed: stop and runtime-mask the six units, quiesce every
listed UID, verify empty processes/sockets, restore their prior localhost-only
drop-ins and reload systemd. Keep the restrictive nft table until that state is
verified. Only then, if removing this candidate, use `sudo nft delete table inet
domino_egress_window`; never flush the ruleset or another table. Remove only the
temporary probe overrides after the units are stopped. Restore masks/start
policy to the previously reviewed **stopped/disabled** state, not to automatic
external operation. If any layer/application state is uncertain, retain the
deny table and stop. A failed atomic nft application adds no partial table;
leave services masked and restore staged drop-ins. Subsequent windows are
explicit operator transactions while drained; no in-place renewal is provided.

## Required positive, negative and expiry evidence

Use a timestamped pre/post snapshot from `sudo nft -j list table inet
domino_egress_window` to attribute each negative to the matching
`denied_<role>` counter. Ensure the probe uses the recorded source UID/cgroup
and that no concurrent process of that UID can inflate the counter. A timeout,
connection refusal, missing route or `EACCES` alone is not proof of this policy:
systemd BPF can reject before nft and generate no nft counter increment.
Correlate attached BPF evidence and controlled positive/negative comparisons;
where isolating layers is needed, use a separately reviewed disposable test
context while real services remain masked. Never remove host enforcement to
manufacture a positive control for a live application.

| Test | Required observation |
| --- | --- |
| Reader and gateway HTTPS | Exact approved IPv4 TCP443 socket + expected TLS hostname succeeds; no credentials/HTTP mutation needed |
| Tunnel edge transport | Exact official IPv4 TCP7844 reachability and bounded UDP7844 packet/response evidence; a UDP `send` success alone proves neither reachability nor peer identity; do not start the connector |
| DNS | TCP and UDP queries to stub127.0.0.53 succeed for the three enabled UIDs; direct external DNS53 and853 fail; deferred UIDs cannot use even the stub |
| Origin/reply path | Harmless loopback listeners prove gateway→8876 and tunnel→8878/8879/8880 request and reply; replies include the SYN-ACK and response body |
| Origin negatives | Tunnel→8876/8881, gateway→8879/8880/8881 and other local ports fail; source-port binding without reply direction cannot bypass |
| External negatives | Each UID: unlisted global IPv4, allowed IP on TCP80/22/8443, wrong protocol/UDP443, direct DNS, and reachable global IPv6 fail; test deferred/auth/onboarding/deposit/write/operator/admin against otherwise allowed endpoints too |
| Existing-connection expiry | Establish credential-free TCP/TLS connections during the window, retain sockets, send a fresh application record after the absolute deadline; transmission is denied and the correct nft counter increases, even if TCP was established |
| Fresh-connection expiry | After the deadline, new TCP443/7844, UDP7844, DNS and local-origin sends fail; appropriate nft counters increase; only constrained local listener replies remain allowed |
| Delayed-install guard | In an isolated qualification context, apply a rendered artifact after its deadline; relative element lifetimes may exist, but every external/new-origin/DNS packet must still be denied by absolute time |

For external IPv6, use an independently reachable numeric control endpoint
with a functioning IPv6 route in a disposable qualification context if the VM
has no route. An absent IPv6 route is inconclusive; the inet default deny plus
effective systemd deny must be qualified rather than inferred from it. Do not
invent a positive path or add host IPv6 connectivity without its own review.
Prove UDP denial with observed firewall/BPF decisions or controlled packet
capture; UDP connect/send calls are insufficient. If counterpart availability,
clock stability, test budget or safe layer isolation prevents attribution,
record the specific test as unqualified and keep activation blocked.

## Primary semantics and limitations

- [nftables manual](https://netfilter.org/projects/nftables/manpage.html):
  `create table` rejects collisions; numeric `meta time` uses UNIX timestamps;
  element timeouts are relative; output socket UID and conntrack direction
  permit the scoped rules. The synthetic candidate passed the nftables 1.0.9
  check; actual artifact validation and behavioral qualification remain required.
- [systemd resource control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html):
  IPAddressAllow/Deny implement cgroup IP filtering; their use here needs
  effective BPF and hierarchy verification on the target system.
- [Cloudflare Tunnel firewall requirements](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/):
  the two pinned global edge inventories and TCP/UDP7844 are the initial tunnel
  candidates. This does not grant optional update/diagnostic endpoints.

The offline tests verify strict parsing, identities, scope, time/TTL constraints,
generated port/address/UID rules and lack of broad established exceptions.
They do not certify a firewall installation, DNS answer authenticity, actual
resolver confinement, a TLS peer, real-token JWTs, connector behavior or
continuous operation. Those remain explicit deployment qualification gates.
