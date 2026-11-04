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
  names. That binding must be a Worker that admits the preview alias: one
  deployed for it (its `APP_ORIGIN` is the alias), or, since 4 Nov 2026
  (launch round P3), production's own with the alias listed in its
  `PREVIEW_ORIGINS`. Production's Workers as committed answer
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

Sign-in, Receipts, Managed positions, Automate's activation check, plans,
deposits from another network and the deposit service all ride a session. The
session service on the VM checks the browser's origin against the one origin it
was started with (`DOMINO_SESSION_ORIGIN`, `backend/session_api.py`) and writes
that origin's host into the sign-in message (`backend/session_siwe.py`).

Since 4 Nov 2026 (launch round P3, item 7: testing without real money) the
listeners and the private families' Workers can also admit the exact preview
alias, so the preview signs in and plans against the same listeners as
production, with sessions of its own. Nothing changes until someone lists it:
every list below is empty as committed. The boundary is in the next section.

To give the preview the private families (after the launch, by the owner):

0. **Migration 057 first** (`backend/migrations/057_session_origin.sql`, as
   postgres: `apply_migrations.py … --migrations 057_session_origin --apply`),
   then the listeners' release that reads it. It only adds the sessions'
   nullable `origin`, which the earlier listeners leave NULL, the canonical
   origin, so it can run with ingress open.
1. **On the VM:** in the environment file of the session listener and of each
   authenticated listener the preview will use (onboarding, deposit,
   performance, position plan, crosschain),
   `DOMINO_SESSION_PREVIEW_ORIGINS=https://preview.domino-app-e65.pages.dev`;
   in the execution status profile, `"previewOrigins":
   ["https://preview.domino-app-e65.pages.dev"]` under `session`. For option 2a,
   also each listener's `DOMINO_<FAMILY>_ACCESS_PREVIEW_SERVICE_ID` (the
   execution profile's `access.previewServiceId`): the client id of the preview
   Workers' own Access service token. Restart each. A malformed value turns
   the preview off and only that: the listener starts, production serves, every
   preview request is refused, and the journal gets an error-priority line
   naming the setting (never its value). No second gateway or tunnel hostname.
2. **In Cloudflare, one of:**
   - **a. Separate preview Workers (recommended).** Deploy each family's Worker
     again under a name of its own (`domino-session-bridge-preview`, ...) from
     `bridge/wrangler.<family>.toml`, with `APP_ORIGIN` the alias,
     `PREVIEW_ORIGINS = ""`, the family's own production
     `<FAMILY>_GATEWAY_ORIGIN` and flag, and a service token of its own that
     the listener's Access application admits (add it to that application's
     policy). Each listener then ties the origin to the caller: the preview
     token may only carry the preview alias, and production's token only the
     canonical origin. Production's Workers stay reachable from production's
     Functions only.
   - **b. Production's Workers.** List the alias in their `PREVIEW_ORIGINS`
     (a reviewed change to `bridge/wrangler.<family>.toml`: the offline check
     `scripts/staging/check_bridge_configs.py` takes `""` or this alias and
     nothing else), deploy them, and bind them in the preview environment. Set
     no preview service id on the listeners. Simpler, but production's private
     Workers then also answer every Function deployed to the Pages preview
     environment (below).
3. **In `app/wrangler.toml` under `[env.preview]`:** one `[[env.preview.services]]`
   table per family, binding its production binding name (`SESSION_BRIDGE`,
   `ONBOARDING_BRIDGE`, `DEPOSIT_BRIDGE`, `PERFORMANCE_BRIDGE`,
   `EXECUTION_BRIDGE`, `POSITION_PLAN_BRIDGE`, `CROSSCHAIN_BRIDGE`) to the
   Worker of step 2, and the family's name added to `PREVIEW_FAMILIES` (for
   example `"setup,session,position-plan,crosschain"`).
   `tests/forwarder.test.mjs` pins this file, so the change is reviewed with it.
   With option b, the comments in `app/wrangler.toml` and
   `app/functions/_lib/bridge.ts` that say a private family is never bound to
   production's Workers need the same change (0xdecimal's files).

Never translate a private family to `https://domino.money`: the sign-in message
would name `domino.money` while the page runs on the preview, which the app
refuses and a wallet flags as another site.

Rollback, in this order:
1. Remove the alias from `DOMINO_SESSION_PREVIEW_ORIGINS` (and the profile)
   and restart the listeners, or set `PREVIEW_FAMILIES` to the public families
   only and redeploy preview.
2. Revoke every session signed in on the preview. Each carries its origin
   (migration 057); a session stays usable for up to 12 hours (30 minutes idle)
   and would be again if the alias were listed again:

   ```sh
   sudo -u postgres psql -d domino_catalogue -c "UPDATE domino_sessions.sessions SET revoked_at=now() \
     WHERE origin='https://preview.domino-app-e65.pages.dev' AND revoked_at IS NULL"
   ```

   (`test_session_listener.py` runs this statement against a real session store.)

   Production's sessions (origin NULL) are untouched.

## Preview origins: the boundary

