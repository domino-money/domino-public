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
npm run check:app   # domain tests, typecheck, lint, build, browser tests
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

Hosting for `app/` is not decided and remains a separate gate. `TECH_STACK.md`
and `FRONTEND_HANDOFF.md` are the place to record it.

Two rules from `web/`'s oxlint config are off here, both because they target a
Next.js app: `next/no-img-element` (the whole `nextjs` plugin) and
`jsx-a11y/prefer-tag-over-role` (custom radio and dialog widgets use valid ARIA
roles on non-semantic elements by design).

## Data honesty

No wallet, no chain read, no transaction, no signing. Every figure in the
practice workspace is simulated and labelled as such.

`src/lib/markets.ts` is the adapter behind the pool ticker and the Top pools
table. It carries the read API's state discriminators (`qualified` /
`unavailable` / `placeholder`) and a `source` field, and today it returns
`placeholder` rows for five pairs built from tokens that exist on the network.
**Those rows are labelled "Sample" wherever they appear and must stay labelled
until the adapter returns qualified data.** Swapping `listMarkets` for a real
call is the only change needed.

The service fee appears only where an owner would be asked to act: the Review
step of position creation, the fee-scenario review, and receipts. It is absent
from the landing page.

Token artwork lives in `public/tokens/<symbol>.svg` and is served from this
app, never from a third-party host. A symbol with no file falls back to a
coloured disc with its letters, so adding a logo is dropping in a file.

## What is not here yet

Wallet connection, SIWE sessions, live chain reads, the browser bridge to the
Python read API, qualified USD prices, and anything that signs. Each has its
own gate in the repository's specifications.
