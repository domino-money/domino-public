# Issue #5 — disabled read bridge implementation

10 September 2026. Candidate branch: `codex/5-read-bridge`.
This report records local implementation and verification, not a public release
or completion of wallet sessions. The owner requested a commit-ready candidate;
Cloudflare credentials will be supplied separately.

## Scope and base

The branch includes pending backend 0.8.0 candidate
`c5fad7cbfe5f6d7d7c65ff0b02769f7bd050101d` (PR #10) and issue #5 design content
from PR #16. Those dependencies remain subject to their reviews. Implementation
work is isolated from the personal bot and from OxDecimal's frontend branch.
No `app/` or `web/` source, wallet authority or live flag changed.

The selected application origin is `https://domino.money`. The proposed backend
hostname is `https://read-origin.domino.money`; no DNS, Access, Tunnel, Worker
route or service has been provisioned by this work.

The [implementation-start notice](https://github.com/domino-money/domino/issues/5#issuecomment-5611945573)
informed OxDecimal of the shared contract and route boundaries before any hook
integration. A notice is not his acknowledgement. No frontend integration is
claimed and #5 should not be closed merely by merging its design PR.

## Delivered behavior

- Shared candidate `read-v1` / `1.0.0` package: five request/response schemas,
  capabilities, finite error contract, generated TypeScript types, portable
  validators, deterministic fixtures and SHA-256 manifest. Local OpenAPI now
  describes the five successful response models and actual error envelopes.
- A default-disabled Cloudflare Worker maps only the five exact browser reads
  to a fixed gateway. It checks Origin/Fetch Metadata, strict bounded JSON,
  request schemas, total deadlines and full successful response schemas. Output
  text is preserved; errors, headers and cookies cannot become arbitrary relays.
- A separate default-disabled loopback gateway verifies Access service RS256
  assertions with fixed issuer, audience, service identity and bounded JWKS
  refresh. IP/global admission is centralized in one gateway process. Wallet
  balances and NFT owners remain public observations, never signed sessions.
- Internal inventory cursors become random 256-bit opaque handles bound to
  wallet, normalized fallback currencies, expiry and reader generation. Their
  lifetime is not renewed by retries, and internal provider state is not exposed.
- Fixed numeric-loopback HTTP and a shared reader deadline bound network work.
  The gateway checks actual reader admission after timeouts before starting
  another operation. Failed thread dispatch releases its own admission slot.
- CI checks shared contract/OpenAPI drift, shared TypeScript compilation and
  bridge tests in addition to the existing full backend checks. Setup and
  release instructions are in [the runbook](../docs/READ_GATEWAY_RUNBOOK.md).

Success field names, raw amount strings, decimal/null semantics, snapshots,
source ages and missing APR are preserved. The only declared success-value
transformation is `inventory.nextCursor`. No historical backfill, financial
calculation, signer or new provider integration is added by this bridge.

## Verification actually executed

| Check | Result |
| --- | --- |
| Full Python suite with `DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1` | **389 passed; zero skips**; disposable PostgreSQL and native EVM reference cases included |
| `npm run check:read-bridge` | **225 passed; zero skips**; includes 88 shared fixture consumer tests |
| Strict TypeScript compile of generated types and runtime declarations | Passed |
| Both schema/OpenAPI exporters with `--check` | Passed; 100 shared package files match generation |
| Wrangler 4.130.0 `deploy --dry-run` against disabled example | Passed; 87.27 KiB bundle, 13.38 KiB gzip; no deployment |
| Python dependency consistency | Passed |
| Staged diff whitespace and repository hygiene | Passed; exact reserved-host adversarial URL fixture documented in scanner |

Local checks used Python 3.14 and Node 25.2.1; the repository CI target remains
Node 24. Native Fetch tests and a Wrangler dry-run do not establish deployed
Cloudflare isolation. Existing FastAPI TestClient emits a deprecation notice
about httpx; it does not fail these checks. Frontend UI and Solidity source are
unchanged, so no new component/browser or separate Solidity-suite claim is made.

Three bounded agent reviews covered contract generation, Worker controls,
gateway identity/admission and deadline transport. Findings fixed and retested:

1. Incomplete successful responses must fail full BFF schema validation.
2. Absolute deadlines must be checked after completion, EOF, parsing and validation.
3. Cursor fixtures must use the actual 64-hex opaque-handle implementation.
4. Shared schema lookup must reject inherited property names such as `__proto__`.
5. A failed worker dispatch must not permanently lock gateway admission.
6. Expired requests must not start new identity/JWKS work.
7. Rotation tests must use an actual replacement RSA key and reject removed keys.
8. Duplicate internal budget headers must be rejected before reader dispatch.

These are engineering reviews and regression evidence, not an external security
audit or certification.

## Acceptance evidence and remaining gates

| Plan area | Local evidence | Still required before activation |
| --- | --- | --- |
| C01–C04: contracts and compatibility | Producer fixtures, strict validation, schema drift/version rejection, generated types | Actual frontend adapter/rendering and deployed old/new compatibility matrix |
| C05–C08: UI semantics and rollout | Missing/zero/partial/stale/opposite-currency fixtures and closed schemas | Escaped rendering, late-selection behavior, component tests and supported rollout combinations |
| B01–B07/B11–B12: read boundary | Fixed routes, identity checks, Origin/header/body/error controls, gateway + actual reader middleware integration | Actual Access/Tunnel/edge routing and alternate-host isolation |
| B03/B08–B10: identity and capacity | Real synthetic RSA signature/rotation, bounded cache/IP memory, concurrent admission, disconnect/deadline tests | Deployed credential revocation, trusted client-IP configuration and route-mix load test |
| D01–D02/D05–D06/D08/D10: data | Existing cache/source tests, opaque cursor continuation/expiry/context tests, read-only capability checks | Frontend live/unavailable presentation and staging provider outage drill |
| D03–D04: selection and mocks | No frontend data connection made | Real adapter selection race and live-to-mock prohibition tests |
| D07/D09: catalogue/topology | Historical routes disabled; CLI rejects multiple workers, gateway file lock | Supervisor/ingress validation preventing independent replicas |
| S01–S10: sessions | Design only; all session/private/write capabilities false | Separate wallet-session implementation and complete session/private-schema tests |
| Operations | Safe response IDs; no application payload/access logging | Counters, correlation, alerting, retention/redaction and rollback evidence in staging |

External provider DNS remains subject to the system resolver's blocking behavior.
Admission stays occupied until that actual worker exits; the gateway itself uses
numeric loopback and a strict socket deadline. The process is intentionally
single-instance, and restart discards its short-lived rate/cursor state. This is
an invited-alpha candidate, not a horizontally scalable public service.

Next release work: obtain the deferred Cloudflare configuration, qualify the
separate staging perimeter/identity, integrate the pinned frontend adapter with
OxDecimal's acknowledgement, and execute the deployment/rollback checks above.
Until then, both live-read flags and every signing/automation capability remain
disabled. Issue #5 stays open for release coordination rather than claiming
public readiness from offline tests.


The next disabled candidate is documented in [the 1.1.0-rc.2 change notice](../docs/READ_CONTRACT_CANDIDATE_1_1.md). The measurements above remain evidence for their original commit.
