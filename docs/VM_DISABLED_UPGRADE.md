# Upgrade an existing disabled installation

`scripts/staging/upgrade_disabled.py` updates the seven source copies and five
static service units installed by [prepare_disabled.py](VM_DISABLED_INSTALL.md).
It supports only an unchanged migration, schema and dependency set on the fixed
Ubuntu 24.04 / PostgreSQL 16 foundation. Its default is an offline archive plan;
`--inspect` checks the existing host read-only; `--apply` changes source/unit files;
`--rollback` restores the old unit references after a completed or interrupted
attempt. Application services must remain stopped throughout these operations.

This document describes a candidate procedure, not evidence of an applied VM
upgrade. Deployment code requires independent review under [repository policy](REVIEW_POLICY.md).
Keep the reviewed helper commit separate from the application archive commits.
Do not execute an unreviewed helper from a target release simply because the
application archive itself was reviewed.

## Source pair and provenance

The first prepared pair is the historical installed source
`a5a855cec1fc5d120d9c1c187a84ff24bc1b02d6` to the integrated backend/staging
source `4c3ee322308900303c679088bc4712ef16500763`:

| Archive | Plain tar bytes | SHA-256 |
| --- | ---: | --- |
| a5 | 11,018,240 | `cddc956efc28a0954eb52388c7e26541f5de0d2191998adcd61bbb5db5e5a562` |
| 4c | 11,294,720 | `38a93abc8fee7959704441ef738209a6a5d120e0c3889d9a7326a723fe2e4400` |

Generate each plain tar with `git archive --format=tar --output=<file> <commit>`
from independently trusted Git objects. Verify both digests before transfer and
on the VM. The archive's commit header is a consistency check, not authenticity.
Use the full reviewed `scripts/staging/` helper directory, root-owned and protected
from other writers, outside either application release. Use `python3 -B` so
imports do not create bytecode in that directory. Keep inputs and outputs private.

```sh
python3 -B scripts/staging/upgrade_disabled.py \
  --from-archive a5.tar \
  --from-archive-sha256 cddc956efc28a0954eb52388c7e26541f5de0d2191998adcd61bbb5db5e5a562 \
  --from-commit a5a855cec1fc5d120d9c1c187a84ff24bc1b02d6 \
  --archive 4c.tar \
  --archive-sha256 38a93abc8fee7959704441ef738209a6a5d120e0c3889d9a7326a723fe2e4400 \
  --commit 4c3ee322308900303c679088bc4712ef16500763
```

The default does not read host configuration, acquire a lock or contact a DB.
It rejects changed bytes **or executable modes** in migrations001–014,
`backend/schema.sql` and `backend/requirements-api.lock`, and rejects identical
source/target commits. Other source changes still need review; passing this
comparison does not establish application compatibility. There is no automatic
selection of a newer branch or release and no migration/dependency upgrade path.

## Before application

1. Coordinate an exclusive maintenance window. Stop all five apps and all manual
   writer/operator jobs. Keep service flags false. Complete the independent helper
   review and required CI, then run the same command as root with `--inspect`.
2. Confirm the current seven copies against the old trusted archive and verify
   all 49 cross-service descriptor access checks with `check_filesystem.py`.
   The updater itself checks complete source identity, runtime ownership and
   role/catalogue access; the separate verifier adds effective filesystem probes.
3. Perform and record an isolated restore rehearsal of a current private full
   database backup using PostgreSQL16, checking schemas, owners, ACLs, rows and
   sequences. Include catalogue/checkpoint and any session/grant/deposit state.
   Create the required reviewed roles in that isolated cluster first: a DB dump
   does not include global roles or PostgreSQL configuration. Never restore over
   the live DB, use `dev_postgres.py` against staging, or treat dump readability as
   restore proof. The updater's backup is not a substitute for this operation gate.
