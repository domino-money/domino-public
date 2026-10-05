# The gated preview's API families

The preview alias `https://preview.domino-app-e65.pages.dev` is the owner's
real-data validation environment. Its beta password remains mandatory. The
adapter is confined to Pages; it does not modify the VM, tunnels, production
Workers, financial capabilities or the production deployment.

Since 2026-10-01 (platform workstream, H7) the preview can use more than the
public reads, family by family, each by an explicit opt-in:

| Family | How the preview reaches it | Enabled in `app/wrangler.toml` |
|---|---|---|
| Public reads (`/api/read/v1/` to `/api/read/v6/`; read-v6, Domino V2's wallet reads, since 2026-10-02) | translated to `https://domino.money`, production's read Worker | yes (`PREVIEW_PUBLIC_READS = "true"`) |
| Setup release (`/api/setup/v1/`: the setup and sequence releases, public contract identities, GET only) | translated to `https://domino.money`, production's setup Worker | yes (`PREVIEW_FAMILIES = "setup"`) |
| Session, onboarding, deposit, performance, execution, position-plan (Domino V2's S1 plans, since 2026-10-02), crosschain (S2's deposits from another network, since 2026-10-02) | as the browser sent them, its own cookies only, to a Worker deployed **for the preview alias** | no: see "Wallet sign-in and the private families" below |

## Boundary

- Only the exact HTTPS alias is eligible. Hash deployments, branch hosts and
  every other origin stay denied, whatever the variables say.
- The reads are opted in by `PREVIEW_PUBLIC_READS=true`; every other family by
  its exact name in `PREVIEW_FAMILIES` (comma-separated: `setup`, `session`,
  `onboarding`, `deposit`, `performance`, `execution`, `position-plan`,
  `crosschain`). Anything else in the list names nothing. Unset or empty: none.
- A public family (the reads, the setup release) is translated to the Worker's
  canonical app origin after Pages has validated the original browser Host,
  Origin and Fetch Metadata. POST requires the preview Origin; a GET of the read
  capabilities or of the setup release may omit it, as those Workers allow.
  Foreign Origins, cross-site or navigation metadata and Worker subrequests stay
  refused. No cookie of any kind crosses it.
- A private family is never translated: it goes on exactly as the browser sent
  it (method, path, body, Origin, Host, Fetch Metadata, its CSRF header and its
  own `__Host-` cookies, nothing else), to the binding the preview environment
  names. That binding must be a Worker deployed for the preview alias, whose
  `APP_ORIGIN` is the preview alias: production's Workers answer
  `https://domino.money` only and refuse the preview's calls.
- No caller chooses an upstream URL. The beta cookie, Authorization, Access
  credentials and forwarding headers are removed as before. The original edge
  client IP remains available for the existing shared read budget.
- Preview uses the existing public-read caches with keys isolated by origin; it
  never shares production cache entries. The beta gate and the preview's checks
  run before any cache or binding.
- Production request handling and its seven bindings are unchanged.

## What the owner can test on the preview today

With this repository's `wrangler.toml` deployed to preview, and nothing else:
the public pages with live figures, Positions and a position's page (the chain is
read from the browser), and New position and Automate up to the wallet's own
prompts: the setup and sequence releases now load there, so Review and the
sequence setup are reached. The wallet's own transactions (Create position,
Collect fees, Close position, the sequence's creation) are real mainnet
transactions from any host; nothing on the preview makes them a rehearsal.

## Wallet sign-in and the private families

Sign-in, Receipts, Managed positions, Automate's activation check and the
deposit service all ride a session. The session service on the VM checks the
browser's origin against the one origin it was started with
(`DOMINO_SESSION_ORIGIN`, `backend/session_api.py`) and writes that origin's
host into the sign-in message (`backend/session_siwe.py`). A preview session
therefore needs, besides this repository's code (ready):

1. On the VM (the backend owner's side, not this repository's): a second
   session gateway, and the authenticated gateways (performance, execution,
   deposit, onboarding) the preview will use, started for the preview origin
   `https://preview.domino-app-e65.pages.dev`, each behind its own tunnel
   hostname and Access service identity. Production's gateways stay as they are.
2. In Cloudflare (Workers & Pages), one Worker per private family, deployed
   from `bridge/wrangler.<family>.toml` under a new name (for example
   `domino-session-bridge-preview`), with:
   - `APP_ORIGIN = "https://preview.domino-app-e65.pages.dev"`;
   - `<FAMILY>_GATEWAY_ORIGIN` = that family's preview gateway hostname from step 1;
   - `<FAMILY>_BRIDGE_ENABLED = "true"` (and the family's other flags as production's);
   - the Access client id and secret of step 1's identity, as Worker secrets (the owner types them).
3. In `app/wrangler.toml` under `[env.preview]`: one `[[env.preview.services]]`
   table per family, binding its production binding name (`SESSION_BRIDGE`,
   `ONBOARDING_BRIDGE`, `DEPOSIT_BRIDGE`, `PERFORMANCE_BRIDGE`,
   `EXECUTION_BRIDGE`, `POSITION_PLAN_BRIDGE`) to its preview Worker of step 2, and the family's name
   added to `PREVIEW_FAMILIES` (for example `"setup,session,performance,execution"`).
   `tests/forwarder.test.mjs` pins this file, so the change is reviewed with it.

Never bind production's own private Workers to the preview, and never translate
a private family to `https://domino.money`: the sign-in message would name
`domino.money` while the page runs on the preview, which the app refuses and a
wallet flags as another site.

## Release and verification

Publish preview only after the owner's authorization, validate it with the
owner, then use a PR with passing checks before integrating to main. Production
requires a separate owner release. Never use a combined preview+production
workflow to satisfy a preview-only request. Preserve the beta gate in both.

Checks cover the forwarder against the real read and setup Workers with
controlled upstream fixtures, original browser admission, credential stripping,
the private families' exact opt-in and untranslated forwarding, refusal of
everything not opted in, unchanged production handling and actual Wrangler
environment parsing (`tests/forwarder.test.mjs`). Live verification must
separately demonstrate real pool figures and the setup release through the
preview, and refusal without the beta session. Do not claim any wallet
signature or financial operation was tested by these checks.

Rollback is preview-only: restore the prior preview deployment, or set
`PREVIEW_PUBLIC_READS` to `false` and `PREVIEW_FAMILIES` to `""` and
rebuild/redeploy preview. Do not stop tunnels or change production.
