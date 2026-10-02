// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {DominoPriceAnchor} from "../../../src/v2/anchor/DominoPriceAnchor.sol";
import {DominoRegistry} from "../../../src/v2/registry/DominoRegistry.sol";
import {CodeStub, RegistryFixtures} from "../registry/RegistryFixtures.sol";

/// @notice A Uniswap v3 pool double with the three reads the anchor makes.
/// Etched at the CREATE2 address the anchor derives, so the derivation is
/// exercised too. observe() answers from a table keyed by secondsAgo.
contract MockV3Pool {
    uint160 public sqrtPrice;
    bool public unlocked;
    int24 public spacing;
    bool public historyTooShort;
    bool public slotReverts;
    mapping(uint32 => int56) public cumulativeAt;

    function setSlot0(uint160 sqrtPriceX96, bool isUnlocked) external {
        sqrtPrice = sqrtPriceX96;
        unlocked = isUnlocked;
    }

    function setTickSpacing(int24 value) external {
        spacing = value;
    }

    function setCumulative(uint32 secondsAgo, int56 value) external {
        cumulativeAt[secondsAgo] = value;
    }

    function setHistoryTooShort(bool value) external {
        historyTooShort = value;
    }

    function setSlotReverts(bool value) external {
        slotReverts = value;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        if (slotReverts) {
            // Revert data long enough to pass for a slot0 answer.
            bytes memory data = abi.encode(sqrtPrice, int24(0), uint16(0), uint16(0), uint16(0), uint8(0), true, true);
            assembly ("memory-safe") {
                revert(add(data, 0x20), mload(data))
            }
        }
        return (sqrtPrice, int24(0), uint16(0), uint16(1), uint16(1), uint8(0), unlocked);
    }

    function tickSpacing() external view returns (int24) {
        return spacing;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        require(!historyTooShort, "OLD");
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; ++i) {
            tickCumulatives[i] = cumulativeAt[secondsAgos[i]];
        }
    }
}

/// @notice StateView.getSlot0 as deployed: (sqrtPriceX96, tick, protocolFee, lpFee).
contract MockStateView {
    mapping(bytes32 => uint160) public sqrtPrice;

    function setSqrtPrice(bytes32 poolId, uint160 value) external {
        sqrtPrice[poolId] = value;
    }

    function getSlot0(bytes32 poolId) external view returns (uint160, int24, uint24, uint24) {
        return (sqrtPrice[poolId], int24(0), uint24(0), uint24(3000));
    }
}

/// @notice A registry that admits everyone, address(0) included: proves the
/// anchor refuses a signature that recovers no one without relying on the
/// registry never admitting the zero address.
contract PermissiveRegistry {
    function isPublisher(address) external pure returns (bool) {
        return true;
    }

    function observationEpoch() external pure returns (uint64) {
        return 0;
    }
}

