// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev The one StateView reading the guard bounds a published price against.
interface IStateViewGuard {
    function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24, uint24);
}

/// @notice Immutable publisher trust for operation-specific price attestations.
/// @dev A publisher is a separately admitted price-integrity service, not the
/// executor. No price is inferred from symbols or current manipulated pool spot.
/// Deployments must qualify that publisher/source; local fixtures do not do so.
contract DominoPriceGuardV4 {
    struct Observation { bytes32 poolId; uint64 blockNumber; bytes32 blockHash; uint64 timestamp; uint64 expiresAt; uint160 sqrtPriceX96; }
    /// @notice The exclusive bound on an observation's age in blocks: it is
    /// admitted while `block.number - blockNumber` is strictly below this, so
    /// the oldest observation accepted is 255 blocks old - one short of the
    /// 256 whose hashes EVM `blockhash` still answers for. Stating the window
    /// here keeps the real lifetime explicit instead of leaving callers to
    /// discover that a longer declared window silently cannot be reached.
    uint64 public constant MAX_OBSERVATION_BLOCKS = 256;
    /// @notice The key that publishes. Not immutable: the guardian below can
    /// hand the role to another address, so a rotated or stolen key does not
    /// force a redeployment of the engine and every vault that pins it.
    address public publisher;
    /// @notice A cold key with exactly two powers - proposing the next publisher
    /// and revoking an observation - and no say in what gets published. The
    /// proposed key must accept, so a typo cannot hand the role to nobody.
    address public immutable guardian;
    address public pendingPublisher;
    /// @notice The reader used to bound a published price against the pool's
    /// own current reading. It does not make the publisher trusted-less: a
    /// publisher that also moves the pool can still move the band. It does
    /// stop a stolen key from attesting a price unrelated to the pool.
    IStateViewGuard public immutable stateView;
    /// @notice How far a published price may sit from that reading, in basis
    /// points of the square-root price. A band on the square root is about
    /// half the band on the price itself; it is stated this way because the
    /// squared form cannot be computed here without overflowing.
    uint256 public immutable maxDeviationBps;
    mapping(bytes32 => Observation) public observations;
    mapping(bytes32 => bool) public revoked;
    error InvalidObservation();
    event PriceObserved(bytes32 indexed id, bytes32 indexed poolId, uint64 blockNumber, uint64 expiresAt);
    event PriceRevoked(bytes32 indexed id);
    event PublisherProposed(address indexed current, address indexed proposed);
    event PublisherChanged(address indexed previous, address indexed current);

    constructor(address publisher_, address stateView_, uint256 maxDeviationBps_, address guardian_) {
        if (publisher_ == address(0) || stateView_ == address(0) || guardian_ == address(0) || guardian_ == publisher_
            || maxDeviationBps_ == 0 || maxDeviationBps_ >= 10000) revert InvalidObservation();
        publisher = publisher_;
        stateView = IStateViewGuard(stateView_);
        maxDeviationBps = maxDeviationBps_;
        guardian = guardian_;
    }

    /// @notice Hand the publisher role to `candidate`, once it accepts. Earlier
    /// observations stay readable until they expire: the band bounded them when
    /// they were published, and the engine's own limits bound them at execution.
    function proposePublisher(address candidate) external {
        if (msg.sender != guardian || candidate == address(0) || candidate == publisher) revert InvalidObservation();
        pendingPublisher = candidate;
        emit PublisherProposed(publisher, candidate);
    }

    function acceptPublisher() external {
        if (msg.sender != pendingPublisher) revert InvalidObservation();
        emit PublisherChanged(publisher, msg.sender);
        publisher = msg.sender;
        pendingPublisher = address(0);
    }

    /// @dev Exact band check on the square-root price. Squaring first would
    /// overflow a uint256 for prices this wide; both products here cannot.
    function _withinBand(uint160 value, uint160 anchor) private view returns (bool) {
        if (value == 0 || anchor == 0) return false;
        uint256 scaled = uint256(value) * 10000;
        return scaled >= uint256(anchor) * (10000 - maxDeviationBps)
            && scaled <= uint256(anchor) * (10000 + maxDeviationBps);
    }

    function publish(Observation calldata point) external returns (bytes32 id) {
        if (msg.sender != publisher || point.poolId == bytes32(0) || point.sqrtPriceX96 == 0
            || point.blockNumber >= block.number || point.blockHash == bytes32(0)
            || blockhash(point.blockNumber) != point.blockHash || point.timestamp > block.timestamp
            || point.expiresAt <= block.timestamp || point.expiresAt <= point.timestamp
            || point.blockNumber + MAX_OBSERVATION_BLOCKS <= block.number) revert InvalidObservation();
        // The attested price must sit within a band of what the pool reads now.
        // Without this the publisher's word is the only bound on the anchor
        // that governs every swap's impact and slippage floor.
        (uint160 spot,,,) = stateView.getSlot0(point.poolId);
        if (!_withinBand(point.sqrtPriceX96, spot)) revert InvalidObservation();
        id = keccak256(abi.encode("DominoPriceObservationV1", block.chainid, address(this), point));
        if (observations[id].sqrtPriceX96 != 0 || revoked[id]) revert InvalidObservation();
        observations[id] = point;
        emit PriceObserved(id, point.poolId, point.blockNumber, point.expiresAt);
    }

    /// @notice The publisher, or the guardian as an emergency brake that needs
    /// no publisher key, retires one observation before it expires.
    function revoke(bytes32 id) external {
        if ((msg.sender != publisher && msg.sender != guardian) || observations[id].sqrtPriceX96 == 0) revert InvalidObservation();
        revoked[id] = true;
        emit PriceRevoked(id);
    }

    function referencePrice(bytes32 id, bytes32 poolId, uint64 observedAtBlock,
        bytes32 observedBlockHash, uint32 maxAge) external view returns (uint160) {
        Observation memory point = observations[id];
        if (revoked[id] || point.poolId != poolId || point.sqrtPriceX96 == 0
            || point.blockNumber != observedAtBlock || point.blockHash != observedBlockHash
            || blockhash(point.blockNumber) != point.blockHash || block.timestamp > point.expiresAt
            || point.blockNumber + MAX_OBSERVATION_BLOCKS <= block.number
            // The claimed timestamp is the publisher's own, so this bound is a
            // ceiling on a self-attested value, not proof of freshness. What
            // actually bounds the age is the block distance above.
            || block.timestamp < point.timestamp || block.timestamp - point.timestamp > maxAge)
            revert InvalidObservation();
        return point.sqrtPriceX96;
    }
}