4. Record the reviewed helper SHA, both archive hashes, restore evidence and
   intended source pair privately. Budget for seven new source copies, two new
   runtime copies (private backup and target), three application-phase DB dumps,
   and another full dump for each rollback attempt. Existing releases and dumps
   remain on disk. The updater bounds runtime bytes to 64 MiB and each DB dump
   to 256 MiB; four maximum-sized dumps alone require 1 GiB. Its `statvfs` preflight
   requires source/runtime allocation, backup space including one rollback dump,
   and PostgreSQL filesystem headroom, aggregating requirements by `st_dev`.
   Metadata byte allowances add 64 MiB on the release device and 128 MiB on the
   backup device for apply (64 MiB for apply and 64 MiB for the rollback reserve).
   Each later rollback attempt requires one new dump plus 64 MiB for metadata.
   PostgreSQL byte headroom is the larger of 1 GiB or 5% of its filesystem.

   The inode budget counts copied source/runtime entries, including files,
   directories and recreated links, plus four dump files for apply or one for a
   rollback attempt. Each metadata allowance adds 1,024 inodes: two allowances
   in the apply backup budget, one on the release device, and one for a later
   rollback attempt. The PostgreSQL device retains another 1,024 headroom inodes.
   The helper requires a positive total inode count (`f_files`) and an available
   count (`f_favail`) between zero and that total; unusable reports or insufficient
   capacity are refused.

   `st_dev` may distinguish logical filesystems that share one storage pool.
   For pooled Btrfs subvolumes or ZFS datasets, calculate the combined pool budget
   manually; independent device checks do not establish total pool headroom.
   A larger installation needs a separately reviewed procedure. Recheck bytes
   and inodes before every retry; these checks do not reserve storage or inodes.

The tool requires the old installed receipt and the shared root0600 installer
lock. It rejects an existing target release or backup directory. It never clears
an earlier attempt automatically. There is no `/opt/domino/current` link in this
layout; the five units pin full release paths directly.

Host checks require exact disabled unit bytes, inactive/dead/static manager state,
zero PIDs, no drop-ins/dependency triggers, no unexpected Domino service/socket/
timer/path/target, no service-UID processes, no application listeners and no other
DB clients. These are observations inside the coordinated maintenance window;
the file lock serializes installer/upgrader operations, not arbitrary root jobs.
The fixed PG16 paths, UTF8, no-TCP settings, socket metadata and reviewed installed
peer mappings must still match. Role/catalogue checks run with read-only queries.
The existing protected Python3.14 environment must match the unchanged lock.

## Apply and evidence

After the preceding gates, add `--apply` to the same command. The operation:

- Creates `/var/backups/domino-disabled/<target>` as root0700 and saves the plan,
  previous receipt, five units, complete private runtime copies/inventory and a
  full plain DB dump. Files, directories and phase journal are made durable before
  cutover. No PG configuration, SQL data or dependencies are changed.
- Creates seven separate immutable copies under `/opt/domino/releases/<target>`.
  Runtime bytes, uid/gid and modes are preserved, including nested lock directories
  and writer 0644 reports inside private 0700 runtime roots. New runtime trees stay
  root-owned 0700 while copying; ownership is handed to the service UID from the
  leaves upward, with the runtime root last. Links, special files,
  extended attributes/ACLs, special permission bits, unsafe modes and excessive
  depth are refused. The existing fixed venv link is recreated; runtime paths
  are never shared or linked.
- Verifies staged source/runtime identity and native unit syntax, then rechecks
  old runtime, stopped state, role/catalogue access and DB fingerprint. It replaces
  each unit atomically and records progress. The five-unit set is not atomic;
  keeping apps stopped makes interruption recoverable. It reloads systemd,
  rechecks state/foundation/roles and
  compares a final DB dump and both old/target runtime snapshots before writing
  `installed.json`.

