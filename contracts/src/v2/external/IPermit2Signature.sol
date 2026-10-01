// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal local declaration of Permit2's SignatureTransfer surface
/// (Uniswap permit2, ISignatureTransfer), limited to what Domino V2 uses.
/// @dev Permit2 is deployed at the canonical address on every target chain.
/// Its EIP-712 domain is EIP712Domain(string name,uint256 chainId,address
/// verifyingContract) with name "Permit2" and no version.
interface IPermit2Signature {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitBatchTransferFrom {
        TokenPermissions[] permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitWitnessTransferFrom(
        PermitBatchTransferFrom memory permit,
        SignatureTransferDetails[] calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;

    function nonceBitmap(address owner, uint256 wordPosition) external view returns (uint256);
}
