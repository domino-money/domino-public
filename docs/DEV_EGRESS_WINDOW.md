# Development egress window candidate (#132)

`scripts/staging/dev_egress_policy.py` renders a finite, expiring network
candidate for the separate development reader, gateway and connector. It does
not resolve hosts, read credentials, contact providers, write files, run native
commands, install, start, renew or enable a service. Output remains
`applied:false`, `policyQualified:false`, `activationSelected:false`.

The [OFF infrastructure](DEV_INFRASTRUCTURE_OFF.md), separately reviewed
backend/profile, Access mapping, quota admission and operator installation
transaction remain prerequisites. Production units, UIDs, ports and tables are
not targets of this renderer.

## Input and fixed scope

Pass one JSON document on stdin, at most 65,536 bytes. Unknown or duplicate
fields, unexpected host pins, URLs, noncanonical addresses and invalid times
are rejected with fixed error codes. No field accepts a provider URL or key.

| Field | Meaning |
| --- | --- |
| `version` | Integer `1` |
| `profile` | Optional `dns_expiring_qualification` (the unchanged default), or explicit `continuous_operator_pins` |
| `observedAt`, `expiresAt` | UTC `YYYY-MM-DDTHH:MM:SSZ`; permission expiry is bounded by the selected profile |
| `operatorAuthorization` | Required only for `continuous_operator_pins`, with the exact fields described below |
| `offManifestSha256` | Exact lowercase SHA256 of the separately reviewed installed OFF manifest |
| `rpcHosts` | Nonempty unique list selecting only `robinhood-mainnet.g.alchemy.com` and/or `rpc.domino.money`, matching the actual private dev configuration; Robinhood's public RPC is not admitted |
| `inventoryHost` | `robinhood-mainnet.g.alchemy.com` or `null`, matching that configuration |
| `accessIssuer` | Dedicated dev issuer hostname, such as `example.cloudflareaccess.com`; no scheme/path |
| `tunnel` | Object with optional boolean `dnsStub` and `accessJwks`; both default to `false` |
| `hosts` | Exact inventory of the selected RPC/inventory hosts, both analytics hosts, issuer and two edge hosts |

Every `hosts` record has exactly `hostname`, `addresses`, `observedAt` and
`expiresAt`. Supply independently verified, fresh DNS/TLS evidence; the renderer
does not verify that a claimed observation happened. There must be 1–64 unique
canonical global IPv4 addresses per host. Both profiles require fresh evidence
for adoption; the two profiles deliberately give DNS TTL different meanings.

`dns_expiring_qualification` keeps the original maximum600-second permission
window. Each source must cover the whole window and be observed no more than
600 seconds before the snapshot. At least10 seconds must remain. A60-second DNS
TTL may yield a42-second native probe window; it is never extended. Such a
window cannot admit an application read after the reader's60-second startup
cooldown. This profile is for bounded native qualification, not continuous
availability; repeated restarts would repeat that cooldown.

`continuous_operator_pins` requires exactly this additional object:

```json
{
  "operatorAuthorization": {
    "authorizationId": "<64 lowercase hexadecimal characters identifying the private approval>",
    "grantedAt": "YYYY-MM-DDTHH:MM:SSZ",
    "expiresAt": "YYYY-MM-DDTHH:MM:SSZ",
    "revoked": false
  }
}
```

The grant must already be effective, unrevoked and no longer than seven days;
its `expiresAt` must equal the snapshot's `expiresAt`. Unknown fields, future or
expired grants, missing authorization and `revoked:true` are rejected. There is
no unbounded or disabled-expiry mode. Every original-direction nft grant and
relative set timeout uses this effective authorization deadline.

`authorizationId` references an external operator approval of the exact
`pinSetSha256`, role/port scope and `offManifestSha256`; it is not a
self-certifying approval supplied by JSON. The installer must verify that
binding against its private current authorization journal.

Each DNS observation must still be valid and at most600 seconds old when this
continuous candidate is rendered. Output `adoptionDeadline` is the earliest
source TTL, source observation plus600 seconds, or authorization expiry; at
least10 seconds must remain. The installer must recheck that deadline, actual
DNS/TLS evidence and the current unrevoked authorization immediately before
initial adoption or a changed-pin update. It must refuse stale staged output.

After adoption, these are explicitly **operator-held static pins** through
`effectivePermissionExpiry`, even after the DNS TTL has elapsed. This does not
claim that DNS remains fresh for seven days. There is no periodic DNS-TTL
restart and no reset of the reader's startup cooldown or provider budgets.
Changed DNS, failed TLS, revocation or other drift requires an operator decision
and a guarded dev-only update or OFF restoration; there is no automatic widening.

The two mandatory analytics hosts are `api.geckoterminal.com` and
`api.dexscreener.com`. The two edge hosts are `region1.v2.argotunnel.com` and
`region2.v2.argotunnel.com`; addresses must belong to the exact reviewed global
inventory reused from `egress_policy.py`, not a Cloudflare CIDR. The operator
must refresh that inventory if Cloudflare changes it. An existing production
issuer is not automatic approval of the development issuer.

| Role | Fixed identity/cgroup | Positive permission during the window |
| --- | --- | --- |
| Reader | UID/GID974, `/dominodev.slice/domino-dev-read.service` | Its configured RPC/inventory and Gecko/Dex IPv4 TCP443 |
| Gateway | UID/GID975, `/dominodev.slice/domino-dev-gateway.service` | Its issuer IPv4 TCP443 and original loopback TCP8890 |
| Connector | UID/GID976, `/dominodev.slice/domino-dev-tunnel.service` | Edge IPv4 TCP/UDP7844 and original loopback TCP8891 |

