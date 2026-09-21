// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Proposed fee arithmetic only; this library provides no asset custody.
library FeeAccounting {
    // The stored tariff is the mode discriminator; no action-based pricing.
    uint16 internal constant SIMPLE_SERVICE_FEE_BPS = 200;
    uint16 internal constant DOMINO_SERVICE_FEE_BPS = 400;
    uint16 internal constant MAX_SERVICE_FEE_BPS = DOMINO_SERVICE_FEE_BPS;

    function isSimple(uint16 feeBps) internal pure returns (bool) {
        return feeBps == SIMPLE_SERVICE_FEE_BPS;
    }

    function validTariff(uint16 feeBps) internal pure returns (bool) {
        return isSimple(feeBps) || feeBps == DOMINO_SERVICE_FEE_BPS;
    }
    error ExcessiveFee();
    error InsufficientReserve();

    /// @dev Only gross USED fees are charged. Retained reserves remain uncharged.
    /// Floor rounding in each currency's integer base units is intentional policy:
    /// the remainder favors the owner. Zero fees are valid (including feeBps == 0
    /// or grossUsed * feeBps < 10_000); do not round up or impose a one-unit toll.
    /// At 200 bps, 49 consumed base units yield zero fee and 50 yield one unit.
    /// This arithmetic does not authorize consumption. Its caller MUST enforce
    /// owner/operator authority, proven earned-fee balances and an economically
    /// justified minimum consumption (or an explicitly capped project subsidy).
    /// That minimum depends on token units and full-path costs; no universal dust
    /// threshold is selected here, and repeated tiny calls are not an approved
    /// way to bypass the economic gate. This no-swap split supplies no swap ledger.
    function consume(uint128 reserve, uint128 grossUsed, uint16 feeBps)
        internal
        pure
        returns (uint128 netAdded, uint128 protocolFee, uint128 remaining)
    {
        if (feeBps > MAX_SERVICE_FEE_BPS) revert ExcessiveFee();
        if (grossUsed > reserve) revert InsufficientReserve();
        protocolFee = uint128(uint256(grossUsed) * feeBps / 10_000);
        netAdded = grossUsed - protocolFee;
        remaining = reserve - grossUsed;
    }
}
