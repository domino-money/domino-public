# Private backend staging — 2026-09-11

The five backend processes are running on the dedicated VM, bound only to
loopback. Read gateway, session, onboarding and deposit launchers have no
`--enable` flag. All five units restrict IP traffic to localhost. Cloudflare
ingress, wallet admission and financial capabilities remain disabled.

This installation followed the owner's explicit staging authorization. It does
not replace source review, consumer ACKs or coordinated HTTPS acceptance. The
[Decimal handoff](STAGING_BACKEND_HANDOFF.md) gives exact packages and missing
Cloudflare inputs; [installer documentation](VM_DISABLED_INSTALL.md) describes
the one-time procedure and separate verification commands.

## Installed build and foundation

- Application source: `a5a855cec1fc5d120d9c1c187a84ff24bc1b02d6`, the corrected
  PR #46 candidate. Decimal approved that exact source on 2026-09-11. This
  record does not imply that its stacked ancestors are already on `main`.
- Plain Git archive: 11,018,240 bytes; SHA-256
  `cddc956efc28a0954eb52388c7e26541f5de0d2191998adcd61bbb5db5e5a562`.
- Ubuntu 24.04.5 LTS, 4 vCPUs, 8 GiB RAM, 100 GiB virtual disk; systemd 255.4.
- PostgreSQL 16.15, instance `postgresql@16-domino.service`; database
  `domino_catalogue`, UTF-8, locale C. No TCP listener; fixed peer mapping on
  `/run/postgresql-domino:8877`, directory 0750 and socket 0770.
- Python 3.14.7 and all 63 application distributions match the lock. Node
  24.21.0 is installed for qualification, not application serving.
- Migrations 001–014 applied in one transaction as the non-superuser schema
  owner. Five schemas contain 24 tables, one audit sequence and six functions.
- Seven separate release/runtime roots serve read, gateway, auth, onboarding,
  deposit, operator and writer identities. Code is root-owned and immutable to
  service users; runtime directories are 0700 and descriptors are 0600.

| Static service unit | Loopback port | Final state |
|---|---|---|
| `domino-read.service` | 8876 | Running; provider egress blocked |
| `domino-gateway.service` | 8878 | Running; gateway disabled |
| `domino-auth.service` | 8879 | Running; session listener disabled |
| `domino-onboarding.service` | 8880 | Running; preview listener disabled |
| `domino-deposit.service` | 8881 | Running; deposit listener disabled |

These are static units with no boot install target. PostgreSQL is enabled for
boot; after a VM reboot, an operator must verify the foundation and start the
five disabled application units explicitly. Application and database process
restart was tested; a complete VM reboot was not performed.

## Corrections found during installation

The original empty PostgreSQL foundation used `SQL_ASCII`. It let migrations
and privilege checks pass, but psycopg returned text columns as bytes. A bounded
catalogue initialization exposed a false checkpoint rewind. All application
processes were stopped, the schema/checkpoint was backed up, and the original
database was preserved as `domino_catalogue_ascii_20260911`. The target database
was recreated as UTF-8 and restored as its non-superuser owner, preserving the
exact checkpoint and database ACL. No original database or backup was deleted.
The installer now rejects non-UTF-8 foundations before backup or application changes; the role checker
also tests both database and server encoding. These guards were added after the
observed installation and correction, not claimed as an earlier preflight.

The fresh catalogue seed initially returned HTTP 502 because its null start
block cannot satisfy the strict read contract. The existing CLI initialized
start block 58,736,592, with target 58,736,591, using actual public chain data
and the interval already documented in the backend README. The UTF-8 resume
returned `caught_up_to_target`. No events were scanned, no background indexer
was started and no historical completeness is claimed.

An immediate smoke invocation also preceded socket binding after `systemctl
start`. The final verification waits for all five sockets with a bounded
deadline; startup connection refusals were retained in private evidence.

## Verified results

| Verification | Observed result |
|---|---|
| Exact application source, full PostgreSQL/native-EVM suite | 1,169 tests passed, zero skips |
| Bridge JavaScript validation | 1,137 tests passed; four exporters and OpenAPI checks passed |
| Solidity and launcher checks | 29 Solidity tests and 3 launcher checks passed |
| Exact #46 GitHub CI | Backend, Contracts, Frontend and Repository hygiene passed |
| Actual OS/SQL identities | 54 connection pairs; expected allowed/peer-denied/socket-denied results |
| Privileges | 2,048 assertions, 40 actual SELECT authorization checks; UTF-8 and ownership checks passed |
| Filesystem isolation | 49 descriptor access pairs under seven real service UIDs |
| Disabled HTTP contract | 46/46 before restart and 46/46 after restart |
| Service egress | Five actual service cgroups blocked external TCP, with same-UID external controls before/after and successful loopback probes |
| Restart | All five application PIDs and the PostgreSQL PID changed; identities, ACLs, UTF-8 and HTTP results preserved |
| Exposure | Five IPv4 loopback listeners only; no PostgreSQL TCP listener |
| Final UTF-8 restore drill | Separate disposable cluster, non-superuser restore, exact schema/ACL/inventory, both seed rows and sequence state preserved; test cluster stopped |

The external TCP controls used a public HTTPS endpoint without transmitting an
HTTP request. The cgroup probes used the actual service UIDs and left the main
application processes unchanged. This verifies the current localhost-only unit
policy; it does not certify a future provider/Tunnel allow policy.

The final restore dump SHA-256 is
`4c05c460d976de121788f10d91613381b8b7d0a35a32ff089cd77e7635a58a25`;
normalized schema SHA-256 is
`434fa3ab85c9364c537ed1ca89aa41a0409477ede9f6a51272123ca386b1178c`.
The original pre-migration backup, first restore proof, pre-UTF-8 dump and final
UTF-8 drill are retained separately in private operator storage. Staging was
read-only throughout each isolated restore exercise.

## Provisioned private configuration and remaining gates

The product's own RPC configuration is staged separately for reader, writer,
auth, onboarding and deposit users; reader also has its inventory provider.
Onboarding and deposit have their own Uniswap API configuration. All files were
checked using their actual loader/UID and restrictive ownership. A persistent
server-side abuse secret is staged in root-only private storage. No credential
values, provider URLs or hashes of secrets are published in this report.

The only initialized data are the catalogue checkpoint and empty deposit
capacity row. There are no wallet grants, sessions, challenges, deposit intents,
receipts or financial operations. No signer or personal-bot runtime was used.

Decimal can continue adapters, rendered UI/session state tests and consumer
fixture acceptance now. Live integration requires the exact app/internal origins,
four separate Access identities/audiences, reviewed Tunnel mapping/transport and
private connector provisioning, Worker build and current manifest ACKs. Backend
then configures the matching origins/JWT checks, reviewed provider egress and
token admission policy before the coordinated enable test. Source merges alone
do not enable routes or grant wallet access.

The local restore drill covers the current two-row database. It does not qualify
recovery of issued wallet transactions, encrypted NAS/offsite backups, scheduled
backup operations, UPS behavior or home-network availability. Those remain
separate operational acceptance work; no availability guarantee is inferred.