Each preview origin is listed twice, independently: on the Worker
(`PREVIEW_ORIGINS`, or the separate Worker's own `APP_ORIGIN`) and on the
listener (`DOMINO_SESSION_PREVIEW_ORIGINS`). Both compare whole strings: an
`https` origin of a lower-case DNS name, nothing else, at most four, never a
pattern. The Worker admits a request only when its URL's origin is a listed one
and its `Origin` header names that same one, then tells the listener which one
it admitted (`X-Domino-Browser-Origin`); the listener admits that header only
when its whole value is one it lists, and records it in the request's line
(`origin`). Tests: `bridge/test/preview-origins.test.mjs`,
`backend/tests/test_preview_origins.py`, `test_session_listener.py`,
`test_onboarding_auth.py`.

**A session belongs to its origin** (review M1, migration 057). Sign-in stores
the origin it happened on (NULL for the canonical origin), and every session
check of every listener (`me`, refresh, logout, and each authenticated
family's checks) compares it with the origin the listener admitted for that
request. A preview's session, its CSRF token and all, is refused when presented
with production's origin, and production's with the preview's, whoever
presents it: a browser, or code that read the cookie server-side. A preview's
traffic also spends budgets of its own (every rate key, site-wide, per address
and per account), so it never spends production's 1000 sign-ins a minute nor a
production visitor's address budget.

**What a listed preview can do.** Pages served from that exact host can sign a
wallet in (the sign-in message names that host, as the wallet shows it) and,
with that session, use every family the forwarder gives it (`PREVIEW_FAMILIES`)
through production's listeners: plans, quotes and bridge status, deposit
preparation, execution receipts, performance enrollment. They read the real
chains and write the real database: a preview session is a real session of
that wallet on the preview, and every transaction is still the wallet's own
signature. It shares production's listener capacity, not its budgets.

**What it cannot do.**
- Use a production session, or production one of its own: the listeners bind
  each session to its origin (above). The cookies are also `__Host-`
  (host-only, `Secure`, `Path=/`, no `Domain`), so a browser never sends one
  host's to the other, and `pages.dev` is a public suffix, so the preview is
  cross-site to `domino.money` and `SameSite=Lax` withholds them on its fetches.
- Sign in through another origin. A challenge names the origin it was asked
  from, and verify rebuilds the message for the origin it is asked from: a
  challenge asked on the preview never signs in on `domino.money`, nor the
  reverse, even with its own preauth context, CSRF and the owner's valid
  signature.
- Speak for another admitted origin. A request whose URL is one admitted
  origin and whose `Origin` is another is refused, as is a preview page calling
  through production's host or the reverse; with option 2a the listener also
  refuses the preview's Access identity for the canonical origin and
  production's for the preview.

**Why another Pages project cannot use it.** Nothing is matched by pattern: a
sibling deployment of the same project (`<branch>.domino-app-e65.pages.dev`, a
hash URL), a host under the listed one, a host merely ending or starting with
it, another scheme, port or case, and `null` are all different strings and are
refused. A `pages.dev` subdomain belongs to one project and only that project
serves its hosts. Ours is `domino-app-e65.pages.dev` although the project is
named `domino-app` (`app/wrangler.toml`): a rule built on the name would also
match `domino-app.pages.dev`, which is not this project's. The Workers have
no Internet route (`workers_dev = false`, `routes = []`): only our Pages
project's service bindings reach them, and no other account can bind them. A
foreign page's own requests to our hosts carry its own `Origin` and are
cross-site, so they are refused without cookies. Siblings of the preview are
same-site with it, so `SameSite` alone would not separate them: their `Origin`
(their own host), Fetch Metadata (`same-site`, not `same-origin`) and the CSRF
token they cannot read do.

**What the Workers trust.** Like production's, a Worker trusts the Pages
Function in front of it to pass the browser's URL, `Origin`, Fetch Metadata and
`CF-Connecting-IP` as they came (`app/functions/_lib/bridge.ts`); a binding
cannot vouch for them. Pages bindings belong to an environment, not to an
alias: whatever is bound in the preview environment answers every Function
deployed there, not only the alias's. Today that is main's own builds after
their checks (CI's `deploy:preview`, a Direct Upload with `--branch preview`)
and the owner's manual deploys; the project builds no branch or fork by
itself. Such code can present any origin its bound Workers admit and any client
address, as anyone can with `curl` against production, and spread its calls
over invented addresses to escape the per-address limits; the preview's own
site-wide limits still hold, and production's are never spent. It cannot
use a session it did not sign in on that origin (the binding above). It can
also ask for a sign-in message naming any origin its bound Workers admit:
under option b that is production's too, because production's Workers admit
`https://domino.money`; under option a only the preview's, because the
preview Worker can name nothing else and the listener refuses the preview
identity for the canonical origin. A message for a host other than the page's
is then stopped only by the wallet's own domain check (the warning a wallet
shows when the page's host is not the message's), the same protection that
stands between any phishing page and production's message. Choose option b
only while the preview environment receives nothing but main's reviewed builds
and the owner's deploys; if Pages ever builds other branches or forks, use a.

**A malformed setting.** A broken `PREVIEW_ORIGINS` turns preview admission off
in that Worker, and only that: production serves, every preview request is
refused, and each request logs `preview_origins_invalid` (visible with
`wrangler tail`; these Workers keep no logs). A broken
`DOMINO_SESSION_PREVIEW_ORIGINS`, `previewOrigins` or preview service id does
the same in the listener, with an error-priority journal line at start. Before
4 Nov 2026 the first answered 503 to production too and the second stopped the
listener at its next restart.

**Still to keep in mind.** The alias is a branch alias: whoever can deploy it
controls the code that runs with sessions created there. List an alias, never
a hash or branch host of someone else's work, and revoke its sessions when
testing ends (rollback above). A sign-in message for the preview's host is
phishable like production's: the wallet's own domain check, and the beta
password in front of the preview, are what stand between a lookalike page and a
signature.

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
