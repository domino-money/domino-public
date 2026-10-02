// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDominoFeeSettlement} from "../interfaces/IDominoFees.sol";
import {IDominoRegistry} from "../interfaces/IDominoRegistry.sol";
import {DominoActionLock} from "../route/DominoActionLock.sol";
import {DominoTokenOps} from "../route/DominoTokenOps.sol";

/// @notice Charges Domino's fees for the contract that inherits it (zap,
/// vault, auto-exit) and settles them with the registry's fee recipient.
/// @dev V1 audit A1: a fee is paid by push in the same transaction, but a
/// recipient that cannot receive (frozen, blacklisted, taxed, a 7702 account
/// without receive, a broken registry) never blocks the action. What the
/// recipient did not get is owed: it stays in this contract, is never
/// spendable by the owner, and anyone may flush it later to the recipient in
/// force at that time. Owed amounts live in ERC-7201 storage, so the module
/// works in a minimal-proxy clone and next to any storage layout.
abstract contract DominoFeeLedger is IDominoFeeSettlement, DominoActionLock {
    error InvalidFeeConfig();
    error FeeNotBacked(address token);
    error FeeRecipientUnavailable();
    error FeeTransferMismatch(address token);

    /// Gas forwarded to the inline payment: enough for any charge currency on
    /// the target chains (proxied stables, WETH, a smart-wallet receive), and
    /// a ceiling on what a recipient or token can burn inside an action.
    uint256 internal constant FEE_TRANSFER_GAS = 100_000;

    /// @custom:storage-location erc7201:domino.v2.fees
    struct FeeStorage {
        mapping(address token => uint256 amount) owed;
    }

    /// keccak256(abi.encode(uint256(keccak256("domino.v2.fees")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant FEE_STORAGE = 0xf7b3336405df5024641f2cde343324d710479baaf72a5fa4cab51610ccbfdf00;

    IDominoRegistry private immutable FEE_REGISTRY;

    constructor(IDominoRegistry registry) {
        if (address(registry).code.length == 0) revert InvalidFeeConfig();
        FEE_REGISTRY = registry;
    }

    // ---------------------------------------------------------- settlement
    function owedFees(address token) public view returns (uint256) {
        return _feeStorage().owed[token];
    }

    /// @notice Pays everything owed in `token` to the current fee recipient.
    /// Anyone may call; it reverts (and the amount stays owed) when the
    /// recipient still cannot receive. Never runs inside an action.
    function flushOwedFees(address token) external nonReentrant returns (uint256 amount) {
        FeeStorage storage fees = _feeStorage();
        amount = fees.owed[token];
        if (amount == 0) return 0;
        address recipient = _recipient();
        if (recipient == address(0)) revert FeeRecipientUnavailable();
        fees.owed[token] = 0;
        uint256 balance = DominoTokenOps.selfBalance(token);
        DominoTokenOps.tryTransfer(token, recipient, amount, gasleft());
        if (balance - DominoTokenOps.selfBalance(token) != amount) revert FeeTransferMismatch(token);
        emit OwedFeesFlushed(token, recipient, amount);
    }

    // ------------------------------------------------------------ internal
    /// @notice Charges `amount` of `token` (held by this contract) as a fee
    /// of `kind` (DominoV2Types.FEE_KIND_*) paid by `payer` for `ref`.
    /// @return deferred The part the recipient did not receive, now owed.
    /// @dev Emits FeeCharged for the whole amount, then FeeDeferred for any
    /// shortfall. The payment is measured on this contract's balance: a
    /// recipient-side transfer tax is the recipient's, a token that moves
    /// less than asked leaves the rest owed, and one that moves more than
    /// asked reverts, since it would spend balances owed to others.
    function _chargeFee(uint8 kind, address token, address payer, uint256 amount, bytes32 ref)
        internal
        returns (uint256 deferred)
    {
        if (amount == 0) return 0;
        FeeStorage storage fees = _feeStorage();
        uint256 balance = DominoTokenOps.selfBalance(token);
        if (balance < fees.owed[token] + amount) revert FeeNotBacked(token);
        emit FeeCharged(kind, token, payer, amount, ref);
        address recipient = _recipient();
        uint256 debited;
        if (recipient != address(0)) {
            DominoTokenOps.tryTransfer(token, recipient, amount, FEE_TRANSFER_GAS);
            uint256 remaining = DominoTokenOps.selfBalance(token);
            if (remaining < balance) debited = balance - remaining;
            if (debited > amount) revert FeeTransferMismatch(token);
        }
        if (debited < amount) {
            deferred = amount - debited;
            uint256 total = fees.owed[token] + deferred;
            fees.owed[token] = total;
            emit FeeDeferred(token, deferred, total);
        }
    }

    /// This contract's balance of `token` that is not owed to the fee recipient.
    function _unowedBalance(address token) internal view returns (uint256) {
        return DominoTokenOps.selfBalance(token) - _feeStorage().owed[token];
    }

    function _feeRegistry() internal view returns (IDominoRegistry) {
        return FEE_REGISTRY;
    }

    /// The registry's recipient, or address(0) when the registry cannot say.
    function _recipient() private view returns (address recipient) {
        try FEE_REGISTRY.feeRecipient() returns (address current) {
            recipient = current;
        } catch {
            recipient = address(0);
        }
    }

    function _feeStorage() private pure returns (FeeStorage storage fees) {
        assembly ("memory-safe") {
            fees.slot := FEE_STORAGE
        }
    }
}
