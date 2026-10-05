# Continuous egress and family activation

The home VM's continuous egress policy — the nft table
`domino_continuous_reads`, one chain per service identity, default deny — was
assembled by hand one role at a time. It describes the identities that existed
when each piece was written. The four financial identities installed on
13 September (`performance`, `performance-collector`, `execution-status`,
`execution-signer`) have no chain and fall through to the table's accept, so
for them the only boundary is each unit's own `IPAddressAllow=localhost`. The
three older private families (`auth`, `onboarding`, `deposit`) have a chain
that admits nothing but their listener's replies, and the tunnel may originate
only to the gateway — so a listener behind `vm-session` or `vm-onboarding` is
unreachable from the connector today, whatever the Cloudflare route says.

`scripts/staging/continuous_egress_policy.py` renders the whole policy for all
fifteen production identities, from operator pins on stdin, together with the
per-unit drop-in, hosts file and target that activate a unit behind it. A
family gets its external destinations, and the tunnel a way to reach its
listener, only when the family is named in `enabled`. The three layers cannot
disagree because one document produces all of them.

It resolves nothing, reads nothing from the host, writes nothing and applies
nothing. The output is a candidate.

## What each identity may reach

Derived from each service's own code, not from a wish list. A class is
rendered only for an enabled role and only for the hostnames actually pinned.

| Identity | Listener | External classes | Why |
|---|---|---|---|
| `read` | 8876 | rpc, analytics | discovery and the market provider |
| `gateway` | 8878 | jwks | `AccessVerifier` fetches the issuer's certs |
| `auth` | 8879 | rpc, jwks | `EoaChecker`; assertion verification |
| `onboarding` | 8880 | rpc, jwks, uniswap | plus the trade API quote |
| `deposit` | 8881 | rpc, jwks, uniswap | same |
| `performance` | 8900 | rpc, jwks | |
| `performance-collector` | — | rpc | reads chain state, serves nothing |
| `execution-status` | 8901 | jwks | Access assertions, database and exact VM-local EOA RPC at `127.0.0.1:18547` |
| `execution-signer` | — | rpc | `ExecutionRpc` broadcast |
| `tunnel` | 20241 | edges, jwks | 7844 to the official edge inventory; connector JWKS |
| `write` | — | rpc; chains with `v2Chains` | the public-data lanes, featured, the queue worker, the followers and the V2 indexer |
| `operator`, `admin` | — | — | never |
| `position-plan` | 8911 | rpc, jwks, uniswap; chains with `v2Chains` | the S1 plan listener (`install_position_plan.py`): `EoaChecker` and plans; assertion verification; Trading API router legs. Optional: a host without the identity renders no chain for it |
| `v2-automation` | — | rpc; chains with `v2Chains`; the node's proxy with `nodeLoopbackReads` | the V2 automation (`install_v2_automation.py`), one instance of `domino-v2-automation@.service` per chain, which binds `v2-automation.hosts` itself. Optional: a host without the identity renders no chain for it |

