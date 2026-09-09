// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Proposed fee arithmetic only; this library provides no asset custody.
library FeeAccounting {
    uint16 internal constant MAX_SERVICE_FEE_BPS = 200;
    error ExcessiveFee();
    error InsufficientReserve();

    /// @dev Only gross USED fees are charged. Retained reserves remain uncharged.
    function consume(uint128 reserve, uint128 grossUsed, uint16 feeBps)
        internal pure returns (uint128 netAdded, uint128 protocolFee, uint128 remaining)
    {
        if (feeBps > MAX_SERVICE_FEE_BPS) revert ExcessiveFee();
        if (grossUsed > reserve) revert InsufficientReserve();
        protocolFee = uint128(uint256(grossUsed) * feeBps / 10_000);
        netAdded = grossUsed - protocolFee;
        remaining = reserve - grossUsed;
    }
}
