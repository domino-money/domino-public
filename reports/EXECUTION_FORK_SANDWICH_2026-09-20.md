# The compound sandwich, measured on a forked Robinhood pool — 20 September 2026

[CONTRACT_REVIEW_2026-09-19](CONTRACT_REVIEW_2026-09-19.md) closed its hardening findings by
reading code: D-01 (every action anchors to a published price, checked against the pool's
live reading) and D-02 (a plan states the ceiling of what one add may cost). It also said, under
"Not covered", that *no finding was reproduced by execution* and that D-01/D-02's exploitability
"needs a forked-pool test that manipulates spot around a compound and measures the value
delta". This is that test. Every number below was read from a fork of Robinhood Chain
(4663) at the head block of the self-hosted node, with the real PoolManager, PositionManager,
StateView, WETH, USDG and the real `weth-usdg` pool (fee 200, tick spacing 4); nothing is an
estimate.

## What was run

`backend/qualify_execution_fork.py` — an operator command in the shape of the deposit fork
qualification, reusing its Anvil child (`DepositFork`) and taking the upstream either from the
read gateway or from a loopback JSON-RPC port. These runs used an SSH-forwarded port of the
self-hosted Nitro node, so no provider credential entered the process, its arguments or its
output. Balances, impersonation and snapshots are child-only controls.

1. Deploy the V4 stack from the built artifacts — factory, read helper, routing helper, price
   guard (band 2000 bps), engine, vault implementation, `finalizeImplementation`, and
   `DominoSetup`.
2. Give a synthetic owner a real root position through `DominoSetup.open`/`mint` — 2 WETH and
   8,000 USDG, WETH wrapped from balance, USDG moved from the pool manager as the deposit
   qualification does — around the current tick, and create the vault over it. Two ranges
   were run: **±200 ticks (≈ ±2% of price)**, a concentrated position, and **±2000 ticks
   (≈ ±22%)**, a wide one.
3. Earn it fees: 40 round trips of a currency0 leg sized to a 0.2% impact, swapped by a fixture
   driver against the real pool. The vault's share of the pool's 0.02% fee is what gets
   compounded — a few USDG. Everything after this point starts from the same snapshot.
4. One compound per scenario, at price moves of 0.5%, 0.9%, 1.1%, 5% and 20% (the vault's
   `maxPriceImpactBps` is 100, so 0.9% is inside the limit and 1.1% outside):
   - **honest** — observation at the true spot, compound, nobody interferes;
   - **pre-observation** — the attacker moves spot, an honest publisher reads the moved pool,
     the operator compounds at it, the attacker restores. No on-chain band can see this: the
     published price and the spot agree;
   - **post-observation** — observation at the true spot, then the attacker moves spot before
     the compound: what the anchor refuses, and what it lets through inside the limit;
   - **ceiling** — post-observation inside the limit, with the plan's `maxAdded` set to the
     honest amounts plus 0.5%: what D-02 refuses;
   - **swap-pre/post-observation** — the same two, on a GENERAL plan that also sells half of the
     currency0 fee for currency1 at the anchor with the vault's own slippage floor: the direct
     channel, where a moved anchor is a moved exchange rate.
5. Value the vault at the pre-scenario price — position amounts from liquidity and range, plus
   reserves, plus fees still uncollected — and the attacker's two balances the same way. The
   attacker's cost is real: the pool's fee on its own volume and the price impact of moving
   and restoring against real depth. Every refused compound is replayed as a call to read its
   revert selector.

The plan is sized as an operator would size it: the liquidity the accrued fees fund at the
observed price, with 10% slack, floors of one unit on each side the range makes non-empty,
and no ceiling unless the scenario says so.

## Results

Values are USDG (six decimals) at the pre-scenario price. "Vault vs honest" is the vault's value after the scenario minus its value after the honest compound - positive means the vault ended better off. "Attacker cost" is what the move and its restoration cost the attacker in fees and impact against real depth. "Swap shortfall" is what the vault's own sale of fees fetched below the true rate because the anchor had moved.

### `weth-usdg`, concentrated root (±200 ticks (±2.0% of price), fork block 68232373
root: token 3011383, ticks [-197756, -197356], liquidity 10158109690717875; fees earned over 40 round trips: 0.001586 WETH + 4.17 USDG; honest compound worth 7.34 USDG

