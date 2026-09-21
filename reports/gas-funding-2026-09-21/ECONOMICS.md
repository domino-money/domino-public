# Gas funding economics — 21 September 2026

At the captured gas price, the model puts marginal company cost near **$0.196 for direct reinvestment, $0.245 with a swap, and $0.303 for successor creation**. Those examples require roughly **$11.31, $14.13, and $17.50 of newly charged consumed earned fees**, respectively, for the existing 2% cut to cover the modeled cost plus the policy's 15% buffer. These are planning scenarios, not live complete-transaction estimates or profitability forecasts. A high-gas snapshot changes them substantially.

For launch, prefunded company ETH is the simplest path consistent with the implemented EOA tooling. Automatic conversion of already collected company revenue is the useful next funding feature; it does not require a larger user fee. Sponsorship may reduce wallet-funding work but adds account integration, provider cost and eligibility requirements. [Architecture and controls](OPTIONS_AND_CONTROLS.md) and [provider evidence](ECOSYSTEM.md) describe feasibility separately.

## Scope, prices and measurement quality

Research only. No mainnet transactions, asset sales, keys or new production behavior. Calculations generated at `2026-09-21T16:30:50.121595+00:00`; [calculation JSON](calculations.json) records formulas, assumptions, source SHA-256 hashes and unrounded decimal results.

The approved [pricing policy](../../PRICING_POLICY.md) charges 2% of consumed earned fees once, excluding principal and previously charged converted lots. Gas comes from that service revenue, with no additional automation fee. The [reinvestment policy](../../REINVESTMENT_POLICY.md) uses a 15% operator-cost buffer and a separate owner-benefit test. Net-realizable fee revenue, failed attempts, route/provider charges and operating expenses all matter. TVL and idle accrued balances are not revenue.

The local synced Nitro node (`eth_syncing=false`) recorded **0.052694 gwei** and zero priority fee at block **68930584**, captured **2026-09-21T16:11:47.060Z**. [Local RPC evidence](local-rpc-probe.json). A 61-header sample spanning 3,604 seconds had minimum **0.049996**, median **0.051788** and maximum **0.491854 gwei**. These are sampled points, not a continuous range, forecast or upper bound. [Measurement evidence](gas-measurements.json).

