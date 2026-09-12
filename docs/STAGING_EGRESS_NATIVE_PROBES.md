# Native egress qualification preparation

Status: candidate operator procedure and credential-free probe. No policy,
probe override or connector is applied or started by these files. This follows
the reviewed renderer in #107; it does not replace the actual-packet, BPF,
expiry, remote-mapping or first-start gates in
[the enforcement runbook](STAGING_EGRESS_ENFORCEMENT.md).

## Native stop-gate finding

On 12 September 2026 UTC, a bounded check on the stopped staging reader ran
`systemctl mask --runtime domino-read.service`. The command returned zero and
created `/run/systemd/system/domino-read.service -> /dev/null`, but systemd
still reported `LoadState=loaded`, `UnitFileState=static`, `ActiveState=inactive`.
The installed unit in `/etc/systemd/system/` had precedence. The check removed
only the runtime mask it had created; the service was never started.

Therefore, do not use a successful mask command as the safety condition. The
required condition is **all six units inactive and `LoadState=masked`**, with
no service processes, socket activation, pending jobs or unaccounted drop-ins.
The six fixed names are `domino-read.service`, `domino-gateway.service`,
`domino-auth.service`, `domino-onboarding.service`, `domino-deposit.service`
and `domino-tunnel.service`. The write/operator/admin accounts have no units
and must have no workload or process either.

## Preserve the custom units before masking

Perform these operator steps only after independent review and acceptance of
the source upgrade. The #83 automatic rollback perimeter does not admit these
unit changes. Preserve the private runtime and database; do not rewind them.

1. Stop the six fixed units and confirm the absence of their processes and
   jobs. Inspect the complete systemd load path, fragments and drop-ins. Refuse
   aliases, generated/transient units, unexpected symlinks, enablement links,
   later overrides or a different service identity. Confirm the original
   units have no `[Install]` section and no capability-enable argument.
2. Create an exclusive, root-owned 0700 evidence directory outside the unit
   load path. Record each original unit's full path, SHA-256, UID/GID, mode and
   link count. Require a root-owned single-link regular file matching the
   reviewed source: the five accepted upgrade unit definitions plus the
   reviewed #75 tunnel unit. Copy its exact bytes to a new 0600 backup file;
   flush and fsync the file and evidence directory before replacing anything.
   Do not move or remove the only surviving copy of an original unit.
3. For each unit, recheck the original file identity and digest. Create an
   exclusive temporary symlink to `/dev/null` in the same unit directory,
   atomically replace only that checked original with the symlink, and fsync
   the directory. Never overwrite an unrelated file/link, use `--force`, or
   remove an unknown runtime mask. Record each completed replacement so a
   partial operation remains diagnosable. All applications remain stopped.
4. Reload systemd. For every unit require `LoadState=masked`, inactive state,
   zero main PID and no pending start job; inspect the actual winning mask
   path. A failed check stops preparation before either egress layer changes.
   Retain completed masks and backups for explicit reconciliation.

These are persistent masks at the winning unit location, not lower-priority
runtime masks. A completed durable mask survives power loss. Static enablement
alone does not exclude every activation source for an original unit that has
not yet been masked. After any interruption, re-establish actual inactive
state, inspect triggers/jobs and verify the complete winning mask inventory
before continuing; never infer completion from a journal marker alone.

## Qualify with the probe command, not the application command

The separately reviewed `scripts/staging/probe_egress_window.py` produces
observations only. Stage it at a root-controlled, service-readable path outside
the application's private runtime; use `/usr/bin/python3 -I -B`. Its JSON plan
must be a root-owned regular file with root-controlled, non-writable parents.
Plans contain only public IPs/hostnames, identity, ports and an expiry. They
must never contain provider URLs, keys, JWTs or Tunnel tokens.

Prepare and review the exact temporary override for each unit while all six
base units remain effectively masked. Store it at the persistent winning
`/etc/systemd/system/<unit>.d/` path, root-owned and hash-checked; fsync its file
and directory before restoring any base unit. A `/run` override is insufficient:
a reboot could erase it while leaving a restored application unit in place.
Keep the override until remasking is durably complete. It must:

