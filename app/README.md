# Domino app

The product frontend. English UI, Robinhood Chain only, built on the approved
Tangerine palette with new structure, screens and components.

`web/` is untouched by this directory and keeps working exactly as before.

## Run it

Both directories must be installed. This app imports domain modules from
`web/lib`, and TypeScript needs `web/` present to resolve them.

```sh
npm --prefix web ci
npm --prefix app ci
npm --prefix app run dev       # http://localhost:5273
```

Checks, the same ones CI runs, in the same order:

```sh
npm run check:app   # domain and gate tests, typecheck, lint, build, browser tests
```

## Tests

Two suites, run from `app/`.

```sh
npm --prefix app test          # pure logic, node --test
npm --prefix app run build     # required before the next one
npm --prefix app run test:render
```

`npm test` compiles the pure modules to `.test-build` and runs
`tests/domain.test.mjs`, the same pattern as `web/scripts/test.mjs`. It covers
the range geometry, the money-display rules, the market adapter's placeholder
states, and the gas and available-fee boundaries of `previewCompound`. The
engine is imported from `web/lib`, never copied, so a change there shows up
here.

`npm test` also runs `tests/read.test.mjs`, the read adapter against every
fixture in `api-contracts/read-v1` with the package's own runtime, the compiled
beta gate and the unmodified bridge Worker, and `tests/contract-pin.test.mjs`,
which recomputes the SHA-256 of every pinned producer manifest.

`test:render` serves `dist` and drives it in a real browser. Beyond rendering
and errors, it exercises the behaviour a helper test cannot prove: a real
pointer drag on a range edge (a still pointer must hold a still bound), input
preservation across back-navigation, the action footer staying outside the
scrolling body at a short viewport, receipt tab switching and the exact-amounts
toggle, section links landing on their target across and within routes, the
price slider's value-to-thumb mapping, both dialogs' focus containment and
accessible names, that every displayed token has real artwork, and that
placeholder figures never appear without their sample label. It also asserts
that exactly one React instance rendered the page by counting fiber key
suffixes in the DOM, which holds in every environment rather than only when
DevTools is present. It exists because
`tsc --noEmit && vite build` stayed green while the deployed page rendered
nothing: two copies of React ended up in the bundle and the first hook threw.
Compilation cannot see that; loading the built files can. It fails on any
uncaught error, `console.error` or failed request, checks that each route
renders real content, and walks the whole create-and-compound flow including
both dialogs' focus containment and accessible names.

The browser is whatever Chromium build the machine already has — Chrome on the
CI runner, Edge on a Windows workstation — so no browser download is added to
the install. Set `DOMINO_BROWSER_PATH` to use a different binary.

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
- **Rotating `BETA_PASSWORD` signs everyone out at once**, because every cookie
  was signed over the old password's digest. Use it to revoke access.
- `POST /__beta/logout` clears the cookie.
- `www.domino.money` redirects to the apex.
- Authenticated responses carry HSTS, `nosniff`, `X-Frame-Options: DENY`,
  `noindex`, private caching and a strict CSP: scripts, styles, images and
  connections from this origin only, plus the Google Fonts `index.html` loads.

**Deploying**, after `npx wrangler login` in your own terminal:

```sh
npm run deploy:preview   # build, then upload to a preview hostname
npm run deploy           # build, then upload as production
```

Both pin wrangler 4.130.0 through `npx` rather than a dependency, so CI never
downloads it.

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
pipeline, which recognises the beta gate's 401 and 503 first, then requires
the exact `X-Domino-Read-Contract` header, then validates with the package
runtime (`assertResponse`, `validateError`) and checks the answer is about the
pool, token or block that was asked for. Anything that fails is a state of its
own (`gate_required`, `incompatible`, `invalid`, `unavailable`, …) and nothing
of it is rendered. Only a validated 429 `read_capacity_busy` is asked again on
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

Components read through `MarketsProvider`, not a source. The default build
uses the curated sample rows, exactly as before; they are not dressed up as
contract payloads, which would mean inventing provider provenance. Previews
and production still deploy that default sample build, and will until the
live-data PR.

**Build modes.** Only `--mode` chooses where data comes from; no environment
variable does.

| Command | Data | Output |
|---|---|---|
| `npm run build`, `npm run dev` | Labelled sample rows, no read code in the bundle | `dist` |
| `npm run dev:fixtures`, `npm run build:fixtures` | Package fixtures through the real pipeline, plus the read lab at `/read-lab.html` | `.fixture-dist` |
| `npm run build:bridge-test` | The bridge source, for a local stub only | `.bridge-dist` |

`vite.config.ts` refuses to write a fixture or bridge build into `dist`, which
is what Pages deploys, or anywhere inside it, however the path is spelled
(`DIST` on a case-insensitive disk, `dist/lab`, `dist/..lab`, an absolute path,
a link).
`tests/build-guard.test.mjs` resolves the real config with each spelling, and
 `tests/render.test.mjs` checks that `dist` makes no
