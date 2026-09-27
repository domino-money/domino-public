# Domino app

The product frontend. English UI, Robinhood Chain only, built on the approved
Tangerine palette with new structure, screens and components.

`web/` is untouched by this directory and keeps working exactly as before.

This is the invited read-only alpha. It reads public pool data live where the
server enables it, says plainly when it cannot, and never signs, approves,
deposits or swaps. No build that can be deployed has a practice mode or a
sample figure.

## Run it

For the separately reviewed native Windows real-data development candidate,
see [local-live setup and boundaries](LOCAL_LIVE.md). It requires dedicated
development provisioning; it never reuses production access or changes Pages.

Both directories must be installed. This app imports domain modules from
`web/lib`, and TypeScript needs `web/` present to resolve them.

```sh
npm --prefix web ci
npm --prefix app ci
npm --prefix app run dev       # http://localhost:5273
```

Checks, the same ones CI runs, in the same order (CI runs `test:pages`,
`test:finance` and `test:gate` beside each other, in jobs of their own):

```sh
npm run check:app   # domain and gate tests, typecheck, lint, build, browser tests
```

## Tests

Three suites, run from `app/`.

```sh
npm --prefix app test          # pure logic, node --test
npm --prefix app run build     # required before the browser suites
npm --prefix app run test:render
npm --prefix app run test:gate # the gate, release and read-state browser suites
```

`test:render` is `test:pages` (the routes of `dist`, sign-in and the consumer
lab), then `test:finance` (the wallet flows: setup, New position, Automate,
positions and their actions). Either runs alone. The browser suites also load
`.test-build`, which `npm test` leaves behind; `npm --prefix app run
build:unit` compiles it without running the tests.

`npm test` compiles the pure modules to `.test-build` and runs
`tests/domain.test.mjs`, the same pattern as `web/scripts/test.mjs`. It covers
the range geometry, the relative scenario the explanatory sections draw (every
figure a multiple of the start price or a share of the starting value), the
market model's states, and the gas and available-fee boundaries of
`previewCompound`. The engines are imported from `web/lib`, never copied, so a
change there shows up here.