Classes: `rpc` is `robinhood-mainnet.g.alchemy.com` or the private
`rpc.domino.money` route (Robinhood's public RPC is not admitted);
`analytics` is `api.geckoterminal.com` or
`api.dexscreener.com`; `uniswap` is `trade-api.gateway.uniswap.org`; `jwks` is
exactly the pinned Access issuer; `edges` are the two `argotunnel.com` names,
whose pins must be members of the official inventory the module carries;
`chains` is Base's and Arbitrum's hosted RPC: Chainstack, Alchemy, and each
chain's public endpoint as a last resort (`CHAIN_HOSTS`). It is granted only
by `v2Chains`, and only to the writer (its V2 indexer instances) and the plan
listener. A host that serves Robinhood alone pins none of it.

Loopback: the gateway may originate to the reader; the tunnel may originate to
every enabled listener it fronts. The tunnel uses the stub resolver; every
other enabled unit reads a pinned hosts file bound over `/etc/hosts` and never
resolves. The writer has no unit of its own here: its units bind `write.hosts`
themselves (`ops/systemd`), and it keeps the stub for operator commands run as
`domino-write` outside them.

The writer resolved through the stub until #315, and that cost minutes of reads
several times a day. `rpc.domino.money` answers with one of two Cloudflare pairs,
alternating with its 300 s TTL, and the writer's set held only the pair seen when
the pins were collected. A call to the other pair hung in `SYN-SENT` until its
deadline, for one or two TTLs. A hosts file rendered from the same pins as the
set cannot lead outside it.

For the V4 sequence snapshot, the reader can use the private VM loopback RPC
at `127.0.0.1:18547`. Set the optional boolean `sequenceSnapshotLoopback` in
the operator policy input only when that tunnel and the reader's matching
private configuration are installed. It adds one reader-owned, loopback-only
TCP rule for port 18547 before the reader's closing rules. The reader option
grants no other service identity or external address. Without it, the renderer
preserves the earlier reader policy.

With the optional boolean `nodeLoopbackReads`, the reader and the writer may
lead their chain reads with that proxy: their private provider files name
`http://127.0.0.1:18547/` first and `rpc.domino.money` next
([local RPC source](LOCAL_RPC_SOURCE.md)). Each of the two identities that is
enabled gets the same exact loopback rule, commented `private node RPC`; the
reader holds one rule for the port whichever of the two options asks for it.
It requires `read` or `write` in `enabled`, and it grants nothing else. Load it
before a provider file names the proxy. Without the rule every call first
fails at the proxy: refused at once under a table with the reset rule below,
and hung until its deadline under the first VM's.

When `execution-status` is enabled, its identity gets a separate rule for the
same exact loopback port. Its private profile must select
`http://127.0.0.1:18547/`; the session checker verifies chain 4663 and a fresh
pinned block before classifying an EOA. This rule does not grant that identity
an external RPC route or change the reader's snapshot opt-in. Its only external
destination is the separately pinned Access issuer for JWKS refresh.

## Input

```json
{
  "version": 1,
  "resolver": "127.0.0.53",
  "accessIssuer": "<team>.cloudflareaccess.com",
  "enabled": ["read", "gateway", "tunnel", "write"],
  "sequenceSnapshotLoopback": true,
  "nodeLoopbackReads": true,
  "v2Chains": true,
  "identities": { "<role>": { "user", "realUid", "effectiveUid", "gid",
                              "supplementaryGids", "unit", "cgroup" } },
  "hosts": [ { "hostname": "...", "addresses": ["..."] } ]
}
```

The optional `sequenceSnapshotLoopback` field defaults to false and requires
`read` in `enabled` when true. It changes the nft policy and its pin digest,
not the unit drop-ins or the public Worker flag. `nodeLoopbackReads` does the
same for the reader and the writer, and requires either in `enabled`.
`v2Chains` (`--v2-chains` when collecting) grants `chains` to the writer and the
plan listener, and requires either in `enabled`.

`identities` names all fifteen roles exactly. `admin` may be `null`, and so
may `position-plan` and `v2-automation` until their installers create the
accounts; an
enabled role with a `null` identity is refused (`enabled_role_without_identity`).
Roles with a service unit must name `domino-<role>.service` and its system-slice
cgroup; `write`, `operator`, `admin` and `v2-automation` must name none. `hosts` are the
operator's pins: public IPv4 only, no private, loopback, metadata or reserved
address, no duplicates, edges only from the official inventory. Every pinned
hostname must be needed by some enabled role, and every enabled role must find
its required classes pinned — a family enabled without the issuer, or
`onboarding` without the trade API, is refused as `incomplete_host_inventory`.

```sh
python3 scripts/staging/continuous_egress_policy.py < pins.json > candidate.json
```

## What it renders

| Artifact | Mode | Notes |
|---|---|---|
| `/etc/domino/continuous-reads/policy.nft` | 0600 | the whole table, every identity, default deny |
| `/etc/domino/continuous-reads/<role>.hosts` | 0644 | for each enabled unit with pins, and `write.hosts` for the writer, whose units bind it; edge names are not pinned here |
| `/etc/systemd/system/domino-<role>.service.d/60-continuous-reads.conf` | 0644 | for each enabled unit: bound to the egress service and the target, address allow-list, hosts bind |
| `/etc/systemd/system/domino-continuous-reads.target` | 0644 | `Requires=` the egress service and the read path (reader, gateway, tunnel); `Wants=` each enabled family |

A family's drop-in also carries `ExecStart=` with the installer's exact
command plus its enable flags, derived from `upgrade_financial.unit_text` so
the two cannot drift. The read path's drop-ins carry no `ExecStart`: the
release drop-in owns it. Families read their environment from
`/etc/domino/financial/<component>/environment`, which their unit already
names; the gateway keeps `gateway.env`. Neither file's contents are rendered.

Every chain ends in two rules. A connection attempt no rule admitted (a TCP
SYN without ACK) is answered with a reset, so the caller sees a refusal at once
and tries its next route instead of waiting out its deadline. Every other
packet keeps the silent drop: a reset for a stray packet of a connection a rule
accepted, a listener's late reply for one, would tear that connection down.
Both rules count in the chain's `denied_<role>` counter.

## The procedure

Render, then review the candidate against what is installed before anything
moves. The renderer proves it describes the host: given the live pins and
`enabled` as today, it reproduces every live chain, set, drop-in, hosts file
and the target, apart from the reset rule each chain gained with #315 (the test
pins both against a masked copy of the live file).

