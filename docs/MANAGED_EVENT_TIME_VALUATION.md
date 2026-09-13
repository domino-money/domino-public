# Internal managed event-time valuation (#97)

`backend/performance_valuation.py` converts reconciled token quantities to exact
USD values using the existing stored production-qualified price series. It adds
no provider, qualification entry, acquisition loop, public schema or UI field.

```python
valuation = load_managed_valuation(
    conn, pool_id=pool_id, currencies=currencies, start=start, end=end)
fee = valuation.value_amount(currency, raw_integer_string, earning_timestamp)
capital = valuation.value_capital_interval(raw_by_currency, start, end)
```

The loader accepts at most 16 distinct chain-4663 currencies, a full target PoolId
and a window of at most 86,400 seconds. It selects the existing code-owned
`price_history.PRODUCTION_QUALIFICATIONS[(pool_id, currency)]`, then calls the
existing `load_price_series`. Currency, decimals, source and target-pool
independence are bound to that qualification. Observation flags and caller
metadata never qualify a source. Reference-only objects are rejected; a removed
or changed registry entry invalidates reuse. The public read API does not call
this adapter or accept these internal objects.

All values, prices and integrals are `Fraction` objects. `exact_decimal` converts
a finite fraction to a calculator input without rounding, with a maximum of 400
fractional digits and 512 total characters. Floats, nonterminating fractions and
oversize inputs are rejected. For example, a uint256 quantity with 255 token
decimals and a price with 36 fractional places can need 291 fractional places.
Time averages can be nonterminating; retain those as fractions until the final
display rounding. This helper does not revise the public performance contract.

An amount result reports its actual denomination, source/evidence, observation
time, expiry and next observation, as well as an exact value or explicit
unavailability. There is no backwards interpolation, future-price fill, fixed
stablecoin peg, symbol mapping or price inferred from the measured pool. A known
event value can remain available when another part of the capital interval has
a gap. The adapter does not establish that a collection timestamp is an earning
timestamp: the caller must independently classify and attribute fee origins.

Capital input is one unchanged, complete component's `{currency: raw_string}`.
The collector owns balance and membership boundaries and must include every
active NFT, out-of-range assets and the epoch residual once. In an ERC20/ERC20
pool, native surplus is a third asset and cannot silently disappear. Avoid
adding aggregate vault holdings and their constituent fee reserves twice.
Every declared currency needs a qualified feed even when its quantity is zero.
The adapter cannot detect a currency omitted from the input.

Capital pieces cover `[start,end)` and split at all observed price changes and
expiry boundaries. Both endpoints and fractional intervals between boundaries
are checked. A price change exactly at the endpoint changes `end_value_usd` but
adds no elapsed time to `integral_usd_seconds`. `boundaries(start,end)` returns
integer interior boundaries for union with the collector's balance/membership
boundaries; it is not coverage evidence by itself. A failed component returns
no partial pieces or integral. More than 4,096 pieces fails explicitly rather
than sampling away an update. Existing price-row limits and the shared read
deadline also apply.

## Current live qualification gaps

As of this implementation, the production registry is empty. That is a current
evidence gap, not a rule that managed performance must always remain unavailable.
The stored source paths provide these dated findings:

- **Alchemy historical observations:** the recorded native ETH query returned
  prices, while sample ERC20 requests reported Robinhood unsupported. Neither
  address coverage, independent market composition nor causal bucket timestamps
  was qualified. RPC support and an observation labeled `usd` do not resolve
  those points. See the [capital/price qualification report](../reports/CAPITAL_PRICES_NFT_QUALIFICATION.md)
  and [source readiness report](../reports/PRICE_SOURCE_READINESS.md).
- **Chainlink reference history:** the existing standard-proxy adapter proves
  mapped ETH/WETH/USDG identities, rounds, publication blocks and source evidence
  under an explicit reference policy. That policy permits an answer age of
  86,520 seconds and defers use until publication plus one second. It is not the
  ordinary production qualification's 300-second maximum. The recorded samples
  exceeded that maximum. Removing `reference_only` or increasing `max_age` does
  not resolve this mismatch. See the [reference policy and dated evidence](../reports/CHAINLINK_REFERENCE_POLICY.md).
- **Other currencies:** accepting arbitrary addresses does not produce an
  independent USD series for them. Each selected asset, including native surplus
  or a currency used to pay a cost, needs its own reviewed mapping and coverage.

The smallest useful next read-only qualification is one selected managed pool
and its complete currency set, with a bounded historical interval and a pinned
snapshot. For an existing Chainlink mapping, reuse the current publication/round
proof acquisition and measure every gap against the current 300-second policy.
That can qualify only intervals whose evidence actually meets the policy; the
known sparse samples cannot establish a full day under that limit. A broader
historical analytics policy requires an explicit reviewed policy/adapter change
with asset mapping, independent source composition, publication causality,
freshness, snapshot/configuration revalidation and revision/expiry behavior.
It must keep execution-oracle qualification separate.

For Alchemy or an additional provider, first establish the exact chain/address
and decimal mapping, actual selected-asset coverage, target-pool independence,
and when each historical observation became available. Then retain and check
every update, both interval endpoints and the admitted age boundary. A real
qualification entry must cite that evidence and an explicit validity/revision
policy; it cannot be generated from a successful request alone. No live probe
or credential access was performed by this implementation.

Qualified prices alone do not complete #97. The canonical journal must also
establish earned origins, actual strategy costs, ownership attribution and full
capital intervals. Receipt gas products retain their separate unqualified L2
cost scope. This adapter emits no APR or complete-income claim.
