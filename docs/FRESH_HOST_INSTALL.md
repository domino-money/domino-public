# Fresh services host

This procedure builds a services host, the role `domino-alpha-01` has played since
September 2026, from the repository alone. It installs:

- the releases that host runs, each with the installer in its own archive;
- reviewed installers for the steps the first host got by hand.

It is also the disaster-recovery procedure. Credentials are sealed to a host's
TPM, so a disk snapshot cannot carry them to another machine: recovery means
building again, then re-sealing.

## Validation on domino-prod-01

The procedure ran end to end on `domino-prod-01`, an AWS t3a.xlarge with
NitroTPM, on 3 Oct 2026. Every unit stayed off. Against the first host:

- **Database schema:** identical, apart from two things:
  - the development lane's 17 grants (the lane is not rebuilt);
  - `domino_automation_install.readiness_upgrade_receipt`, which only the
    first host's upgrade path created.
- **Runtimes:** byte-identical. That covers the interpreter binary and its
  standard library, `pyvenv.cfg`, and the RECORD files of both environments.
- **Units, drop-ins and egress artifacts:** identical, or identical in effect.
  The read and gateway activation is one drop-in per unit instead of the 70, 80
  and 90 layers. The automation units name their release directly instead of
  through a 50 drop-in. Those that differ in effect name a host-specific
  runtime path, or list the same addresses in another order.
- **Release trees and cloudflared:** identical modes, owners and hashes.

## Inputs

### Releases

Each archive is `git archive --format=tar <commit>`. That output is
byte-identical to the archive the first host installed.

| Lane | Commit | Archive SHA256 | Installer |
| --- | --- | --- | --- |
| Foundation: read, gateway, auth, onboarding, deposit, operator, write | `4c3ee322308900303c679088bc4712ef16500763` | `38a93abc8fee7959704441ef738209a6a5d120e0c3889d9a7326a723fe2e4400` | its `prepare_disabled.py` |
| Financial base | `fbc0d5eb9a0ac9c9abf7b062d2c26a94b4806710` | `122f95d1b2be05a648d3f4ff89c9605c86a445b7329cf25b7b1e27f5317947b2` | its `upgrade_financial.py` |
| Session listener | `0b85ee96d8a13a38b112437c33f3cbfec1406d83` | `b79428fc1d5688c54c4172be7d5fa2b1f43f1d924f1532fef6fd805cacfd9a7c` | its `install_auth_release.py` |
| Execution status | `e47235d397abc20a0125688b03e92da1b0ff4a78` | `b4400f1400d7becc3fd37467e51f68f6442363087a100a1c0f5ec2dfa2347fe2` | its `install_financial_release.py` |
| Automation and gas peers | `0aa852bb8cb46712eba4e944a1e384fba4a0197e` | `cc8a03a0edf4f85e471ce3f802ec51fc8b18ee0cceb3e45aeb1e2aca2be32da1` | its `install_automation.py` |
| Public data | `7a288595f67b200ed739cd8c71e84e35fba76a79` | `afd9b30a20407788a4373643287e1ed07808c90837d55bb7340d62ecd3824220` | its `install_public_data.py` |
| Read path | `965fc290ec31d03d4e9f1fd9470f0a5e73539f69` | `19111afbc907e82b09d119a65ff60ba5b857a188b0576aa4b2dcfda8c79ddc62` | `install_read_release.py` from this repository |

The public-data commit is reachable only from the branch
`claude/public-data-follower-release`. Keep that branch.

The read path uses this repository's `install_read_release.py` because the
release's own copy predates support for a host whose only read release is the
foundation's.

### Binaries

- **uv:** `uv-x86_64-unknown-linux-gnu.tar.gz` from uv 0.12.13. `install_runtimes.py`
  pins its SHA256.
- **cloudflared:** `cloudflared-linux-amd64`, as pinned in
  [scripts/cloudflared/release.json](../scripts/cloudflared/release.json).

The interpreter and the Python packages come from the network in step 2.

## Host base

These steps are done by hand and depend on the provider:

- Ubuntu 24.04, x86_64.
- Before installing PostgreSQL, write `create_main_cluster = false` to a file in
  `/etc/postgresql-common/createcluster.d/`.
