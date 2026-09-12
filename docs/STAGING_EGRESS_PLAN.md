# Staging egress preparation

Issue #45 · Candidate prepared 2026-09-11 · **No installed policy or network qualification**

This is the network work that can be prepared before the encrypted Tunnel token
arrives. It does not install a firewall, change DNS, start any application or
connector, enable flags, or grant a wallet. The installed `a5` release and stopped
application units are separate from this source. The disabled source upgrade has
its own [procedure](VM_DISABLED_UPGRADE.md) and review; do not interleave its
cutover with a network change.

The first release needs two distinct outbound paths: the reader and Access
verifiers use HTTPS; `cloudflared` connects to the edge and local gateways. Keep
their identities and permissions separate. A successful TLS handshake is neither
a provider data qualification nor an Access/consumer acknowledgement.

## Destination matrix

Resolve the installed numeric UID from the exact account name; never copy a UID
from another machine. “Configured RPC” means the primary and **only the explicit
fallbacks** in that service's operator-owned product configuration. An entry in
`rpcAllowedHosts` alone does not mean the service uses that provider. Extract only
hostnames in a private operator session; do not copy credential paths, URLs,
headers, environment dumps or provider file contents into evidence.

| Unit / effective account | Stage | Permitted new outbound connections |
| --- | --- | --- |
| `domino-read.service` / `domino-read` | First token and selected-pool reads | TCP443 to configured chain-4663 RPC hosts and `api.geckoterminal.com`; its database Unix socket remains under existing peer/ACL rules. |
| Same reader | Optional later read routes | `robinhood-mainnet.g.alchemy.com:443` only when inventory is selected; `api.dexscreener.com:443` only when discovery is selected. Do not expand the initial surface just because these adapters exist. |
| `domino-gateway.service` / `domino-gateway` | Read service-auth acceptance | TCP443 to the **one private configured Access issuer hostname** for `/cdn-cgi/access/certs`; TCP to `127.0.0.1:8876`. No RPC, inventory, market or Uniswap egress. |
| `domino-auth.service` / `domino-auth` | Separate session acceptance | Its issuer JWKS plus its configured RPC hosts on TCP443 for fresh plain-EOA verification. Existing private database socket only. |
| `domino-onboarding.service` / `domino-onboarding` | Later preview acceptance | Its issuer JWKS and configured RPC hosts, plus `trade-api.gateway.uniswap.org:443` and `liquidity.api.uniswap.org:443` for bounded previews. All preview flags stay false until their separate acceptance. |
| `domino-deposit.service` / `domino-deposit` | Deferred | No external egress addition, Access app, service token or Tunnel mapping in this phase. |
| `domino-tunnel.service` / `domino-tunnel` | First connector window | Global Tunnel edge destinations below on UDP/TCP7844; only `127.0.0.1:8878,8879,8880` as new origin connections. No provider, JWKS, public443 or deposit egress. |
| `domino-write`, `domino-operator`, PostgreSQL | No background acquisition/job in this phase | No added network permission. Database access uses the existing Unix socket; do not turn on a writer/indexer to qualify public reads. |
| Resolver and time synchronization | Existing VM infrastructure | Retain the independently inspected infrastructure rules. These daemons are not app users and must not inherit an app allowlist or Tunnel token. |

All enabled rows need the **inspected resolver destination** on UDP/TCP53 if their
actual libc/Go path uses DNS sockets. This is a permission to that resolver, not
to arbitrary resolvers. AF_UNIX resolution through systemd-resolved requires its
own namespace/access inspection. App responses to established loopback clients
must remain possible; do not mistake response traffic for a new outbound origin.

Source checks: [RPC host/path validation](../backend/rpc_config.py),
[inventory](../backend/inventory.py), [public market host](../backend/market_data.py),
[Access verifier](../backend/bridge_identity.py),
[quote](../backend/uniswap_quote.py), [LP preview](../backend/uniswap_position.py).
The default RPC candidates are `rpc.mainnet.chain.robinhood.com` and
`robinhood-mainnet.g.alchemy.com`. This document does not assert which are currently
configured. `api.g.alchemy.com` historical-price reads and Blockscout's legacy
qualification CLI are outside the first public token/pool path.