`npm test` also runs `tests/read.test.mjs`, the read adapter against every
fixture in `api-contracts/read-v1` with the package's own runtime, the compiled
beta gate and the unmodified bridge Worker, including the read budget below;
`tests/contract-pin.test.mjs`, which recomputes the SHA-256 of every pinned
producer manifest; `tests/build-guard.test.mjs`, the deploy guards in
`vite.config.ts`; `tests/forwarder.test.mjs`, the `/api` chain (see
[Deploy and closed beta](#deploy-and-closed-beta)); and
`tests/release.test.mjs`, the release script in a temporary directory.

`test:render` serves `dist` and drives it in a real browser. Beyond rendering
and errors, it exercises the behaviour a helper test cannot prove: a real
pointer drag on the simulator chart (a still pointer must hold a still price),
section links landing on their target across and within routes, the price
slider's value-to-thumb mapping, that no route shows a dollar figure, that
Connect wallet is disabled on every route and nothing is stored in the browser,
the honest positions screen, and the not-connected landing: one capabilities
GET, no POST and no figure. It scans every text file of `dist` for sample,
practice, fixture and test-only markers. It also asserts that exactly one
React instance rendered the page by counting fiber key suffixes in the DOM,
which holds in every environment rather than only when DevTools is present.
It exists because `tsc --noEmit && vite build` stayed green while the
deployed page rendered nothing: two copies of React ended up in the bundle and
the first hook threw. Compilation cannot see that; loading the built files
can. It fails on any uncaught error, `console.error` or failed request, and
checks that each route renders real content.

`test:gate` runs `tests/gate.browser.test.mjs` and
`tests/release.browser.test.mjs` against `dist` behind the compiled gate, then
`test:read` (see Read data). The release suite puts a stub where the /api
forwarder and bridge would be and walks every honest state of the deployable
landing with its exact wire cost. R-1's pacing runs in real time there, so it
is timing-sensitive: rerun it once if it flakes.

The browser is whatever Chromium build the machine already has — Chrome on the
CI runner, Edge on a Windows workstation — so no browser download is added to
the install. Set `DOMINO_BROWSER_PATH` to use a different binary.

On macOS, branded Chrome starts GoogleUpdater about 20 seconds after launch.
The updater and the crash handlers inherit the pipes playwright-core opened for
Chrome's output and can hold them for up to ten minutes after Chrome exits, and
`browser.close()` waits for them. So every suite closes its browser through
`tests/support/close-browser.mjs` and runs under `node --test
--test-force-exit`: a file ends a few seconds after its browser does, whatever
still holds those pipes. To keep the updater out of local runs altogether,
point `DOMINO_BROWSER_PATH` at a build that has none, such as Playwright's own
(`npx playwright-core install chromium` from `app/` puts it under
`~/Library/Caches/ms-playwright/chromium-*/`; the executable is inside the
`.app` there). Chrome for Testing 145 from that cache started no updater in 50
seconds, and its `close()` returned in 73 ms.

For a look rather than a check:

```sh
npm --prefix app run preview   # http://127.0.0.1:5274
```

## Deploy and closed beta

The site is a Cloudflare Pages project, `domino-app`, configured in
`wrangler.toml`. `functions/_middleware.ts` runs before every request the
deployment receives — pages, assets and `/api/*` — and nothing of the app is
served until the browser holds a valid access cookie. Because the gate is code
in every deployment, it covers `www.domino.money`, `domino-app-e65.pages.dev`
(Cloudflare appended `-e65` because the plain name was taken), `preview.domino-app-e65.pages.dev` and
every preview hostname the same way; there is no hostname around it.

It proves an invitation, nothing more. It is not wallet authentication, grants
no capability in the app, and never stands in for a session.

**Production answers on its own hosts only.** `wrangler.toml` sets
`CANONICAL_HOSTS_ONLY = "true"` for production and nothing for previews. A
production deployment then serves `domino.money`, redirects `www.domino.money`
to it, and answers every other host — `domino-app-e65.pages.dev`, its hash
URLs, anything else — with a JSON 404 `{"error":"not_found"}` before the gate
looks at anything, so none of them is an entrance. Previews keep the gate on
their own hosts. This covers deployments made from this change on; an older
deployment still answers on its hash URL until it is deleted in the dashboard.

**Two secrets, set by the project owner and never committed:**

```sh
npx wrangler pages secret put BETA_PASSWORD --project-name domino-app
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" | npx wrangler pages secret put BETA_COOKIE_KEY --project-name domino-app
```

The CLI in wrangler 4.130.0 sets **production** secrets only; it has no
per-environment flag. Set the same two names for preview in the dashboard:
Workers & Pages → `domino-app` → Settings → *Choose Environment: Preview* →
Variables and secrets, both with type **Secret** — never *Text*, which stores
the value in plain view — and a different random cookie key. The password must be
at least 16 characters. Without both secrets, or with either too weak or reused
as the other, every request gets 503 — including the login form. The deployment
is never open by misconfiguration.

**Set Fail closed in both environments.** Workers & Pages → `domino-app` →
Settings → Runtime → *Fail open/closed* → **Fail closed**, once with *Choose
Environment* on Production and once on Preview. The free plan runs Pages
Functions up to 100,000 requests a day. With *Fail open*, once that is exhausted
Cloudflare serves the static files without running this middleware — the whole
site, unguarded, and someone could exhaust the quota on purpose. *Fail closed*
returns an error instead.

**How it behaves:**

- A page navigation without access gets the access page with status 401. It
  ships no script, and its own CSP forbids `fetch()`.
- Any other request without access — an asset, a token image, an API call —
  gets 401 `{"error":"beta_access_required"}`. Nothing is served.
- `POST /__beta/login` accepts only a small same-origin form post and compares
  the password in constant time. It sets `__Host-domino-beta` with `Secure`,
  `HttpOnly`, `SameSite=Lax`, `Path=/` and seven days of life, signed with
  HMAC-SHA256 over its expiry and a digest of the current password.
- **Rotating `BETA_PASSWORD` signs everyone out** wherever the new secret
  applies, because every cookie was signed over the old password's digest.
  Pages keeps older deployments on their hash URLs, so after rotating and
  redeploying, delete the superseded deployments or check in a private window
  that the old password fails on every host that still answers.
- `POST /__beta/logout` clears the cookie.
- `www.domino.money` redirects to the apex.
- Authenticated pages and assets carry HSTS, `nosniff`, `X-Frame-Options:
  DENY`, `noindex`, private caching and a strict CSP: scripts, styles, images
  and connections from this origin only, plus the Google Fonts `index.html`
  loads. `/api` answers differ; see below.

**The `/api` chain.** rugged97 accepted this ingress on #45: Pages gate →
fixed API forwarder → private service binding.

```text
browser → functions/_middleware.ts        gate, host allowlist, headers
        → functions/api/[[path]].ts       every /api/* the gate admits, but
                                          a path with an empty segment,
                                          which the middleware hands to
                                          forward() itself
        → forward() in functions/_lib/bridge.ts
        → READ_BRIDGE | SESSION_BRIDGE | ONBOARDING_BRIDGE | DEPOSIT_BRIDGE
        → that family's Worker from bridge/src
```

- `/api/read/v1/`, `/api/session/v1/`, `/api/onboarding/v1/` and
  `/api/deposit/v1/` each go to one fixed binding. Any other `/api` path gets
  a JSON 404 `not_found`, never `index.html`. So does a path with an empty
  segment, such as `/api//x` or `/api/read/v1//capabilities`, even under a
  family's prefix: Pages' route for `functions/api/[[path]].ts` does not match
  it, so the middleware hands it to the forwarder itself, and no Worker is
  handed a path Pages would not have routed to the forwarder.
- The origin is checked first. Anything but `https://domino.money` gets 404
  `not_found`, so a preview or pages.dev host never reaches a binding, even
  one bound there by mistake.
- A request carrying `CF-Worker` is another Worker's subrequest, whose
  `CF-Connecting-IP` proves nothing, and gets 403 `worker_subrequest_refused`.
  That is defense in depth only: the owner's WAF rule on
  `cf.worker.upstream_zone`, scoped to this entrance, is the primary control.
- A missing or wrong binding, or one that throws, gives 503
  `bridge_unavailable`. No refusal carries an `X-Domino-*-Contract` header, so
  from outside a refusal can always be told from a Worker's answer.
- The Worker gets the original URL, method and body, with headers rebuilt
  from an allowlist: `Content-Type`, `Content-Length`, `Origin`, `Host`,
  `Sec-Fetch-*`, its own `X-Domino-<svc>-Contract`, `X-Domino-CSRF` (session,
  onboarding and deposit) and `CF-Connecting-IP` as the edge wrote it. Session
  gets the `__Host-domino-preauth` and `__Host-domino-session` cookies,
  onboarding and deposit only `__Host-domino-session`, read none: the gate has
  already taken every cookie off a public read (see
  [Credentials on reads](#read-data)), and `forward()` would give the read
  family none anyway. Duplicates arrive as sent, so the Worker still refuses
  them. The beta cookie, `Authorization`, `X-Forwarded-*`, `CF-Access-*`,
  every other `X-Domino-*` header, `Content-Encoding` and `Transfer-Encoding`
  never leave.
- A body sent with `Content-Encoding` (no browser's `fetch()` sends one, a
  script can) reaches the Worker without that header, as the bytes that were
  sent. An enabled Worker's strict UTF-8 and JSON parsing then refuses
  compressed bytes as `invalid_request`: 400 in session-v1, onboarding-v1 and
  deposit-v1, 422 in read-v1, whose status map says so (review note F1V-C1).
  Sent to a Worker directly, the header itself would be refused as 415
  `json_required`; through the forwarder it never arrives. A disabled Worker
  answers `route_not_available` before it reads a body.
- Every `/api` answer past the gate leaves with `Cache-Control: no-store,
  no-transform` and `Content-Security-Policy: default-src 'none';
  frame-ancestors 'none'`. The gate's own 401 is unchanged.
- **Production is bound; previews are not.** `wrangler.toml` binds
  `READ_BRIDGE`, `SESSION_BRIDGE`, `ONBOARDING_BRIDGE` and `DEPOSIT_BRIDGE`
  to the Workers `domino-read-bridge`, `domino-session-bridge`,
  `domino-onboarding-bridge` and `domino-deposit-bridge`, as
  `[[env.production.services]]` only. The owner deployed those Workers
  first, with every flag `"false"`. Once this config is deployed, an admitted
  API call on `domino.money` reaches its family's disabled Worker:
  `GET /api/read/v1/capabilities` answers 200 with `dataMode: "disabled"`,
  and every other route answers 404 `route_not_available`, each with the
  Worker's `X-Domino-<svc>-Contract` header. Nothing is enabled by the
  bindings, and no Worker calls anything upstream. There is no
  `[env.preview]` and no top-level `services`, so a preview has no binding:
  every `/api` call there gets 404 `not_found` from the origin check, with no
  contract header. Deposit stays deferred: its Worker and binding are
  deployed disabled with no secrets, and it gets no Access application or
  Tunnel mapping until its own gates pass.

`tests/forwarder.test.mjs` drives this chain request by request, with
recording bindings and with the real bridge Workers under their reviewed
disabled vars. `globalThis.fetch` is a tripwire before the Workers load, so
any upstream call fails the suite. Its stand-in for Pages routes `/api` with
the matcher wrangler 4.130.0 uses, and a test fails if the deploy scripts
move off that version (both run `scripts/release.mjs`, whose `WRANGLER`
constant and deploy command it checks), so the routing is re-checked first. It also checks
that `wrangler.toml` can give vars and bindings to production only, and reads
the file with wrangler 4.130.0's own config reader (web's pinned copy,
offline): production must bind exactly the seven names `forward()` looks up,
each to its own Worker, and preview none. With those bindings and the real
disabled Workers, every family gets its disabled answer and a preview host
its 404, with no upstream call. It runs
the gate's public-read step and the forwarder together: a signed-in read
reaches `READ_BRIDGE` with no Cookie header, having already lost it at the
gate, an empty segment still gets the JSON 404, and the other families keep
only their named cookies. For F1V-C1 it builds enabled Workers in memory,
with placeholder credentials and the tripwire as their transport, and shows
a compressed body refused as `invalid_request` before any upstream call.

**Deploying.** One build, recorded, then deployed twice without a rebuild:
first to the gated preview, then, unchanged, to production. After
`npx wrangler login` in your own terminal:

```sh
npm run release:build    # build, refuse any forbidden marker, record the digest
npm run release:verify   # optional: dist still matches the record
npm run deploy:preview   # verify, then upload that dist as a preview
npm run deploy           # verify, then upload the same dist as production
```

Deploy production from the same checkout that deployed the preview. The
release record, `.release/manifest.json` and `.release/deployed.json`, is
written in that checkout and ignored by git, so no other clone, worktree or
machine has it, and `npm run deploy` there refuses for want of a preview
deploy it never saw. In a new checkout, run `npm run release:build` and
`npm run deploy:preview` there first, check the preview, then `npm run
deploy`.

**Automatic preview.** CI also builds, records and deploys the gated preview
after all four checks pass on a push to `main`. Pull requests and manual CI
runs never deploy. A running main workflow finishes, including its upload;
GitHub keeps only the newest pending main run, so rapid pushes may skip an
intermediate commit. This follows the latest pending version rather than
promising a deployment for every merge. New PR revisions still cancel their
obsolete checks, and manual runs cannot replace pending main push runs.

In repository Settings → Secrets and variables → Actions, configure
`CLOUDFLARE_API_TOKEN` under **Secrets** and `CLOUDFLARE_ACCOUNT_ID` under
**Variables**. Only the deployment and missing-configuration steps receive
them. If either is absent, the build is recorded, the upload is skipped, and
a notice identifies the missing setting. The Pages beta secrets and Fail
closed settings described above still apply. CI's local release record is
discarded with its runner; it does not authorize a production deploy from
another checkout.

`scripts/release.mjs record` hashes every file of `dist`, `functions/` and
`wrangler.toml` (SHA-256 over sorted relative paths) into one digest and
writes `.release/manifest.json`, and refuses a `dist` that carries any marker
from `scripts/deploy-markers.mjs`. It also refuses a checkout with uncommitted
changes (changed tracked files anywhere in the repository, or untracked files
under `app/` that git does not ignore): commit first, then build, so the
commit it records, which both deploys pass as `--commit-hash`, names the bytes
that were built. Both deploys verify the digest first, then
run `npx --yes wrangler@4.130.0 pages deploy ./dist` with no build step,
tagged with the recorded commit. Production is refused unless
`.release/deployed.json` shows the same digest deployed to preview. wrangler
compiles `functions/` at upload, which is why their sources are in the
digest. The upload fetches the pinned wrangler through `npx`, including in
the preview CI job. wrangler takes the project from `wrangler.toml`'s `name`: the
Pages project is `domino-app`, and `domino-app-e65.pages.dev` is only its
hostname (Cloudflare appended `-e65` there because the plain name was taken).
Leave `name` as it is: wrangler 4.130.0 would find no project under any other
name, offer to create one, and leave domino.money as it was.

**After every Pages deploy, check the bindings (step C11).** In the
dashboard, Workers & Pages → `domino-app` → Settings → Bindings:

- *Choose Environment* on **Production**: exactly seven, each a Service
  binding: `READ_BRIDGE` → `domino-read-bridge`, `SESSION_BRIDGE` →
  `domino-session-bridge`, `ONBOARDING_BRIDGE` → `domino-onboarding-bridge`,
  `DEPOSIT_BRIDGE` → `domino-deposit-bridge`, `PERFORMANCE_BRIDGE` →
  `domino-performance-bridge`, `EXECUTION_BRIDGE` → `domino-execution-bridge`
  and `SETUP_BRIDGE` → `domino-setup-bridge`.
- *Choose Environment* on **Preview**: none.

Repeat both after every deploy, preview deploys included. Signed in on
`domino.money`, `/api/read/v1/capabilities` then shows `dataMode: "disabled"`
with an `X-Domino-Read-Contract` header. To roll back, delete the seven
`[[env.production.services]]` tables and release again (`npm run
release:build`, `npm run deploy:preview`, `npm run deploy`: `wrangler.toml` is
part of the recorded digest, so the old record no longer verifies): production
API calls then answer 503 `bridge_unavailable` and call nothing.

**Looking at it locally.** `scripts/gated-server.mjs` serves `dist` through the
compiled middleware with `node:http`, which is how the browser tests run it:

```sh
npm test && npm run build
BETA_PASSWORD=local-preview-password BETA_COOKIE_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") npm run serve:gated
```

**Tests.** `tests/gate.test.mjs` drives the middleware one request at a time,
and every refusal also asserts that nothing was served. `tests/gate.browser.test.mjs`
opens the built site through the real middleware in a browser: no password
shows only the access page and every built file answers 401; the right
password opens the whole app with no CSP violation; signing out closes it; a
cookie stops working when the password rotates. Removing the cookie check fails
7 unit and all 8 browser tests; letting a wrong password through fails the unit
suite.

## Read data

`src/lib/read/` is the typed adapter for rugged97's read contract
(`api-contracts/read-v1`, pinned in `src/lib/read/pin.ts` with the producer
commit and each package's manifest SHA-256). The pin is producer commit
`b50f80e5f5f6eacc07645d9856ab649047161aae`, the squash of #77 on main; with
#75 (listener provenance in all four manifests) it is one combined release,
and no contract version changed. One interface, `ReadSource`,
covers all nine routes and has two implementations: the package fixtures, and
the same-origin bridge at `/api/read/v1/*`. Both hand their replies to one
pipeline, which recognises the beta gate's 401 and 503 first, then the site's
own /api layer (the /api forwarder's refusals from #80, or the index page a
deployment without an /api function serves), then requires the exact
`X-Domino-Read-Contract` header, then validates with the package runtime
(`assertResponse`, `validateError`) and checks the answer is about the pool,
token or block that was asked for. Anything that fails is a state of its own
(`gate_required`, `not_connected`, `incompatible`, `invalid`, `unavailable`,
…) and nothing of it is rendered. Only a validated 429 `read_capacity_busy` is asked again on
its own (R-1 on #1): three attempts at most, each after the bridge's
Retry-After plus up to 250 ms, and only while the read's budget covers the
wait. A transient 503/504 is shown as itself, with a Retry for the person.
A read has 60 s from the moment it is queued, which cover the queue, the
capabilities check, every attempt and wait, and one cursor or revision
restart; each attempt, fetch and body, has 20 s of them at most. At either
deadline the attempt is cancelled, and an answer that arrives anyway is
discarded; past its deadline a read sends nothing more, not even the
capabilities check. These deadlines, the Retry-After waits and the pacing
between reads are measured on the browser's monotonic clock
(`performance.now()`), so a change to the system time, an NTP step or a
resume from sleep neither cuts a read short nor lets a late answer in; only
the time a reply was received is stamped with the wall clock.

An identical read, the same route and body asked for again on one screen,
joins the read already queued or in flight instead of being sent again, and
is held to that read's deadline, its first reader's, rather than to 60 s
from its own enqueue. The first reader was queued no later, so that
deadline is never more than 60 s after the joiner was queued, and R-1's
bound holds for every reader: a joiner may be answered `read_deadline`
before its own 60 s are up, never after them. Each reader also stops at its
own abort or deadline, whichever comes first, without cancelling the read
for the others; the last one to leave cancels it.

Components read through `MarketsProvider`, not a source. **The deployable
build reads live.** Production and development read the reviewed pool
selection in `src/config/selectedPools.ts` through the same-origin bridge at
`/api/read/v1/*`: the two chain-4663 pool ids rugged97 selected on #45 as
candidates for fresh pool-market validation. The list holds ids only; pair
names and figures come from validated reads, and its order is not a ranking.
The ticker and the Selected pools table share one provider and one result
set. There are no sample rows anywhere.

**The featured pools list** (read-v5, `src/lib/read/featuredList.ts`, added
2026-09-26). Before the markets, the deployable build asks the daily list once,
`POST /api/read/v5/featured-pools` with `{}`, first in the queue and for 1.5 s
at most, with no capabilities GET. The edge answers it, so it spends none of
the tab's gateway budget. A current or repaired list the contract's runtime and
the app's own checks accept (no hooks, a fixed fee, no token that reads as ETH,
WETH or USDG on another contract, no symbol with the text of a web address,
nothing in `FEATURED_DENY`) becomes the rows, under "Top pools · last 24h" with
its method line (always "Ranked daily at 12:00 UTC") and a Pinned chip; a carried-over, manual or stale one (within 72 h, by the server's
clock) keeps the neutral "Selected pools". Anything else (`none`,
`route_not_available`, an error, an invalid answer, the 1.5 s passing) keeps
the embedded list above, exactly as before the list existed. Every 60 s the
list is read again: the same list changes nothing, pools that left it leave at
once, `none` switches back to the embedded list at once, and new pools or a new
order wait for a reload. `src/lib/read/featuredSource.ts` is the one place
screens take the list from; the main tokens are frozen in
`src/config/mainTokens.ts`, so no list can re-point USDG.

**Read budget.** The read capabilities are asked first, with no POST and no
place in the queue, and they decide which routes a load uses
(`src/lib/read/marketsProvider.ts`). With only the lean routes listed, a load
is one `pool-market` read per selected pool with `includePriceHistory: false`
sent explicitly, each followed by the token reads its row still needs (a token
shared by rows is read once), strictly one read at a time: N + U POSTs for N
pools and U distinct tokens. Each row is on screen as soon as its market read
answers, named from the catalogue's labels, and its price waits quietly until
its token reads land. When `markets-snapshot` is listed, one snapshot read puts
every stored entry on screen first, and only the pools it could not answer for
well enough (absent, stale or unavailable) are read through `pool-market`. When
`pool-metrics` is listed, each row reads it after its market and tokens, and its
qualified figures take precedence; a refused pool-metrics or token read stays on
its row, and so does one pool's market payload refused by a hop (502
`upstream_contract_mismatch`). Apart from token metadata that read as available,
kept in memory for the page, every load reads again, and the bridge's own
bounded observation cache keeps its original ages. The APR column shows
Domino's qualified APR where pool-metrics gives one, otherwise the read
service's estimate, and "Unavailable", never 0, when there is neither. An empty
selection reads nothing and says "No pools selected yet".

The shared scheduler (`src/lib/read/scheduler.ts`) keeps the tab inside the
gateway's per-client budget (a burst of 5, then 30 reads a minute, counting every
attempt), starts provider-lane reads at least 1.1 s apart (read-v3's stored
reads skip that spacing, which the gateway's stored lane does not have), starts
the markets table's reads before any queued card or page read, and holds the
whole queue for the service's Retry-After after any 429. When the stored
overview serves a pool without figures that are coming (figures the provider
gave before, no failed collection, and the next collection running or due
within 10 s), the table asks again just after that collection and the row
waits for them instead of saying "Unavailable"; it says "Unavailable" at once
otherwise, and after a collection that brought none or 25 s of waiting. A load
whose last viewer leaves keeps running for 2 s, so going from Home to Markets
joins it. A refresh never shortens
the table: a pool whose read fails keeps its last good row, stale and dated.
What a busy service refused (one pool's market, one token, one pool-metrics
read), and rows whose provider figures were rate limited, are asked again on
their own: only those reads, a few times per visit, only while the page is
visible, with jitter.

**Honest states** are decided in the shared read layer (`interpret.ts`,
`describe.ts`), never per screen, and nothing ever stands in for a failed read:

| Reply | Shown | Retry |
|---|---|---|
| Gate 401 | Access expired, with Sign in again | no |
| /api forwarder 503 `bridge_unavailable`, or no /api at all (the site's index page) | Live data unavailable | no |
| /api forwarder 404 `not_found` (a preview or any other host) | Live data isn't available here | no |
| Capabilities `dataMode: "disabled"`, no enabled read, or 404 `route_not_available` | Live data is switched off for now | no |
| 429 `read_capacity_busy` | asked again under R-1, then Read service busy | yes |
| Producer 503 or 504, transient | Temporarily unavailable | yes, for a person |
| A read deadline | Pool data unavailable, naming the limit | yes |

The forwarder's refusals are recognised by their exact bytes and status, and
only without the contract header; anything else without the header is still a
contract mismatch or an edge page. The Retry column describes the read lab,
which keeps its Retry buttons. The product screens show none of these states
as a panel or a button: the state sits in titles, data attributes and an
sr-only live region, and only busy and transient answers are asked again on
their own, bounded, while the page is visible (`src/lib/read/screens/transient.ts`).

**Build modes.** Only `--mode` chooses where data comes from; no environment
variable does.

| Command | Data | Output |
|---|---|---|
| `npm run build`, `npm run dev` | Deployable: live reads of the selected pools through the bridge. The dev server has no /api, so it shows "Live data unavailable" | `dist` |
| `npm run dev:fixtures`, `npm run build:fixtures` | Package fixtures through the real pipeline, plus the read lab at `/read-lab.html` | `.fixture-dist` |
| `npm run build:bridge-test` | The bridge source for the package fixture pool, for a local stub only | `.bridge-dist` |

`vite.config.ts` refuses to write anything but a deployable build into `dist`,
which is what Pages deploys, or anywhere inside it, however the path is spelled
(`DIST` on a case-insensitive disk, `dist/lab`, `dist/..lab`, an absolute path,
a link). It checks every deployable mode on every build (bridge reads, the
selected pools, no lab, every other flag off), and its
`domino:deployable-bundle-check` plugin fails a deployable build that carries
any marker from `scripts/deploy-markers.mjs`: sample or practice wording, the
example token, fixture labels, files and ids, the read lab or test hooks.
`tests/build-guard.test.mjs` resolves the real config with each spelling and
exercises both checks, and `tests/render.test.mjs` scans the built `dist`.
`npm run test:read` (part of `test:gate`) builds both test modes and drives
them behind the real gate: `tests/read-states.browser.test.mjs` renders every
fixture case with the real Selected pools table, ticker and family panels;
`tests/read-bridge.browser.test.mjs` reads through `bridge/src/worker.mjs` in
front of package fixtures.

**Still off in the deployed build:** signing, wallet funding, swaps, sessions,
previews and deposits. Connect wallet stays disabled. Whether live reads are
on is the server's answer, not the build's.

**Credentials on reads.** Reads use `credentials: 'same-origin'` so the beta
cookie reaches the gate. The app adds no credential of its own (no
Authorization, CSRF or session header, no SIWE), but the browser also attaches
every same-origin cookie whose Path covers `/api/read/v1/`. session-v1 sets its
session and preauth cookies with `Path=/`, which their `__Host-` prefix
requires, so once #14 creates a session the browser sends them to this origin
with public reads too. They stop at the gate: `functions/_middleware.ts` checks
the beta cookie and then passes every `/api/read/*` request on with no Cookie
header at all, so neither the read bridge nor anything behind it ever sees a
session credential. `forward()` in `functions/_lib/bridge.ts` is a second
layer: it gives the read family no Cookie header even if one arrived.
`tests/gate.test.mjs` checks the gate in node, `tests/forwarder.test.mjs`
checks the gate and the forwarder together, and
`tests/read-bridge.browser.test.mjs` plants both cookies in Chromium and checks
what the browser sends, what passes the gate and what reaches the gateway.

**Backend reconciliation.** Issue #1 asks for the adapter's types to be agreed
against `backend/openapi-read.json` and the Python response fixtures.
`tests/backend-contract.test.mjs` does that on every run. It pins the OpenAPI
document by digest (`BACKEND_OPENAPI_PIN` in `src/lib/read/pin.ts`), and
checks that its nine POST read routes are read-v1's. It compares every
request and response schema with read-v1 field by field. It drives
`fixtures/request-boundaries.json` (the Python request models' own boundary
corpus) through the adapter's request check and the real bridge Worker, and
every Python-produced response in `fixtures/producer/` through the adapter.
Each difference found is recorded, with what the adapter does about it, in
`tests/backend-contract.ledger.mjs`; the test fails on an unrecorded difference
and on a recorded one that has gone. Seven differences are recorded. Three
were raised with rugged97 and are decided on issue #1. The OpenAPI `tokenIds`
item now carries the uint256 bound (#74) and the array `uniqueItems` (#77);
its pattern is read-v1's followed by `(?![\s\S])`, an end assertion that the
read-v1 runtime's full-match rule makes equivalent, and the test checks that
relation exactly. The private capabilities response stays untyped, and the
bridge keeps the closed read-v1 shape. The bridge's 8192-byte request limit,
which answers 413 to a 4096-character cursor of four-byte characters the
Python model accepts, is intentional. Four more differences are by design:
404/405 are bridge-only, the contract header and the `/api/read/v1/` paths
belong to the bridge, and the bridge seals the wallet-assets cursor. In every
case the browser path (read-v1 and the bridge) is the stricter or an
equivalent side, and the adapter follows it.

## Routes

### Onboarding and deposit consumer tests (#124)

`npm run build:consumer-test` builds the recovered onboarding preview and
deposit lab into `.consumer-test-dist`. Run `npm run test:consumer` after the
production build to check their lazy chunks and browser behavior. This suite
also runs through `npm run check:app`.

In this test build, `#/live-preview` uses the session port and the separate
`onboarding-v1` client; its initial currencies, pool and amounts are synthetic
test inputs. `#/deposits` uses only the fixture transport and a disabled wallet
handoff. These screens are integration test surfaces, not a customer funding
flow. The production and development builds define both consumer flags as
false and emit neither screen nor its consumer fixtures.

The existing deployed read path remains shared through `appBridgeSource()`.
Public token/pool selection still needs a separate connection to a customer
onboarding flow; merging these test screens does not provide that connection.
Worker activation, real deposit transport and wallet sending are separate work.

`npm run check:producer-fixtures` optionally checks the derived fixtures against
the Python producer models; it requires the backend Python dependencies and is
not part of the frontend CI job.

| Route | Screen |
|---|---|
| `#/` | Home: pool ticker, hero, feature cards, Selected pools, how it works, range simulator, what Domino does not do |
| `#/markets`, `#/markets/<token>` | Markets: hourly volume cards for the selected pools, asset and pair filters, Selected pools, and the pool catalogue search. Older links `#/explore` and `#/pools` open it too |
| `#/pool/<id>`, `#/pool/<id>/<token>` | One pool, verified at the latest block: its figures, chart, range planner, and its activity and positions where the capabilities list them |
| `#/positions` | Positions: managed positions, receipts, position NFTs looked up by ID, the Wallet card and automation. Older links `#/app` and `#/portfolio` open it too; `#/portfolio/<address>` shows a public address |
| `#/new`, `#/new/<pool id>` | New position: pool, range, amount, automation and review, then Setup |
| `#/automate` | Auto-compound and Domino-compound, with the ways into Setup and the sequence screen |
| `#/setup`, `#/sequence` | The owner's wallet screens: create or recover a position, and create or manage a sequence |
| `#/docs`, `#/docs/<slug>` | The documentation |
| `#/settings` | Build facts, capabilities |

### Read-only pool exploration

The **Pools** navigation, **Explore pools** link on Positions and footer entry
open `#/pools`, including on a small screen. Two token selectors are visible
immediately. Each opens a bounded token dialog: paste a Robinhood Chain
contract address or list candidates from a public address. Applying the first
token loads existing pools directly below the selectors; a second token
optionally narrows the results. Select a pool and use **Explore range** for
the second, non-executable step. Pool identity and extended provenance sit in
expandable details; provider attribution and unavailable/stale states remain
visible. The stored catalogue expands under **More sources** and loads only
on request. The page reuses `TokenPicker`, `PoolPicker`, `PoolRangeControls`
and the app's single scheduled source. Opening the route or token dialog sends
no read; submitting a lookup or applying a changed token initiates the read.

Back, Escape and the backdrop close the current dialog and restore focus to
its trigger. Closing a token dialog cancels its component-owned reads without
applying an unconfirmed choice. Confirmed selections live only on the page;
changing a token clears the prior pool/range, and changing the first token
also clears the second. Leaving the route discards all selections and cancels
remaining component reads. No selection is stored or passed to a quote,
deposit or wallet action.
Native ETH and wrapped ERC-20 identities stay distinct. Provider figures keep
their source/coverage; missing APR stays unavailable, and an empty configured
catalogue is not presented as proof that no pool exists. New-pool creation is
described as a separate future path, never enabled here.

The normal route is covered by the existing built-app render suite and the
gated real-bridge/fixture consumer suite (`read-screens.bridge.test.mjs`).
Those offline fixtures are test inputs only, never deployment data. Actual
authenticated edge acceptance is recorded separately in the issue after a
reviewed release; preview origins intentionally cannot call the read bridge.

## Domain logic belongs to `web/lib`

The range maths is rugged97's. This app **imports** it and never copies it:

```ts
import { previewPosition } from 'core/position'
```

`core/*` is an alias to `../web/lib/*`, declared in `tsconfig.json` and
`vite.config.ts` (which also opens `server.fs.allow` for the parent directory).
A fix in `web/lib` reaches this app with no action here. The explanatory
sections run it on a position of no particular size (`src/lib/scenario.ts`)
and show only ratios: multiples of the start price and shares of the starting
value.

The app has one palette, the dark one (`src/styles/tokens.css`), and keeps
nothing in the browser for it. There is no practice workspace and no
`domino-practice-v1` storage.

## Toolchain

Vite 7 + React 19 + TypeScript + Tailwind 4, with oxlint using the same rule
set as `web/`.

This is a new directory rather than a change to `web/`, so nothing was
migrated: `web/` keeps vinext, Cloudflare and the Sites publishing path, and its
preview stays available throughout. Vite was chosen here because the Sites
toolchain is not needed for a directory that does not publish through it, and
its beta plugins add moving parts to a build that only has to produce static
assets.

### Role and integration

`app/` is the product frontend that will be served to customers. `web/` remains
the practice workbench and the owner of the domain modules. Both exist until
`app/` reaches parity and a hosting decision is made.

The browser cannot reach the Python read service directly: it returns 403
`local_client_required` for any request carrying an `Origin` header. Data will
therefore arrive through the bridge Worker, reached on this app's own origin
at `/api/read/v1/*` through the Pages forwarder and a private service binding
(see [the `/api` chain](#deploy-and-closed-beta)); the Worker has no route of
its own. It emits no CORS headers and requires `url.origin === APP_ORIGIN`, so
a deployed worker cannot be called from a dev server on another port. The
deployable build reads through that bridge; until a deployment connects it,
the site says live data is unavailable and shows no figure.

Hosting is Cloudflare Pages at `https://domino.money`; see
[Deploy and closed beta](#deploy-and-closed-beta). The decision is recorded in
`TECH_STACK.md` and `FRONTEND_HANDOFF.md`.

Two rules from `web/`'s oxlint config are off here, both because they target a
Next.js app: `next/no-img-element` (the whole `nextjs` plugin) and
`jsx-a11y/prefer-tag-over-role` (custom radio and dialog widgets use valid ARIA
roles on non-semantic elements by design).

## Data honesty

No wallet, no transaction, no signing and no invented figure. The only market
data on screen comes from validated live reads, named with its provider and
age. The explanatory sections draw the product's own maths in relative terms
and say what is not available in the alpha.

Each Selected pools row follows #93's display rules. It names the block its
pool was verified at, and its pair comes from the token reads of the pool's
own currency addresses, never from the provider's base/quote. TVL and 24h
volume are "Reported by GeckoTerminal" and dated only by when they were
retrieved ("retrieved 12 s ago": the read service's cache age, counted on
from its answer), never "as of" or "updated at", because the provider's own
update time is not known. A stale observation, or one on screen past the read
service's 60 s fresh window, is marked stale in the cell; a rejected or
unavailable one keeps the verified row with its figures unavailable and the
reason; a null figure is "Not reported", never $0. `sourceUrl` is never read.
A failure on one pool (a 504, a 429 that outlasts R-1) drops only that pool,
named in the status line, and leaves the other row.

`src/lib/markets.ts` holds the figures behind the pool ticker and the Selected
pools table and the one rule for showing them. Each figure carries a state:
`qualified` (pool-metrics `usableAsCurrent24h`, the only current 24h/APR
figure), `provider` (named, unreconciled), `stale` (a figure that was current,
with its original time; stale pool metrics count only when they would be
`usableAsCurrent24h` if the snapshot were fresh, and are otherwise `partial`),
`partial` and `reference` (never current, never a cell value), `absent`,
`unavailable` or `rejected`. There is no sample or placeholder state. The
table reads pool-metrics only where the capabilities list it; a row without it
has its APR `unavailable` with the reason `fee_apr_not_provided`, and its Est.
APR cell shows the read service's estimate instead. Token symbols from reads
are untrusted text: `TokenLabel` renders them isolated in `<bdi>` and never as
an attribute, URL or artwork key.

The service fee appears nowhere in the alpha: nothing can be created or
compounded.

Token artwork lives in `public/tokens/` and is served from this app, never
from a third-party host. A read token gets artwork only through its address
(`ARTWORK_BY_ADDRESS` in `src/lib/read/project.ts`), never through its
symbol, and shows a plain disc without one.

## What is not here yet

Wallet connection, SIWE sessions, position lookup, qualified USD prices and a
current APR, and anything that signs. Each has its own gate in the
repository's specifications.
