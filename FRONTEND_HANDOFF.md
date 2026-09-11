# Frontend handoff

## Wallet-session backend candidate (#31 / #14)

The backend portion of #14 now has a separate disabled implementation candidate
in #31. Its [session-v1 contract](api-contracts/session-v1/README.md) defines
bootstrap/challenge/verify/me/logout, HttpOnly cookies, CSRF, supported plain EOAs,
expiry and safe errors. [Integration/rollback](docs/WALLET_SESSIONS.md) lists the
remaining consumer and staging evidence. Existing `read-v1` fields and app/web
hooks are unchanged. Frontend owns wallet discovery, account/network changes,
multi-tab/session refresh behavior and rendering; the backend does not claim
those checks passed or activate them. Sign-in grants no spending authority.

Audience: wallet users who trade tokens but are new to LPs. The app should make positions understandable without implying guaranteed profits or eliminating market risk. The UI language is English.

## Approved direction

Tangerine accents, modern rounded cards with light retro details. Positions are NFT-like cards; activity uses exactly one card per row at all widths. Highlight net reinvestment in green, costs in red, and use signed numbers plus labels so color is not the only cue. Keep exact receipts in a modal with progressive details. Creation and management unfold in dialogs/cards, without a long scrolling procedure.

The practice workbench is the visual baseline. Preserve its distinction between simulations and real transactions. Do not redesign the palette or introduce a fixed reserve of fees as part of integration work.

## Coordination before real data

OxDecimal must receive advance notice before a live API is connected or a
consumed response field/meaning changes. Follow the
[compatibility and notice process](docs/API_COMPATIBILITY.md), including the
exact contract version, shared payload fixtures, affected hooks, test results
and rollback. Use the candidate `api-contracts/read-v1/` schemas, types and runtime validators; TypeScript declarations alone do not validate HTTP JSON.

The [read bridge specification](docs/API_READ_BRIDGE.md) and
[acceptance plan](docs/API_READ_BRIDGE_TEST_PLAN.md) now have a disabled implementation candidate for issue #5. The shared package
contains the five route contracts and fixtures. No public endpoint is active
and no existing success field is renamed. Only `inventory.nextCursor` changes
to an opaque browser handle. Mock adapter work can continue; actual rendering
and the recorded frontend acknowledgement remain required before activation.

## First integration slices

1. A typed read-data adapter and deterministic mocks for token, pool, activity, capital and NFT owner views. Coordinate contract gaps against `backend/openapi-read.json`; amounts stay strings. *Built against read-v1 1.1.0-rc.3 in `app/src/lib/read/` (all nine routes, fixture and bridge sources, both off in the deployed build); see `app/README.md` → Read data. Pinned to producer commit `b50f80e5f5f6eacc07645d9856ab649047161aae` (#77, which with #75 is one combined release) and reconciled against `openapi-read.json` and the Python fixtures on every test run. The seven differences are recorded in `app/tests/backend-contract.ledger.mjs`: the three raised with rugged97 are decided on issue #1 (the `tokenIds` pattern now differs only by an equivalent end assertion; the private capabilities document stays untyped; the 8192-byte bridge limit is intentional) and four are by design. Previews and production still deploy the default sample build until the live-data PR. The consumer acknowledgement for these pins is still pending.*
2. Read-only position cards using this adapter: token pair, range, snapshot, fees, principal and owner status. Hide unavailable valuation behind a clear state, never a plausible invented number.
3. Token and pool selection dialogs: wallet token or pasted address, explanation of pairing, existing pools, fee/range choices and metadata/freshness states. Advanced new-pool initialization is a separately labeled path and remains non-executable until implemented.
4. Loading, unavailable, stale and partial states with retry that preserves prior data. Responsive interaction and accessible keyboard/focus behavior.

Each slice has its own GitHub issue and acceptance criteria. Mock data must be unmistakable; a successful mock cannot enable deposit, swap, mint, compound or successor creation. Read integration must not remove the current browser-Origin restrictions on the Python service. A same-origin bridge is a separate task.

## Hosting and access

`app/` is served by Cloudflare Pages at `https://domino.money` (project `domino-app`, configured in `app/wrangler.toml`). During the closed beta the entire deployment — pages, assets and `/api/*` — sits behind a shared-password gate in `app/functions/_middleware.ts`. Because the gate is code in every deployment rather than a setting on one hostname, it covers `www`, `*.pages.dev` and preview hostnames equally. The project owner chose this over the Cloudflare Access perimeter described in `docs/API_READ_BRIDGE.md`.

The password proves an invitation, nothing more. It is not wallet authentication, grants no capability in the app, and never substitutes for a session; wallet admission belongs to the session backend. A deployment missing either secret answers 503 to every request rather than opening. See `app/README.md` for operation and rotation.

`/api/*` takes one more step, the ingress rugged97 accepted on #45: past the gate, `app/functions/api/[[path]].ts` forwards each family (read, session, onboarding, deposit) through a fixed private service binding to its bridge Worker and refuses everything else as JSON, never with a Worker contract header: another host gets 404, a missing binding 503, another Worker's subrequest 403. Every answer past the gate leaves with `Cache-Control: no-store, no-transform`. In production, `CANONICAL_HOSTS_ONLY` confines the deployment to `domino.money` and `www.domino.money`, so its pages.dev and hash URLs are not entrances. Production binds the four families to their Workers (`[[env.production.services]]` in `app/wrangler.toml`), each deployed with every flag off, so a production API call gets that Worker's disabled answer; previews have no binding and get 404, and the owner checks both after every deploy. Deposit stays deferred: no secrets, Access application or Tunnel mapping until its own gates pass. Details in `app/README.md`.

## Data rules

- Identify assets by chain and address; symbols/decimals are optional, untrusted metadata. A zero-decimal token is valid, missing decimals are different.
- Distinguish a measured zero from missing data, and partial discovery from an exhaustive empty result.
- Retain provenance, block/hash, coverage and freshness. Mixed wallet pages do not share a single snapshot.
- Provider-reported TVL and volume may be displayed with their source and freshness. Reconciled on-chain valuations and fee APR still require qualified historical inputs; missing APR must remain unavailable.
- NFT owner at a snapshot is public data, not wallet authentication or user authorization.
- Display service charges against consumed fees; never silently charge principal or unused fee balances.

## Backend 0.8 market data handoff

The additive `POST /v1/read/pool-market` route is ready for a typed mock adapter.
Its request contract is in `backend/openapi-read.json`; real public response
fixtures are the `reads[].result` objects in
`reports/on-demand-market-http-probe-2026-09-09.json`. The route works without a
local pool catalogue or historical ledger. This does not enable browser access
to the loopback API; the reviewed bridge/session boundary remains issue #5.

Display `market.data.reportedLiquidityUsd` and `volume24hUsd` as attributed
provider figures, preserving null versus zero and the enclosing
`available`/`stale`/`unavailable`/`rejected` status. Market cache age describes
retrieval age, not a guaranteed source update timestamp. Keep `feeApr24h: null`
and execution disabled. A verified pool can remain selectable for planning
when its provider metrics are missing; it must not receive an APR/suggestion
badge inferred from missing history.

Price history is optional. `priceToken` names the provider base/quote role and
the response includes the actual currency address. Use that address as the
chart identity, preserve timestamps and gaps, and distinguish an open hourly
candle from a closed one. Do not assume base equals the user's purchased token
or token0. No token symbols or external logos are trusted for identity.
