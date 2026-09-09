# Revert fee review and Domino implications

Checked 9 September 2026 against current first-party documentation. Research and product planning only; no wallet was connected, no transaction was signed and no Domino pricing code was changed.

## Findings

The documentation associates the creation-flow charge with swaps used to fund or balance a position. It does not establish a universal standalone fee for minting a position NFT or initializing an ordinary Uniswap pool. Directly opening the current documentation matters: search snippets still described a flat 0.65%, while the current pages describe dynamic swap pricing with a 0.65% cap.

| Service | Published charge and basis | Treatment and source |
|---|---|---|
| Ordinary position management without a swap | No Revert fee | Applies to ordinary add/remove/claim flows; wallet gas remains separate. [Position management](https://docs.revert.finance/revert/position-management) |
| Assisted swaps, including position creation and management | Dynamic; eligible stablecoin pairs can reach 0.01%; capped at 0.65% | Applicable quote shown before confirmation. Documentation says pricing generally follows the pool fee tier, but does not provide a universal formula or fully specify every route's collection basis. [Position management](https://docs.revert.finance/revert/position-management), [creation guide](https://docs.revert.finance/revert/initiator/start-providing-liquidity) |
| Uniswap auto-compounder | 2% of collected-and-compounded fees | Shared between protocol and executor compensation; do not count it all as profit or add executor compensation to it again. [Auto-compounder](https://docs.revert.finance/revert/auto-compounder) |
| Manual SelfCompoundor | 1% of compounded amounts, described as a performance fee | Separate technical contract path; not evidence that all ordinary manual transactions cost 1%, or that every current interface uses it. Verify the applicable contract/quote. [Self-compounder](https://docs.revert.finance/revert/technical-docs/self-compounder) |
| Auto-Range | Choose 0.15% of position assets **or** 2% of uncollected fees at execution | Additional configured gas budget; these alternatives are not cumulative. Unspent gas budget remains capital for the next position. [Auto-Range](https://docs.revert.finance/revert/auto-range) |
| Auto-Exit | Choose 0.15% of position assets **or** 2% of uncollected fees at execution | Additional configured gas budget; unused budget returns to the owner. [Auto-Exit](https://docs.revert.finance/revert/auto-exit) |
| Aerodrome AERO auto-compounding | 1% protocol fee plus 1% gas fee | Applies to reinvested AERO rewards, a different earning source from Uniswap swap fees. [AERO auto-compounding](https://docs.revert.finance/revert/aerodrome/aero-auto-compounding) |

## Other economic flows

Revert Lend borrowers pay variable interest based on utilization. Lenders receive interest; the full borrower payment is not protocol revenue. [Borrowing](https://docs.revert.finance/revert/revert-lend/borrowing), [lending](https://docs.revert.finance/revert/revert-lend/lending)

The V3Vault implementation retains a configurable portion of interest through `reserveFactorX32`, and restricts withdrawals to excess reserves above a protection threshold. Its current setting is deployment-specific and was not verified here; no universal current percentage is asserted. Source pinned to commit `7e85a81ac97663a3a731f6d6f07f14d774962a6e`: [V3Vault](https://github.com/revert-finance/lend/blob/7e85a81ac97663a3a731f6d6f07f14d774962a6e/src/V3Vault.sol).

Lending liquidations have a documented 2–10% penalty relative to debt, paid through collateral to the liquidator. This is not automatically a fee to the Revert treasury. No separate fixed origination charge or leverage surcharge was established by the pages reviewed. [Liquidations](https://docs.revert.finance/revert/revert-lend/liquidations), [leverage](https://docs.revert.finance/revert/revert-lend/leverage)

Stable Hooks documents configurable hook/protocol shares taken from gross LP trading fees. The technical page labels these deployments pre-launch; it does not establish a universal active percentage or a flat pool-creation charge. This is a different product with different accounting, outside Domino's hookless alpha. [Stable Hooks technical documentation](https://docs.revert.finance/revert/technical-docs/stable-hooks)

## Verification limits and interpretation

The public discovery interface loaded without a connected account, but no personalized transaction quote or receipt was obtained. The rate findings above are published schedules, not a reconstruction of one wallet's exact charge. Dynamic route-specific bases, live reserve factors and deployment coverage require transaction-level verification before claiming an exact replica.

Keep Revert service revenue, gas/executor reimbursement, underlying DEX trading fees, lending interest and liquidation incentives separate. Do not assume a standalone assisted-swap fee stacks on every auto-compound/auto-range swap: the reviewed pages do not establish such universal stacking. Do not treat a maximum swap fee as the rate paid by every user.

This review supports adding assisted-swap monetization to Domino's creation flow. A blanket charge on every deposit or every new underlying pool would be Domino's own pricing choice, not a confirmed imitation of Revert. The agreed ongoing fee-only Domino strategy also differs from Auto-Range's withdrawal and redeployment of principal.

## Recommended Domino direction

Use two revenue lines in alpha: a disclosed fee for owner-requested assisted swaps, and the existing 2% cut on earned fees consumed by automation. Preserve ordinary creation/management without an assisted swap as free of a Domino setup fee in this baseline. The user authorized pursuing monetization modeled on Revert; the exact dynamic rate table remains a proposed calibration, not a deployed charge.

[PRICING_POLICY.md](PRICING_POLICY.md) specifies the bases, caps, non-stacking rule, examples and remaining implementation work. Paid manual compounding, Auto-Exit, lending or custom hooks are separate potential services; this competitor review does not add them to the alpha.
