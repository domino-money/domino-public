# Provider window: where 25 requests a minute actually binds — 18 September 2026

E6 ("pacing for the market provider") was written from measurements taken on the
development lane. Those measurements do not describe production, and the work as
scoped does not reproduce there. This records what does.

## Two ceilings, both development-only

| Constant | Value | Where |
|---|---|---|
| `MarketCache.requests_per_minute` | **25** | `backend/market_cache.py:23` — the production default |
| same, overridden | 6 | `backend/dev_read_service.py:227` — development reader only |
| `CEILINGS['gecko']`, `CEILINGS['dex']` | 6 | `backend/dev_read_budget.py:24` — development budget only |

Every `provider_capacity_busy` observed on the development lane — in the #177 QA
notes and in the 17 September measurements of the discovery work — was taken
against a ceiling four times tighter than the one production runs. A refusal
there is not evidence of a refusal here.

## What the production ceiling does under the alpha's own traffic

Measured against the real `MarketCache` with a synthetic provider, driving the
Markets carousel (six selected pools, a pool read and a chart each):

| Scenario | Ceiling | Provider calls | Cache hits | Rate limited |
|---|---|---|---|---|
| Three visitors, same six pools | **25** | 12 | 24 | **0** |
| same | 6 | 6 | 12 | 18 |
| Three visitors, six distinct pools each | **25** | 18 | 0 | **0** |
| same | 6 | 6 | 0 | 12 |

Three concurrent visitors cost twelve provider calls, not thirty-six: `get()`
holds its lock across the provider call, so concurrent readers of one key
collapse into one call and twenty-four hits. That collapse is what keeps the
carousel under the ceiling, and it already works.

## The cliff, and what stands one pool away from it

Distinct cold pools in a single sixty-second window, at the production ceiling:

| Cold pools | Provider calls | Refused |
|---|---|---|
| 12 | 24 | 0 |
| **13** | 25 | **1** — the first refusal |
| 15 | 25 | 5 |
| 20 | 25 | 15 |

The alpha's six selected pools cost twelve calls. **The cliff is at thirteen
pools, one above what the product serves today.** So the ceiling binds the
moment the markets list grows past twelve — which is the open decision on
whether that list stays at six or opens (#169) — or when free token search
discovers many distinct pools in one minute.

## What follows

Building provider pacing now would be building against a development constant.
The refusal path has the same shape the read gate had before its own fix — an
instant refusal where a short wait would serve — so if it ever binds, the remedy
is known. What is missing is production evidence, and the per-hop records added
for #138's observability work now carry `reason: provider_capacity_busy` on
exactly this path: once the reader and gateway deploy, the journal answers
whether the ceiling is ever reached before the markets list is widened.

No production figure, cache state or provider response is asserted here; the
numbers above come from the real cache under a synthetic provider.
