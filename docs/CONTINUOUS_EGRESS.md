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
thirteen production identities, from operator pins on stdin, together with the
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
| `auth` | 8879 | rpc, jwks | `PlainEoaChecker`; assertion verification |
| `onboarding` | 8880 | rpc, jwks, uniswap | plus the trade API quote |
| `deposit` | 8881 | rpc, jwks, uniswap | same |
| `performance` | 8900 | rpc, jwks | |
| `performance-collector` | — | rpc | reads chain state, serves nothing |
| `execution-status` | 8901 | — | database only |
| `execution-signer` | — | rpc | `ExecutionRpc` broadcast |
| `tunnel` | 20241 | edges, jwks | 7844 to the official edge inventory; connector JWKS |
| `write` | — | rpc | the indexer's provider |
| `operator`, `admin` | — | — | never |

Classes: `rpc` is `rpc.mainnet.chain.robinhood.com` or
`robinhood-mainnet.g.alchemy.com`; `analytics` is `api.geckoterminal.com` or
`api.dexscreener.com`; `uniswap` is `trade-api.gateway.uniswap.org`; `jwks` is
exactly the pinned Access issuer; `edges` are the two `argotunnel.com` names,
whose pins must be members of the official inventory the module carries.

Loopback: the gateway may originate to the reader; the tunnel may originate to
every enabled listener it fronts. The tunnel and the indexer use the stub
resolver; every other enabled unit reads a pinned hosts file bound over
`/etc/hosts` and never resolves.

## Input

```json
{
  "version": 1,
  "resolver": "127.0.0.53",
  "accessIssuer": "<team>.cloudflareaccess.com",
  "enabled": ["read", "gateway", "tunnel", "write"],
  "identities": { "<role>": { "user", "realUid", "effectiveUid", "gid",
                              "supplementaryGids", "unit", "cgroup" } },
  "hosts": [ { "hostname": "...", "addresses": ["..."] } ]
}
```

`identities` names all thirteen roles exactly (`admin` may be `null`). Roles
with a service unit must name `domino-<role>.service` and its system-slice
cgroup; `write`, `operator` and `admin` must name none. `hosts` are the
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
| `/etc/domino/continuous-reads/<role>.hosts` | 0644 | for each enabled unit with pins; edge names are not pinned here |
| `/etc/systemd/system/domino-<role>.service.d/60-continuous-reads.conf` | 0644 | for each enabled unit: bound to the egress service and the target, address allow-list, hosts bind |
| `/etc/systemd/system/domino-continuous-reads.target` | 0644 | `Requires=` the egress service and every enabled unit |

A family's drop-in also carries `ExecStart=` with the installer's exact
command plus its enable flags, derived from `upgrade_financial.unit_text` so
the two cannot drift. The read path's drop-ins carry no `ExecStart`: the
release drop-in owns it. Families read their environment from
`/etc/domino/financial/<component>/environment`, which their unit already
names; the gateway keeps `gateway.env`. Neither file's contents are rendered.

## The procedure

Render, then review the candidate against what is installed before anything
moves. The renderer proves it describes the host: given the live pins and
`enabled` as today, it reproduces every live chain, set, drop-in, hosts file
and the target (the test pins that against a masked copy of the live file).

```sh
# 1. Back up what is there.
sudo cp -p /etc/domino/continuous-reads/policy.nft \
  /etc/domino/continuous-reads/policy.nft.bak-$(date -u +%Y%m%d)

# 2. Install each artifact with its mode and owner (root), from the candidate.

# 3. Check the file before it is loaded; nothing is applied by this.
sudo nft -c -f /etc/domino/continuous-reads/policy.nft

# 4. Load it. The file's own delete/add pair rebuilds the table from the file,
#    and every rule counter restarts at zero: that is the evidence the live
#    chain now comes from the file.
sudo systemctl daemon-reload
sudo systemctl restart domino-continuous-egress.service

# 5. Nothing else moved.
systemctl is-active domino-continuous-reads.target domino-read.service \
  domino-gateway.service domino-continuous-egress.service domino-tunnel.service
curl -s --max-time 5 127.0.0.1:20241/metrics | grep '^cloudflared_tunnel_ha_connections'
sudo nft list chain inet domino_continuous_reads tunnel
```

Rollback is the backup copied back and the egress service restarted.

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
above, then `systemctl start domino-<role>.service` — the target now requires
it, so the next restart of the target brings it too. The rest of a family's
activation is its own work and is not here: the private environment and
profile under `/etc/domino/financial/<component>/`, the Access application
and hostname, the tunnel route, the Worker's service token and flag (#170–#174).

## Not yet a role

`domino-reference-collector` (the reference price timer) has no identity on
the host yet. The renderer names exactly the identities that exist; add the
role when the account is created, with no listener and a class of its own for
its two providers, `api.g.alchemy.com` and `api.coingecko.com` — the prices
API is not the RPC host, and neither is a class any listener has.

The review-plan baseline in `scripts/staging/dev_infrastructure.py` records a
digest of the policy file that predates the indexer fragment; once a rendered
file is installed, that digest can be re-pinned to the rendered bytes.
