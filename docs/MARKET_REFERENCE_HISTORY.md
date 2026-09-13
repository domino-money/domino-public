# Canonical market reference history probe

`backend/qualify_market_reference.py` obtains a bounded Alchemy Prices API
history for a reviewed Robinhood currency/reference mapping. It produces a
sanitized local report with no database writes, source registration, public API
changes, price-policy changes, or execution capability.

The mapping is selected only by chain 4663 and its canonical currency address:
native ETH (`0x0000000000000000000000000000000000000000`) selects the Ethereum
symbol reference. Canonical WETH (`0x0bd7d308f8e1639fab988df18a8011f41eacad73`)
selects Ethereum WETH `0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2`;
canonical USDG (`0x5fc5360d0400a0fd4f2af552add042d716f1d168`) selects Ethereum
USDG `0xe343167631d89b6ffc58b88d6b7fb0228795491d`. Robinhood identities reuse
`chainlink_history` constants and the
[official Robinhood token identities](https://docs.robinhood.com/chain/contracts/).
This adapter map is not a token-admission list. An arbitrary address or symbol
cannot select a reference, and USDG is never assumed to equal one dollar.

ERC-20 requests specify the reviewed reference's exact Ethereum network/address
and require both echoed with USD currency. Sources identify the
[Ethereum WETH contract](https://developers.uniswap.org/docs/protocols/v3/guides/swapping/single-hop-swapping)
and [Ethereum USDG contract](https://docs.paxos.com/guides/stablecoin/usdg/mainnet).
Only native ETH uses a fixed symbol request, with its exact symbol echo required.
There is no ticker fallback. `crosschain_market_reference` describes a price
reference, not an equivalent executable Robinhood token price. An Ethereum
contract response does not itself price the Robinhood contract. Historical token decimals, wrapper
or bridge equivalence, source composition, independence from the measured pool,
and bucket timestamp semantics remain **unqualified**. Canonical token decimal
counts are expected mapping metadata, not an on-chain historical verification.
The [historical endpoint](https://www.alchemy.com/docs/data/prices-api/prices-api-endpoints/prices-api-endpoints/get-historical-token-prices)
and [provider source FAQ](https://www.alchemy.com/docs/reference/prices-api-faq)
do not by themselves establish those guarantees.

One call accepts at most one day plus 300 seconds and 290 raw response rows.
Duplicate timestamps with exactly equal numeric values are deduplicated without
rounding; conflicting values, malformed decimal strings, errors and out-of-window
points fail. An explicit null price remains a missing observation. Unknown
provider metadata and raw exception text are excluded from reports. No fallback,
interpolation, current-price fill or pagination is attempted.

Coverage reports missing UTC five-minute grid points and requested boundaries.
`observed_grid_complete` describes only this finite diagnostic. It proves neither
causal event-time coverage nor availability at the provider bucket timestamp.
Unaligned request boundaries require actual observations at those instants for
that diagnostic to be complete; nearby samples are not substituted. No report
qualifies TVL/APR. Dollar metrics stay null and `executionAvailable` stays false.

Use an existing private **product** provider configuration and a new report path:

```sh
backend/.venv/bin/python backend/qualify_market_reference.py \
  --currency 0x0bd7d308f8e1639fab988df18a8011f41eacad73 \
  --start 1789171200 --end 1789257600 \
  --provider-config backend/runtime/providers.json \
  --output /tmp/canonical-market-reference-new.json
```

The start/end arguments are inclusive UTC Unix seconds and must be in the past.
No key or private endpoint belongs on the command line or in the output file.
The existing provider loader checks file ownership/permissions; the existing
Alchemy endpoint validator and bounded HTTP transport handle the request.
Existing outputs, including symlinks, are not overwritten. Exit zero means the
bounded diagnostic grid was collected; source and production qualification
remain false. Exit one indicates an incomplete report or a sanitized failure.
