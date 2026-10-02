// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";

/// @notice Auto-exit (#283, S3): a separate contract the owner enables on a
/// vault and instructs with a signed ExitMandate.
/// @dev Full consent takes two explicit acts: the vault's setExitModule and the
/// EIP-712 mandate signature (EOA, EIP-7702 account or EIP-1271 wallet). The
/// trigger is checked against the anchor price, never the bare spot, and the
/// delivery has a floor against that anchor. Fee: FEE_AUTO_EXIT_BPS of the
/// position at exit, the only charge even with conversion: of the converted
/// output when the owner converts into a charge currency; in the best-ranked
/// charge currency the owner receives when receiving both tokens; otherwise
/// of each token withdrawn (docs/v2/F4_AUTO_EXIT.md).
interface IDominoAutoExit {
    error InvalidMandate();
    error MandateNotActive();
    error TriggerNotReached();
    error Unauthorized();

    /// Status of a mandate hash.
    /// 0 unknown, 1 active, 2 revoked, 3 executed. Expiry is read from validUntil.
    function mandateStatus(bytes32 mandateHash) external view returns (uint8 status);

    struct Execution {
        bytes anchorEvidence;
        DominoV2Types.SwapLeg[] legs;
        uint128 amount0MinRemoved;
        uint128 amount1MinRemoved;
    }

    event MandateRegistered(
        bytes32 indexed mandateHash, address indexed owner, address indexed vault, uint256 tokenId, uint64 validUntil
    );
    event MandateRevoked(bytes32 indexed mandateHash);
    event MandateExecuted(
        bytes32 indexed mandateHash,
        uint160 anchorSqrtPriceX96,
        address indexed recipient,
        uint256 amount0,
        uint256 amount1
    );

    function registry() external view returns (address);
    function domainSeparator() external view returns (bytes32);

    /// Anyone may submit; the signature must be the mandate owner's, who must own the vault.
    function registerMandate(DominoV2Types.ExitMandate calldata mandate, bytes calldata signature)
        external
        returns (bytes32 mandateHash);

    /// The mandate owner only, at any time, without the operator.
    function revokeMandate(bytes32 mandateHash) external;

    /// An admitted operator, once the anchor crosses a trigger.
    function execute(bytes32 mandateHash, Execution calldata execution) external returns (uint256 amount0, uint256 amount1);
}
