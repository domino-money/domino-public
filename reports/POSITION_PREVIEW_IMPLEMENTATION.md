# Uniswap LP preview qualification — 2026-09-10

Issue #36 implements the thin Uniswap integration selected by the user: use the
official LP API's position calculations, keep key/identity/budget validation in
Domino, and do not build another deposit math engine. The result is an internal
non-executable adapter plus explicit local CLI, stacked on #35.

## Real provider evidence

Four explicit `/lp/create` calls used the locally configured product API key and
the public placeholder `0x000000000000000000000000000000000000dead`: an initial
schema/envelope probe, then three complete adapter probes. No private owner,
signer, approvals, permits, signatures, simulation, transaction broadcast, funds
or gas payments were involved. The response's transaction was inspected in
memory and discarded; only the normalized projection was saved.

The existing Robinhood (4663) hookless WETH/USDG pool was:
`0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6`,
fee 200 pips, spacing 4, ticks -200000 to -196000, requested slippage 50 bps.
These public tokens are probe inputs, never a runtime allowlist.

| Adapter probe | Provider nominal result in raw units | Result |
| --- | --- | --- |
| WETH independent `1000000000000000` | WETH `1000000000000000`, USDG `2000332` | Identity/plan inspected; selected caps fit; 1.105 s. |
| USDG independent `2000000` | WETH `999833920927532`, USDG `2000000` | Same checks from the other input side; 0.565 s. |
| WETH input, USDG budget `1` | Provider still returned USDG `2000332`, encoded max `2058955` | Domino marked `blocked` / `token1_maximum_exceeds_budget`; 0.574 s. |

The provider ignored `dependentToken.amount` as a hard cap in the tested request.
That confirms why budget checks must use the actual encoded maxima and must not
assume the API honors that field as enforcement. In the first probe the encoded
WETH max was `1023897128617882`, distinct from the nominal input. Concentrated LP
slippage affects composition: it is not a flat `nominal × 1.005` rule per token.
Domino does not duplicate that calculation or claim independent slippage proof.

All three prepared payloads matched the direct PositionManager
`modifyLiquidities(bytes,uint256)` plan, its owner/recipient, exact PoolKey,
ticks, mint/settlement actions and request deadline. Those structural checks are
not an independent pool-state or token-safety audit.

Returned prices were raw token1/token0, for example
`0.000000002063215669444018480018326861` at the lower bound. The adapter labels
that unit and leaves human-price conversion to verified decimals and the official
frontend/SDK. It accepts canonical ticks only, avoiding the ambiguous upstream
`priceBounds` examples. No local range rounding or price/liquidity solver was
added.

The [sanitized normalized evidence](position-preview-live-2026-09-10.json) includes
request identity, observed values, exact caps and 30-second expiry. It is expired
historical evidence, not a current quote or deposit recommendation. No key, raw
provider response, executable calldata or provider request ID is retained. No
missing-key/invalid-key control was run; this is not an API authentication audit.

Gas estimates were absent with `simulateTransaction: false` and remain null.
The placeholder's supplied native balance/reserve were explicitly zero: they
exercise selected-value comparisons, not proof of sufficient gas. Every result
keeps execution unavailable, balances/allowances unverified and no independent
simulation success. Native-pool settlement/refund has offline tests only; live
qualification covers ERC-20/ERC-20.

## Offline verification

- **68 new focused tests**: 25 adapter, 27 mint inspection and 16 CLI tests.
- **531 backend tests passed with PostgreSQL and native EVM enabled, zero skips.**
- Shared contract exporter: all 113 generated files match. Read OpenAPI matches
  the existing producer routes/models. No public contract changed.
- Repository hygiene and `git diff --check` pass.
- Two independent agent reviews found no blocking issue in this internal scope;
  a redundant test that did not exercise its stated behavior was removed.

Coverage includes either independent token, generic addresses, native/ERC-20
distinction, one-sided deposits, exact raw integers, unknown/zero budgets and gas,
nominal versus maximum spend, ignored dependent cap, incorrect owner/pool/range/
deadline, noncanonical ABI, unexpected recipients/actions, multicalls, permits,
oversized calldata, provider failures/redaction and parent/total deadlines.

All offline tests use synthetic data and local isolated PostgreSQL/EVM. The task
database was stopped after verification. No wallet credentials or live network
are required in CI. The pre-existing FastAPI test-client deprecation notice is
informational; dependency changes were outside this slice.

## Integration boundary

`backend/uniswap_position.py`, `lp_mint_inspection.py` and `preview_position.py`
are internal only. No frontend, browser route, shared API/session contract,
deployment, migration, tariff, personal bot or live contract changed. Direct
deposits have no Domino setup percentage or 2% earned-fee cut. No swap occurs.

The [integration contract notes](../docs/POSITION_PREVIEW.md) describe field units,
failure codes, TTL, caps and responsibilities. Public integration must agree its
schema with OxDecimal before changing a browser hook. Owner authentication,
balances/allowances, transaction/slippage validation and simulation, wallet
review/signing, submission and receipt reconciliation remain execution work;
this adapter cannot authorize those actions. Advanced pool initialization and
swap-assisted balancing remain separate Uniswap integration steps, not an excuse
to recreate upstream math.