read request and contains no read code. `npm run test:read` (part of
`test:gate`) builds both read modes and drives them behind the real gate:
`tests/read-states.browser.test.mjs` renders every fixture case with the real
Top pools table, ticker and family panels; `tests/read-bridge.browser.test.mjs`
reads through `bridge/src/worker.mjs` in front of package fixtures.

**Still off in the deployed build:** live data, the bridge source, signing,
wallet funding, swaps, sessions, previews and deposits. Connect wallet stays
disabled. Turning live data on needs the consumer acknowledgement on #1 and a
staging exercise first.

**Credentials on reads.** Reads use `credentials: 'same-origin'` so the beta
cookie reaches the gate. The app adds no credential of its own (no
Authorization, CSRF or session header, no SIWE), but the browser also attaches
every same-origin cookie whose Path covers `/api/read/v1/`. session-v1 sets its
session and preauth cookies with `Path=/`, which their `__Host-` prefix
requires, so once #14 creates a session the browser sends them to this origin
with public reads too. They stop at the gate: `functions/_middleware.ts` checks
the beta cookie and then passes every `/api/read/*` request on with no Cookie
header at all, so neither the read bridge nor anything behind it ever sees a
session credential. `tests/gate.test.mjs` checks that in node, and
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

| Route | Screen |
|---|---|
| `#/` | Landing: pool ticker, hero widget, top pools, product cards, range simulator, Domino sequence, how it works, limits |
| `#/app` | Positions workspace: practice cards, activity feed, receipts |
| `#/settings` | Appearance, capability table, build facts, practice data summary |

## Domain logic belongs to `web/lib`

The money maths, the range maths and the practice workspace are rugged97's.
This app **imports** them and never copies them:

```ts
import { previewPosition, usd, qty } from 'core/position'
import { previewCompound, pendingFeesExplanation } from 'core/compound'
import { addPracticePosition, runPracticeCompound, practiceFunding } from 'core/practice'
import { useLocalWorkspace } from 'core/local-workspace'
```

`core/*` is an alias to `../web/lib/*`, declared in `tsconfig.json` and
`vite.config.ts` (which also opens `server.fs.allow` for the parent directory).
A fix in `web/lib` reaches this app with no action here, and there is no second
copy of the accounting to drift.

Practice data uses the same `domino-practice-v1` storage key and the same
schema, and appearance uses `domino-appearance`.

**Those keys do not share records between the two apps.** `localStorage` is
scoped per origin, and the two dev servers listen on different ports, so
`localhost:5273` and `localhost:8877` hold separate stores. Sharing the key and
schema means a book written by either app is readable by the other if they are
ever served from one origin; it does not mean a card created here shows up in
the workbench today.

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
therefore arrive through the bridge worker, mounted on this app's own origin at
`/api/read/v1/*` — it emits no CORS headers and requires `url.origin ===
APP_ORIGIN`, so a deployed worker cannot be called from a dev server on another
port. Until that is enabled, `src/lib/markets.ts` serves labelled placeholder
rows and the workspace runs entirely on the practice modules.

Hosting is Cloudflare Pages at `https://domino.money`; see
[Deploy and closed beta](#deploy-and-closed-beta). The decision is recorded in
`TECH_STACK.md` and `FRONTEND_HANDOFF.md`.

Two rules from `web/`'s oxlint config are off here, both because they target a
Next.js app: `next/no-img-element` (the whole `nextjs` plugin) and
`jsx-a11y/prefer-tag-over-role` (custom radio and dialog widgets use valid ARIA
roles on non-semantic elements by design).

## Data honesty

No wallet, no chain read, no transaction, no signing. Every figure in the
practice workspace is simulated and labelled as such.

`src/lib/markets.ts` holds the figures behind the pool ticker and the Top
pools table and the one rule for showing them. Each figure carries a state:
`qualified` (pool-metrics `usableAsCurrent24h`, the only current 24h/APR
figure), `provider` (named, unreconciled), `stale` (a figure that was current,
with its original time; stale pool metrics count only when they would be
`usableAsCurrent24h` if the snapshot were fresh, and are otherwise `partial`),
`partial` and `reference` (never current, never a cell value), `absent`,
`unavailable`, `rejected`, or `placeholder`. Today it returns `placeholder`
rows for five pairs built from tokens that exist on the network. **Those rows
are labelled "Sample" wherever they appear and must stay labelled until the
adapter returns qualified data.** Token symbols from reads are untrusted text:
`TokenLabel` renders them isolated in `<bdi>` and never as an attribute, URL or
artwork key.

The service fee appears only where an owner would be asked to act: the Review
step of position creation, the fee-scenario review, and receipts. It is absent
from the landing page.

Token artwork lives in `public/tokens/<symbol>.svg` and is served from this
app, never from a third-party host. A symbol with no file falls back to a
coloured disc with its letters, so adding a logo is dropping in a file.

## What is not here yet

Wallet connection, SIWE sessions, live chain reads in the deployed build,
qualified USD prices, and anything that signs. The read adapter and its bridge
source exist but are off until the consumer acknowledgement and staging. Each has its
own gate in the repository's specifications.