| scenario | move | outcome | vault vs honest (USDG) | attacker cost (USDG) | swap shortfall (USDG) |
| --- | ---: | --- | ---: | ---: | ---: |
| honest | - | executed | 0.00 (baseline) | - | - |
| swap-honest | - | executed | 0.00 (baseline) | - | 0.0000 |
| pre-observation | 0.5% | executed | +0.54 | 2.59 | - |
| post-observation | 0.5% | refused (InvalidAmount()) | no change | 2.59 | - |
| ceiling | 0.5% | refused (InvalidAmount()) | no change | 2.59 | - |
| swap-pre-observation | 0.5% | executed | +0.60 | 2.58 | 0.0109 |
| swap-post-observation | 0.5% | executed | +0.60 | 2.58 | 0.0000 |
| pre-observation | 0.9% | executed | +0.97 | 4.72 | - |
| post-observation | 0.9% | refused (InvalidAmount()) | no change | 4.72 | - |
| ceiling | 0.9% | refused (InvalidAmount()) | no change | 4.72 | - |
| swap-pre-observation | 0.9% | executed | +1.00 | 4.70 | 0.0205 |
| swap-post-observation | 0.9% | executed | +1.00 | 4.70 | 0.0000 |
| pre-observation | 1.1% | executed | +1.18 | 5.96 | - |
| post-observation | 1.1% | refused (InvalidPrice()) | no change | 5.97 | - |
| swap-pre-observation | 1.1% | executed | +1.21 | 5.94 | 0.0256 |
| swap-post-observation | 1.1% | refused (InvalidPrice()) | no change | 5.97 | - |
| pre-observation | 5.0% | executed | +2.13 | 28.28 | - |
| post-observation | 5.0% | refused (InvalidPrice()) | no change | 28.30 | - |
| swap-pre-observation | 5.0% | executed | +2.03 | 28.17 | 0.1282 |
| swap-post-observation | 5.0% | refused (InvalidPrice()) | no change | 28.30 | - |
| pre-observation | 20.0% | executed | +2.12 | 92.42 | - |
| post-observation | 20.0% | refused (InvalidPrice()) | no change | 92.44 | - |
| swap-pre-observation | 20.0% | executed | +1.65 | 91.92 | 0.5126 |
| swap-post-observation | 20.0% | refused (InvalidPrice()) | no change | 92.44 | - |

### `weth-usdg`, wide root (±2002 ticks (±22.2% of price), fork block 68234852
root: token 3011465, ticks [-199552, -195548], liquidity 1056926085997426; fees earned over 40 round trips: 0.000165 WETH + 0.43 USDG; honest compound worth 0.77 USDG

| scenario | move | outcome | vault vs honest (USDG) | attacker cost (USDG) | swap shortfall (USDG) |
| --- | ---: | --- | ---: | ---: | ---: |
| honest | - | executed | 0.00 (baseline) | - | - |
| swap-honest | - | executed | 0.00 (baseline) | - | 0.0000 |
| pre-observation | 0.5% | executed | +0.05 | 2.00 | - |
| post-observation | 0.5% | executed | +0.05 | 2.00 | - |
| ceiling | 0.5% | refused (InvalidAmount()) | no change | 2.00 | - |
| swap-pre-observation | 0.5% | executed | +0.06 | 2.00 | 0.0011 |
| swap-post-observation | 0.5% | executed | +0.06 | 2.00 | 0.0000 |
| pre-observation | 0.9% | executed | +0.10 | 3.64 | - |
| post-observation | 0.9% | executed | +0.10 | 3.64 | - |
| ceiling | 0.9% | refused (InvalidAmount()) | no change | 3.64 | - |
| swap-pre-observation | 0.9% | executed | +0.10 | 3.64 | 0.0021 |
| swap-post-observation | 0.9% | executed | +0.10 | 3.64 | 0.0000 |
| pre-observation | 1.1% | executed | +0.12 | 4.60 | - |
| post-observation | 1.1% | refused (InvalidPrice()) | no change | 4.60 | - |
| swap-pre-observation | 1.1% | executed | +0.12 | 4.60 | 0.0027 |
| swap-post-observation | 1.1% | refused (InvalidPrice()) | no change | 4.60 | - |
| pre-observation | 5.0% | executed | +0.55 | 26.28 | - |
| post-observation | 5.0% | refused (InvalidPrice()) | no change | 26.28 | - |
| swap-pre-observation | 5.0% | executed | +0.54 | 26.26 | 0.0176 |
| swap-post-observation | 5.0% | refused (InvalidPrice()) | no change | 26.28 | - |
| pre-observation | 20.0% | executed | +2.09 | 92.62 | - |
| post-observation | 20.0% | refused (InvalidPrice()) | no change | 92.69 | - |
| swap-pre-observation | 20.0% | executed | +2.00 | 92.52 | 0.1547 |
| swap-post-observation | 20.0% | refused (InvalidPrice()) | no change | 92.69 | - |

