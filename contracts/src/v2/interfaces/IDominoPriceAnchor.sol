// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";

/// @notice The price every Domino V2 action is bounded by.
/// @dev Two sources behind one call. A v4 pool, or a v3 pool without a usable
/// oracle, needs a PriceObservation signed by an admitted publisher
/// (EIP-712, this contract's domain). A v3 pool may instead use its own TWAP.
/// The returned anchor is always compared with the pool's current spot.
interface IDominoPriceAnchor {
    error InvalidObservation();
    error ObservationRevoked();
    error ObservationExpired();
    error TwapUnavailable();
    error SpotOutsideBand();

    event ObservationRevokedBy(bytes32 indexed observationHash, address indexed by);

    function registry() external view returns (address);
    function domainSeparator() external view returns (bytes32);

    /// @notice Verifies a signed observation: admitted publisher, not revoked,
    /// observedAt at or after the registry epoch, not past validUntil, and
    /// validUntil - observedAt at most maxAgeSeconds.
    function verifyObservation(
        DominoV2Types.PriceObservation calldata point,
        bytes calldata signature,
        uint32 maxAgeSeconds
    ) external view returns (uint160 sqrtPriceX96);

    /// @notice A v3 pool's time-weighted sqrt price over `secondsAgo`.
    function twapSqrtPrice(DominoV2Types.PoolRef calldata pool, uint32 secondsAgo)
        external
        view
        returns (uint160 sqrtPriceX96);

    /// @notice The anchor and current spot, after the band check.
    /// @param evidence abi.encode(PriceObservation, bytes signature), or
    /// abi.encode(uint32 secondsAgo) for a v3 TWAP.
    function anchor(
        DominoV2Types.PoolRef calldata pool,
        bytes calldata evidence,
        uint32 maxAgeSeconds,
        uint16 maxDeviationBps
    ) external view returns (uint160 anchorSqrtPriceX96, uint160 spotSqrtPriceX96);

    /// @notice Voids one observation. Publisher or guardian.
    function revokeObservation(bytes32 observationHash) external;
    function isRevoked(bytes32 observationHash) external view returns (bool);
}