- Install the packages: `postgresql-16 postgresql-client-16 nftables ufw haproxy curl xz-utils ca-certificates`.
- Create the administrator `domino` (uid 1000, sudo).
- Install `/etc/ssh/sshd_config.d/00-domino.conf` with:
  `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
  `PermitRootLogin no`, `AllowUsers domino`, `AllowAgentForwarding no`,
  `X11Forwarding no`, `AllowTcpForwarding local`.
- Configure ufw to deny all inbound traffic and to admit port 22 only from the
  management peers, on the private network interface.
- With Tailscale, run `--netfilter-mode=off`. Its own rules accept all tailnet
  traffic ahead of ufw.
- For the TPM, install `libtss2-esys-3.0.2-0t64 libtss2-mu-4.0.1-0t64 libtss2-rc0t64 libtss2-tcti-device0t64`.
  Without them `systemd-creds has-tpm2` reports `partial`.

## Conventions

- **Where to run from:** every installer runs as root, with `python3 -B`, from a
  root-owned copy. A release installer runs from its own archive's
  `scripts/staging`. The fresh-host tools run from this repository's `scripts/`.
- **umask 022.** Only plans and baselines are private. Create each one first with
  `install -m 0600 /dev/null <file>`, then redirect into it. Under umask 077,
  `upgrade_financial.py` creates `/opt/domino/financial` as 0700, and
  `install_auth_release.py` then refuses with `release_directory_not_traversable`.
- **Nothing is enabled or started until cutover.**

Below, `$A_<lane>` stands for
`--archive <file> --archive-sha256 <sha256> --commit <commit>` of that lane.

## Steps

1. **Foundation.** Identities, socket directory, cluster `16/domino` (UTF8, C
   locale, checksums), peer maps, roles and database, and `/etc/domino` (root,
   0700). `upgrade_financial.py` needs `/etc/domino` and refuses without it.

   ```sh
   python3 -B install_host_foundation.py --inspect
   python3 -B install_host_foundation.py --apply
   ```

2. **Runtimes.** uv, CPython 3.14.7, `/opt/domino/backend-venv` and
   `/opt/domino/queue-worker/venv`, from the foundation archive's lock.

   ```sh
   python3 -B install_runtimes.py $A_foundation --uv-archive uv-x86_64-unknown-linux-gnu.tar.gz --apply
   ```

3. **Foundation release**, from its own tree. Then run its checks:
   `check_roles.py`, and `check_filesystem.py $A_foundation`.

   ```sh
   python3 -B scripts/staging/prepare_disabled.py $A_foundation           # plan
   python3 -B scripts/staging/prepare_disabled.py $A_foundation --apply
   ```

4. **Post-install.** These are the two hand steps that followed the first
   host's install: the administrator's peer rows and socket group, and the public
   schema revoke (#106). Only `prepare_disabled.py` checks either.

   ```sh
   python3 -B install_host_foundation.py --post-install
   ```

5. **Financial base**, from its own tree.

   ```sh
   python3 -B scripts/staging/upgrade_financial.py $A_financial > plan.json
   python3 -B scripts/staging/upgrade_financial.py $A_financial --inspect > baseline.json
   python3 -B scripts/staging/upgrade_financial.py $A_financial --baseline baseline.json --apply
   ```

6. **Hand-applied migrations 020–027.** Each runs in one transaction as the
   identity the first host used, and each gets a receipt.

   ```sh
   python3 -B apply_migrations.py $A_public_data --apply --migrations \
     020_pool_requests,021_reference_price_sources,022_event_timestamp_source,023_pool_request_scheduling,024_public_observations,025_public_history,026_public_demand,027_remove_wallet_access_gate
   ```

7. **Session listener.** Run `install_auth_release.py $A_auth --inspect`, then
   `--apply`, then `systemctl daemon-reload`. It refuses until 027 is applied.

8. **Automation.** Run `install_automation.py $A_automation`, then `--inspect`
   into a private baseline, then `--baseline … --apply`. This applies 028–040
   and 046. Hold `install_automation_boot.py` until cutover.

9. **Migration 041.**

   ```sh
   python3 -B apply_migrations.py $A_public_data --migrations 041_session_delegated_accounts --apply
   ```

10. **Execution status.** Run
    `install_financial_release.py --component execution-status $A_execution_status`
    with `--inspect`, then `--apply`. It refuses without 041.

11. **Migrations 042–045 and 047.**

    ```sh
    python3 -B apply_migrations.py $A_public_data --apply --migrations \
      042_provider_priority,043_featured_pools,044_demand_horizon,045_featured_live,047_provider_ceiling
    ```

12. **Queue-worker root.** The writer's lock and runtime, and the first host's
    four base units.

    ```sh
    python3 -B install_queue_worker_root.py $A_public_data --apply
    ```

13. **Public data.** Run `install_public_data.py $A_public_data` with
    `--inspect`, then `--apply`. Its units bind the writer's pinned hosts file,
    `/etc/domino/continuous-reads/write.hosts`, which step 17 writes; none of
    them starts before cutover.

14. **Read release**, from this repository.

    ```sh
    python3 -B install_read_release.py $A_read --inspect
    python3 -B install_read_release.py $A_read --apply
    ```

15. **Read activation.** One drop-in each for the reader and the gateway: the
    release, its runtime, and the v1–v5 bridge reads live since 27 Sep.

    ```sh
    python3 -B install_read_activation.py --commit 965fc290ec31d03d4e9f1fd9470f0a5e73539f69 --apply
    ```

16. **Connector.** No token yet; the connector starts only at cutover.

    ```sh
    python3 -B install_cloudflared.py --binary cloudflared-linux-amd64 --sealed-token --apply
    ```

    `--sealed-token` adds a 45 drop-in. It loads the token as a credential
    sealed to this host, `/etc/domino/credentials/cloudflared-token.cred`
    (`--name=cloudflared-token`), under the unit's own credential id. The first
    host kept a plain file instead.

17. **Continuous egress.** Collect on this host, render, review, install. Nothing
    is loaded until the target starts.

    ```sh
    python3 -B install_continuous_egress.py --collect --access-issuer ordio-hq.cloudflareaccess.com \
      --enabled read,gateway,tunnel,write,auth,execution-status \
      --sequence-snapshot-loopback --public-data-collectors --node-loopback-reads > pins.json
    python3 -B continuous_egress_policy.py < pins.json > candidate.json
    python3 -B install_continuous_egress.py --candidate candidate.json --apply
    ```

18. **Node endpoint.** The keep-alive proxy on `127.0.0.1:18547`, and the reverse
    tunnel's restricted user. The proxy is the only thing this procedure starts.

    ```sh
    python3 -B install_node_rpc_endpoint.py --peer <clawber tailnet IPv4> \
      --peer-key <clawber /etc/domino/rpc-tunnel/id_ed25519.pub> --apply
    ```

    `--verify` compares an installed endpoint with what `--apply` writes.

### clawber's side

Two units serve the node to this host. The node itself is not changed.

**`domino-rpc-direct.socket` and `domino-rpc-direct.service`: the primary path.**

- The socket has `ListenStream=<clawber tailnet IPv4>:18549`, `FreeBind=yes`,
  `NoDelay=yes`, `IPAddressDeny=any` and `IPAddressAllow=<this host's tailnet IPv4>/32`.
