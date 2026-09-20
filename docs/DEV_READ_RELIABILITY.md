# Continuous development read operation

The owner authorized the preventive deployment on 20 September 2026 after the
development lane's seven-day authorization expired and disconnected its Tunnel.
This operating profile supersedes manual renewal for the adopted runtime. It
does not enable financial services or change Cloudflare Access or API contracts.

## How continuity works

`dev_read_maintenance.py` manages a **revocable standing authorization** and
finite seven-day leases. A systemd timer checks every 15 minutes and renews when
three days remain. Firewall, reader qualification and gateway admission receive
one deadline. A machine returning after a long outage can renew an expired lease
before its development services start, provided authorization is still enabled,
the adopted baseline matches, time is synchronized, and DNS/TLS checks pass.

This preserves application expiry checks rather than substituting an arbitrarily
distant date. The current grant's date is not a scheduled service shutdown while
automatic renewal works. Renewal restarts the reader and retains its mandatory
60-second cooldown, approximately once every four days. Consumers must handle
the existing temporary unavailable/cooldown response.

The manager verifies its root-owned control file, tracked file hashes and modes,
loaded unit configuration, provider/tunnel hostname inventory and synchronized
clock before mutating anything. DNS or baseline failures before a transaction
leave the existing valid lease running and raise a monitor issue.

Changing DNS addresses triggers a development-only update of nft sets, service
IP allowlists and namespace-bound hosts files. HTTPS addresses must be public
IPv4 and pass certificate verification for their existing hostname. Tunnel edge
addresses must remain within the explicit region1/region2 Cloudflare inventory
ranges. An unfamiliar Tunnel range requires operator intervention; it is not
automatically broadened. Hostnames and provider URLs cannot be added through
the control file.

The transaction uses `/opt/domino/.disabled-install.lock`, private backups and a
durable journal. It validates nft syntax, closes admission during staging, then
publishes matching admission before starting the gateway, which checks its grant
at startup. The reader's own cooldown continues to reject premature data reads.
Only successful readiness and a WETH read commit the new lease. The manager
compares the production policy/PIDs across live transactions. Interrupted work
is restored from hash-checked backups before another adoption is attempted.
An unsuccessful renewal restores the prior still-valid lease when possible.

## Services and files

| Component | Purpose |
| --- | --- |
| `domino-dev-continuous.target` | Enabled boot target for this operating profile |
| `domino-dev-maintenance-boot.service` | Validates/reconciles authorization and recreates the reviewed connector marker before dev starts |
| `domino-dev-maintenance.timer` | Lease and DNS/TLS check every 15 minutes |
| `domino-dev-health.timer` | Read-only observation roughly every minute |
| Role `90-continuous.conf` | `Restart=on-failure`, ten-second backoff and bounded start rate |
| `/etc/domino/dev-maintenance/control.json` | Root-only standing authorization and lease timing |
| `/var/lib/domino-dev-maintenance/lease.json` | Adopted baseline and committed deadline |
| `/var/lib/domino-dev-maintenance/transaction.json` | Present only during a staged transaction/recovery |
| `/var/lib/domino-dev-maintenance/status.json` | Sanitized latest health result |
| `/var/lib/domino-dev-maintenance/last-error.json` | Sanitized most recent maintenance failure, cleared on successful completion |

The continuous target **wants** individual application services instead of
requiring their success as a group. The legacy `domino-dev-off.target` is stopped
at installation, because its older Requires/PartOf relationships can propagate
a gateway startup failure into repeated restarts of the whole development lane.
The egress prerequisite and existing role isolation remain mandatory.

The startup validator never synchronously starts units ordered after itself.
This avoids a systemd dependency cycle. A busy operator lock is a failure for
boot validation; only the periodic maintenance check may skip a busy lock.

## Observation and alerts

The monitor compares **five** deadline observations: reader, gateway, saved nft,
effective nft and committed lease. It checks process state, whether the reader
loaded its current profile, connector connections and application readiness.
It reports expiry thresholds at 48 hours, 24 hours and one hour. A renewal
failure becomes critical when at most an hour remains.

Zero connections for 60 seconds is critical; fewer than four for 120 seconds is
degraded. A fresh transaction/cooldown is labeled maintenance, with the raw
observations retained; stale transactions remain failures. It verifies a real
WETH token read at most once every 15 minutes, preserving the six-start/minute
application budget. Journal messages are emitted on issue transitions only.

A Codex heartbeat named **Saúde do túnel dev-read** checks the server report and
timers every 30 minutes and notifies the owner only of actionable changes or
recovery. It also flags a status file older than five minutes and SSH failures.
Server-side renewal and observation do not depend on the desktop being awake;
desktop alert delivery does depend on the automation host being available.
Journal/status files retain server-side evidence if desktop delivery is delayed.

Public authenticated verification is supported but requires a legitimate Access
client credential. The credential was not available at deployment. The monitor
reports that gap rather than treating an unauthenticated public 401 as success.
Store the private JSON expected by `dev_read_health.py` at
`/etc/domino/dev-maintenance/access.json`, root-owned mode 0600. Never paste its
contents into chat, Git, a shell argument or a report. The public status route is
`https://dev-read.domino.money/internal/dev/v1/status`, not `/health`.
Accepted fields are `clientId` and `clientSecret`, optionally with the launcher's
integer `version: 1`; extra fields or other versions are refused.

## Operation

Inspect without exposing credentials:

```sh
sudo cat /var/lib/domino-dev-maintenance/status.json
systemctl list-timers 'domino-dev-*' --all
sudo journalctl -u domino-dev-maintenance.service -u domino-dev-health.service --since '1 hour ago'
```

Run a scheduled check or a deliberate renewal:

```sh
sudo systemctl start domino-dev-maintenance.service
sudo python3 -B /usr/local/lib/domino-dev-maintenance/dev_read_maintenance.py renew
```

Revoke immediately:

```sh
sudo python3 -B /usr/local/lib/domino-dev-maintenance/dev_read_maintenance.py revoke
```

Revocation disables standing authorization and gateway admission, closes the
development firewall and stops development application services. It does not
revoke/delete the external Cloudflare service token. Re-enabling is a deliberate
operator requalification/adoption, not simply setting an old timestamp forward.

After an application deployment changes tracked profiles or unit configuration,
the manager intentionally refuses renewal until that new, verified baseline is
adopted. The operator must review the changes, validate the runtime, take the
operator lock, and update the private lease snapshot with this manager's
`snapshot()` function. Do not overwrite baseline state to silence an unexplained
drift alert. Old version-bound staging manifests are not current renewal tools.

## Further availability work

The selected mitigation for DNS changes is guarded pin refresh; no private RPC
network route was required for this delivery. The reader is in a VM and the node
is on clawber, so loopback is not interchangeable. A later private route must
preserve authentication and source fallback.

A second connector on the same physical host would retain the host failure
domain. No independent always-on host was provisioned here. Deploy a replica
only when such a host and protected origin connectivity are available; it would
not replace authorization renewal or application-level checks.

Reference: [Cloudflare Tunnel firewall requirements](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/),
[Tunnel metrics](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/metrics/).
