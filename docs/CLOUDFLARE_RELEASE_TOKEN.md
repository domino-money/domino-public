# The read-path release token

The read path cannot be published because the Cloudflare API token in
`secrets.CLOUDFLARE_API_TOKEN` can read Pages and nothing else. This is what a
replacement needs, why each permission is needed, and how to hand it over
without it passing through anyone's chat or transcript.

## What is blocked, and the evidence

`Publish read path` with `operation=inspect`, run against `ce6c783` on
2026-09-18, reported:

| Resource | Result |
|---|---|
| `workers/scripts/domino-read-bridge/settings` | **HTTP 403, error 10000** |
| `cfd_tunnel/7abb1264-…/configurations` | **HTTP 401, error 1001** |
| `pages/projects/domino-app` | read fine — production at `39c59c2` |

The Pages call succeeded on the same token and the same account, so the account
is right and the credential is valid: what is missing is permission. A
Cloudflare token cannot widen its own scope, so this needs a token edited or
recreated by someone with access to the account.

Without it, `operation=bridge` cannot run at all: it reads the Worker's settings
before doing anything, and the helper raises on any non-OK response, so it fails
closed rather than half-publishing.

## The account and the resources

| | |
|---|---|
| Account ID | `d85749a9e56c4564e9d4f55a4cfbcb15` (already a repository variable) |
| Worker | `domino-read-bridge` |
| Tunnels | `31526265-ca63-40f2-bbb7-bd37a537f899`, `7abb1264-ee70-4b69-a33c-b75a9deb4589` |

## The permissions, and the call that needs each

Account-level permissions only. Nothing below is a zone permission, and nothing
needs access to DNS, certificates, billing or membership.

| Permission | Level | Needed by |
|---|---|---|
| **Workers Scripts** | Read | `GET workers/scripts/domino-read-bridge/settings` — read before publishing, and read back after, to prove the deployed flags are the requested ones |
| **Workers Scripts** | Edit | `wrangler deploy -c bridge/wrangler.read.toml --keep-vars` — the publication itself |
| **Cloudflare Tunnel** | Read | `GET cfd_tunnel/<id>/configurations` on both tunnels — read the current configuration, and read it back to prove only the intended paths changed |
| **Cloudflare Tunnel** | Edit | `PUT cfd_tunnel/<id>/configurations` — add the read-v2 paths, preserving every other setting |
| **Pages** | Read | `GET pages/projects/domino-app` — already works today; keep it |

`wrangler deploy` may additionally require **Account Settings: Read** to resolve
the account. If it does, its error names it; adding that one is the fix, and
nothing else about this list changes.

Pages **Edit** is deliberately not requested. It is what `operation=app` and
`operation=publish` would need to upload the frontend, and this work publishes
only the bridge. Add it separately if and when the app is republished.

## How to hand it over

The value must never travel through a chat, an issue, a commit or a transcript.
Two ways, in order of preference:

1. **Set the secret directly.** Both `rugged97` and `OxDecimal` have
   administrator access to this repository, so whoever creates the token can
   store it themselves at
   `Settings → Secrets and variables → Actions → CLOUDFLARE_API_TOKEN`, or with
   `gh secret set CLOUDFLARE_API_TOKEN` and paste at its prompt. The value then
   reaches no one else.
2. **Through a password manager**, if it must pass between people — never a
   message, and never a file in this repository.

If the existing token is edited rather than replaced, the stored secret stays
valid and nothing needs to be set at all.

## How it is verified afterwards

Re-run the workflow with `operation=inspect` against the current `main` commit.
It is read-only, and every resource above must come back without an `error`
field. That run also answers the open question this work is waiting on: whether
`READ_V2_BRIDGE_ENABLED` is already `true` on the deployed Worker, which decides
whether publishing is a code swap or also switches a route on.

Only then does `operation=bridge` run, followed by the VM move described in
[the switch-on runbook](READ_PATH_SWITCH_ON.md).

Note for whoever reads that inspect: it reports a refused resource inside its
JSON output and still exits successfully, so the workflow's own conclusion is
not evidence that access is complete. Read the fields.

## What this token does not grant

It is account-scoped to Workers, Tunnel and Pages reads. It does not sign a
transaction, hold a wallet key, reach the home VM, read the database, or touch
the Access service credentials the Worker already holds — those stay secrets on
the Worker and are explicitly retained across a publication. Nothing in this
release changes funds, chain authority, or which wallets are admitted.