abstract contract AnchorFixtures is RegistryFixtures {
    uint256 internal constant PUBLISHER_KEY = uint256(keccak256("domino.v2.f1.publisher"));
    uint256 internal constant SECOND_PUBLISHER_KEY = uint256(keccak256("domino.v2.f1.publisher.second"));
    uint256 internal constant OUTSIDER_KEY = uint256(keccak256("domino.v2.f1.outsider"));
    uint256 internal constant OPERATOR_KEY = uint256(keccak256("domino.v2.f1.operator"));
    /// secp256k1 group order.
    uint256 internal constant CURVE_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    bytes32 internal constant MOCK_INIT_CODE_HASH = keccak256("domino.v2.f1.mock-v3-pool");
    uint32 internal constant MIN_TWAP = 60;
    uint32 internal constant MAX_AGE = 300;
    /// 2**96: price 1.
    uint160 internal constant PRICE = 79228162514264337593543950336;

    address internal constant TOKEN_A = address(0xA0A0);
    address internal constant TOKEN_B = address(0xB1B1);
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    DominoRegistry internal registry;
    DominoPriceAnchor internal anchor;
    MockStateView internal stateView;
    address internal factory;

    function _deployRegistry() internal {
        DominoRegistry.Config memory config;
        config.governance = GOVERNANCE;
        config.guardian = GUARDIAN;
        config.timelockSeconds = TIMELOCK;
        config.feeRecipient = RECIPIENT;
        config.operators = new address[](1);
        config.operators[0] = vm.addr(OPERATOR_KEY);
        config.publishers = new address[](2);
        config.publishers[0] = vm.addr(PUBLISHER_KEY);
        config.publishers[1] = vm.addr(SECOND_PUBLISHER_KEY);
        registry = new DominoRegistry(config);
    }

    function _deployAnchor() internal {
        stateView = new MockStateView();
        factory = address(new CodeStub());
        anchor = new DominoPriceAnchor(address(registry), factory, MOCK_INIT_CODE_HASH, address(stateView), MIN_TWAP);
    }

    function _pool4() internal pure returns (DominoV2Types.PoolRef memory) {
        return DominoV2Types.PoolRef({
            dex: DominoV2Types.DEX_V4, currency0: address(0), currency1: USDG, fee: 3000, tickSpacing: 60, hooks: address(0)
        });
    }

    function _pool3() internal pure returns (DominoV2Types.PoolRef memory) {
        return DominoV2Types.PoolRef({
            dex: DominoV2Types.DEX_V3, currency0: TOKEN_A, currency1: TOKEN_B, fee: 3000, tickSpacing: 60, hooks: address(0)
        });
    }

    function _poolId(DominoV2Types.PoolRef memory pool) internal pure returns (bytes32) {
        return keccak256(abi.encode(pool.currency0, pool.currency1, pool.fee, pool.tickSpacing, pool.hooks));
    }

    function _v3Address(address v3Factory, bytes32 initCodeHash, DominoV2Types.PoolRef memory pool)
        internal
        pure
        returns (address)
    {
        bytes32 salt = keccak256(abi.encode(pool.currency0, pool.currency1, pool.fee));
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", v3Factory, salt, initCodeHash)))));
    }

    /// A mock v3 pool at the address the anchor derives for `pool`: initialized
    /// at `sqrtPriceX96`, unlocked, with the reference's tick spacing.
    function _placeV3Pool(DominoV2Types.PoolRef memory pool, uint160 sqrtPriceX96) internal returns (MockV3Pool placed) {
        address at = _v3Address(factory, MOCK_INIT_CODE_HASH, pool);
        vm.etch(at, address(new MockV3Pool()).code);
        placed = MockV3Pool(at);
        placed.setSlot0(sqrtPriceX96, true);
        placed.setTickSpacing(pool.tickSpacing);
    }

    function _setV4Spot(DominoV2Types.PoolRef memory pool, uint160 sqrtPriceX96) internal {
        stateView.setSqrtPrice(_poolId(pool), sqrtPriceX96);
    }

    function _observation(DominoV2Types.PoolRef memory pool, uint160 sqrtPriceX96)
        internal
        view
        returns (DominoV2Types.PriceObservation memory)
    {
        return DominoV2Types.PriceObservation({
            pool: pool,
            sqrtPriceX96: sqrtPriceX96,
            observedAt: uint64(clock) - 5,
            validUntil: uint64(clock) + 55,
            nonce: 1
        });
    }

    function _sign(uint256 key, DominoV2Types.PriceObservation memory point) internal view returns (bytes memory) {
        return _signDigest(key, anchor.hashObservation(point));
    }

    function _signDigest(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _evidence(DominoV2Types.PriceObservation memory point, bytes memory signature)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(point, signature);
    }

    function _signed(DominoV2Types.PriceObservation memory point) internal view returns (bytes memory) {
        return _evidence(point, _sign(PUBLISHER_KEY, point));
    }
}
