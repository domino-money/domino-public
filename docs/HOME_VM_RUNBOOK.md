# Home VM staging runbook

Issue #49 · **VM foundation provisioned; application staging stays private and disabled**

The isolated staging VM runs Ubuntu 24.04 LTS with 4 vCPUs, 8 GiB RAM and a preallocated 100 GiB disk. Dedicated SSH access works through the host; no router port was opened. A separate NAT network and host firewall block guest access to the host/LAN/Tailscale/other VM, with positive public DNS/HTTPS and negative internal-connection checks confirmed by firewall counters. A libvirt lifecycle hook refuses startup/restore when the actual network or firewall verification fails. Host storage layout, free-space measurements and management identities belong in the private deployment record.

PostgreSQL 16.15 is installed with no TCP listener, a private Unix socket, fixed peer mappings and separate non-superuser service/operator roles. Python 3.14.7 and the locked backend dependencies are available on that VM. The initial foundation had an empty application database. The explicit [disabled installer](VM_DISABLED_INSTALL.md) now supplies the complete migration plan and five service units for the combined candidate. Consult the [installation record](VM_STAGING_2026-09-11.md) for applied migrations, role/restart checks and actual service state. Provider credentials, wallet grants and Cloudflare ingress are separate release steps; a private disabled installation is not consumer or production acceptance. Private host details and provisioning artifacts stay outside the repository.

OxDecimal owns **all Cloudflare configuration, DNS, frontend routing and frontend access gating**. Backend work owns the wallet allowlist for login and private operations. The wallet allowlist does not restrict public blockchain reads and does not grant token approvals, signing or financial execution. See [wallet access](WALLET_ACCESS.md), [wallet sessions](WALLET_SESSIONS.md), [read gateway](READ_GATEWAY_RUNBOOK.md) and [API compatibility](API_COMPATIBILITY.md).

## 1. Inputs needed before provisioning

| Owner | Required input or deliverable |
| --- | --- |
| Server owner | SSH access and storage preparation complete; VM allocated and running. |
| Server inspection | VM/OS/network foundation installed; verify the installation evidence, backup destination/restore and UPS handling |
| Server owner | Four initial wallet identities were supplied and checksum-validated locally; the pending list stays private and has not been applied to a staging database |
| Backend | Pinned release commit and dependency locks, read/session contract versions and digests, supported route list, SQL migration/role plan, service ownership, rollback and restore evidence |
| OxDecimal | Exact HTTPS app origin and internal origin hostnames; Worker build/digests and disabled flags; Access issuer, four distinct read/session/onboarding/deposit audiences and service identities (deposit deferred until its own gate); Tunnel mapping and outbound transport requirements; authoritative client-IP/framing behavior; denial/default routes and preview-hostname policy |
| Both collaborators | Consumer acknowledgement, end-to-end test window, operator contact and who disables ingress during an incident |

Credentials and Tunnel tokens travel through local secret provisioning, never an issue, this document, a chat prompt or a shell argument. Non-secret issuer/audience/service identifiers still need to match the agreed environment exactly. `https://domino.money` is the selected app origin. The selected internal origins are `https://vm-read.domino.money`, `https://vm-session.domino.money`, `https://vm-onboarding.domino.money` and `https://vm-deposit.domino.money`. These agreed names are not provisioning evidence. The first ingress phase defers the deposit Access app, service token and Tunnel mapping. See the [current handoff](STAGING_BACKEND_HANDOFF.md) for Pages service bindings, the owner-selected beta perimeter and required ingress proof.

## 2. Initial VM estimate and isolation

Allocated starting configuration, not a measured capacity guarantee: **4 vCPU, 8 GiB RAM and 100 GiB SSD** for the small staging audience. Reserve disk headroom and measure PostgreSQL growth, memory, CPU, latency and provider quotas before changing limits. This is not enough information to promise a user count or retention horizon. GPU acceleration and a full-chain archive are not required for this stage.

