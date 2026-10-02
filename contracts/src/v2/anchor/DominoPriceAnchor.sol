// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {IUniswapV3PoolMinimal} from "../external/IUniswapV3Minimal.sol";
import {IV4StateViewMinimal} from "../external/IUniswapV4Minimal.sol";
import {IDominoPriceAnchor} from "../interfaces/IDominoPriceAnchor.sol";
import {IDominoRegistry} from "../interfaces/IDominoRegistry.sol";
import {AnchorMath} from "./AnchorMath.sol";

/// @title Domino V2 price anchor
/// @notice The price every Domino V2 action is bounded by, and the pool's
/// current spot checked against it.
/// @dev Two kinds of evidence (docs/v2/F1_REGISTRY_ANCHOR.md):
/// - a PriceObservation signed (EIP-712, this contract's domain) by a key the
///   registry admits as publisher, verified at use: no publication
///   transaction, no block-hash binding. It is void once revoked by hash, once
///   the registry's observation epoch passes its observedAt, once its
///   publisher is removed, and after validUntil;
/// - for a v3 pool, the pool's own TWAP over a window between minTwapSeconds
///   and the caller's maxAgeSeconds.
/// The anchor is returned together with the spot (v4 through StateView, v3
/// through slot0) only when the two prices are within the caller's band.
/// Everything here is a view except revocation; nothing holds funds.
contract DominoPriceAnchor is IDominoPriceAnchor {
    /// The pool cannot be priced: an invalid reference (a v3 reference with a
    /// hook or the wrong tick spacing, an unknown dex), a version this
    /// deployment does not serve, no pool deployed, an uninitialized pool, or
    /// a v3 pool in the middle of one of its own operations (locked).
    error PoolUnavailable();
    /// Revocation is reserved to admitted publishers, the guardian and governance.
    error Unauthorized();
    error InvalidConfig();

    /// The highest TWAP floor a deployment may set.
    uint32 public constant MAX_MIN_TWAP_SECONDS = 1 days;
    /// secp256k1n / 2: signatures with a higher s are the malleated twin of a
    /// canonical one and are refused.
    uint256 private constant HALF_CURVE_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    address public immutable registry;
    /// Uniswap v3 factory and its pool init code hash; zero when this chain's
    /// deployment serves no v3 pools.
    address public immutable v3Factory;
    bytes32 public immutable v3PoolInitCodeHash;
    /// Uniswap v4 StateView; zero when this deployment serves no v4 pools.
    address public immutable v4StateView;
    /// The shortest TWAP window accepted as an anchor. The caller (an operator)
    /// picks the window; this floor keeps it from picking one short enough to
    /// be moved by holding a manipulated price for a few blocks.
    uint32 public immutable minTwapSeconds;

    bytes32 private immutable _cachedDomainSeparator;
    uint256 private immutable _cachedChainId;
    address private immutable _cachedThis;

    mapping(bytes32 => bool) private _revoked;

    constructor(
        address registry_,
        address v3Factory_,
        bytes32 v3PoolInitCodeHash_,
        address v4StateView_,
        uint32 minTwapSeconds_
    ) {
        if (registry_.code.length == 0 || (v3Factory_ == address(0)) != (v3PoolInitCodeHash_ == bytes32(0))
            || (v3Factory_ == address(0) && v4StateView_ == address(0))
            || (v3Factory_ != address(0) && v3Factory_.code.length == 0)
            || (v4StateView_ != address(0) && v4StateView_.code.length == 0) || minTwapSeconds_ == 0
            || minTwapSeconds_ > MAX_MIN_TWAP_SECONDS) revert InvalidConfig();
        registry = registry_;
        v3Factory = v3Factory_;
        v3PoolInitCodeHash = v3PoolInitCodeHash_;
        v4StateView = v4StateView_;
        minTwapSeconds = minTwapSeconds_;
        _cachedChainId = block.chainid;
        _cachedThis = address(this);
        _cachedDomainSeparator = DominoV2Types.domainSeparator(block.chainid, address(this));
    }

    // ------------------------------------------------------------ evidence
    /// @notice EIP-712 domain: name "Domino", version "2", this chain, this contract.
    function domainSeparator() public view returns (bytes32) {
        if (address(this) == _cachedThis && block.chainid == _cachedChainId) return _cachedDomainSeparator;
        return DominoV2Types.domainSeparator(block.chainid, address(this));
    }

    /// @notice The EIP-712 digest a publisher signs for `point`; also the
    /// hash revokeObservation and isRevoked take.
    function hashObservation(DominoV2Types.PriceObservation calldata point) external view returns (bytes32) {
        return _digest(point);
    }

    /// @inheritdoc IDominoPriceAnchor
    /// @dev The window rule (validUntil - observedAt <= maxAgeSeconds) and the
    /// two time checks together bound the age at use by maxAgeSeconds, and an
    /// observation dated in the future is refused, so no key can pre-sign
    /// observations that outlive the window it was given.
    function verifyObservation(
        DominoV2Types.PriceObservation calldata point,
        bytes calldata signature,
        uint32 maxAgeSeconds
    ) external view returns (uint160 sqrtPriceX96) {
        return _verify(point, signature, maxAgeSeconds);
    }

    /// @inheritdoc IDominoPriceAnchor
    /// @dev A raw reading: any nonzero window the pool's history covers. The
    /// floor and the caller's maximum age apply in anchor().
    function twapSqrtPrice(DominoV2Types.PoolRef calldata pool, uint32 secondsAgo)
        external
        view
        returns (uint160 sqrtPriceX96)
    {
        return _twap(pool, secondsAgo);
    }

    /// @notice The pool's current sqrt price, read as anchor() reads it.
    function spotSqrtPrice(DominoV2Types.PoolRef calldata pool) external view returns (uint160 sqrtPriceX96) {
        return _spot(pool);
    }

    /// @inheritdoc IDominoPriceAnchor
    /// @dev evidence of exactly 32 bytes is a TWAP window; anything else must
    /// decode as (PriceObservation, bytes signature) for this very pool. The
    /// band is symmetric on the price: see AnchorMath.withinBand.
    function anchor(
        DominoV2Types.PoolRef calldata pool,
        bytes calldata evidence,
        uint32 maxAgeSeconds,
        uint16 maxDeviationBps
    ) external view returns (uint160 anchorSqrtPriceX96, uint160 spotSqrtPriceX96) {
        spotSqrtPriceX96 = _spot(pool);
        if (evidence.length == 32) {
            uint256 secondsAgo = uint256(bytes32(evidence));
            if (secondsAgo < minTwapSeconds || secondsAgo > maxAgeSeconds) revert TwapUnavailable();
            anchorSqrtPriceX96 = _twap(pool, uint32(secondsAgo));
        } else {
            (DominoV2Types.PriceObservation memory point, bytes memory signature) =
                abi.decode(evidence, (DominoV2Types.PriceObservation, bytes));
            if (!_samePool(point.pool, pool)) revert InvalidObservation();
            anchorSqrtPriceX96 = _verify(point, signature, maxAgeSeconds);
        }
        if (!AnchorMath.withinBand(anchorSqrtPriceX96, spotSqrtPriceX96, maxDeviationBps)) revert SpotOutsideBand();
    }

    // ---------------------------------------------------------- revocation
    /// @inheritdoc IDominoPriceAnchor
    /// @dev Any admitted publisher, the guardian or governance; the hash need
    /// not have been used, so an observation can be voided before it is.
    function revokeObservation(bytes32 observationHash) external {
        IDominoRegistry roles = IDominoRegistry(registry);
        if (msg.sender != roles.guardian() && msg.sender != roles.governance() && !roles.isPublisher(msg.sender)) {
            revert Unauthorized();
        }
        if (_revoked[observationHash]) revert ObservationRevoked();
        _revoked[observationHash] = true;
        emit ObservationRevokedBy(observationHash, msg.sender);
    }

    function isRevoked(bytes32 observationHash) external view returns (bool) {
        return _revoked[observationHash];
    }

    // ------------------------------------------------------------ internal
    function _digest(DominoV2Types.PriceObservation memory point) private view returns (bytes32) {
        return DominoV2Types.digest(domainSeparator(), DominoV2Types.hashPriceObservation(point));
    }

    function _verify(DominoV2Types.PriceObservation memory point, bytes memory signature, uint32 maxAgeSeconds)
        private
        view
        returns (uint160)
    {
        if (point.sqrtPriceX96 < AnchorMath.MIN_SQRT_PRICE || point.sqrtPriceX96 > AnchorMath.MAX_SQRT_PRICE
            || point.observedAt > block.timestamp) revert InvalidObservation();
        if (block.timestamp > point.validUntil || point.validUntil - point.observedAt > maxAgeSeconds) {
            revert ObservationExpired();
        }
        bytes32 digest = _digest(point);
        address signer = _recover(digest, signature);
        IDominoRegistry roles = IDominoRegistry(registry);
        if (signer == address(0) || !roles.isPublisher(signer)) revert InvalidObservation();
        if (_revoked[digest] || point.observedAt < roles.observationEpoch()) revert ObservationRevoked();
        return point.sqrtPriceX96;
    }

    /// @dev 65-byte (r, s, v) signatures with a canonical s; anything else
    /// recovers no one.
    function _recover(bytes32 digest, bytes memory signature) private pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (uint256(s) > HALF_CURVE_ORDER) return address(0);
        return ecrecover(digest, v, r, s);
    }

    function _samePool(DominoV2Types.PoolRef memory a, DominoV2Types.PoolRef calldata b) private pure returns (bool) {
        return a.dex == b.dex && a.currency0 == b.currency0 && a.currency1 == b.currency1 && a.fee == b.fee
            && a.tickSpacing == b.tickSpacing && a.hooks == b.hooks;
    }

    function _spot(DominoV2Types.PoolRef calldata pool) private view returns (uint160 sqrtPriceX96) {
        if (pool.dex == DominoV2Types.DEX_V4) {
            if (v4StateView == address(0)) revert PoolUnavailable();
            bytes32 poolId =
                keccak256(abi.encode(pool.currency0, pool.currency1, pool.fee, pool.tickSpacing, pool.hooks));
            (sqrtPriceX96,,,) = IV4StateViewMinimal(v4StateView).getSlot0(poolId);
            if (sqrtPriceX96 == 0) revert PoolUnavailable();
            return sqrtPriceX96;
        }
        address pair = _v3Pool(pool);
        (bool ok, bytes memory slot0) = pair.staticcall(abi.encodeCall(IUniswapV3PoolMinimal.slot0, ()));
        if (!ok || slot0.length < 224) revert PoolUnavailable();
        bool unlocked;
        (sqrtPriceX96,,,,,, unlocked) = abi.decode(slot0, (uint160, int24, uint16, uint16, uint16, uint8, bool));
        if (sqrtPriceX96 == 0 || !unlocked) revert PoolUnavailable();
        if (IUniswapV3PoolMinimal(pair).tickSpacing() != pool.tickSpacing) revert PoolUnavailable();
    }

    function _twap(DominoV2Types.PoolRef calldata pool, uint32 secondsAgo) private view returns (uint160) {
        if (pool.dex != DominoV2Types.DEX_V3 || secondsAgo == 0) revert TwapUnavailable();
        address pair = _v3Pool(pool);
        uint32[] memory ago = new uint32[](2);
        ago[0] = secondsAgo;
        (bool ok, bytes memory observed) = pair.staticcall(abi.encodeCall(IUniswapV3PoolMinimal.observe, (ago)));
        if (!ok || observed.length == 0) revert TwapUnavailable();
        (int56[] memory cumulatives,) = abi.decode(observed, (int56[], uint160[]));
        int56 mean = AnchorMath.meanTick(cumulatives[0], cumulatives[1], secondsAgo);
        if (mean < AnchorMath.MIN_TICK || mean > AnchorMath.MAX_TICK) revert TwapUnavailable();
        return AnchorMath.getSqrtPriceAtTick(int24(mean));
    }

    /// @dev The v3 pool a reference names: CREATE2 from the factory, as
    /// Uniswap's PoolAddress computes it. Unsorted or equal tokens and unknown
    /// fees name an address with no pool, which the callers refuse; a hook is
    /// refused here because v3 has none, and the tick spacing is checked
    /// against the pool by _spot.
    function _v3Pool(DominoV2Types.PoolRef calldata pool) private view returns (address) {
        if (pool.dex != DominoV2Types.DEX_V3 || v3Factory == address(0) || pool.hooks != address(0)) {
            revert PoolUnavailable();
        }
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            hex"ff",
                            v3Factory,
                            keccak256(abi.encode(pool.currency0, pool.currency1, pool.fee)),
                            v3PoolInitCodeHash
                        )
                    )
                )
            )
        );
    }
}
