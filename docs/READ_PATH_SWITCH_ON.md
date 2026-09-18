# Switching production to the current read path

The reader and gateway on the home VM have served commit `85e7511` since
12 September while `main` moved on. This is the procedure for moving them, and
the order the wire contracts require.

## Why the order is not free

Both wire versions are unchanged — read-v1 is still `1.1.0-rc.3` and read-v2
still `2.0.0-rc.1` — while their schemas and producer behaviour changed under
those same strings. A hop validates the other side's bytes against whichever
schema version it was built with, so "same version" does not mean "compatible".

Measured by validating each side's producer fixtures with the other side's
runtime (each runtime accepts its own fixtures completely, so the cross results
are the real signal):

| Direction | read-v1 | read-v2 |
|---|---|---|
| Worker at `85e7511` validating the new reader | **6 of 62 rejected** | 1 of 25 rejected |
| Worker at `main` validating the old reader | **0 of 58 rejected** | 1 of 25 rejected |

The six read-v1 rejections are `markets-snapshot` (a route the old contract does
not have, and not in `ENABLED_READS`, so it is never asked) and two
`wallet-assets` paging fixtures, which gained `candidatesProbed`,
`candidatesSkipped` and `skippedReason` with the partial-page work.
**`wallet-assets` is one of the seven enabled reads**, so a reader that moves
first answers the Wallet card with 502 `upstream_contract_mismatch` until the
Worker catches up.

read-v2 `pool-market` is rejected in **both** directions: the protocol-fee
adjusted estimate was re-derived under an unchanged version. No ordering saves
it; only turning it off across the switch does.

## The order

1. **Turn read-v2 off** on the Worker, so `pool-market` v2 degrades to
   unavailable rather than answering 502 during the switch. The app already
   renders an unavailable state; a 502 is a failure it reports.
2. **Publish the Worker** (O5) — from `main`, keeping its enabled v1 reads and
   Access secrets. A Worker at `main` accepts the old reader on every enabled
   v1 route, so this step alone changes nothing a user sees.
3. **Move the VM** (O4) — install the new release for both service identities
   and restart through `domino-continuous-reads.target`, never the members.
4. **Turn read-v2 back on**, now that both sides derive the estimate the same
   way.

Steps 2 and 3 are each individually safe in that order. The window that the
earlier plan called unavoidable applies only to read-v2, and step 1 removes it.

## Before starting

```sh
# The tunnel is up and the whole path is active; three of four is the failure
# mode documented in HOME_VM_RUNBOOK.md section 6.
systemctl is-active domino-continuous-reads.target domino-read.service \
  domino-gateway.service domino-continuous-egress.service domino-tunnel.service
curl -s --max-time 5 127.0.0.1:20241/metrics | grep '^cloudflared_tunnel_ha_connections'

# The commit being released is green on main.
gh run list --branch main --limit 1
```

Record the commit now serving, so a rollback has a target:

```sh
systemctl show domino-read.service -p WorkingDirectory --value
systemctl show domino-gateway.service -p WorkingDirectory --value
sudo cp /etc/systemd/system/domino-read.service.d/70-reader-release.conf \
        /root/70-reader-release.conf.bak-$(date +%s)
sudo cp /etc/systemd/system/domino-gateway.service.d/70-gateway-release.conf \
        /root/70-gateway-release.conf.bak-$(date +%s)
```

## Step 2 — the Worker

The credentialed path is the `Publish read path` workflow, dispatched against
the exact commit (it refuses a mismatch):

```sh
gh workflow run read-path-release.yml -f operation=bridge -f source_sha=<commit>
```

`inspect` reports the existing access without printing credentials; `bridge`
runs `tunnels` then `worker`, retaining the enabled v1 reads and the Access
secrets already on the Worker.

## Step 3 — the VM

Production keeps one tree per service identity under
`/opt/domino/releases/<commit>/{read,gateway}`, each with its own venv and its
own `0600` runtime configuration. Install the new release beside the old one —
never in place, and never shared with the development lane, which has its own
root under `/opt/domino/dev/releases/`. Then repoint the two drop-ins and
restart through the target:

```sh
sudo systemctl daemon-reload
sudo systemctl restart domino-continuous-reads.target
systemctl is-active domino-continuous-reads.target domino-read.service \
  domino-gateway.service domino-continuous-egress.service domino-tunnel.service
```

## What proves it worked

```sh
# The reader answers on loopback and reports the release now serving.
curl -s --max-time 8 http://127.0.0.1:8876/health

# One structured line per hop, with the gateway's id carried into the reader.
sudo journalctl -u domino-gateway -u domino-read --since '-5 min' --no-pager -o cat | grep '^{' | tail
```

A served read leaves three lines under one `requestId`: the reader's health and
route hops, then the gateway's. A line with `"reason"` names why a hop refused,
and `gate`/`admitted` say whether admission was the cause — the evidence the
provider-window and admission questions are waiting on.

Then, from outside, `wallet-assets` is the route to exercise first: it is the
one whose schema moved, so it is the one that would have broken had the order
been reversed.

## Rollback

Restore the two drop-in backups, `daemon-reload`, and restart through the
target. A Worker at `main` accepts the old reader on every enabled v1 route, so
the Worker does not need to be rolled back with it; read-v2 stays off until both
sides agree again.