USD displays use the actual Coinbase ETH/USD trade quote **$2,748.79/ETH**, trade timestamp **2026-09-21T16:10:47.868047798Z**, retrieved **16:10:48.068Z**. [Official ticker](https://api.exchange.coinbase.com/products/ETH-USD/ticker); captured body in [ecosystem evidence](ECOSYSTEM.md). No USDG peg or USDG/USD price is assumed.

Nitro charges child execution plus parent-chain posting, expressed as one gas bill. A full `eth_estimateGas` or `gasEstimateComponents` total already includes posting; adding a separate data estimate to that total would double count. The model below instead combines a synthetic child footprint with a separately measured posting component. [Official Nitro estimation documentation](https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas).

The child receipts use an explicit ArbSys stand-in and artificial account funding. They measure these scenarios' EVM work; they do not establish complete native Nitro execution gas. The synthetic 1-gwei receipt price is never used as today's network price. Earlier [corrected fork results](../v4-remediation-2026-09-21/FORK_RESULTS.md), the [fresh footprint](gas-footprint-fork.json), [extended lifecycle footprint](gas-footprint-lifecycle-fork.json), and [local 20% fork](local-fork-narrow-20pct.json) give the observed range. Different treasury/position states change gas; the upper observed value is a conservative modeling input within this sample, **not a worst-case cap**. Owner exits are outside operator automation and excluded.

The exact calldata posting quotes include both zero observations and nonzero observations. [Nonzero quotes](nonzero-data-quotes.json) use pinned block **68923379**, hash `0xbe307cc6ca57f5cd9dc9ac6a3ee319ef3de846f9d78016f53c14d99b9f920207`, captured **2026-09-21T16:19:29.498139Z**. Returned data gas is 116,005 / 122,176 / 117,543 for direct / swap / MINT, and 58,257 for publishing. Each quote returned **52,962,000 wei** per L2 gas unit. Multiplying by that same returned value gives its posting cost; the header base fee and another snapshot's price are not substitutes. WETH/native transfer use the same block's 30,496 / 25,523 data gas from the first measurement. The following nonzero scenario combines these fixed historical posting costs with the baseline execution price; it is deliberately a **mixed-snapshot sensitivity**, not a same-block live quote. A zero sample does not guarantee permanent free posting.

## Per-transaction footprint

The last two columns use the upper observed execution footprint. They exclude publishing, treasury replenishment, failures and fixed operating costs from the individual execute row.

| Operation | Observed child gas | Calldata bytes | Zero posting: ETH / USD | Recorded nonzero posting: ETH / USD |
| --- | --- | --- | --- | --- |
| Direct reinvestment | 1,157,932–1,175,124 | 1764 | 0.00006192 / $0.170 | 0.00006807 / $0.187 |
| Swap + reinvestment | 1,440,762–1,497,579 | 1956 | 0.00007891 / $0.217 | 0.00008538 / $0.235 |
| MINT successor | 1,737,500–1,895,616 | 1764 | 0.00009989 / $0.275 | 0.00010611 / $0.292 |
| Publish observation | 157,278 | 196 | 0.00000829 / $0.0228 | 0.00001137 / $0.0313 |
| Unwrap WETH | 47,873 | 36 | 0.00000252 / $0.0069 | 0.00000414 / $0.0114 |
| Native ETH transfer | 21,000 | 0 | 0.00000111 / $0.0030 | 0.00000246 / $0.0068 |

MINT's 1,737,500 gas comes from the extended measurement and 1,895,616 from the completed local 20% lifecycle. Swap's observed lower and upper are 1,440,762 and 1,497,579. These are particular synthetic states, not guaranteed live bounds. Full native transaction estimation and receipt reconciliation remain necessary before committing funds.

## Model and admission threshold

Let `F` be the gross reference ETH-equivalent value of **new original earned fees actually consumed and charged**, `s=0.02`, `h` the haircut needed to realize the company service share (set it to zero when `F` already uses a net realization quote), and `a` the portion of net service revenue available to this cost budget. Per-currency integer fee rounding must replace `s*F` in actual execution quotes. MINT or another recipe can consume previously charged lots and produce little or no new service revenue; that operation cannot pass a standalone revenue test by charging those lots again. A capped company subsidy is a separate decision.

```text
Cs = P * successful execution gas / 1e18 + success posting cost
Cf = P * failed execution gas / 1e18 + failure posting cost
C  = Cs + f/(1-f)*Cf + publication cost/N + treasury batch cost/B + O
cash break-even F = C / (s * a * (1-h))
policy-buffered F = 1.15 * C / (s * a * (1-h))
```

`f` is the fraction of mined execution attempts that fail; geometric retry averaging is a planning assumption, not permission to retry a stale transaction. `N` is successful eligible executions per paid publication, and `B` successful executions funded per treasury batch. `O` allocates other operating expenses. A mined revert normally earns no service fee but consumes gas and posts its transaction data. Dropped, unmined replacements do not themselves consume chain gas.

The existing planner compares the realized service cut with its supplied buffered gas quote. This study additionally allocates publication, treasury realization, failures and operating costs; it does not claim that current quote generation automatically aggregates every component.

The central scenario uses `f=5%`, failed compute at 50% of successful compute, the same posting allowance for a failed attempt, `N=10`, `B=100`, `h=0.3%`, `a=100%`, and zero fixed operating costs. Failure rate, haircut, sharing, conversion cost and allocation are **assumptions**. The token-conversion batch is a 350,000 all-in gas-equivalent planning allowance, including any approval/swap/unwrap/transfers and their posting; no live route quote supports that allowance. It is not added on top of a second data quote. Slippage/DEX losses belong in `h` only if not already included in a net realizable quote.

At these assumptions, cash break-even is about **50.15 times** cost; the 15% buffered fee threshold is about **57.67 times** cost. The buffer is company cost headroom, not a customer idle reserve. Reserving half the net revenue for other purposes doubles the consumed-fee threshold; reserving 25% raises it by one third. A 1% realization loss raises the baseline threshold by about 0.71%; 5% raises it by about 4.95%. Illiquid or unquoted fee assets cannot be assigned a cash value merely because the contract collected them.

## Publisher sharing and treasury batching

Table uses the recorded nonzero posting scenario and central assumptions above. `F` is consumed fee value, **not** the service fee charged to the owner.

| Recipe | Successful actions/publication N | Cost ETH | Cost USD | Buffered F, ETH | Buffered F, USD |
| --- | --- | --- | --- | --- | --- |
| Direct reinvestment | 1 | 0.00008158 | $0.224 | 0.00470474 | $12.93 |
| Direct reinvestment | 10 | 0.00007134 | $0.196 | 0.00411442 | $11.31 |
| Direct reinvestment | 100 | 0.00007032 | $0.193 | 0.00405539 | $11.15 |
| Swap + reinvestment | 1 | 0.00009936 | $0.273 | 0.00573032 | $15.75 |
| Swap + reinvestment | 10 | 0.00008912 | $0.245 | 0.00514000 | $14.13 |
| Swap + reinvestment | 100 | 0.00008810 | $0.242 | 0.00508096 | $13.97 |
| MINT successor | 1 | 0.00012063 | $0.332 | 0.00695690 | $19.12 |
| MINT successor | 10 | 0.00011039 | $0.303 | 0.00636658 | $17.50 |
| MINT successor | 100 | 0.00010937 | $0.301 | 0.00630754 | $17.34 |

Sharing only works for compatible executions using the same eligible pool/anchor within its **255-L2-block freshness bound** and any shorter applicable observation-age policy. Observed block spacing around 0.1 second suggests about 25.5 seconds, not an entitlement to that much time or enough throughput for 100 actions. `N=100` is a sensitivity, not demonstrated production capacity. Wasted/expired publications lower realized `N`; unrelated pools and observations separated by hours cannot share the same publication. Failed publication attempts must also be included in the actual publication budget; the simple table assumes publication succeeds. Publishing every 25 seconds whether work is ready would create 3,456 publications per pool per day. At the measured baseline footprint, that hypothetical cadence costs about **$78.73–$108.04 per pool per day** across the zero/nonzero posting scenarios, before any execution. It is not current behavior or a recommended schedule. Publish on demand for ready eligible work and measure actual sharing; continuous publication can dominate a low-volume service.

A refill transfers previously owned company assets. Native ETH needs only a transfer; WETH needs unwrap plus transfer; another fee token needs a quoted, permitted conversion. The company must bootstrap enough native ETH for the first transactions; future fee revenue cannot prepay the transaction that earns it.

| Treasury batch | One whole batch USD | Per success, B=10 | B=100 | B=1000 |
| --- | --- | --- | --- | --- |
| Native transfer | $0.0068 | $0.00068 | $0.00007 | $0.00001 |
| WETH unwrap + transfer | $0.0181 | $0.00181 | $0.00018 | $0.00002 |
| Token conversion, assumed 350k all-in | $0.0507 | $0.00507 | $0.00051 | $0.00005 |

For a different token, the assumed 200k–500k all-in conversion budget costs **$0.0290–$0.0724 per batch** at baseline, before token realization loss. A multi-hop route, approvals, extra wallets or difficult tokens can exceed it. One transfer here funds one destination; additional operator/publisher/refiller transfers need their own allowance. Manual and automated execution of the same treasury conversion have the same chain costs. Automation primarily improves replenishment reliability and adds monitoring/signing requirements.

## Three company-funded options

All ranges below keep `N=10`, `B=100`, the 5%/half-compute failure assumption, 0.3% realization haircut and 15% fee threshold buffer. Lower bounds use the zero posting scenario; upper bounds use the recorded nonzero posting scenario. Execution uses the same upper observed footprint throughout. These are **scenario ranges, not guaranteed bounds**. Fixed operating costs are separate.

| Option | Recipe | Marginal cost/success, USD | Buffered consumed fee value, USD |
| --- | --- | --- | --- |
| A — prefunded native ETH | Direct reinvestment | $0.177–$0.196 | $10.21–$11.28 |
| A — prefunded native ETH | Swap + reinvestment | $0.225–$0.245 | $12.97–$14.10 |
| A — prefunded native ETH | MINT successor | $0.284–$0.303 | $16.39–$17.48 |
| B — treasury conversion/refill | Direct reinvestment | $0.177–$0.196 | $10.22–$11.32 |
| B — treasury conversion/refill | Swap + reinvestment | $0.225–$0.245 | $12.99–$14.14 |
| B — treasury conversion/refill | MINT successor | $0.284–$0.304 | $16.40–$17.51 |
| C — sponsored, included API | Direct reinvestment | $0.214–$0.271 | $12.32–$15.62 |
| C — sponsored, included API | Swap + reinvestment | $0.266–$0.325 | $15.36–$18.72 |
| C — sponsored, included API | MINT successor | $0.331–$0.389 | $19.11–$22.42 |
| C — sponsored, over-quota API | Direct reinvestment | $0.226–$0.283 | $13.01–$16.31 |
| C — sponsored, over-quota API | Swap + reinvestment | $0.278–$0.337 | $16.05–$19.41 |
| C — sponsored, over-quota API | MINT successor | $0.343–$0.401 | $19.81–$23.12 |

**A — prefunded company ETH, manual replenishment.** Fits the existing EOA sender and admission model. The table allocates one native transfer per 100 successes; it assumes company treasury already has native ETH. Low software complexity and direct cost visibility favor launch. Manual lead time and isolated wallet balances can still stop execution. If replenishment requires selling tokens, add the corresponding treasury realization cost from B; initial company capital is working capital, not recurring revenue.

**B — separate automated company treasury realization and replenishment.** Collect the approved service share first, then convert only company assets and fund the operator/publisher. This preserves the user's 2% rate and fee-lot accounting. The table varies the all-in conversion budget from 200k to 500k per batch; no route, approval or sales automation currently qualifies that range. Benefits are fewer interruptions and systematic limits. Costs are token liquidity risk, price impact, refill failures and new treasury controls. Revenue on another chain or in an unavailable market is not immediately spendable local ETH.

**C — company-sponsored smart account/paymaster.** Model adds an assumed **100k–300k all-in incremental gas-equivalent per UserOperation**, covering validation/account/paymaster and additional posting overhead, before the sponsorship percentage. It assumes both execution and publication use sponsorship, charges failure attempts, and keeps B's central treasury-realization allocation for eventual company bill funding. That allocation is not a requirement to top up a managed paymaster. Real account deployment, complete UserOp gas, calldata and provider quotes are unmeasured; a first deployment may cost more. The current EOA validation/signer/nonce/receipt path needs a qualified account adapter. Native contract support alone does not make this a drop-in change.

The C table uses Pimlico's published **10% above EntryPoint actualGasCost** and compares included API quota with its illustrative **$0.0105 per sponsored UserOperation after quota**, applied to modeled execution attempts and publications. Actual polling/request use controls API credits. Commercial access and complete UserOp estimates remain unqualified. [Pimlico pricing](https://docs.pimlico.io/guides/pricing). Robinhood USDG is technically listed for ERC-20 payment, but its plan entitlement and live quote still need confirmation; this does not authorize charging customer assets. [Supported-token table](https://docs.pimlico.io/references/paymaster/erc20-paymaster/supported-tokens).

Alchemy publishes an **8% covered-gas surcharge**, but PAYG mainnet starts with a $0/month base sponsorship limit pending credits/custom limits. Its gas-only equivalent is included separately in calculation JSON; applying the same assumed account overhead yields slightly less than the 10% case, before any separate API or commercial costs. It is not an activated Domino quote. [Alchemy gas-manager terms](https://www.alchemy.com/docs/wallets/reference/gas-manager-faqs). Company sponsorship shifts who fronts and bills gas, not who ultimately pays. Provider availability, spend controls and invoicing can be useful; they introduce another execution dependency.

## Gas, failures and operating costs

Each cell below is `marginal cost / buffered consumed-fee threshold`, in USD at the dated ETH quote. Historical posting ETH costs are held fixed while L2 execution price changes; this isolates price sensitivity and is not a prediction of posting-price correlation. Gas prices above 0.5 gwei and larger posting charges remain possible.

| L2 price, gwei | Direct | Swap | MINT |
| --- | --- | --- | --- |
| 0.052694 | $0.196 / $11.31 | $0.245 / $14.13 | $0.303 / $17.50 |
| 0.1 | $0.355 / $20.50 | $0.447 / $25.80 | $0.559 / $32.23 |
| 0.25 | $0.861 / $49.64 | $1.089 / $62.81 | $1.369 / $78.96 |
| 0.5 | $1.703 / $98.20 | $2.158 / $124.48 | $2.719 / $156.82 |

The sampled high of 0.491854 gwei is over nine times the baseline, so a 15% estimation margin cannot protect an old quote across such a move. Re-quote and wait when eligibility fails. The following direct-execution sensitivity includes the same publication/refill allocations and posting assumption. Early `InvalidPrice` refusals in the local 20% run used 317,599/340,536 child gas, but later failures can cost much more; there is no single universal failure discount.

| Mined failure fraction | Failed compute 25%: cost / F | 50%: cost / F | 100%: cost / F |
| --- | --- | --- | --- |
| 0% | $0.191 / $11.00 | $0.191 / $11.00 | $0.191 / $11.00 |
| 1.00% | $0.191 / $11.03 | $0.192 / $11.06 | $0.193 / $11.11 |
| 5.00% | $0.194 / $11.18 | $0.196 / $11.31 | $0.201 / $11.57 |
| 10.00% | $0.197 / $11.38 | $0.202 / $11.65 | $0.212 / $12.20 |
| 25.00% | $0.211 / $12.14 | $0.225 / $12.96 | $0.253 / $14.60 |

Owning a node does not make hardware, electricity, backup, connectivity or staff free. A hypothetical **$50/month**, explicitly not measured Domino spending, allocates as follows to successful direct executions:

| Successes/month | Fixed opex/success | Total cost/success | Additional buffered fee basis | Total buffered fee basis |
| --- | --- | --- | --- | --- |
| 1000 | $0.050 | $0.246 | $2.88 | $14.19 |
| 10000 | $0.005 | $0.201 | $0.29 | $11.60 |

Use actual workload and costs: `O_USD = monthly fixed costs / successful executions + variable support/provider costs`. Avoid double counting an expense already covered by a reduced revenue allocation `a`. The figures above establish neither enough consumed-fee volume nor positive owner benefit to support those monthly counts.

For illustration, 1,000 baseline direct successes consume about **0.07134046 ETH ($196.10)**, or **0.08204153 ETH** with the model's 15% spending headroom, before fixed costs. That is a workload budget, not a sufficient wallet balance rule. Current signing checks the maximum transaction liability (`gasLimit * maxFeePerGas`), which can exceed expected receipt cost. Reserve outstanding maximum liabilities, the next eligible transaction and burn during refill lead time; mutually exclusive replacements at one nonce use the maximum liability, not the sum of every candidate. Size publisher and refill wallets too. See [signer](../../backend/execution_signer.py) and [economic gate](../../backend/execution_planner.py).

## Decision and remaining evidence

Use A for a controlled launch, with company ETH buffers and honest full-path cost inputs. Build B as a separate, limited treasury service if recurring volume makes manual funding fragile. Treat C as an optional account/billing integration after estimating its complete UserOperations and confirming commercial access. None requires an extra customer fee or a sale of principal. A customer gas escrow or an additional deduction would be a different product policy, not implied by this study.

Before assigning a live threshold, obtain coherent native Nitro estimates for actual deployed calldata/account state, a real realization route or cash value for each fee currency, measured failure/publication utilization, workload and infrastructure cost, and provider terms where relevant. Keep the owner-benefit gate independent. The present evidence establishes useful order-of-magnitude costs and sensitivity; it does not prove that every vault, fee lot or market condition is economically executable.

## Reproduction and arithmetic checks

Run `python3 reports/gas-funding-2026-09-21/reproduce_economics.py --out-dir /tmp/domino-gas-economics-reproduced` from the integrated checkout. The script uses committed evidence and the standard Python library only; it has no network or wallet access. It regenerates this report and calculation JSON, checks the zero-cost-component identity and the 57.5-times buffered threshold at zero haircut, monotonic sharing/failure/price sensitivities, the revenue-allocation identity, AA-to-EOA reduction when overhead and markup are zero, same-response posting arithmetic, and recorded price/MINT inputs. Timestamp and source hashes deliberately reflect the inputs used for that reproduction. These checks validate arithmetic and provenance, not the assumed failure rates, conversion route, provider gas or workload.
