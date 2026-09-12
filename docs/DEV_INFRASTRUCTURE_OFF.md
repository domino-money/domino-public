# Development infrastructure OFF candidate (#132)

This change renders concrete, hashed infrastructure material for the development
read path. **It does not install or start anything.** No provider credential,
Access client secret, connector token, quota approval or production change is
included. The current live frontend and VM receipts remain separate evidence.

The backend entrypoints and their private schemas belong to the coordinated
`backend/dev_read_*` change. This infrastructure must select a reviewed commit
that actually contains them; main `7e7173` alone does not. Decimal owns `app/`,
the Windows local launcher, dedicated Access provisioning and local acceptance.

## Generate review material locally

`scripts/staging/dev_infrastructure.py` accepts a small non-secret specification:

| Field | Required value |
|---|---|
| `version` | Integer `1` |
| `releaseCommit` | Exact reviewed 40-character lowercase commit containing the development backend |
| `contractManifestSha256` | Exact 64-character lowercase read-v1 manifest digest |
| `issuer` | Exact dedicated application's `https://TEAM.cloudflareaccess.com` issuer |
| `audience` | Dedicated development Access application AUD, 64 lowercase hexadecimal characters |
| `serviceId` | Dedicated development Service Auth identity, never its secret |

Unknown fields, URLs with paths/userinfo, duplicate keys and injection characters
are refused. In particular there is no `enabled`, provider URL or secret field.
Keep the operator specification and generated output outside the checkout:

```sh
python3 -B scripts/staging/dev_infrastructure.py \
  --spec /private/operator/dev-off-spec.json \
  --output /private/operator/new-dev-off-bundle
```

The output directory must not exist. The command writes a `rootfs` tree, a
`manifest.json` binding all ten files' hashes and intended ownership/modes, and
a `procedure.json` bound to that manifest. It prints the manifest/procedure
SHA256 values. Generated packaging files are local 0600; that is **not** a claim
that target service ownership or root-only installation has been applied.

The generator does not invoke a shell, systemd, nft, PostgreSQL, DNS, HTTP or a
provider. It has no install, apply, enable, rollback or secret-reading mode.

## Fixed separation and OFF behavior

| Role | OS identity | Loopback port | Private writable runtime |
|---|---|---:|---|
| Reader | `domino-dev-read`, UID/GID 974 | 8890 | `/var/lib/domino-dev/reader` |
| Gateway | `domino-dev-gateway`, UID/GID 975 | 8891 | `/var/lib/domino-dev/dev-read-gateway` |
| Independent connector | `domino-dev-tunnel`, UID/GID 976 | Metrics 20242 | `/var/lib/domino-dev/tunnel` |

These identities/ports were unused in the operator's dated readiness inspection;
they are not reservations. The future native preflight must refuse collisions,
unexpected files, memberships, unit drop-ins or existing instances.

All services use a separate immutable `/opt/domino/dev/releases/COMMIT` source,
the reviewed Python environment, clean `env -i`, no capabilities, no namespace
creation, strict filesystem protections and a dedicated `dominodev.slice`.
The slice caps development at half of one CPU, 768 MiB memory high / 1 GiB maximum,
zero swap and 64 tasks. Child memory maxima are 512 / 192 / 128 MiB. These are process
resource bounds; PostgreSQL and provider quotas require separate controls.

The generated reader starts without `--enable` or a profile and must use the
development backend's no-provider OFF branch. The gateway starts without
`--enable`; its own immutable profile is generated with 6 requests/minute and
burst 2, and its admission document is `enabled:false, expiresAt:0`.
Neither statement authorizes backend activation or a live provider request.

The independent connector is absent from the target's dependencies. Its unit
also requires `/run/domino-dev-connector.reviewed`, which this bundle never
creates. There is no `[Install]` section, timer, auto-start or reboot selection.
The pinned cloudflared binary matches the existing reviewed 2026.9.0 installation
path; a later installer must verify the recorded binary digest before execution.
Its explicit empty config does not establish safe remote routing.

`domino_dev_off` is a separate nft table, dispatching only the three new UIDs.
Its default per-role outcome is drop. It permits established replies from each
role's exact loopback listener and the gateway's original requests to 8890 only.
It grants no provider, DNS, edge 7844 or JWKS 443 access; even the connector lacks
an origin permission in this OFF policy. The service BPF candidate denies all
addresses except 127.0.0.1; nft supplies the narrower port/direction boundary.
This generated policy cannot operate a live Tunnel or fetch provider data.

The production `domino_continuous_reads` table, production UIDs, files, target,
ports 8876 / 8878 and flags are not rewritten. The full host chain ordering and
actual cgroup BPF behavior still require native inspection. Offline string and
manifest checks do not prove kernel enforcement.

## Private configuration and revocation

`/etc/domino/dev` is root-controlled. Each role's private subdirectory is 0700,
owned by that role, and bound **as a read-only directory** into its namespace.
The gateway profile/admission leaves are 0600, UID/GID 975. The future reader
profile is 0600, UID/GID 974, with a separate 0700 writable runtime. This matches
the backend's self-owned private-file validation; changing leaves to root-owned
would make the application refuse them.

