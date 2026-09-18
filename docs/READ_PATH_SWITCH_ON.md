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

1. **Publish the Worker** (O5) — from `main`, keeping its enabled v1 reads and
   Access secrets. A Worker at `main` accepts the old reader on every enabled
   v1 route, so this step changes nothing a user sees on read-v1.
2. **Move the VM** (O4) — install the new release for both service identities
   and restart through `domino-continuous-reads.target`, never the members.

Each step is individually safe in that order. The window that the earlier plan
called unavoidable applies only to read-v2 `pool-market`, and it is the time
between the two steps: minutes, when they run back to back.

The release tooling cannot close that window by turning read-v2 off —
`releaseVars()` in `scripts/publish-read-path.mjs` publishes
`READ_V2_BRIDGE_ENABLED=true` unconditionally — and changing the Worker's
variables by hand outside the release script is not part of this procedure.
During the window every v2 `pool-market` answers 502
`upstream_contract_mismatch`, which the app treats as transient and bounded;
v1 market figures are unaffected. Run the two steps together and the window is
as short as the restart.

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
`/opt/domino/releases/<commit>/{read,gateway}`. Each carries two links rather
than copies: `backend/.venv` to the shared interpreter, and `backend/runtime`
to the directory holding that identity's private configuration, which lives
once and is inherited by every release after it.

`scripts/staging/upgrade_disabled.py` cannot perform this install. It validates
the whole host as the only thing on it, and this host also runs a financial
installation, a development lane, a tunnel, a continuous egress policy and the
indexer with its timers. `scripts/staging/install_read_release.py` claims only
the two read-path roots: it reads the release the units actually name, carries
the two links forward, requires the dependency lock to be unchanged because it
installs no package, and writes one directory and nothing else.

Run it from a root-owned path — it refuses a toolchain anyone else could have
written to:

```sh
sudo install -d -m 755 -o root -g root /opt/domino/upgrade-staging
sudo tar xf <archive> -C /opt/domino/upgrade-staging scripts/staging
sudo cp <archive> /opt/domino/upgrade-staging/
sudo chown -R root:root /opt/domino/upgrade-staging
sudo chmod -R go-w /opt/domino/upgrade-staging

cd /opt/domino/upgrade-staging/scripts/staging
sudo python3 -B install_read_release.py --inspect \
  --archive /opt/domino/upgrade-staging/<archive> \
  --archive-sha256 <sha256> --commit <commit>
# then the same command with --apply
```

The archive is a plain `git archive --format=tar <commit>`; its pax comment
carries the commit and is checked against `--commit`.

Installing changes nothing that is running. Activation is the drop-in swap and
the restart, and the order above still governs: the Worker moves first. Back the
drop-ins up, repoint them at the new release, then restart through the target:

```sh
for c in reader gateway; do
  u=$([ $c = reader ] && echo read || echo gateway)
  sudo sed -i "s|/opt/domino/releases/<previous>/|/opt/domino/releases/<commit>/|g" \
    /etc/systemd/system/domino-$u.service.d/70-$c-release.conf
done
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
