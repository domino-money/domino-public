// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Token calls for the Domino V2 route and fee modules. The native
/// currency is address(0), as in DominoV2Types.
/// @dev Every call copies at most one word of return data, so a token cannot
/// make the caller pay for a large return payload. ERC-20s that return nothing
/// are accepted (USDT style); a token address without code never is.
library DominoTokenOps {
    error TokenCallFailed(address token);

    uint256 private constant BALANCE_OF = 0x70a08231;
    uint256 private constant ALLOWANCE = 0xdd62ed3e;
    uint256 private constant TRANSFER = 0xa9059cbb;
    uint256 private constant APPROVE = 0x095ea7b3;

    /// The balance of `account`; reverts when the token cannot answer.
    function balanceOf(address token, address account) internal view returns (uint256 amount) {
        if (token == address(0)) return account.balance;
        bool ok;
        assembly ("memory-safe") {
            mstore(0x14, account)
            mstore(0x00, shl(96, BALANCE_OF))
            ok := staticcall(gas(), token, 0x10, 0x24, 0x20, 0x20)
            ok := and(ok, gt(returndatasize(), 0x1f))
            amount := mload(0x20)
        }
        if (!ok) revert TokenCallFailed(token);
    }

    function selfBalance(address token) internal view returns (uint256) {
        return balanceOf(token, address(this));
    }

    /// The ERC-20 allowance from `owner` to `spender`; reverts when the token cannot answer.
    function allowance(address token, address owner, address spender) internal view returns (uint256 amount) {
        bool ok;
        assembly ("memory-safe") {
            let free := mload(0x40)
            mstore(free, shl(224, ALLOWANCE))
            mstore(add(free, 0x04), owner)
            mstore(add(free, 0x24), spender)
            ok := staticcall(gas(), token, free, 0x44, 0x00, 0x20)
            ok := and(ok, gt(returndatasize(), 0x1f))
            amount := mload(0x00)
        }
        if (!ok) revert TokenCallFailed(token);
    }

    /// Sends `amount` of `token` to `to` and reverts if the call fails.
    function transfer(address token, address to, uint256 amount) internal {
        if (!tryTransfer(token, to, amount, gasleft())) revert TokenCallFailed(token);
    }

    /// Attempts a transfer with at most `gasLimit` gas; never reverts. The
    /// caller decides what a failure means (the fee ledger defers the fee).
    function tryTransfer(address token, address to, uint256 amount, uint256 gasLimit) internal returns (bool ok) {
        if (token == address(0)) {
            assembly ("memory-safe") {
                ok := call(gasLimit, to, amount, 0x00, 0x00, 0x00, 0x00)
            }
            return ok;
        }
        assembly ("memory-safe") {
            let free := mload(0x40)
            mstore(free, shl(224, TRANSFER))
            mstore(add(free, 0x04), to)
            mstore(add(free, 0x24), amount)
            mstore(0x00, 0)
            ok := call(gasLimit, token, 0, free, 0x44, 0x00, 0x20)
            // Success: the call returned true, or returned nothing from a contract.
            ok := and(ok, or(and(gt(returndatasize(), 0x1f), eq(mload(0x00), 1)),
                and(iszero(returndatasize()), gt(extcodesize(token), 0))))
        }
    }

    /// Sets an ERC-20 allowance and reverts if the token refuses.
    function approve(address token, address spender, uint256 amount) internal {
        bool ok;
        assembly ("memory-safe") {
            let free := mload(0x40)
            mstore(free, shl(224, APPROVE))
            mstore(add(free, 0x04), spender)
            mstore(add(free, 0x24), amount)
            mstore(0x00, 0)
            ok := call(gas(), token, 0, free, 0x44, 0x00, 0x20)
            ok := and(ok, or(and(gt(returndatasize(), 0x1f), eq(mload(0x00), 1)),
                and(iszero(returndatasize()), gt(extcodesize(token), 0))))
        }
        if (!ok) revert TokenCallFailed(token);
    }
}
