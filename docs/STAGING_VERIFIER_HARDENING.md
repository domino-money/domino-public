# Staging verifier hardening

This increment addresses the nonblocking catalogue, installed-source and test
coverage notes in [Decimal's PR #68 review](https://github.com/domino-money/domino/pull/68#pullrequestreview-5175880336),
tracked under [issue #49](https://github.com/domino-money/domino/issues/49).
It changes operational helpers and their tests. The installed application remains
`a5a855cec1fc5d120d9c1c187a84ff24bc1b02d6`; its four package versions/digests,
migrations, SQL authority and unit/network policy are unchanged. The dated
[staging handoff](STAGING_BACKEND_HANDOFF.md) remains historical evidence, not a
claim that these new verifiers have already run on that VM.

## PostgreSQL inventory

Both installer preflight and the read-only role verifier use the same explicit
schema/database ACL expectations. They include system schemas, `public`, PUBLIC
grants, grantors and grant options. Preflight accepts only the four foundation
schemas and five initial Domino roles' database grants; after installation the
inventory adds the five application schemas and deposit CONNECT. The existing
effective table/function/sequence and peer checks remain in place.

Any default ACL entry in the target database or persistent role/database setting
in the dedicated cluster fails verification, regardless of owner or database
scope. The migrations' schema-local default REVOKEs leave no default-ACL rows.
No value is reset automatically. The expected foundation uses PostgreSQL 16's
`pg_database_owner` ownership of `public`; an extra temporary schema also requires
operator inspection rather than an automatic exception.

These checks do not authenticate the running database server, attest stored
function/trigger bodies, audit every cluster role or prove a financial write.
They do not replace the actual host peer/isolation checks or behavioral suite.

## Installed source identity

Use the updated [filesystem command](VM_DISABLED_INSTALL.md#local-verification-and-catalogue-checkpoint)
with `--archive`, `--archive-sha256` and `--commit`. Obtain the digest independently
from the reviewed release. A manifest, commit label or checksum stored inside the
installation is not an independent trust anchor. The tar's commit comment is a
consistency check, not a Git signature.

Run a separately reviewed, operator-controlled copy of the complete helper set:
`check_filesystem.py` reuses the bounded archive validator in `prepare_disabled.py`,
which imports `catalogue_inventory.py`. Importing those modules never executes
installation. The command has no apply/start/repair path.

Every regular file in each of the seven roots must match the trusted tar's bytes
and expected executable mode; the file/directory inventory must be exact. Only
the already-validated `.venv` link and each private runtime directory are excluded.
Files are opened read-only without following links, size-bounded and checked for
metadata/path changes during hashing. The report records commit, tar SHA256,
copy count, files per copy and total verified files. It never reads runtime data.

This is point-in-time correspondence to a trusted archive. It cannot prove that
the approved source is bug-free, that a compromised root/kernel reports honest
bytes, or that a process previously loaded the same code. The venv/interpreter
remain subject to the existing ownership/protection checks; this change does not
attest their complete dependency bytes or running process memory. Root remains
able to change the installation after a successful check. Do not describe a
successful report as continuous tamper protection or production qualification.

## Reproducible tests and CI

The unprivileged stdlib suite uses temporary files and subprocess/HTTP fixtures.
It tests the installer default plan-only boundary, hostile tar paths/types/hash,
all seven source copies, same-size readonly tampering, unexpected/missing files,
links, modes, deadline failure, catalogue response validation, precise denial
classification and bounded HTTP response validation. It never invokes apply,
runuser, systemd, a real HTTP service or the VM:

```sh
python3 -B -m unittest discover -s scripts/staging/tests -p test_staging_helpers.py -v
```

The opt-in SQL suite creates its own unprivileged PostgreSQL cluster under a
fresh temporary directory, with a private Unix socket and TCP disabled. It
applies exactly migrations 001–014 as the fixture's non-superuser owner. It
checks the positive inventory and transactional mutations of schema/DB grants,
grant options, owners, extra schemas, default ACLs and persistent settings.
Every mutation rolls back and rechecks the clean inventory. It also demonstrates
four previously undetected states passing the old metadata checks while the new
inventory rejects them. The cluster is stopped and removed by test cleanup:

```sh
DOMINO_TEST_STAGING_POSTGRES=1 DOMINO_PG_BIN=/usr/lib/postgresql/16/bin \
  python3 -B -m unittest discover -s scripts/staging/tests -p test_catalogue_postgres.py -v
```

CI runs the offline suite in Repository hygiene and the isolated SQL suite with
PG16 in Backend. Neither step installs a release or uses `dev_postgres` against
staging. Local development also supports PG18 for these catalogue probes; a pass
on PG18 does not substitute for PG16 CI or actual Ubuntu host qualification.

Before relying on the new checks operationally, review the exact helper commit,
run the verifier set explicitly on the intended disabled host with the independently
trusted archive, and preserve its report. This increment does not perform that
host run or change the prior VM evidence. DNS/address-family policy, shared auth
role redesign, offsite backups and recovery of issued financial transactions
remain separate activation work; no provider, wallet, ingress or execution gate
is waived.