## What the numbers say

**D-01 holds on a real pool.** Every post-observation move at or beyond the limit — 1.1%, 5%,
20% — was refused with `InvalidPrice()`, with or without a swap, on both ranges. The anchor is
the published observation; the engine compares the live spot to it before any action, and a
spot that moved more than `maxPriceImpactBps` since the observation ends the execution before
it touches the position.

**D-02 holds, and the wide range is where it can be seen.** On the ±2% position a spot that
moved even 0.5% after the observation changes the required composition by more than the
plan's slack, so the add is refused as `InvalidAmount()` before any ceiling matters — the
compound fails closed on its own. On the ±22% position the same moves fit and execute; with
the ceilings set to the honest amounts they are refused with `InvalidAmount()`. The ceiling is
the deciding clause there, which is what the review asked for and what
`DominoExecutionEngineV4._bound` now pins.

**The pre-observation sandwich is real, and it does not pay.** In every executed
pre-observation scenario the vault ended *better* off than in the honest compound, by cents:
the attacker's own volume pays the pool's fee, the root position earns its share, and that
share exceeds any impermanent loss on the few USDG being compounded. The attacker's cost
rises with the move — roughly $2.6 at 0.5%, $4.7 at 0.9%, $6 at 1.1%, $28 at 5% and $92 at
20% on this pool's depth — while what it can extract is bounded by the compounded fees, which
the review already stated. The direct channel is the swap: selling fees at a moved anchor
loses the move times the amount sold, and the swap shortfall column shows exactly that, in
tenths of a cent here because the amounts are fees. For a manipulation to pay, one compound
would have to sell fees worth the attacker's cost divided by the move, and on this pool that
ratio is nearly flat: $4.72 for 0.9%, $28.28 for 5%, $92.42 for 20% — about **$500 of fees
sold at the moved rate per compound**, whatever the move. That is the number to keep against
the fee reserves a vault is allowed to accumulate before compounding, and it scales with the
pool's depth.

**What no band can see is bounded by the publisher.** Pre-observation manipulation defeats
the guard's band by construction (spot and published price agree) and passes the engine's
impact check (the anchor *is* the moved price). The residual is whatever an honest-but-naive
publisher reads; the deviation band bounds a stolen key, not a moved pool. The measured
attacker cost is what makes this expensive, and it scales with pool depth, not with the
vault.

**One operational note, not a security one.** On a concentrated range, a 0.5% move between
observation and execution makes an honestly sized compound fail. In production the two are
seconds apart, but volatile pairs move that much in seconds; the executor should expect
`InvalidAmount()` refusals and re-plan rather than treat them as faults.

## Reproduce

```sh
backend/.venv/bin/python backend/qualify_execution_fork.py \
  --source-url http://127.0.0.1:18547 --rounds 40 --moves 50,90,110,500,2000 --output /tmp/narrow.json
backend/.venv/bin/python backend/qualify_execution_fork.py \
  --source-url http://127.0.0.1:18547 --width 2000 --rounds 40 --moves 50,90,110,500,2000 --output /tmp/wide.json
```

with `127.0.0.1:18547` forwarded to a Nitro node's HTTP port, or `--rpc-config` naming a private
`providers.json` whose historical source is archive-capable. A pruned node keeps state for its
block-age window only, so the fork starts at the head and a run must finish inside that
window; these took about four minutes each. The raw outputs of the runs summarised above are
in [`fork/`](fork/). `backend/tests/test_qualify_execution_fork.py` checks the tool's
arithmetic and its source guard offline.