Use suitable local SSD storage and monitor shared-disk headroom; an observed free-space value is not a retention guarantee. A sequential read benchmark does not qualify PostgreSQL random writes, fsync, durability or the application workload. Keep unrelated host volumes and existing data untouched: do not mount, repartition, format or delete them as part of staging setup. Use a restricted backup target for encrypted backups, not a shared live PostgreSQL data directory. Give the VM no mount of unrelated applications, their runtime, operator wallets or key stores. Do not reuse their Python environments, ports, databases or provider files. Isolate the VM from other workloads with explicit CPU/RAM/storage limits. Prefer a separate network segment when the host supports it; management access stays on the approved LAN/VPN, not a new router port-forward. Record host-specific storage layout and qualification privately.

Keep inbound application and PostgreSQL ports closed on both the router and VM firewall. The backend binds only to loopback. OxDecimal coordinates an outbound Tunnel connector, which does not require opening inbound application ports. Configure egress for required DNS/time synchronization, approved provider HTTPS/Access key retrieval and Decimal's reviewed Tunnel transport. Do not guess firewall ports or run an unreviewed Tunnel install command. [Cloudflare Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/).

A home VM shares the home's power and internet failure domain. UPS handling, a tested restore target and an operator response procedure are prerequisites for any availability promise; hardware size alone is not high availability.

## 3. What can run from this checkout

The repository pins **Python 3.14** and `backend/requirements-api.lock`; development database work supports PostgreSQL **16+**. Install a maintained PostgreSQL major through the selected distribution's supported procedure after host inspection, and record the exact version. Do not invent an `apt`/hypervisor command before the distribution is known or let a package upgrade silently migrate a database major. Node 24 and the root pinned EVM tools are needed for build/test work, not for serving the Python processes.

This checkout has these launchers:

| Component | Existing command, from its product checkout | Exposure/default |
| --- | --- | --- |
| Public data reader | `backend/.venv/bin/python backend/read_api.py --port 8876 --read-budget 15` | `127.0.0.1:8876`; local API, rejects browser origins |
| Read gateway | `backend/.venv/bin/python backend/read_gateway.py --port 8878 --reader-port 8876` | `127.0.0.1:8878`; disabled without `--enable` |
| Wallet session listener | `backend/.venv/bin/python backend/session_api.py --port 8879` | `127.0.0.1:8879`; disabled without `--enable` |
| Onboarding listener | `backend/.venv/bin/python backend/onboarding_api.py --port 8880` | `127.0.0.1:8880`; disabled without `--enable` |
| Deposit listener | `backend/.venv/bin/python backend/deposit_api.py --port 8881` | `127.0.0.1:8881`; disabled without `--enable` |
| Development PostgreSQL helper | `backend/.venv/bin/python backend/dev_postgres.py start` | Task-local cluster; **not the staging provisioner** |

The combined candidate includes all five launchers. The [disabled installer](VM_DISABLED_INSTALL.md) creates separate release/runtime roots and explicit systemd units for those commands, without enabling gateways/listeners or starting an indexer. It is a one-time installer for the inspected empty-database foundation, not a general upgrade tool or a cleanup scheduler. Review its plan before apply. A disabled listener is not a database/RPC readiness test; the reader's `/health` is process liveness only. The reader has no disabled flag and would use the configured/default provider for a valid request; the staging units additionally restrict IP traffic to loopback until a reviewed enable configuration is selected.

The public-data and auth paths remain separate:

```text
browser -> Pages gate/host checks -> service binding -> read Worker -> Access/Tunnel
                                                                     -> 127.0.0.1:8878 -> 127.0.0.1:8876
browser -> Pages gate/host checks -> service binding -> session Worker -> separate Access/Tunnel
                                                                        -> 127.0.0.1:8879 -> private PostgreSQL socket
```

Only the gateway's fixed `/internal/read/v1/*`, session listener's `/internal/session/v1/*`, onboarding listener's `/internal/onboarding/v1/*` and deposit listener's `/internal/deposit/v1/*` routes may become Tunnel destinations. These prefixes never authorize arbitrary wildcard dispatch. Do not publish port 8876, PostgreSQL, `/health`, OpenAPI or unmatched paths. All four eventual Access service identities/audiences must remain distinct; deposit is deferred rather than reusing another identity. Workers expose no public routes/domains; the reviewed production Pages Function is their only permitted binding caller. The exact Worker/Tunnel mapping and inputs are in the [staging handoff](STAGING_BACKEND_HANDOFF.md). Public reads require their existing service-authenticated backend path, but never a user-wallet allowlist check. The shared beta password gates invited staging separately from backend Service Auth and wallet ownership; its rotation, host denial and historical-deployment requirements are in that handoff.