The DB fingerprint covers the plain dump, including rows and sequences.
Random `\restrict`/`\unrestrict` guard command lines are normalized only for the
fingerprint; the saved dump retains its guards for restore. The security fix
[introduced in PostgreSQL 16.10](https://www.postgresql.org/docs/release/16.10/)
also applies to the production PG16 tools. This normalization is required in
production and must not be removed as a test-only accommodation.
The dump's file-size limit is set by an isolated Python wrapper **after**
`runuser` opens its PAM session and before `exec` of `pg_dump`. Lower inherited
limits are preserved. An inherited parent limit alone is insufficient:
[runuser resets RLIMIT_FSIZE](https://manpages.ubuntu.com/manpages/noble/man1/runuser.1.html).
Local PostgreSQL tests execute the real limiting wrapper with the fixture user;
they do not claim to execute native PAM. The actual VM's process boundary remains
part of operational acceptance. Fingerprints and private file hashes
stay inside the root-only backup. Public JSON contains fixed refusal reasons,
source identifiers and preservation booleans, never configuration, DB contents
or their fingerprints. This plain dump also excludes database-level ownership
and CONNECT ACLs; `check_roles.py` checks that fixed foundation separately during
preflight, immediately before cutover and after reload. A stable dump fingerprint
alone does not prove role/database-level state unchanged.
PostgreSQL configuration, global roles and database creation/ACLs remain covered
by the existing foundation backup and separate recovery procedure.

No app is started/enabled, no migrations are replayed, no DB is restored and no
old release or evidence is deleted. Access, Tunnel, DNS, egress changes and wallet
grants remain separate operations. The final receipt proves this source cutover;
it does not claim HTTP readiness, restart or restore qualification.

## Interrupted operation and rollback

On failure keep apps stopped and inspect the private `upgrade-state.json`, source
trees and unit files. Do not rerun `--apply` over existing evidence. Before any
unit change, a durable journal contains phase, source pair, DB fingerprint and
whether staging completed. A failure before this journal exists cannot have
changed unit references; partial backup files are retained for inspection.

Run the same pinned command with `--rollback` after the cause is understood.
Rollback accepts only known phases and exact old/new units. It revalidates the
old source, foundation, dependencies, DB and runtime snapshot; when staging
completed it also requires intact target source/runtime. A partial stage may
remain after an early failure, but was never selected for execution. Known old/new
temporary unit files from a crash are accepted, including empty files and exact
prefixes of a known old/new version at root 0600 or 0644. They must still be regular
single-link files. Unrelated bytes or unsafe file metadata are refused.

Rollback atomically restores the five saved old unit references, reloads systemd
and confirms stopped/static state and roles. It can be retried after interruption
of rollback; it preserves the staging-complete flag across attempts. A completed
rollback is recorded as `rolled_back` and is not replayed. The durable
`upgrade-state.json` is authoritative for this operation's phase. `installed.json`
is a historical success receipt and remains on disk after rollback; never infer
the currently selected source from that receipt alone. Require the journal phase,
exact current unit references and independent source identity to agree.
Both source trees and all private evidence remain. A future attempt needs explicit
operator assessment of retained destinations; this tool does not delete or resume staging.

If any DB/runtime/unit/source drift occurred, reconcile it explicitly. Do not
force rollback or replace current private data with an older snapshot. This tool
never rewinds SQL data or financial/session state.

## Acceptance after cutover

Make the tool-managed rollback decision **before the first smoke start**.
A service start that changes a lock/runtime file or DB state closes this tool's
snapshot-based rollback path, even when every feature flag stays false. After
that point, recovery requires explicit reconciliation of the changed state;
do not restore an old private snapshot merely to make rollback pass.

Run the separate source/filesystem and role verifiers. Reconfirm actual BPF egress
enforcement before a coordinated bounded smoke start. Wait for all five sockets,
run the reviewed46-request `check_disabled_http.py`, repeat after a controlled
application/PostgreSQL restart, then return services to the agreed stopped state.
Record these results separately from source installation and any real VM reboot.
The new checker requires `no-store, no-transform`; an a5 rollback requires its
separately pinned historical checker/header expectations. Preserve flags false
and static units throughout; none of these checks authorizes HTTPS activation.

Offline fault-injection tests use temporary files and stubbed host boundaries;
the optional PostgreSQL tests use only disposable local clusters. Neither is an
applied VM upgrade or proof of Linux host behavior. CI runs these tests alongside
the existing required suites; operational evidence is collected only after review.
