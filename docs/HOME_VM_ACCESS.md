# Operator access to the home VM

How an authorised operator reaches the machine that runs the public read path and
the indexers, and what to check once there. **Private addresses, usernames and key
material stay in the operator's own SSH configuration, outside this repository**
([runbook rule](HOME_VM_RUNBOOK.md)). This page is the procedure, not a credential
store.

## What you need before starting

| Piece | Where it lives | Notes |
|---|---|---|
| SSH client configuration | `~/.ssh/<operator>_vm_config` | Defines two hosts: a jump host and the VM behind it. Not read from `~/.ssh/config`, so every command passes `-F`. |
| Private key | `~/.ssh/<operator>_vm_<date>_ed25519` | Mode 600, owned by the operator. Never paste it into a chat, an issue or a commit. |
| Public key | the matching `.pub` | Safe to share; install it on the VM (or on another machine) as needed. |
| Access to the VM's operator account | provisioned with that public key | The account is a member of the local `sudo` group through the installer's operator role. |

The VM has **no inbound route of its own**: it is reached through the jump host,
which is why the configuration uses `ProxyJump`. If the jump host is unreachable,
so is the VM — check the tunnel before debugging the VM.

## Connecting

```sh
# Everything, through the configured jump host.
ssh -F ~/.ssh/<operator>_vm_config <vm-alias>

# A single remote command, no interactive shell.
ssh -F ~/.ssh/<operator>_vm_config <vm-alias> 'systemctl --failed'
```

The configuration looks like this; fill the addresses and users from the private
provisioning record:

```
Host <jump-alias>
  HostName <jump-host>
  User <jump-user>
  Port 22
  IdentityFile ~/.ssh/<operator>_vm_<date>_ed25519
  IdentitiesOnly yes

Host <vm-alias>
  HostName <vm-internal-address>
  User <vm-operator>
  Port 22
  ProxyJump <jump-alias>
  IdentityFile ~/.ssh/<operator>_vm_<date>_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
```

## Verify the connection

```sh
# 1. The key you hold is the one you think it is.
ssh-keygen -lf ~/.ssh/<operator>_vm_<date>_ed25519.pub

# 2. The account and its privilege, in one round trip.
ssh -F ~/.ssh/<operator>_vm_config <vm-alias> 'id -un; hostname; sudo -n whoami'

# 3. The units that are supposed to be running.
ssh -F ~/.ssh/<operator>_vm_config <vm-alias> \
  'systemctl is-active domino-read domino-gateway domino-continuous-egress \
   domino-queue-worker.timer domino-catalogue-follower.timer'
```

`sudo -n whoami` answering `root` is expected: the installer grants the operator
account passwordless sudo. If it asks for a password, stop and reconcile the
account against the provisioning record before changing anything.

## What lives where on the VM

| Piece | Path |
|---|---|
| Indexer releases | `/opt/domino/queue-worker/release`, `/opt/domino/queue-worker/read-release` |
| Indexer virtualenv | `/opt/domino/queue-worker/venv` (uv, CPython 3.14) |
| Provider credential | `<release>/backend/runtime/providers.json`, mode 600, owned by the indexer account |
| Database descriptor | `<release>/backend/runtime/catalogue-db.json`, mode 600, owned by the account that reads it |
| Continuous egress policy | `/etc/domino/continuous-reads/policy.nft` (and its dated backup) |
| Followers and workers | `domino-queue-worker.timer`, `domino-catalogue-follower.timer` |
| Database | Unix socket only, private port, database `domino_catalogue`; administrative role reached with `sudo -u <db-admin-os-user> psql -h <socket> -p <port> -U <db-admin-role> -d domino_catalogue` |

Read-only checks that answer most questions:

```sh
# Catalogue coverage and revision.
sudo -u <db-admin-os-user> psql -h <socket> -p <port> -U <db-admin-role> -d domino_catalogue -Atc \
  'select start_block,next_block,revision from domino_catalogue.state'

# Pool requests and their state.
sudo -u <db-admin-os-user> psql -h <socket> -p <port> -U <db-admin-role> -d domino_catalogue -Atc \
  'select pool_id,status,attempts,last_error from domino_activity.pool_requests order by requested_at'

# What the last indexer run spent on provider headers.
sudo journalctl -u domino-queue-worker -n 5 --no-pager | grep -o '"headerCalls": [0-9]*'
```

## Rules that keep this safe

- Private addresses, usernames and key material belong to the operator's private
  configuration, never to this repository, an issue or a chat transcript.
- Credentials are per operator and per key. Sharing an account or forwarding the
  agent (`ForwardAgent yes`) widens the blast radius for no operational gain.
- The provider credential is a billable secret: read it in place, do not copy it
  into a shell history, a report or a commit.
- A spend ceiling belongs to every backfill. `--max-header-calls` is the hard
  stop; a run that ends with `stoppedBecause: budget` is a decision point, not a
  failure to retry blindly.
