// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Immutable publisher trust for operation-specific price attestations.
/// @dev A publisher is a separately admitted price-integrity service, not the
/// executor. No price is inferred from symbols or current manipulated pool spot.
/// Deployments must qualify that publisher/source; local fixtures do not do so.
contract DominoPriceGuardV4 {
    struct Observation { bytes32 poolId; uint64 blockNumber; bytes32 blockHash; uint64 timestamp; uint64 expiresAt; uint160 sqrtPriceX96; }
    address public immutable publisher;
    mapping(bytes32 => Observation) public observations;
    mapping(bytes32 => bool) public revoked;
    error InvalidObservation();
    event PriceObserved(bytes32 indexed id, bytes32 indexed poolId, uint64 blockNumber, uint64 expiresAt);
    event PriceRevoked(bytes32 indexed id);

    constructor(address publisher_) {
        if (publisher_ == address(0)) revert InvalidObservation();
        publisher = publisher_;
    }

    function publish(Observation calldata point) external returns (bytes32 id) {
        if (msg.sender != publisher || point.poolId == bytes32(0) || point.sqrtPriceX96 == 0
            || point.blockNumber >= block.number || point.blockHash == bytes32(0)
            || blockhash(point.blockNumber) != point.blockHash || point.timestamp > block.timestamp
            || point.expiresAt <= block.timestamp || point.expiresAt <= point.timestamp
            || point.expiresAt - point.timestamp > 3600) revert InvalidObservation();
        id = keccak256(abi.encode("DominoPriceObservationV1", block.chainid, address(this), point));
        if (observations[id].sqrtPriceX96 != 0 || revoked[id]) revert InvalidObservation();
        observations[id] = point;
        emit PriceObserved(id, point.poolId, point.blockNumber, point.expiresAt);
    }

    function revoke(bytes32 id) external {
        if (msg.sender != publisher || observations[id].sqrtPriceX96 == 0) revert InvalidObservation();
        revoked[id] = true;
        emit PriceRevoked(id);
    }

    function referencePrice(bytes32 id, bytes32 poolId, uint64 observedAtBlock,
        bytes32 observedBlockHash, uint32 maxAge) external view returns (uint160) {
        Observation memory point = observations[id];
        if (revoked[id] || point.poolId != poolId || point.sqrtPriceX96 == 0
            || point.blockNumber != observedAtBlock || point.blockHash != observedBlockHash
            || blockhash(point.blockNumber) != point.blockHash || block.timestamp > point.expiresAt
            || block.timestamp < point.timestamp || block.timestamp - point.timestamp > maxAge)
            revert InvalidObservation();
        return point.sqrtPriceX96;
    }
}