If the selected remote mapping uses connector-side Access verification, set
`accessJwks:true`: it grants the connector TCP443 only to the exact issuer pins
in a separate set. It never grants 443 to the edge set. If the connector requires
DNS/SRV discovery, `dnsStub:true` admits only that connector to
127.0.0.53 TCP/UDP53. The reader and gateway use mounted host pins and receive
no DNS permission. These flags are independent and require explicit review;
DNS can answer arbitrary names, but subsequent IP/port egress remains restricted.

There is no IPv6, public listener, direct connector→reader, production loopback
or unrestricted established-connection grant. Existing replies are allowed
only from each role's fixed loopback listener, with connection-tracking reply
direction. Every original-direction permission, including DNS, local origins
and established external traffic, has the original absolute UTC deadline.
External sets also expire relatively; delayed installation cannot extend the
absolute deadline. At expiry the chains retain their final drops and listener
replies. This requires trustworthy host time and functioning native nft/BPF.

## Artifacts, renewal and OFF restoration

The seven artifacts are the existing dev nft target
`/etc/domino/dev/off-policy.nft`, three role-specific
`/etc/domino/dev/ROLE/hosts` files, and three
`domino-dev-ROLE.service.d/50-dev-egress.conf` drop-ins (the reader unit uses
`domino-dev-read`). Hashes and intended root ownership/modes accompany every
file. The nft file is0600; non-secret host files and drop-ins are0644.

The nft candidate atomically replaces only `inet domino_dev_off` with
add/delete/add in one transaction. A second permissive table could not override
the OFF table's drops. The base hook keeps policy accept for unmatched UIDs;
the actual host's other chains can still deny permitted traffic.

Drop-ins reset IP allow/deny lists, deny everything except exact role addresses,
and add only that role's host-file bind to `/etc/hosts`. They preserve the
existing read-only private-directory bind and do not change commands, enable
flags, identities, resource limits or startup policy. Host files contain only
IPv4 localhost and that role's required names. These file binds pin inodes:
replacement requires draining/restarting the dev services, not hot file renewal.
IP/port policy cannot distinguish different TLS names sharing one allowed IP;
the reviewed application must retain its fixed endpoint/issuer validation.

Before first application, the external operator transaction must verify the
full OFF manifest and policy hash, fixed accounts/groups, absent new paths,
source/binary/profile identity, full units/firewall, DNS/TLS evidence and quotas.
Acquire the existing operator lock; drain all three dev services and dev policy,
retain current kernel denial, atomically stage the finite files, run native
syntax/merged-unit checks, then start only the independently authorized dev
selection and prove actual mounts/BPF/positive and negative paths. Connector
selection and reader enablement are separate changes, not selected here.
The current separately implemented installer is OFF-only. Positive adoption
and nft-only renewal still require their own reviewed operator transaction;
this renderer does not add those modes to that installer.

A new authorization requires a newly observed, independently admitted snapshot
and the exact previous installed file hashes. The normalized `pinSetSha256`
binds role-specific hostname/IP mappings and both connector permission flags,
independently of evidence timestamps or authorization IDs. Identical pins keep
all six host/drop-in artifact bytes and hashes unchanged. Do not replace those
files or restart the reader merely because a DNS TTL elapsed.

For a newly authorized continuous renewal with identical pins and effective
units, the external installer may perform a separately guarded atomic nft-only
transaction under the same operator lock, preserving running processes and
budgets. It must check current authorization/revocation, baseline, installed
hashes and actual pins/BPF; a hash alone does not establish live state. Changed
pins, connector flags, units or host-file inodes require the original dev-only
drain/restart and native proof. Unknown drift is refused. Without a new valid
authorization, the old absolute expiry remains in force and traffic is denied.

Revocation is an explicit operator action, not a background capability of this
renderer: invalidate the recorded authorization ID, disable dev admission,
and, under the operator lock and an exact known-state guard, immediately replace
the dev table with the exact OFF policy in one nft transaction. Do this before
waiting for dev processes to drain: the existing positive BPF cannot override
the OFF table's drops. Then drain dev dependents and restore the six files.
Setting `revoked:true` in a future input rejects generation but cannot change
an already-installed kernel policy. The installer must consult the current
private authorization journal; an old JSON document is never proof that a grant
is still active.

The output's `rollback` binds the original OFF manifest, exact OFF nft bytes and
digest from `dev_infrastructure.policy()`, and the six added files with their
positive hashes. First restore immediate OFF kernel denial as above, then drain
dev services, persist the OFF nft file and remove only those six files whose
current bytes match the recorded candidate. Retain the restrictive dev table.
Removing the drop-ins restores the base OFF BPF and
private-directory mounts. No credential, profile, production file, service or
database is a rollback target. The operator must refuse unknown drift.

```sh
python3 -B scripts/staging/dev_egress_policy.py < /private/operator/dev-egress-snapshot.json
python3 -B -m unittest discover -s scripts/staging/tests -p test_dev_egress_policy.py -v
```

The focused tests cover scope, timing, explicit connector permissions, host
mounts, strict input, hashes and OFF restoration offline. They do not claim
native nft/BPF enforcement, actual provider headroom or an operational Tunnel.
