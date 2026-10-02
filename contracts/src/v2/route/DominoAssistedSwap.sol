// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {DominoFeeLedger} from "../fees/DominoFeeLedger.sol";
import {DominoFeeRules} from "../fees/DominoFeeRules.sol";
import {DominoSwapExecutor} from "./DominoSwapExecutor.sol";

/// @notice The assisted swap of a manual action (#283 S1): the plan's legs,
/// executed and accepted by effect, then the 65 bps fee in the token the
/// charge-currency rule selects. The zap and the vault inherit this.
abstract contract DominoAssistedSwap is DominoSwapExecutor, DominoFeeLedger {
    constructor(RouteConfig memory config) DominoSwapExecutor(config) DominoFeeLedger(config.registry) {}

    /// @notice Checks the intent's fee terms against the legs, executes them
    /// and charges the fee.
    /// @param feeBps The signed intent's feeBps: FEE_ASSISTED_SWAP_BPS, or 0 with no legs.
    /// @param feeToken The signed intent's feeToken: the rule's selection, or 0 with no legs.
    /// @param payer The owner the fee is charged to (FeeCharged.payer).
    /// @param ref The intent hash (FeeCharged.ref).
    /// @return amountsOut What each leg delivered, measured.
    /// @return fee The fee charged in feeToken: 65 bps of the swapped amount, rounded down.
    function _assistedSwap(
        DominoV2Types.SwapLeg[] memory legs,
        address[] memory extraTracked,
        uint16 feeBps,
        address feeToken,
        address payer,
        bytes32 ref
    ) internal returns (uint256[] memory amountsOut, uint256 fee) {
        DominoFeeRules.requireAssistedSwapTerms(ROUTE_REGISTRY, legs, feeBps, feeToken);
        amountsOut = _executeLegs(legs, extraTracked);
        fee = DominoFeeRules.feeOf(DominoFeeRules.swappedAmount(legs, amountsOut, feeToken), feeBps);
        _chargeFee(DominoV2Types.FEE_KIND_ASSISTED_SWAP, feeToken, payer, fee, ref);
    }
}
