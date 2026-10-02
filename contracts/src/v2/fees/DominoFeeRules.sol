// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {IDominoPositionActions} from "../interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../interfaces/IDominoRegistry.sol";

/// @notice Where and how much Domino charges (owner decisions of 1 Oct 2026,
/// docs/v2/F0_INTERFACES.md). Pure rules: no transfer happens here.
/// @dev The assisted-swap fee of a manual action is charged in one token,
/// chosen from the plan's swap legs by the registry's charge-currency ranks
/// (Robinhood: USDG, then ETH/WETH; Base and Arbitrum: USDC, then ETH/WETH):
/// the best-ranked charge currency among the legs' tokens, looked up first
/// among the inputs, then the outputs, then the route hops; ties (ETH and WETH
/// share a rank) go to the earlier place, then to the earlier leg. With no
/// charge currency in the route, the fee is charged in the first leg's input.
/// A hop is a token one leg delivers and a later leg spends, i.e. a leg
/// boundary; hops inside one Universal Router call or one pool path are not
/// visible to the contract and do not count. Every v3/v4 pool is accepted:
/// the rule only selects the token.
library DominoFeeRules {
    error InvalidFeeMode();

    /// Where the selected fee token appears in the route.
    uint8 internal constant FROM_INPUT = 1;
    uint8 internal constant FROM_OUTPUT = 2;
    uint8 internal constant FROM_HOP = 3;
    /// No charge currency in the route: the first leg's input.
    uint8 internal constant FROM_FALLBACK = 4;

    uint256 internal constant BPS = 10_000;

    /// @notice The token the assisted-swap fee is charged in, and where it was found.
    /// @dev Reverts with InvalidPlan on an empty route: no swap, no fee.
    function assistedSwapFeeToken(IDominoRegistry registry, DominoV2Types.SwapLeg[] memory legs)
        internal
        view
        returns (address token, uint8 source)
    {
        uint256 count = legs.length;
        if (count == 0) revert IDominoPositionActions.InvalidPlan();
        uint256 bestRank = type(uint256).max;
        for (uint8 place = FROM_INPUT; place <= FROM_HOP; ++place) {
            for (uint256 i; i < count; ++i) {
                address spent = legs[i].tokenIn;
                if (_place(legs, i, spent, true) == place) {
                    uint256 rank = registry.chargeCurrencyRank(spent);
                    if (rank != 0 && rank < bestRank) (bestRank, token, source) = (rank, spent, place);
                }
                address delivered = legs[i].tokenOut;
                if (_place(legs, i, delivered, false) == place) {
                    uint256 rank = registry.chargeCurrencyRank(delivered);
                    if (rank != 0 && rank < bestRank) (bestRank, token, source) = (rank, delivered, place);
                }
            }
        }
        if (source == 0) (token, source) = (legs[0].tokenIn, FROM_FALLBACK);
    }

    /// @notice The swapped amount, in `token`, that the assisted-swap fee is
    /// a fraction of: the larger of what the legs spent in `token` (signed
    /// amountIn) and what they delivered in it (measured `amountsOut`). An
    /// input or a hop counts what entered the swap, an output what came out;
    /// a hop the plan barely spends is still charged on what it carried.
    function swappedAmount(DominoV2Types.SwapLeg[] memory legs, uint256[] memory amountsOut, address token)
        internal
        pure
        returns (uint256 amount)
    {
        if (amountsOut.length != legs.length) revert IDominoPositionActions.InvalidPlan();
        uint256 spent;
        uint256 delivered;
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].tokenIn == token) spent += legs[i].amountIn;
            if (legs[i].tokenOut == token) delivered += amountsOut[i];
        }
        amount = spent > delivered ? spent : delivered;
    }

    /// @notice `bps` of `amount`, rounded down (in the payer's favour).
    function feeOf(uint256 amount, uint16 bps) internal pure returns (uint256) {
        return amount * bps / BPS;
    }

    /// @notice The intent's fee terms against the plan: with no swap leg
    /// feeBps and feeToken are zero; otherwise feeBps is the assisted-swap
    /// tariff and feeToken the rule's selection (address(0) is native ETH).
    function requireAssistedSwapTerms(
        IDominoRegistry registry,
        DominoV2Types.SwapLeg[] memory legs,
        uint16 feeBps,
        address feeToken
    ) internal view {
        if (legs.length == 0) {
            if (feeBps != 0 || feeToken != address(0)) revert IDominoPositionActions.FeeMismatch();
            return;
        }
        (address selected,) = assistedSwapFeeToken(registry, legs);
        if (feeBps != DominoV2Types.FEE_ASSISTED_SWAP_BPS || feeToken != selected) {
            revert IDominoPositionActions.FeeMismatch();
        }
    }

    /// @notice The automation tariff for a vault mode, charged once on the
    /// consumed fees of each pool token (proportional in both).
    function automationFeeBps(uint8 mode) internal pure returns (uint16) {
        if (mode == DominoV2Types.MODE_SIMPLE) return DominoV2Types.FEE_AUTOMATION_SIMPLE_BPS;
        if (mode == DominoV2Types.MODE_DOMINO) return DominoV2Types.FEE_AUTOMATION_DOMINO_BPS;
        revert InvalidFeeMode();
    }

    /// Where `token` sits at leg `index`: as spent (`asInput`) it is a hop when
    /// an earlier leg delivered it, else an input; as delivered it is a hop
    /// when a later leg spends it, else an output.
    function _place(DominoV2Types.SwapLeg[] memory legs, uint256 index, address token, bool asInput)
        private
        pure
        returns (uint8)
    {
        if (asInput) {
            for (uint256 j; j < index; ++j) {
                if (legs[j].tokenOut == token) return FROM_HOP;
            }
            return FROM_INPUT;
        }
        for (uint256 j = index + 1; j < legs.length; ++j) {
            if (legs[j].tokenIn == token) return FROM_HOP;
        }
        return FROM_OUTPUT;
    }
}
