# read-v5: the featured pools list

One stored route, separate from read-v1 to read-v4 (featured-pools v1 §10):

- `POST /api/read/v5/featured-pools`, body `{}` (no keys), header
  `X-Domino-Read-Contract: 1.0.0-rc.2`; upstream `/internal/read/v5/featured-pools`.
- The answer is the list the VM serves now, the same for every visitor, as it
  was stored when it was published or repaired. `status` is `current`,
  `repaired`, `carried_over`, `manual` or `none`; `none` (nothing served, or the
  owner's `mode off`) is a 200 with no pools, and may still carry the week's
  `withdrawn` pools. `upcoming` is always `null` (rc.1 and rc.2).
- Errors are read-v1's codes (`ERROR_STATUS_BY_CODE`); a stored list the
  producer's contract refuses is `upstream_contract_mismatch` (502), never a
  partial list.

The producer's contract is `backend/featured_contract.py`.

## rc.2 (featured-policy v2, 28/09/2026)

The owner's policy v2 ranks by today's APR alone, above two floors (24 h
volume and liquidity), with every safety rule and no other market rule. What
changes on the wire from rc.1:

- `contractVersion` (and the header) is `1.0.0-rc.2`;
- `rules.rankBy` is `feeAprEstimate24hPercent` (today's APR) or, for a list
  chosen under v1, `min_fresh_and_previous_day_feeAprEstimate24hPercent`;
- `rules.minReferenceDepthUsd`, `maxAprPercent`, `maxTurnover24h` and
  `minPoolAgeHours` may be `null`: that rule is off;
- a ranked pool's `rankInputs.prevApr` may be `null` (no evaluation the day
  before) and `rankInputs.referenceDepthUsd` may be `null` (not measured).

Still required: `rules.minVolume24hUsd` and `minTvlUsd`, and a ranked pool's
`rankApr`, `freshApr`, `volume24hUsd` and `reportedLiquidityUsd`. Under v2,
`rankApr` equals `freshApr`. A list stored under v1 is served as it was
recorded, with rc.2's version (`valid/current-policy-v1.json`).

During the transition (the Worker and the app first, then the VM) the runtime
also accepts rc.1, held to rc.1's rules (`CONTRACT_VERSIONS`), in the body and
in the header. The Worker asks in rc.2, relays each answer in the version it
was answered in, and refuses one whose body names another version than its
header. Dropping rc.1 is the last step.

## Fixtures

`fixtures/valid/*.json` are answers the producer serves; every validator must
accept each of them. `fixtures/invalid/*.json` are the valid `current` answer
with exactly one defect, named by the file; every validator must refuse each
of them. `scripts/export-read-v5-fixtures.py` writes both sets from the
producer (`--check` compares), and `backend/tests/test_featured_contract.py`
fails when they drift from it.

Three rules go beyond the spec's list, and the fixtures hold them:

- a token symbol has no whitespace (`invalid/spaced-symbol.json`), like the
  selector's token rule;
- a listed pool is not also in `withdrawn` (`invalid/listed-and-withdrawn.json`):
  a pool chosen again leaves it, so a link to a listed pool is never refused;
- `ageSource` may be `null` (`valid/repaired.json`): age is a market rule, so
  a pinned, carried, fallback or manual pool can have none.

The Worker's `runtime.mjs` (`CONTRACT_VERSION`, `ROUTES`, `validateRequest`,
`validateResponse`) and the app's consumption are the bridge side's (§10.3).

`runtime.mjs` is written by hand in read-v4's pattern, with `runtime.d.mts`
for TypeScript. `runtime.test.mjs` walks both fixture sets, checks that each
invalid fixture differs from `valid/current.json` only where its name says,
and reads the producer's vocabulary from its source; the bridge's
`npm run check` runs it. The app pins the runtime's SHA-256 as
`READ_V5_PIN` (`app/src/lib/read/pin.ts`), so any edit to it fails
`app/tests/contract-pin.test.mjs` until the pin moves with it.