Cloudflare's [current firewall documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)
requires global `region1.v2.argotunnel.com` and `region2.v2.argotunnel.com` edge
addresses on UDP7844 for QUIC and TCP7844 for HTTP/2. Preserve the pinned candidate's
automatic transport selection. The exact official IPv4/IPv6 entries, rather than
an enlarged subnet or Cloudflare's entire CDN ranges, must accompany the private
policy review. Recheck the source and DNS SRV/A/AAAA answers before installation.
No US/FedRAMP selection is proposed. Optional API/update HTTPS stays denied.
The pinned candidate's API precheck may consequently report degradation; see
[the diagnostic distinction](CLOUDFLARED_STAGING.md#egress-and-first-start-gate).
No Tunnel destination or token was contacted for this preparation.

## Policy layers and their limits

Use the existing VM-to-host/LAN/Tailscale isolation unchanged. Add an independently
reviewed **guest** policy for the Domino socket UIDs; the host's forward chain
cannot identify individual guest process UIDs. Do not replace or flush the host's
libvirt rules, guest firewall, SSH path or resolver/time services.

1. Keep `IPAddressDeny=any` in each service and localhost for its existing local
   traffic. The reviewed `20-reviewed-egress.conf` adds only exact approved public
   IPv4 `/32` destinations for that row. Initial external IPv6 remains denied;
   later IPv6 connectivity requires separately verified routing and exact `/128`
   entries. Include no external
   address for deferred services. Reject unexpected inherited/drop-in allows.
2. Pair those cgroup filters with a guest nftables output chain scoped to the
   resolved `meta skuid` values. For each UID, allow only the matrix's protocol,
   destination set and destination port, then deny its remaining new traffic.
   Preserve only the required loopback replies and new local connections/DNS.
   Sets for dynamic HTTPS addresses expire; see renewal below. Review both IPv4
   and IPv6, actual chain order and counters. No blanket localhost or established
   accept may let an unrelated **new** connection bypass the per-UID policy.
3. Application transports retain exact HTTPS hosts, CA/hostname verification,
   no redirect/proxy forwarding and bounded responses. No ingress-controlled URL
   or token-supplied `jku`/`x5u` becomes a new allowed destination.

These are complementary controls. [systemd v255's IP filters](https://github.com/systemd/systemd/blob/v255/man/systemd.resource-control.xml)
apply to sockets created in the unit and include both address families; they do
not restrict ports, FQDNs, TLS names or HTTP paths. Localhost includes all of
127/8 plus `::1`. AF_UNIX sockets and traffic performed by a local resolver on the
app's behalf are outside that IP filter. A cloned UID without its cgroup does
not test it. Native unit parsing alone does not establish kernel BPF enforcement.

[nftables socket-UID matching](https://wiki.nftables.org/wiki-nftables/index.php/Matching_packet_metainformation)
allows the port layer to cover the service's sockets even in a diagnostic unit.
It does not inspect HTTPS names. Shared CDN IPs still permit other TLS services
on the same permitted address/port at the network layer. A compromised process
could also query arbitrary names through a permitted general resolver. This
candidate restricts resolver **destinations**, not DNS question names, and makes
no FQDN-isolation or DNS-exfiltration prevention claim. If that stronger property
is required, qualify a separate restricted resolver or egress proxy; do not claim
it from `IPAddressAllow` or add a proxy silently. No such daemon is introduced here.

## DNS inventory, renewal and failure behavior

Before turning this design into a concrete drop-in, capture privately: effective
`/etc/resolv.conf` target, `hosts:` NSS order, resolver listeners/upstreams,
service-visible resolver sockets/files, IPv4/IPv6 routes, numeric service UIDs,
existing nftables order, parent cgroup filters and all unit overrides. Read only
the necessary fields. Do not dump credentials, full unit environments or lab
topology. DNS from the operator's laptop is not evidence for the guest.

The authorized read-only inventory at **2026-09-11 16:59 UTC** found:

- `/etc/resolv.conf` resolves to `/run/systemd/resolve/stub-resolv.conf`, selecting
  `127.0.0.53`; NSS is `hosts: files dns`. Both local stubs have TCP/UDP53 listeners.
  The proposed app DNS destination is therefore **127.0.0.53:53 only**, not the
  unused proxy stub or the upstream resolvers directly.
- The resolver's public upstreams are configured, with LLMNR, mDNS and DoT off;
  DNSSEC reports `no/unsupported`. This was configuration inspection, not DNSSEC
  qualification or an active DNS/provider test. Keep its existing infrastructure
  access separate from application socket permissions.
- The guest has an IPv4 default route and no IPv6 default route. First-window
  external rules therefore use IPv4 only; do not mistake IPv6 no-route errors for
  enforced denial. The connector's documented default is IPv4, consistent with
  that choice; verify its actual transport after the approved start.
- cgroup v2 is mounted. All five application units are inactive/static, have no
  drop-ins, no network namespace override and empty `ControlGroup`; configured
  IP filters allow only localhost and deny all remaining addresses. The app units
  have no address-family restriction; the separate Tunnel candidate does.
  **No current attached-BPF or new-destination connectivity claim follows from
  these stopped-unit properties.**

The private evidence is `2026-09-11-egress-preparation/vm-network-readonly.json`
under the coordinator's ignored evidence directory. It read no runtime/provider
contents, Access IDs, environment or credential. The existing initial-install
`egress-check-final.json` records successful outside-cgroup controls before/after
and loopback checks, with external timeouts inside each of the five old service
cgroups. Preserve it as dated evidence for a5; it does not qualify an upgrade or
new egress destinations. No active probe was repeated in this preparation.

[systemd-resolved's interfaces](https://github.com/systemd/systemd/blob/v255/man/systemd-resolved.service.xml)
explain why a successful libc lookup does not prove UDP53 came from the app UID.
Exercise the selected path without widening access to all loopback services or
all external53. Keep direct DoH/DoT, mDNS, LLMNR and alternative resolver traffic
outside these app permissions. Never modify system-wide DNS to pass a probe.

For each exact configured HTTPS hostname, privately record the chosen resolver,
observation time, bounded CNAME chain, full A/AAAA answer set and the minimum
remaining TTL. Inspect both families, but initially admit only the reviewed A
addresses; AAAA results are recorded, not permitted. Refuse empty, excessive or
malformed answers, any non-global
address, unexpected names, and an expired observation. Use no more than 8 CNAME
hops or 64 total addresses per hostname. Do not admit a wildcard, CDN netblock,
provider URL path or arbitrary DNS answer supplied by an HTTP request.

The first H-window policy is **time-bounded**, not an unattended DNS updater:

- Take a fresh snapshot immediately before the reviewed network test. Stage the
  matching exact addresses in BPF and expiring per-UID nftables destination sets.
  The expiry is at most the shortest remaining DNS TTL and at most 10 minutes;
  no TTL floor may extend that deadline. A zero/too-short TTL is a failed input,
  not permission to install a permanent entry.
- Refresh only through the coordinated operator path, while reads are disabled
  or drained. Resolve and validate again, review additions/removals, stage the new
  BPF union before the atomic nftables set replacement, and then remove obsolete
  BPF entries. No new address is usable until **both** layers admit it. Verify
  effective policy and probes again; keep no stale address in an expiring set.
- nftables timeouts close the usable path if a refresh fails. On expiry/outage,
  disable admission and report unavailable; never replace the policy with `any`,
  extend a stale TTL, change provider silently or hide failure behind cached age.
  Test an expired set in the isolated probe window, including a connection that
  was already established; a broad established rule must not bypass expiry.
- The official Tunnel edge list is versioned separately from HTTPS DNS answers.
  DNS discoveries must stay inside that reviewed exact list; any change requires
  a refreshed review. Prove the connector's actual transport/family after start.
  Do not infer QUIC viability from a UDP `connect()` call.

A concrete renewal implementation, boot ordering and effective-policy verifier
are still required before unattended public uptime. The helper below deliberately
does not apply/renew firewall rules. After reboot all application/connector units
remain static; verify foundation and current policy before controlled start.
This respects the existing no-autostart staging decision. General machine update
egress is an operator activity, not a new permission for these service UIDs.

## Credential-free observations and acceptance

[probe_egress.py](../scripts/staging/probe_egress.py) provides the small TCP/TLS
portion of the evidence. Its default is **validation only**, with no network.
It reads up to 12 targets from bounded stdin, uses literal socket addresses and
optional verified TLS SNI, sends no HTTP request and accepts no key/header/URL
fields. A run uses a shared 40-second network budget, with at most 3 seconds per
socket stage. DNS is intentionally a separate bounded process, not an unbounded
`getaddrinfo()` inside this probe.

Example manifest shape uses documentation addresses, **not operational targets**:

```json
{"version":1,"probes":[
  {"id":"approved-https","address":"192.0.2.1","port":443,"expect":"connect","tlsName":"provider.example"},
  {"id":"unrelated-https","address":"192.0.2.2","port":443,"expect":"deny"}
]}
```

Validate a private, credential-free manifest offline:

```sh
python3 -B scripts/staging/probe_egress.py < /private/operator/probes.json
python3 -B -m unittest discover -s scripts/staging/tests -p test_egress_probe.py -v
```

For execution, a reviewed operator harness must place the diagnostic process in
a temporary unit with the real service's UID, groups, address families, filesystem
restrictions, parent slice and the **same proposed egress filters**. Replace only
the app command with this probe; omit all provider/session/Tunnel credentials and
start hooks. Keep the real application and connector stopped. Inspect effective
restrictions and cgroup membership, then invoke the probe inside that unit with
`--execute --expected-uid <numeric-uid> --expected-cgroup <exact-v2-path>` and its
private stdin manifest. No helper here creates a unit or moves a process. Limit
the harness to 50 seconds and stop/remove its temporary unit after capture.
During later disabled-service acceptance, additionally corroborate the actual
service cgroup's loaded BPF programs and policy; a replica's name/UID alone is
insufficient. Use the same effective namespace for filesystem denial checks.

The report never includes addresses, TLS names, payloads or raw errors. It labels
success as an observation and always leaves `policyQualified:false`. Root,
unexpected UID and mismatched cgroup execution are rejected before network work.
An explicit permission error is useful negative evidence only with the matched
kernel/counter/control evidence. Timeout, refusal and no route are **not**
evidence of a firewall denial; those rows remain inconclusive. A failed positive
TLS check is a mismatch, also not evidence of firewall denial.

| Evidence to capture | Positive and negative condition |
| --- | --- |
| DNS path | Approved names/SRV return the expected bounded answers under actual libc/Go resolver behavior; direct unapproved resolver sockets fail. Record Unix-socket resolution separately. No arbitrary-name denial claim. |
| Provider/JWKS | Credential-free TLS verifies each approved hostname at its current allowed address; unrelated public address443 and a disallowed port on an otherwise permitted address are denied. Verify a reachable control immediately before/after outside the cgroup, without broadening the real unit. |
| Cross-service separation | Gateway cannot reach RPC/GeckoTerminal; reader cannot reach unrelated issuer/Uniswap destinations; Tunnel cannot reach provider/JWKS443. Shared-address collisions are recorded as the IP layer's limitation, not falsely certified hostname denial. |
| Tunnel edge | Both regions and the selected address family work. TCP/TLS observations can precede token delivery; QUIC needs a valid protocol response or actual connector transport evidence in the H-window. `nc -zu` success is insufficient. |
| Local origins | Approved disabled origins8878/8879/8880 can be reached in the later controlled start; unrelated local ports8876/8881/20241 and SSH cannot be new Tunnel connections. Metrics remain loopback-only and unmapped. |
| Private resources | Existing role/filesystem verifiers still deny Tunnel PostgreSQL/runtime access; no new group membership. Host/LAN/Tailscale denials and foundation hook remain intact. |
| Expiry/restart | Expired destination set denies a formerly allowed connection, also without established-connection escape. With fresh policy the disabled-service/connector restart passes again. No flag is changed to prove this. |

Use the existing [role/filesystem verifiers](STAGING_VERIFIER_HARDENING.md) and
[disabled HTTP checks](STAGING_BACKEND_HANDOFF.md); do not build a second SQL or
HTTP suite here. Preserve exact release/unit/policy hashes, kernel/cgroup version,
UTC times, probe outcome counts and relevant firewall/BPF counter changes.
Restrict raw journals/packet metadata locally; do not collect provider requests,
tokens, session cookies or personal wallet traffic.

## Sequence and remaining inputs

1. **Prepared in source:** per-stage identity/destination matrix, failure/renewal
   contract and offline-tested TCP/TLS observer. No private Access IDs or provider
   configuration was read for this change.
2. **Next, without the `.age`:** coordinator uses the completed sanitized VM
   inventory, reconfirms it after the independent disabled upgrade, and produces exact private address,
   resolver, nftables and unit candidates; reviews them; runs controlled
   credential-free positive/negative and expiry probes. No network policy apply
   is implied by this document's merge.
3. **H-window after Decimal's handoff:** verify the pinned connector and encrypted
   token delivery, three exact mappings/default404, Access service policies,
   selected commits/pins and stop owner. Start only under the separately agreed
   procedure, keeping flags false; establish actual Tunnel/HTTPS/JWT evidence.
4. **Capabilities later:** token reads before bounded selected-pool reads;
   session/grant acceptance separately; preview/deposit/financial execution remain
   unavailable until their own gates. Public-read permission is never a wallet
   grant or execution permission.

If a policy or probe fails, leave admission disabled and stop only the affected
diagnostic/service path through the coordinator. Remove/revert its reviewed
egress additions, preserve the existing host isolation and evidence, and do not
restore database state or turn off another task's services. No action in this
preparation changes Cloudflare resources owned by Decimal.
