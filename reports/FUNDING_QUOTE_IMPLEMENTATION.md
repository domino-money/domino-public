# Funding quote preview evidence — 10 September 2026

Issue [#34](https://github.com/domino-money/domino/issues/34) implements a reusable,
non-executable Trading API quote adapter and explicit local CLI. The branch is
based on #27 at `9b4f25f`; frontend, public API payloads, auth flags, contract
execution and personal-bot operation are unchanged. Scope and normalization are
in [the module specification](../docs/FUNDING_QUOTE_PREVIEW.md).

## Live read

Two single-request probes used the product's already configured private Uniswap
key. Neither used a real wallet: both supplied the public burn-address
placeholder. The first response exposed complete owner aggregate outputs with
absent optional legacy portion fields. Normalization now recognizes the
explicit 100% owner aggregate as zero-fee evidence while retaining null legacy
fields. The second probe validated that final behavior.

The final request started **2026-09-10 17:10:24 UTC** and completed within the
following second. It quoted 0.001 WETH for **2.449211 USDG**, with gross minimum
**2.436964 USDG** at 50 bps slippage. The provider reported **0.03%** price impact,
**193,244** gas units and **$0.06258873087984332** estimated gas. These are old
provider observations, not current prices, full-cost estimates or a receipt.

The exact route was the hookless WETH/USDG v4 pool
`0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6`,
fee 200 pips, tick spacing 4. The reported block was **59,570,974** without a
block hash. The adapter checked currency/owner/request/PoolKey association;
it did not independently revalidate on-chain state or simulate a funded wallet.
Empty failure codes mean no provider simulation failure was reported.

The [sanitized result](funding-quote-live-2026-09-10.json) retains normalized
amounts, recipients, limits and provenance. It expired after 30 seconds and is
evidence only. No credentials, raw provider response, permits, quote IDs or
transaction calldata were retained. No missing-key/invalid-key control was run;
this is not a provider authentication audit. No approval, signature, swap,
broadcast, funding, gas payment or service-fee collection occurred.

## Verification

- **463 backend tests passed**, with PostgreSQL and native EVM explicitly
  enabled and no skips. This includes **52 focused quote/CLI tests**.
- **238 bridge/shared-contract tests passed**, no skips. Existing read contract
  generation (113 files) and OpenAPI checks matched without payload changes.
- Independent agent review covered amount/identity substitution, multihop and
  split route boundaries, fee/recipient contradictions, native identity, expiry,
  safe projection and error sanitization. Its 18 adversarial tests are included
  in the counts above. The final 52 focused tests were independently rerun.
- Review findings fixed before delivery: serialized-expiry boundary, legacy vs
  aggregate fee contradictions, and distinguishing explicit aggregate zero
  evidence from missing legacy fee fields. Final review found no remaining
  actionable issue in this preview scope.

Tests used a task-specific virtual environment, PostgreSQL cluster and ephemeral
Anvil. Test services were stopped after validation. Dependency versions were
unchanged. Internal engineering review does not replace the independent protocol
and operational audit required before public financial execution.

## Handoff

No endpoint was added to read-v1 or session-v1. OxDecimal's frontend can continue
independently; a future quote HTTP contract needs its own versioned fixture/type
notice and consumer acknowledgement before integration. The helper deliberately
does not select a Domino tariff, compute the swap fraction for an LP range,
register an owner intent or return an executable quote. Those are the next
funding/transaction stages, with clear accounting and owner-signing boundaries.

#4 remains open for production metric qualification and #5 for staging/consumer
evidence. Historical lifetime replay remains optional audit work under the
approved MVP data strategy, rather than a dependency of this quote read.
