// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Robinhood's ArbSys precompile supplies the same L2 domain as JSON-RPC.
interface IArbSysDomino {
    function arbBlockNumber() external view returns (uint256);
    function arbBlockHash(uint256 blockNumber) external view returns (bytes32);
}

/// @notice Qualified L2 block context for Robinhood Chain (4663).
/// @dev Nitro's NUMBER/BLOCKHASH opcodes use the ancestor-chain domain. Never
/// fall back to those opcodes if ArbSys is unavailable, including on a fork.
library DominoL2Block {
    error InvalidL2BlockContext();

    function number() internal view returns (uint256) {
        return uint256(_read(abi.encodeCall(IArbSysDomino.arbBlockNumber, ())));
    }

    function hash(uint256 blockNumber) internal view returns (bytes32) {
        return _read(abi.encodeCall(IArbSysDomino.arbBlockHash, (blockNumber)));
    }

    function _read(bytes memory data) private view returns (bytes32 value) {
        if (block.chainid != 4663) revert InvalidL2BlockContext();
        (bool ok, bytes memory result) = address(0x64).staticcall(data);
        // Precompiles may have no code. Validate their response, not code size.
        if (!ok || result.length != 32) revert InvalidL2BlockContext();
        return abi.decode(result, (bytes32));
    }
}