- The service runs `/usr/lib/systemd/systemd-socket-proxyd --connections-max=256 127.0.0.1:8547`
  under `DynamicUser`, with `IPAddressAllow=127.0.0.1/32` only.
- The allow-list must sit on the socket. Tailscale's own rules accept tailnet
  traffic ahead of the firewall.

**`domino-rpc-tunnel-prod.service`: the backup path.** It is a copy of
`domino-rpc-tunnel.service` with three changes:

- `-R 127.0.0.1:18548:127.0.0.1:8547 domino-rpc-tunnel@<this host's tailnet IPv4>`;
- `UserKnownHostsFile` pins this host's ed25519 key, read over a trusted channel
  such as SSM;
- `IPAddressAllow=127.0.0.1/32 <this host's tailnet IPv4>/32`.

## Left for later phases

### Secrets (owner)

The secrets are re-sealed on the new host with
`systemd-ask-password | systemd-creds encrypt --with-key=host+tpm2`. Some files
are copied over the private network; they never pass through a log or an
assistant. The paths are:

- `/etc/domino/financial/automation/`:
  - the two keystores, which are copied;
  - the two `*-keystore-password.cred` files, which are sealed;
  - `config.json`;
  - the `40-keystore-credentials.conf` drop-in, which `configure_automation.py`
    writes.
- `/etc/domino/financial/gas-{reservation,settlement}/config.json`
- `/etc/domino/financial/auth/{environment,rpc.json}`
- `/etc/domino/financial/execution-status/{profile.json,session-abuse-secret}`
- `/etc/domino/private/session-abuse-secret`
- `/etc/domino/continuous-reads/gateway.env`
- `/etc/domino/credentials/cloudflared-token.cred`, sealed with the step 16 drop-in (a plain file on the first host)
- `providers.json` in the read, gateway and writer runtimes; then, as each
  file's owner, `configure_rpc.py --node-loopback on` in the reader's and the
  writer's (docs/LOCAL_RPC_SOURCE.md)
- `/etc/domino/v2/chain-rpc.json` and `/etc/credstore.encrypted/v2-rpc-*`

### Data (cutover)

The live dump replaces `domino_catalogue` entirely. Before restoring:

- create `domino_dev_catalogue_reader` as `NOLOGIN`, or filter its 17 grants
  out of the restore list;
- expect the dump to bring back `readiness_upgrade_receipt`.

Run `check_roles.py` after the restore.

### Enablement (cutover)

- `domino-continuous-reads.target`
- `domino-public-data.target`, and `domino-featured.service` under it
- the queue-worker and catalogue-follower timers
- `install_automation_boot.py --apply`

### Development lane

It is not rebuilt: its installers are pinned to the first host's identities.
