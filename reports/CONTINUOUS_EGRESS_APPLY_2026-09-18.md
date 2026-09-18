# Continuous egress rendered whole and applied — 18 September 2026

## What changed and why

The continuous policy described nine identities. The four financial
identities installed on 13 September (`performance`,
`performance-collector`, `execution-status`, `execution-signer`) had no
chain and fell through to the table's accept, bounded only by each unit's
own `IPAddressAllow=localhost`. The policy file is now rendered whole by
`scripts/staging/continuous_egress_policy.py` (repository commit `89c44c8`)
from the operator's pins, with the activation drop-ins, hosts files and target
from the same document — `docs/CONTINUOUS_EGRESS.md`.

For today's enabled set (`read`, `gateway`, `tunnel`, `write`) the rendering
reproduces every live chain, set, drop-in, hosts file and the target, which
the renderer's test pins against a masked copy of the live file, and adds
exactly four chains, each admitting only its listener's replies. No
permission changed. Four artifacts differed in form and were replaced; four
were byte-identical and were not touched.

| Artifact | Result |
|---|---|
| `/etc/domino/continuous-reads/policy.nft` | replaced — four chains added; the `write` set and resolver pair in canonical order |
| `/etc/domino/continuous-reads/read.hosts` | replaced — same lines, sorted by hostname |
| `domino-gateway.service.d/60-continuous-reads.conf` | replaced — the stale `ExecStart` from an old release dropped; the release drop-in has owned that line since |
| `domino-tunnel.service.d/60-continuous-reads.conf` | replaced — same allow-list, sorted |
| read drop-in, `gateway.hosts`, `tunnel.hosts`, the target | byte-identical, untouched |

## How it was applied

1. The candidate was rendered locally from the pins read off the host minutes
   before, and proved equivalent to those same files a second time.
2. `policy.nft` copied to `policy.nft.bak-20260918`; the three other replaced
   files backed up beside themselves with the same suffix, verified by digest
   against the copies taken before the install. systemd ignores `.d/` entries
   that do not end in `.conf`, so the backups are not loaded as drop-ins.
3. The four files installed with `install`, root-owned, `0600` for the policy
   and `0644` for the rest; the installed policy's digest matched the
   candidate's (`8abbc509…`).
4. `nft -c -f` on the installed file, then `nft -f` — the egress service's
   own command, one atomic transaction — and `systemctl daemon-reload`.

**The egress service was deliberately not restarted.** The reader, gateway
and tunnel are `BindsTo=` it, and an explicit restart propagates to bound
units: on 16 September the restart recorded in
`CONTINUOUS_EGRESS_WRITE_2026-09-16.md` stopped and restarted `domino-read`
and `domino-gateway` (journal: Stopping, Deactivated, Stopped, Started at
11:33:46Z; the tunnel was already down that day). That record's "nothing else
moved" was wrong. Loading the file directly rebuilds the table the same way
and moves nothing.

## Verified

- `domino-read`, `domino-gateway`, `domino-tunnel` PIDs 124844, 124845,
  161183 before and after; all five units active; the ready file present;
  the egress service `active (exited)`, `NRestarts=0`;
  `cloudflared_tunnel_ha_connections 4` throughout.
- The table holds 14 chains (output plus thirteen). Every one of the thirteen
  deny counters read 0 packets immediately after the load — `denied_tunnel`
  had held 9 before, so the live chain now comes from the file.
- Live traffic through the rebuilt table, packets counted on the accept
  rules: tunnel UDP/7844 207 (the QUIC edge connections), tunnel DNS 2;
  indexer provider HTTPS 455 (89,468 bytes), indexer DNS 60.
- One `pool-market` read for WETH/USDG on the reader's loopback answered
  `200` in 3.52 s, `market.status available`, `cache miss` — it went to the
  provider — and the reader's external rule counted 111 packets
  (20,687 bytes). All thirteen deny counters still 0.
- The gateway's effective `ExecStart` still names release `85e7511` from the
  release drop-in; the tunnel's effective `IPAddressAllow` still lists 24
  entries. The gateway answering `404` on `/v1/capabilities` over loopback is
  not a regression: `85e7511` has no such route.

## Rollback

Copy each `.bak-20260918` back over its file, `nft -f
/etc/domino/continuous-reads/policy.nft`, `systemctl daemon-reload`. The
four financial identities return to falling through the table; nothing else
changes.

## What this does not do

No family is enabled. Each still needs its private environment and profile
under `/etc/domino/financial/<component>/`, its Access application and
hostname, its tunnel route, the Worker's service token and flag — #170 to
#174 — and then a rendering with the family named in `enabled`, applied the
same way, before `systemctl start` of its unit.