The directory bind is essential: the operator atomically replaces the backing
`admission.json`, and the gateway reopens it on every request. A file bind or
startup environment snapshot would keep the old inode/value. The service sees
the updates but cannot write through its read-only mount. Its parent paths are
root-controlled. The native test must prove both replacement visibility and
write denial; ownership/mode checks alone are insufficient.

The reader profile may contain provider keys and is **not generated**. Only
the reader may see its own profile directory. Gateway, connector, production
release/runtime, private credential source and DB socket access are explicitly
isolated. Only the reader joins `domino-db`; the other two roles have no DB group
and cannot see `/run/postgresql-domino`.

Connector credentials deliberately use a different lifecycle: a root-only 0600
source under root 0700 `/etc/domino/dev/tunnel-private` is delivered with the
existing reviewed `LoadCredential` mechanism. The command uses only the private
credential-copy path, never its value. Rotation requires a controlled connector
restart. `LoadCredential` is **not used for hot gateway admission**. Neither a
connector token nor the Windows-only Access client secret is in this bundle.

## Native installation boundary and rollback

The actual continuous supervisor/guard is a private operator artifact outside
this repository and checks exact production roots, roles, cgroups and hashes.
Reusing it for the new dev roles would either fail or silently widen its scope.
This change therefore supplies a hashed, concrete apply/rollback **review plan**,
not an invented generic VM installer. `procedure.json` pins the observed
revision 5 production manifest and requires a fresh native baseline before any
future installation. A changed baseline requires reconciliation and review.

The remaining operator implementation must bind the selected source/archive,
all emitted file hashes and modes, exact SQL/peer snapshots and native merged
units to an exclusive candidate journal. Stage only absent dev targets; do not
overwrite an unknown prior attempt. Root-controlled source and configuration,
native unit syntax and nft checks in a disposable network namespace precede
any service start. The OFF listener test must then prove read-only mounts,
atomic replacement, sibling secrets/DB denial, production-port denial and
unchanged production state. Do not reuse the production 45s healthy-start timeout
for a future enabled reader with a 60s admission cooldown; distinguish process
liveness from its eventual admitted state without resetting the cooldown.

Rollback first disables development admission and revokes the separate Access
identity if provisioned, then drains only the development target, three dev
services and dev policy service. Keep the restrictive dev nft table after stop.
Use only the matching guarded SQL/peer rollback with zero dev sessions; no
`CASCADE`, database rewind or removal of unrelated operator files. Retain inert
artifacts and evidence if a guard fails. Production services and secrets are
never recovery targets.

The [SQL profile](DEV_CATALOGUE_OFF_PROFILE.md) is a separate explicit opt-in audit/generator. Existing
production role/ACL checks remain strict; normal upgrade wrappers must refuse
the extra dev role until the matching deprovision restores their old baseline
or a later reviewed upgrade path explicitly supports it. There is no silent
acceptance of arbitrary new roles, grants or persistent role settings.

## Remaining activation and acceptance

Before enabling anything, the coordinated backend and this boundary need
independent review. Actual provider quota reservation, a dedicated Access
identity/AUD, its revocation mechanism, token delivery and the exact dev-only
remote paths must be confirmed. Allowed families are the seven reviewed reads,
guarded capabilities and guarded development status. No production Worker/Pages
binding, wildcard route or direct reader/metrics/admin exposure is introduced.

A separately reviewed positive network candidate must keep connector edge 7844,
issuer JWKS 443 and gateway 8891 permissions distinct and verify every hostname
pin. It must deny other external and production loopback targets under actual
service UIDs, mounted files and cgroups. This OFF bundle intentionally grants
none of those live permissions.

Provider limits in the development backend do not prove shared account/IP
headroom. The coordinator is obtaining non-secret quota/reservation facts;
starting another reader must not silently double production's provider allowance.
Any needed production transport/aggregate-budget modification is a separate
explicitly reviewed delta. Generic inputs and unavailable/empty/unindexed states
remain honest; budgets may refuse the largest requests rather than truncate data.

Finally, Decimal must demonstrate an uncommitted visible HMR edit with actual
supported reads on Windows, exact Host/Origin controls, bounded tabs/worktrees,
active-access revocation and secret/build-artifact exclusion. A generated bundle,
successful credential handoff or server-only smoke test does not close #132.

## Offline checks in this change

```sh
python3 -B -m unittest discover -s scripts/staging/tests \
  -p test_dev_infrastructure.py -v
```

The 14 focused checks cover injection/unknown-input rejection, exact identities,
no production targets, no enable/auto-start, RO-directory revocation wiring,
credential and DB isolation, emitted nft/BPF limits, resource/drain behavior,
manifest/procedure integrity and exclusive private local generation. Native
systemd/nft/BPF, credentials, provider, PostgreSQL and Windows checks are not
claimed by these tests.
