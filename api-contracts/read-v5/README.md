# read-v5: the featured pools list

One stored route, separate from read-v1 to read-v4 (featured-pools v1 §10):

- `POST /api/read/v5/featured-pools`, body `{}` (no keys), header
  `X-Domino-Read-Contract: 1.0.0-rc.1`; upstream `/internal/read/v5/featured-pools`.
- The answer is the list the VM serves now, the same for every visitor, as it
  was stored when it was published or repaired. `status` is `current`,
  `repaired`, `carried_over`, `manual` or `none`; `none` (nothing served, or the
  owner's `mode off`) is a 200 with no pools, and may still carry the week's
  `withdrawn` pools. `upcoming` is always `null` in rc.1.
- Errors are read-v1's codes (`ERROR_STATUS_BY_CODE`); a stored list the
  producer's contract refuses is `upstream_contract_mismatch` (502), never a
  partial list.

The producer's contract is `backend/featured_contract.py`.

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
