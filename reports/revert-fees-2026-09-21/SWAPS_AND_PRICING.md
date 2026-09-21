# Revert assisted swaps: pricing, collection and Domino comparison

Research date: **21 September 2026**. Read-only review of official documentation, public repository source and the publicly served application bundle. Repositories were cloned under `/tmp`; no external application/test code was executed, wallet connected, signature requested or transaction sent. AutoCompound, SelfCompoundor, AutoRange and AutoExit have a separate review; this report covers their swap integration boundary only.

**Finding:** Revert currently advertises a dynamic assisted-swap service fee capped at **0.65%**, with eligible stablecoin pairs as low as **0.01%**. Ordinary position management without swaps is advertised as fee-free. The examined current Utils source does **not** hard-code that schedule or a protocol fee recipient: it accepts router calldata and checks resulting token deltas. Consequently, the documentation establishes the product tariff, while a specific quote, nested router commands and receipt are needed to establish the exact token, basis and recipient for a real transaction. A Domino charge of **2% of assisted-swap volume** would be a separate, materially higher tariff; Revert's 2% compounding fee is not evidence for it.

## Current documentation versus historical wording

The current [position-management page](https://docs.revert.finance/revert/position-management) says the applicable fee is shown before confirmation, generally follows the pool fee tier, and is capped at 0.65%; eligible stablecoin pairs can pay 0.01%. It covers swaps used when adding, withdrawing or claiming. This is a conditional advertised low rate, not proof of a universal on-chain minimum or a deterministic formula for every pool.

The current [creation guide](https://docs.revert.finance/revert/initiator/start-providing-liquidity) distinguishes depositing the correct token ratio without a swap from custom amounts that may require balancing. Its preview includes swap amounts/direction and the applicable rate, capped at 0.65%. Neither page establishes a separate universal mint-NFT or initialize-pool percentage fee.

Search results still returned older flat-0.65% wording for the same page. Direct page reads returned the dynamic schedule. This establishes a documentation/index discrepancy, not the date of a tariff change or proof that historical users all paid 0.65%. The current public UI also contains additional fee-display branches described below; none was promoted into a live fee claim without a quote/receipt.

## Source identities and naming

| Official repository/ref inspected | Exact SHA | Relevant source |
| --- | --- | --- |
| `revert-finance/v3utils`, main | `e29e49af36ee05d2c9734fc4cdb1855c929555e9` | [V3Utils, header/constructor](https://github.com/revert-finance/v3utils/blob/e29e49af36ee05d2c9734fc4cdb1855c929555e9/src/V3Utils.sol#L11-L59) |
| `revert-finance/v3utils`, historical `fees-in-contract` branch | `1de29a580a9472f38a727f77d5d27242048f57f8` | [Immutable reward parameters](https://github.com/revert-finance/v3utils/blob/1de29a580a9472f38a727f77d5d27242048f57f8/src/V3Utils.sol#L19-L68) |
| `revert-finance/lend`, main | `7e85a81ac97663a3a731f6d6f07f14d774962a6e` | [V3Utils v1.1](https://github.com/revert-finance/lend/blob/7e85a81ac97663a3a731f6d6f07f14d774962a6e/src/transformers/V3Utils.sol#L12-L39), [Swapper](https://github.com/revert-finance/lend/blob/7e85a81ac97663a3a731f6d6f07f14d774962a6e/src/utils/Swapper.sol#L51-L110) |
| `revert-finance/v4lend`, main | `e02e056d3cfbce5542eeaac3aff4306cffcad0f1` | [V4Utils v1.0](https://github.com/revert-finance/v4lend/blob/e02e056d3cfbce5542eeaac3aff4306cffcad0f1/src/vault/transformers/V4Utils.sol#L23-L41), [Swapper](https://github.com/revert-finance/v4lend/blob/e02e056d3cfbce5542eeaac3aff4306cffcad0f1/src/shared/swap/Swapper.sol#L59-L137) |
| `Uniswap/universal-router`, main; integration-mechanism reference only | `64027f3372aa235734207c4e05667204f6f927e1` | [Payments](https://github.com/Uniswap/universal-router/blob/64027f3372aa235734207c4e05667204f6f927e1/contracts/modules/Payments.sol#L38-L85) |

No distinct `V3UtilsV2.sol`/`contract V3UtilsV2` was found in the inspected official repositories and fetched v3utils history. The v3utils `v2.0.0` tag resolves to `6d20f3540719a66295737daa5e8e84d0bc99fa2e` and still contains a contract named `V3Utils`; the newer lend source labels its contract v1.1. Do not conflate repository tags, Utils labels and the **0x Swap API v2** integration. A differently named deployment would need its exact source/address before assigning it a fee formula.

## What the Utils actually charge

### Mainline V3Utils and the newer V3/V4 variants

The old mainline V3Utils forwards encoded swap data to its immutable 0x router, approves the requested input budget, clears the approval, measures input/output balance deltas and checks minimum output. It has no internal Revert percentage deduction, configurable fee schedule or fee receiver in this path. [V3Utils `_swap`, lines 539–575](https://github.com/revert-finance/v3utils/blob/e29e49af36ee05d2c9734fc4cdb1855c929555e9/src/V3Utils.sol#L539-L575).

There is direct historical integration evidence for a router-level affiliate fee: committed test fixtures request `buyTokenPercentageFee=0.01` with a specific `feeRecipient`, then embed the resulting 0x data. That is a **1% test quote**, not a current 1% Revert tariff or authenticated current treasury address. [Official test fixture, lines 913–924](https://github.com/revert-finance/v3utils/blob/e29e49af36ee05d2c9734fc4cdb1855c929555e9/test/integration/V3Utils.t.sol#L913-L924).

The newer lend V3Utils and v4lend V4Utils dispatch to either an immutable Universal Router or 0x AllowanceHolder. For Universal Router they forward a command sequence; for 0x they submit caller-supplied data with a bounded approval/value. They measure what leaves and arrives and enforce `amountOutMin`. Neither examined shared swapper deducts an additional fixed Revert swap fee. V4 also has a direct native/wrapped-native conversion branch. A Solidity field named `fee` in mint/pool parameters is the **pool fee tier**, not a Revert service tariff. [V3 Swapper, lines 69–110](https://github.com/revert-finance/lend/blob/7e85a81ac97663a3a731f6d6f07f14d774962a6e/src/utils/Swapper.sol#L69-L110), [V4 Swapper, lines 77–137](https://github.com/revert-finance/v4lend/blob/e02e056d3cfbce5542eeaac3aff4306cffcad0f1/src/shared/swap/Swapper.sol#L77-L137), [V4 pool construction](https://github.com/revert-finance/v4lend/blob/e02e056d3cfbce5542eeaac3aff4306cffcad0f1/src/vault/transformers/V4Utils.sol#L729-L736).

This does not mean the app's swap is free: a fee transfer can be part of those nested router instructions, reflected in lower net output or greater input consumed. The helper does not independently enforce the advertised 65-bps cap, identify each fee recipient or break out pool fees versus affiliate fees from a single balance delta.

### Historical `fees-in-contract` branch: explicit output fee

The 18 July 2023 branch adds immutable `protocolRewardX64` and `protocolRewardReceiver` constructor arguments. After a successful router call it computes:

`reward = floor(outputBalanceDelta × protocolRewardX64 / 2^64)`

It pays the reward **in the output token**, subtracts it from returned output, then tests the user's minimum against the remaining output. The `Swap` event reports input delta and output after this explicit reward. Because the basis is a balance delta, a partial swap produces a reward based on what arrived, not the entire originally proposed input. There is no monetary floor; integer rounding may produce zero. The `uint64` representation bounds the ratio below 100%, but the constructor does not impose a 0.65% business cap. [Reward formula and order of operations, lines 552–590](https://github.com/revert-finance/v3utils/blob/1de29a580a9472f38a727f77d5d27242048f57f8/src/V3Utils.sol#L552-L590).

This is a historical alternative implementation, not evidence that current production runs it. No deployed address, constructor ratio or receiver was matched to this branch. It also does not inspect router data for another affiliate fee: combining both mechanisms could charge at both layers. The code alone cannot establish whether any real integration did so.

## Router-level bases, recipients and caps

| Mechanism | Basis and settlement | What can be concluded for Revert |
| --- | --- | --- |
| Historical 0x API v1 affiliate fee | `buyTokenPercentageFee` designates a fraction of buy amount paid in the buy token to `feeRecipient`. | Revert's committed fixture shows this option was used in tests. It does not prove the current rate or address. [0x's dated 2023 guide](https://beta.0x.org/post/monetize-crypto-trading-in-your-app-with-swap-api). |
| Current 0x API v2 affiliate fee | `swapFeeRecipient`, `swapFeeBps`, `swapFeeToken`; fee token may be sell or buy token, and the quote returns amount/token. Default API fee limit is 1,000 bps, not Revert's 65-bps tariff. | A returned quote and decoded settlement are needed to determine the actual choice. The guide's explicit sell-token example uses `bps/10000 × sellAmount`; it also contains a buy-amount comment, so do not apply a sell-token integer formula to a differently denominated buy-token fee. [0x monetization guide](https://docs.0x.org/evm/0x-swap-api/guides/monetize-your-app-using-swap). |
| Universal Router `PAY_PORTION` | Sends a portion of its **current balance of the specified token** to the encoded recipient. `TRANSFER` can instead send an exact amount. | Command order determines whether that balance represents funding input, swap output or another intermediate balance. The command is a mechanism, not proof Revert used it in a particular call. [Pinned payment source](https://github.com/Uniswap/universal-router/blob/64027f3372aa235734207c4e05667204f6f927e1/contracts/modules/Payments.sol#L22-L68), [dispatcher](https://github.com/Uniswap/universal-router/blob/64027f3372aa235734207c4e05667204f6f927e1/contracts/base/Dispatcher.sol#L153-L181). |
| Route/venue costs | Pool trading charges, price impact, provider fees and possibly positive-slippage allocation affect final proceeds. | They are not automatically Revert revenue. The quote's separate `integratorFee` and `zeroExFee` fields matter. [0x v2 response and migration guide](https://docs.0x.org/docs/upgrading/upgrading-to-swap-v2). |

0x API v1 was retired on 11 April 2025 according to its migration guide. Its historical fee arguments should not be presented as the current API. Current 0x monetization supports trade-surplus allocation under specified commercial plans; this study did not establish that Revert enables it or receives that surplus. Router fee capabilities and current Revert policy are separate evidence categories.

## Authorization, partial fills and refunds

For direct swap/funding calls, the caller supplies token budget, output minimum, routing bytes and recipient fields, and provides the relevant token approval/permit or native value. NFT-management actions additionally validate position custody/caller authorization; NFT return and leftover recipients are distinct fields. The newer V3 flow supports owner permit plus execution, and the V4 transformer admits the owner/self-custody or an approved vault's active transform. This authorization is not a separate on-chain signature over a canonical Revert fee schedule. [V3 authorization](https://github.com/revert-finance/lend/blob/7e85a81ac97663a3a731f6d6f07f14d774962a6e/src/transformers/V3Utils.sol#L95-L148), [V4 caller validation](https://github.com/revert-finance/v4lend/blob/e02e056d3cfbce5542eeaac3aff4306cffcad0f1/src/vault/transformers/Transformer.sol#L49-L61).

Both newer `swap` helpers return actual received output and refund `amountIn − amountInDelta` to the selected recipient. A third funding token can be split across two swaps, with the unspent third-token remainder returned; unused pool assets after mint/increase also return. V4's liquidity helpers intentionally account for final whole balances as leftovers. [V3 swap/refund](https://github.com/revert-finance/lend/blob/7e85a81ac97663a3a731f6d6f07f14d774962a6e/src/transformers/V3Utils.sol#L405-L435), [V4 swap/refund](https://github.com/revert-finance/v4lend/blob/e02e056d3cfbce5542eeaac3aff4306cffcad0f1/src/vault/transformers/V4Utils.sol#L578-L607), [V4 split funding/refund](https://github.com/revert-finance/v4lend/blob/e02e056d3cfbce5542eeaac3aff4306cffcad0f1/src/vault/transformers/V4Utils.sol#L870-L916), [V4 liquidity leftovers](https://github.com/revert-finance/v4lend/blob/e02e056d3cfbce5542eeaac3aff4306cffcad0f1/src/vault/transformers/V4Utils.sol#L838-L866).

These refunds do not prove an affiliate charge was proportionally refunded. An input fee transferred away is part of the input debit; an output fee taken before funds reach Utils is already absent from output. Its partial-fill treatment depends on the actual router sequence. Universal Router's optional allow-revert flag also requires explicit cleanup commands to recover router-held leftovers. [Official command/cleanup documentation](https://developers.uniswap.org/docs/protocols/universal-router/concepts/commands).

If the encompassing transaction reverts, its transfers revert too, while network gas can be spent. Conversely, leftover liquidity dust after a successful assisted swap does not imply the completed swap service should be free: the exchange occurred. Do not infer an extra Revert service charge at every intermediate hop merely because a route touches several pools; decode all fee-transfer commands before counting charges.

## Funding swaps versus reinvestment swaps

The Utils `COMPOUND_FEES` path can perform a balancing swap and increase liquidity; no separate fixed 2% compounding deduction appears in the examined Utils path itself. It must be distinguished from the separately deployed AutoCompound/SelfCompoundor products. [V3 compound dispatch](https://github.com/revert-finance/lend/blob/7e85a81ac97663a3a731f6d6f07f14d774962a6e/src/transformers/V3Utils.sol#L180-L252), [V4 compound dispatch](https://github.com/revert-finance/v4lend/blob/e02e056d3cfbce5542eeaac3aff4306cffcad0f1/src/vault/transformers/V4Utils.sol#L246-L281).

The parallel automator review found no explicit extra Revert assisted-swap debit in the current shared router swapper; automatic paths still have their own reward accounting and venue costs. This does **not** establish that every arbitrary router payload is free of affiliate fees. It also does not support a universal claim that Revert stacks its advertised 0.65% cap on top of every auto-compound, range or exit charge. Exact function, source version, configuration and nested swap data must be checked together.

## Public frontend observation and live-evidence limits

The homepage served [application bundle `app.C46CA8AE2B38C7F0047EECF6408B5CB9.js`](https://revert.finance/js/app.C46CA8AE2B38C7F0047EECF6408B5CB9.js), 17,545,838 bytes, SHA-256 `d6ec5d794870e369e03b6194f161de27998fc415629c53e373573d518d68d242`. It was downloaded and read as text only. At served line 27,558, display function `Hjc` formats a supplied fee, conditionally adds 0.15 percentage points, and has 0.65%/0.80% fallbacks. At line 24,138, `UMb` contains 0.65/0.55/0.45/0.35/0.25 values associated with thresholds. The bundle also contains a `revertFees` response field.

Those observations are evidence of shipped display code, **not proof that a specific branch currently executes, what the threshold represents, who receives the added amount, or what settlement charges**. The study did not call private quote endpoints or run the bundle. Dynamic documentation and static fallbacks should therefore be reported separately; the next conclusive artifact would be a real public quote response plus decoded transaction/receipt, not a guess from minified names.

The [official address list](https://docs.revert.finance/revert/resources/contract-addresses) currently includes V4Utils on Robinhood at `0xd322Dc8F96004d2A92a2ae821b99D25eBB2a3EA4`, as well as other networks and V3Utils v1.1 deployments. That listing establishes published deployment intent/identity, not deployed-source equivalence or current fee parameters. A read-only attempt to retrieve Robinhood Blockscout's verified-source API returned HTTP 403. No live constructor setting, current recipient, bytecode/source match or representative settled swap was established here.

## Comparison with a proposed Domino 2% assisted-swap fee

The existing [Domino pricing policy](../../PRICING_POLICY.md) separates an assisted-swap cap of **65 bps on consumed selected swap input** from **200 bps on consumed earned fees for automation**, with no internal automated-swap stacking. A proposal to charge 200 bps on assisted-swap volume changes the first boundary. It should be described as a new Domino tariff, not implementation of Revert's advertised schedule. Subsequent decisions about separate Domino automation modes are a different pricing axis.

For the **same economically comparable chargeable swap amount**, 2% is about **3.08 times** a 0.65% fee, a **1.35 percentage-point** increase; versus 0.01%, it is 200 times the nominal rate. Input- and output-denominated fees are not exactly interchangeable when execution price, taxes or rounding differ, so compare final proceeds as well as headline percentages.

Illustration only: a $1,000 deposit that actually swaps $500 produces $10 at a 2% input fee, versus $3.25 at 0.65%, before venue costs and gas. Charging $20 on the entire deposit instead would use a different base. A direct deposit with no swap has no assisted-swap base under the current policy.

Likewise, 2% of earned fees and 2% of swapped volume cannot be casually added or substituted. If $100 of earned fees is the automation base and $20 is separately made subject to another gross swap charge, the nominal charges would be $2 plus $0.40 under that hypothetical specification; taking the swap fee after another deduction changes the calculation. Such stacking is explicitly excluded by the current policy and was not established as Revert's universal practice.

If Domino adopts a new assisted-swap rate, its implementation should retain explicit gross-input basis, floor rounding in token units, rate/version, exact fee recipient, maximum debit, net DEX input, net output floor, expiry and owner consent. A route change must not silently change that reviewed fee. Charge once on the authorized consumed base, reconcile partial execution/refunds, and distinguish Domino revenue from venue/provider fees and surplus allocation. The Revert research provides useful mechanisms and comparisons; it does not authorize changing those Domino rules.

Validation performed: static source and history inspection, primary documentation reads, exact repository SHA capture, public bundle digest and line references, and report/link hygiene. No Forge/npm execution, deployment or contract runtime test was performed for this research-only report.