## 4. PostgreSQL foundation and application process ownership

`backend/dev_postgres.py` creates a private, same-OS-user Unix-socket cluster beneath `backend/runtime/`, using `--auth-local=trust`, `--auth-host=reject`, `listen_addresses=` and mode 0700 directories/socket access. That is useful for task-local tests, where socket access is controlled by one development user. **It must not be promoted to a multi-service staging installer.** PostgreSQL `trust` accepts the requested database identity from a caller that can connect; separate role names do not make it safe to share that socket among differently trusted services. [PostgreSQL trust authentication](https://www.postgresql.org/docs/16/auth-trust.html).

Provision a separate PostgreSQL service under its own OS account. Use an explicitly selected Unix-socket directory, no TCP listener (`listen_addresses = ''`), restricted directory/socket access, and **peer authentication with exact `pg_ident.conf` mappings** from OS service users to the fixed SQL roles. Do not grant every socket-group member every SQL identity. The socket group only permits connecting; the peer mapping establishes which role a process may request. [Peer authentication](https://www.postgresql.org/docs/16/auth-peer.html), [user-name maps](https://www.postgresql.org/docs/16/auth-username-maps.html), [socket/listener configuration](https://www.postgresql.org/docs/16/runtime-config-connection.html).

Installed separation, verified for the dated disabled candidate:

| OS responsibility | SQL access | Files/other authority |
| --- | --- | --- |
| PostgreSQL account | Database engine | Private data/WAL directory; no app or Tunnel credentials |
| Migration/deployment operator | Owns schema/migrations; administrative work only | Reviewed release install; not an HTTP process |
| Reader service | `domino_catalogue_reader` | Its product provider config; no auth schema, wallet grants or session secrets |
| Optional bounded catalogue writer job | `domino_catalogue_writer` | Explicit job only; no automatic lifetime indexer or auth state |
| Session service | `domino_session_auth` | Auth tables and allowlist SELECT according to the reviewed migrations; no permission to grant wallet access |
| Onboarding service | `domino_session_auth` | Its own descriptor/runtime and preview credentials; no membership administration |
| Deposit service | `domino_session_auth` and `domino_deposit_service` | Two explicit peer mappings for auth and deposit storage; no DDL/operator role |
| Wallet-access operator | `domino_wallet_access_operator` | Grant/revoke through the operator function; SELECT on grants/audit; no public admin endpoint |
| Read gateway service | None | Read Access verification configuration and private lock directory |
| Tunnel connector | None | Decimal's connector credentials/configuration; no provider or session secret access |

Runtime SQL roles must not own their schemas/tables or have SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS. Review grants and role membership explicitly; prove that the reader cannot read auth/access tables, the auth service cannot grant access, and a service OS user cannot connect as an operator/owner role. `008_wallet_sessions.sql` is applied as the schema owner, not `domino_session_auth`. Apply the explicit complete migration sequence 001–014 for the pinned combined release, including onboarding/session state, deposit recovery and wallet access. The deposit role needs CONNECT on the database in addition to the grants from migrations. Apply all fourteen migrations in one transaction as the same non-superuser DDL owner; do not run them under runtime roles. Do not run every `.sql` file indiscriminately: the repository also contains draft tenant/schema work.

### Loader constraints that affect the install layout

`catalogue.database_settings()` currently loads a fixed `backend/runtime/catalogue-db.json` beside the resolved Python module. It accepts only:

```json
{"host":"/run/postgresql-domino","port":8877,"dbname":"domino_catalogue"}
```

This is the sanitized descriptor of the installed target. The directory/port must match the separately provisioned cluster. `host` must be an absolute Unix-socket path; the database name is fixed to `domino_catalogue`. The loader does not accept a TCP DSN, role, password or arbitrary SQL options. The file must be a regular, non-symlink file owned by the effective service UID, with no group/other permissions (use 0600). SQL role selection is fixed in code. Peer mappings fit this interface without adding a database password to HTTP or config fields.

The provider loader and session singleton lock also enforce effective-UID ownership/private files. Therefore a single shared 0600 descriptor owned by one user cannot serve several distinct users. **Before staging**, provision separate service checkout/runtime roots of the same pinned commit with per-service owned descriptors/configuration, or implement and review an explicit per-service config-root loader. Do not weaken permissions, share auth secrets with the reader, or add a symlink to bypass these checks. Application code and virtual environments should be deployment-owned and read-only to service users; only each service's required runtime directory is writable. The session listener needs its own owned 0700 runtime directory and lock file.

Distinct release directories also create distinct lock paths. A supervisor must prevent two versions/replicas of the same service from running; copying the checkout does not provide a global singleton. Single-process mode is part of the current admission/cache design. Keep `WEB_CONCURRENCY` and `UVICORN_WORKERS` absent or `1`; no automatic replicas/autoscaling.

## 5. Wallet access and secrets

Issue #49 uses persistent database grants in `domino_wallet_access`, with a grant generation checked by the backend. It is **not** a browser flag, Redis cache or JSON wallet-list runtime. The operator CLI is `backend/manage_wallet_access.py`; use its reviewed [operator documentation](WALLET_ACCESS.md#administration) and `--help` for arguments. The CLI supports `--database-config` before the subcommand for an operator-owned descriptor. Its admin connection uses the same private database descriptor and fixed `domino_wallet_access_operator` role. Grant/revoke/list belongs to the operator account, never the reader, frontend or session service. The four initial wallet addresses are held in a private pending provisioning file, not read by the application; apply them through the operator CLI only after the target database/roles and release are ready. No real wallet grant or example wallet is seeded by this runbook.

Login/private authorization must recheck current grants and generation; removing access must not depend on a process restart or frontend refresh. Reinstating an address must not resurrect credentials from an earlier grant generation. Public reads remain available independently. These are backend policy checks, not proof that a signed-in wallet can execute financial operations; each later private endpoint must integrate the same authorization boundary rather than treating stored identity as permission.

Use the existing product configurators locally under the intended service identity, with hidden input prompts. `backend/configure_rpc.py --help` and `backend/configure_uniswap.py --help` describe their supported private config-file options; the enabled session launcher requires an explicit `--rpc-config` file. Never copy another application's credentials or runtime files. Provider configuration is read at startup; a changed file does not imply the running reader has adopted it.

The session process additionally needs the exact `DOMINO_SESSION_ORIGIN`, separate Access issuer/audience/service ID, and persistent `DOMINO_SESSION_ABUSE_SECRET` described in [WALLET_SESSIONS.md](WALLET_SESSIONS.md). The read gateway uses the separate `DOMINO_ACCESS_*` and `DOMINO_BRIDGE_READS` settings in its [runbook](READ_GATEWAY_RUNBOOK.md). Stage these in restricted local service-secret storage; protect any environment file as secret material. The CLI currently reads the session abuse secret from the environment, so protect process inspection/core dumps and do not print environment diagnostics. Do not regenerate this secret on every restart; rotation affects abuse-rate namespaces and needs coordinated handling.

No private wallet key or transaction signer belongs on this VM for these services. Keep provider credentials, session secret and Tunnel/Access credentials separately owned. Backups/logs do not become safe simply because their source directory is ignored by Git.

## 6. Reproducible checks and disabled startup

These commands are supported today. Run tests in a **separate development/test checkout**, under a test OS identity, never against the staging cluster or service runtime:

```sh
python3.14 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-api.lock
backend/.venv/bin/python scripts/export-read-contract.py --check
backend/.venv/bin/python scripts/export-read-openapi.py --check
backend/.venv/bin/python scripts/export-session-contract.py --check
backend/.venv/bin/python -m unittest discover -s backend/tests -v
```

For the PostgreSQL/EVM suite, install the repository's Node dependencies and pinned test tools as described in [README](../README.md), then use the **test checkout's** helper:

```sh
backend/.venv/bin/python backend/dev_postgres.py prepare-tests
DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1 backend/.venv/bin/python -m unittest discover -s backend/tests -v
backend/.venv/bin/python backend/dev_postgres.py stop
```

Record actual test results for the target Linux/Python/PostgreSQL versions. Success with the development `trust` cluster does not validate staging's peer mappings or separate service users.

After the separate service roots and PostgreSQL are provisioned, start only the five installed static units, **without `--enable` on any gateway/listener**. Section 3 lists their launchers for reference; a command run directly in a service-user terminal does not inherit the units' network restrictions. The reader uses the 15-second budget expected by the read gateway. Wait for socket readiness with a bounded deadline, then verify loopback-only sockets, disabled gateway responses, and no exposed health/OpenAPI route through the planned ingress. Disabled routes should not be mistaken for healthy authenticated login. Do not start an arbitrary `uvicorn --host 0.0.0.0` command to make remote testing easier.

The disabled installer provides units with these actual commands, fixed working directories, one process each, restrictive umask, limited restart frequency, graceful shutdown and exact writable runtime paths. Code and the shared locked virtual environment remain deployment-owned. The units contain no credentials or `--enable`, and initially deny non-loopback IP traffic. Verify the installed units, peer-role matrix, positive/negative HTTP cases and restart behavior before calling the private preparation complete. A later enable step must supply the missing reviewed configuration and update the network policy explicitly; it is not an automatic restart side effect.

## 7. Handoff and staging activation evidence

Backend provides Decimal the pinned producer commit, `read-v1` and `session-v1` manifests/digests, exact route/port mapping, safe error fixtures (including wallet denial/unavailable states), allowed methods/body limits, disabled-mode checks and the rollback procedure. Decimal provides the matching consumer/Worker build, acknowledgement and the ingress identity/framing details from section 1. Backend does not edit or provision Cloudflare as part of this handoff.

Keep all four Worker flags and listeners disabled until the following is demonstrated on the actual VM and HTTPS path:

- Separate service users and peer mappings work; negative cross-role tests fail; migrations match the release; no default/demo grants exist.
- Exact Access JWT claims, audience/service-ID isolation, trusted client IP, origin checks, request-size limits, timeouts, invalid/duplicate headers and unmatched paths retain their current denials through the real Tunnel.
- Login is denied for an unapproved wallet and allowed only for an approved supported EOA; revoked and regranted identities cannot reuse an earlier session/grant generation. Database/RPC outages deny private authorization without opening the allowlist.
- Public reads need no login/allowlist entry. Their provider provenance, missing/stale data and error responses survive the frontend adapter unchanged.
- HTTPS cookies, CSRF, challenge replay, GET session recovery, POST refresh, logout, multi-tab/account switching and lost-response handling pass against the agreed contract version.
- Monitoring, disk alerts, time synchronization, backup/restore and rollback drills pass. Session cleanup is request-driven today; a bounded operator cleanup schedule and retention validation still need provisioning before a wall-clock retention promise.

Only after the existing release gates and frontend acknowledgement are complete should the operator coordinate Decimal's flags and the listeners' explicit enable configuration. This runbook neither supplies that authorization nor claims an external security review has occurred.

## 8. Backups, restore and shutdown

For initial staging, propose nightly encrypted backups plus one before each schema/release change, with a starting retention of seven daily and four weekly copies. These are planning defaults to confirm with the owner. Keep a restricted copy on the NAS and a separately protected copy outside the VM/host failure domain. Record backup time, release/migration versions, PostgreSQL major, checksum and restore result; alert on missed backups and low disk. VM snapshots alone are not a tested PostgreSQL restore plan.

Prefer a logical custom-format backup of the database **excluding reusable auth state**, while preserving wallet-access grant generations and the append-only audit. This backup contains private admission information even though its catalogue data is public; restrict and encrypt it accordingly. `pg_dump` produces a consistent single-database backup; it does not include global role provisioning. Use a compatible client version and retain the reviewed role/peer/migration configuration separately. [pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html).

The following is an **auth-excluding template**, not a complete issued-deposit disaster-recovery procedure. Review the archive dependencies, admission reconciliation and preserved deposit/operator evidence before using it with a nonempty application database. It is available **after** `/run/postgresql-domino`, the database-owner connection and a private backup directory have been provisioned. Run it as the designated backup/operator identity whose peer mapping is approved. The output path is a placeholder to replace with a new private filename; do not overwrite the last good backup:

```sh
pg_dump --host=/run/postgresql-domino --port=8877 \
  --username=domino_catalogue_admin --dbname=domino_catalogue \
  --format=custom --exclude-schema=domino_sessions \
  --file=/PRIVATE_BACKUP_DIRECTORY/NEW_STAGING_DATABASE.dump
```

The cluster provisioning must explicitly create/map that administrative role; the name's existence in the development helper is not staging provisioning. Inspect the archive and restore with `pg_restore --exit-on-error` into a **separate isolated cluster/VM** first, using reviewed roles and the same database name required by the application loader. Reapply the matching auth schema/migrations without restoring old session, preauth or challenge rows. Preserve the restored membership generations and audit; do not drop those tables or reset generations. While ingress remains off, reconcile restored grants against the current private operator record and revoke restored admissions through the reviewed operator procedure before selectively regranting the currently approved list. A stale backup is not authority to readmit an address. If the current approval record is unavailable or any revocation cannot complete, private ingress stays off. Inspect privileges and prove that old credentials fail before reconnecting ingress. [pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html).

If a full VM/database snapshot is restored for disaster recovery, keep session/private ingress disabled while the operator invalidates restored auth state and revokes stale grants under the reviewed procedure, preserving membership generations and audit. Restoring an abuse secret is not session invalidation; rotating it alone also does not invalidate stored bearers. This combined build persists deposit intents, reservations, selected transactions, nonce/conflict evidence and receipts. Preserve all of that state and the operator archive across backups, rollback and restore. An auth-only reset cannot resolve an issued operation or justify minting again. Reconcile potentially submitted transactions under the reviewed deposit procedure before enabling private ingress; neither a VM snapshot nor restored admission is evidence that no transaction was sent.

For a routine application update: coordinate Decimal's ingress disable/drain, stop each old app process gracefully, install the matching release/configuration, and start disabled listeners before readiness checks. In a foreground terminal use Ctrl+C; under systemd use its reviewed stop action. Do not delete lock files to bypass an active process or run a second copy after a timeout. The OS releases the lock when the process exits. Read restarts clear in-memory caches and pagination handles, so clients restart pagination rather than reuse a cursor. Routine session-process restart preserves database-backed authorization; allowlist changes do not require restart.

For VM shutdown, stop ingress/app work first, then stop the **actual PostgreSQL service** through its configured manager and wait for clean completion. Do not use `dev_postgres.py stop` against the staging cluster or send SIGKILL to PostgreSQL as a normal shutdown method. PostgreSQL fast shutdown terminates sessions while rolling back active transactions and completing shutdown; immediate/crash shutdown is a different recovery path. [PostgreSQL shutdown modes](https://www.postgresql.org/docs/16/server-shutdown.html).

After restart, verify time, filesystem ownership, PostgreSQL/peer access, grants, provider configuration and disabled listeners before coordinating ingress restoration. A failed configuration load or missing database must remain unavailable; it must never fall back to an open wallet policy.

## Completion record

This document was checked against the current Python launchers, database/config loaders, development cluster helper, session schema and existing bridge/session runbooks. SSH host inspection and private wallet-list validation are complete as described above. VM/OS/network and empty PostgreSQL installation are complete as described above. The dated disabled-installation evidence records the application/role/restart/local-restore checks actually completed against the pinned combined candidate. Real provider/consumer HTTPS acceptance, external backup destination and production restore drills, wallet grants and Cloudflare ingress remain separate. A fresh empty-schema restore test does not qualify recovery of issued financial operations or availability under host/ISP/power failure.
