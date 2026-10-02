// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {AnchorMath} from "../../../src/v2/anchor/AnchorMath.sol";
import {DominoPriceAnchor} from "../../../src/v2/anchor/DominoPriceAnchor.sol";
import {IUniswapV3PoolMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {IDominoPriceAnchor} from "../../../src/v2/interfaces/IDominoPriceAnchor.sol";
import {CodeStub} from "../registry/RegistryFixtures.sol";
import {AnchorFixtures, MockStateView} from "./AnchorFixtures.sol";
import {UniswapV3PoolRuntime} from "./UniswapV3PoolRuntime.sol";

/// @notice The anchor against the deployed Uniswap v3 pool bytecode (Base
/// WETH/USDC 0.05%, code hash pinned to the chain profile), at its own address
/// and derived from the real factory and init code hash. The oracle history is
/// written into the pool's storage, laid out as v3-core lays it out (slot0 in
/// slot 0, liquidity in slot 4, observations from slot 8; checked against the
/// live pool's getters when the fixture was taken), so observe() interpolates
/// and refuses exactly as on chain.
contract DominoPriceAnchorV3DeployedTest is AnchorFixtures {
    address internal constant BASE_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    bytes32 internal constant INIT_CODE_HASH = 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant POOL = UniswapV3PoolRuntime.BASE_WETH_USDC_500;

    /// The tick history: FIRST over [now-1000, now-400), SECOND over
    /// [now-400, now-100), CURRENT since.
    int24 internal constant FIRST = -2000;
    int24 internal constant SECOND = 1000;
    int24 internal constant CURRENT = 1300;

    function setUp() public {
        _warpTo(START);
        _deployRegistry();
        vm.etch(BASE_FACTORY, address(new CodeStub()).code);
        anchor = new DominoPriceAnchor(
            address(registry), BASE_FACTORY, INIT_CODE_HASH, address(new MockStateView()), MIN_TWAP
        );
        vm.etch(POOL, UniswapV3PoolRuntime.code());
        _storeObservation(0, START - 1000, 0);
        _storeObservation(1, START - 400, int56(FIRST) * 600);
        _storeObservation(2, START - 100, int56(FIRST) * 600 + int56(SECOND) * 300);
        _storeSlot0(CURRENT, true);
        vm.store(POOL, bytes32(uint256(4)), bytes32(uint256(1e18)));
    }

    function _pool() internal pure returns (DominoV2Types.PoolRef memory) {
        return DominoV2Types.PoolRef({
            dex: DominoV2Types.DEX_V3, currency0: WETH, currency1: USDC, fee: 500, tickSpacing: 10, hooks: address(0)
        });
    }

    /// slot0: sqrtPriceX96 | tick | observationIndex 2 | cardinality 3 | cardinalityNext 3 | feeProtocol 0x44 | unlocked.
    function _storeSlot0(int24 tick, bool unlocked) internal {
        uint256 word = uint256(AnchorMath.getSqrtPriceAtTick(tick)) | (uint256(uint24(tick)) << 160)
            | (uint256(2) << 184) | (uint256(3) << 200) | (uint256(3) << 216) | (uint256(0x44) << 232)
            | (uint256(unlocked ? 1 : 0) << 240);
        vm.store(POOL, bytes32(0), bytes32(word));
    }

    /// observations[index]: blockTimestamp | tickCumulative | secondsPerLiquidityCumulativeX128 | initialized.
    function _storeObservation(uint256 index, uint256 timestamp, int56 tickCumulative) internal {
        uint256 word = uint256(uint32(timestamp)) | (uint256(uint56(tickCumulative)) << 32) | (uint256(1) << 248);
        vm.store(POOL, bytes32(8 + index), bytes32(word));
    }

    function testFixtureIsTheDeployedPoolInTheStateWritten() public view {
        _check(keccak256(POOL.code) == UniswapV3PoolRuntime.CODEHASH, "deployed code hash");
        IUniswapV3PoolMinimal pool = IUniswapV3PoolMinimal(POOL);
        (uint160 sqrtPriceX96, int24 tick, uint16 index, uint16 cardinality,,, bool unlocked) = pool.slot0();
        _check(sqrtPriceX96 == AnchorMath.getSqrtPriceAtTick(CURRENT) && tick == CURRENT, "slot0 price and tick");
        _check(index == 2 && cardinality == 3 && unlocked, "slot0 oracle and lock");
        _check(pool.token0() == WETH && pool.token1() == USDC && pool.fee() == 500 && pool.tickSpacing() == 10, "pool");
        _eq(anchor.spotSqrtPrice(_pool()), AnchorMath.getSqrtPriceAtTick(CURRENT), "spot through the anchor");
    }

    function testTwapInterpolatesTheDeployedOracle() public view {
        // [now-300, now]: 200 s of SECOND, 100 s of CURRENT -> 1100.
        _eq(anchor.twapSqrtPrice(_pool(), 300), AnchorMath.getSqrtPriceAtTick(1100), "inside a segment");
        // [now-120, now]: 20 s of SECOND, 100 s of CURRENT -> 1250.
        _eq(anchor.twapSqrtPrice(_pool(), 120), AnchorMath.getSqrtPriceAtTick(1250), "short window");
        // [now-1000, now]: the whole history -> -770.
        _eq(anchor.twapSqrtPrice(_pool(), 1000), AnchorMath.getSqrtPriceAtTick(-770), "whole history");
    }

    function testTwapExtrapolatesTheCurrentTickToNow() public {
        _advance(50);
        // [now-300, now] is now [start-250, start+50]: 150 s of SECOND, 150 s of CURRENT -> 1150.
        _eq(anchor.twapSqrtPrice(_pool(), 300), AnchorMath.getSqrtPriceAtTick(1150), "extrapolated");
    }

    function testWindowOlderThanTheHistoryIsUnavailable() public {
        vm.expectRevert(IDominoPriceAnchor.TwapUnavailable.selector);
        anchor.twapSqrtPrice(_pool(), 1001);
    }

    function testAnchorBandsTheDeployedPoolTwap() public {
        // Anchor at tick 1100, spot at 1300: 1.0001^200 = 1.0202 on the price.
        vm.expectRevert(IDominoPriceAnchor.SpotOutsideBand.selector);
        anchor.anchor(_pool(), abi.encode(uint32(300)), MAX_AGE, 201);
        (uint160 anchored, uint160 spot) = anchor.anchor(_pool(), abi.encode(uint32(300)), MAX_AGE, 203);
        _check(anchored == AnchorMath.getSqrtPriceAtTick(1100), "TWAP anchor");
        _check(spot == AnchorMath.getSqrtPriceAtTick(CURRENT), "deployed spot");
    }

    function testDeployedPoolMidOperationIsRefused() public {
        _storeSlot0(CURRENT, false);
        vm.expectRevert(DominoPriceAnchor.PoolUnavailable.selector);
        anchor.anchor(_pool(), abi.encode(uint32(300)), MAX_AGE, 300);
    }

    function testReferenceWithAnotherTickSpacingIsRefused() public {
        DominoV2Types.PoolRef memory wrong = _pool();
        wrong.tickSpacing = 60;
        vm.expectRevert(DominoPriceAnchor.PoolUnavailable.selector);
        anchor.spotSqrtPrice(wrong);
    }
}