- Replace `ExecStart` with only the reviewed Python probe and that unit's
  fixed plan path. Clear all start/pre/post/reload/stop command hooks before
  adding any reviewed probe command; no application or connector command may
  survive in effective configuration.
- Clear credential directives, including `LoadCredential`, encrypted/imported
  and inline credential variants. In particular, the Tunnel token must not be
  loaded for a socket probe. Use an empty process environment except the
  minimal reviewed interpreter environment.
- Set a neutral working directory, `Restart=no`, a hard runtime limit no
  longer than 90 seconds and bounded termination of the complete control
  group. Preserve the original User/Group, supplementary groups, namespaces,
  filesystem hardening, capabilities, address families and IP filters.
- Add no `[Install]` section, trigger or auto-start dependency. Do not enable
  a unit. Record all original and temporary files and their exact hashes.

After both reviewed enforcement layers are installed, restore only each
checked masked base unit from its preserved exact bytes, using an exclusive
temporary regular file, its original metadata, atomic replacement and fsync.
Its complete reviewed probe override must already be present. Reload and
inspect effective commands, credentials, identities and filters **before** a
manual probe start. If anything differs, stop and remask it. This bounded
transition permits the probe command only; it does not release the original
application or connector for execution.

Run the six controlled probe units together so each expected local origin has
a live, fixed `PING`/`PONG` counterpart under its actual service UID. Capture
actual cgroup membership and effective BPF programs while they run. Correlate
phase timestamps with nft counter snapshots and controlled positive/negative
comparisons. Do not qualify a denial from an errno or timeout alone.

After probes, stop and effectively remask all six units before removing any
temporary command override. Verify no processes/sockets remain. Retain the
restrictive nft table while restoring the previous IP filters. Remove only
the owned `40-egress-window.conf` files when returning to the baseline; an
unexpected `20-reviewed-egress.conf` or other override must be reconciled,
not silently revealed by deleting the later file. The filename in the older
#75 example is not proof that such a file exists on this VM.

Restore original units from verified backups only after the stopped baseline
policy is established. Require static/inactive state and no enablement links.
Only then may the owned nft table be removed under the existing rollback
procedure. A later connector window uses fresh DNS evidence and explicit
coordination; expired qualification artifacts cannot be reused.

## Interpret the observations conservatively

The probe verifies its real/effective UID, primary/supplementary groups,
cgroup and deadline before sockets. It reports bounded TCP/TLS, DNS, QUIC
version-negotiation, loopback and expiry observations. It emits no credentials
and performs no financial or authenticated HTTP request. QUIC nonce correlation
is an observed unauthenticated round trip, not authenticated peer identity.
TLS write acceptance is not packet delivery or proof of expiry enforcement.

Reject the entire run on identity/deadline drift or any `invalidRun` result.
Process success and a complete JSON stream do not establish policy success.
The controller must match every expected role/test/phase, reject missing,
duplicate or inconclusive observations, and correlate actual network evidence.

Fixed listeners remain available through expiry. If a source-port test cannot
bind while its listener owns that port, it is **untested**, not denied. Complete
that gate in a separately controlled phase with a live reachable counterpart,
successful source-port binding and attributed BPF/nft decisions. Never close
all target listeners and then count connection refusals as expiry proof.

The helper does not supply a controller, policy installation, IPv6 connectivity,
isolated layer tests or a delayed-install test. On the staging VM there is no
IPv6 default route; that is not evidence that filtering works. Those existing
gates require the separate controlled contexts described in the enforcement
runbook. Keep first start blocked if any required observation remains
unqualified. Nothing here authorizes changing a capability flag.

This helper accepts only the six installed service roles. Write, operator and
admin have no installed service/cgroup; test their exact UID/GID/group identities
separately without inventing service units or claiming a service BPF result.