```sh
# 1. What the candidate changes on this host: each artifact new, changed or
#    the same. Nothing is written.
sudo python3 -B install_continuous_egress.py --candidate candidate.json --update --inspect

# 2-3. Write the new and changed artifacts with their rendered mode and owner.
#    The new policy passes `nft -c` before any file moves, and what each
#    artifact replaced is kept in the backup directory, which must not exist.
#    It reloads systemd; it loads no table and restarts nothing.
sudo python3 -B install_continuous_egress.py --candidate candidate.json --update --apply \
  --backup /root/egress-backup-$(date -u +%Y%m%dT%H%M%SZ)

# 4. Load it the way the egress service does, as one nft transaction. The
#    file's own delete/add pair rebuilds the table from the file, and every
#    rule counter restarts at zero: that is the evidence the live chain now
#    comes from the file. Do NOT restart the egress service for this: the
#    reader, gateway and tunnel are BindsTo= it, and an explicit restart
#    propagates to them — on 16 September it stopped and restarted the reader
#    and the gateway (journal: Stopping, Deactivated, Stopped, Started at
#    11:33:46Z), which that day's record did not notice.
sudo nft -f /etc/domino/continuous-reads/policy.nft
sudo systemctl daemon-reload

# 5. Nothing else moved.
systemctl is-active domino-continuous-reads.target domino-read.service \
  domino-gateway.service domino-continuous-egress.service domino-tunnel.service
curl -s --max-time 5 127.0.0.1:20241/metrics | grep '^cloudflared_tunnel_ha_connections'
sudo nft list chain inet domino_continuous_reads tunnel
```

The drop-in and target changes take effect at each unit's next start; when the
pins are unchanged, the address allow-lists they carry are too, so nothing waits
on that. Rollback is `install_continuous_egress.py --restore <backup>`, which
puts back what the update replaced and removes what it added, then the same
load. Neither mode removes an installed file the candidate does not name.

### The first apply

Against today's host with today's `enabled`, a first apply changes no
permission. Four things differ in form, all from the hand-written history:

- the `write` set moves inside its chain block, and its two resolver rules
  render tcp-then-udp like the tunnel's — the fragment was folded in the
  other way round;
- the tunnel drop-in's allow-list is sorted numerically;
- the gateway drop-in loses the stale `ExecStart` it carried from an old
  release; the release drop-in has owned that line since;
- hosts files are sorted by hostname.

And four things are added: a chain, counter and jump for each of the four
financial identities, each admitting only its listener's replies. That closes
the fall-through.

### Switching a family on

Add it to `enabled`, pin what its classes need, render, review, apply as
above, then `systemctl start domino-<role>.service` — the target now wants
it, so the next start of the target brings it too, and its own restarts stay
its own. The rest of a family's
activation is its own work and is not here: the private files under
`/etc/domino/financial/<component>/` — `environment`, and the file the
rendered command names: `rpc.json` for `auth`, `onboarding` and `deposit`
(the listener refuses to start enabled without it; owned by the family's
account, mode `0600`, an `rpcUrl` on an allowed host), `profile.json` for
`performance` and `execution-status` — the Access application and hostname,
the tunnel route, the Worker's service token and flag (#170–#174). For `auth`,
the release the listener runs is named by its own `50-release.conf`, written by
`install_auth_release.py`, and for `performance`, `performance-collector` and
`execution-status` by `install_financial_release.py`
([financial upgrade](FINANCIAL_BACKEND_UPGRADE.md)); the egress drop-in sorts
after it and replaces only `ExecStart`, whose relative script path resolves in
that release.

A family in the target's `Requires=` shares its failures with the read path.
systemd propagates a member's restart to the target that requires it, and the
target's restart to every unit `PartOf=` it: on 24 September `domino-auth`,
enabled while its drop-in had lost its configuration bind, exited at start, and
each of its three automatic restarts restarted the egress service, reader,
gateway, tunnel and the public-data lanes (23:20:50 to 23:21:09 UTC), until its
start limit left it failed and the target inactive. Recovery put the target
back without it and set its egress drop-in aside. The renderer
now names families in `Wants=` and only the read path in `Requires=`: `Wants=`
carries no restart back to the target, and the family's `PartOf=` still takes it
down with the target. Start a family enabled and watch it run before applying a
candidate that adds it.

### Node loopback reads and the writer's hosts file (#315)

Rendered for the live `enabled` with `nodeLoopbackReads`, a candidate differs
from the table the first VM loaded in four ways:

- the writer's chain admits `127.0.0.1:18547`, and the reader's rule for that
  port is commented `private node RPC`;
- every chain gains the reset rule ahead of its drop;
- `write.hosts` is a new file;
- the read and auth drop-ins and hosts files change only if the pins did.

Install `write.hosts` before the public-data release whose units bind it: a
unit whose bind source is missing does not start. Load the table before any
provider file names the proxy. Collect the pins again on the day: the reader's
and the writer's hosts files pin `rpc.domino.money` to whatever it answered
then. Both of its Cloudflare pairs may be pinned, since each is a pin the set
admits and each hosts file lists.

## Not yet a role

`domino-reference-collector` (the reference price timer) has no identity on
the host yet. The renderer names exactly the identities that exist; add the
role when the account is created, with no listener and a class of its own for
its two providers, `api.g.alchemy.com` and `api.coingecko.com` — the prices
API is not the RPC host, and neither is a class any listener has.

The review-plan baseline in `scripts/staging/dev_infrastructure.py` records a
digest of the policy file that predates the indexer fragment; once a rendered
file is installed, that digest can be re-pinned to the rendered bytes.
