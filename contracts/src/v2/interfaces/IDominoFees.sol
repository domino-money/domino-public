// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice How every fee-charging contract (zap, vault, auto-exit) reports and
/// settles Domino's fees.
/// @dev A fee is transferred to the registry's fee recipient in the same
/// transaction. If that transfer fails (a frozen or taxed recipient, a
/// rejecting native receiver) the action does not revert: the amount is kept
/// as owed, never spendable by the owner, and anyone may flush it later to the
/// recipient in force at that time.
interface IDominoFeeEvents {
    /// @param kind DominoV2Types.FEE_KIND_*.
    /// @param ref The action, intent or mandate hash the fee belongs to.
    event FeeCharged(uint8 indexed kind, address indexed token, address indexed payer, uint256 amount, bytes32 ref);
    event FeeDeferred(address indexed token, uint256 amount, uint256 totalOwed);
    event OwedFeesFlushed(address indexed token, address indexed recipient, uint256 amount);
}

interface IDominoFeeSettlement is IDominoFeeEvents {
    function owedFees(address token) external view returns (uint256);
    /// Pays the owed amount of `token` to the current fee recipient. Anyone may call.
    function flushOwedFees(address token) external returns (uint256 amount);
}
