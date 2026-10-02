// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {IV4PoolManagerMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {DominoFullMath} from "../../../src/v2/route/DominoFullMath.sol";
import {DominoSwapExecutor} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {DominoSwapFloor} from "../../../src/v2/route/DominoSwapFloor.sol";
import {FullMath} from "../../reference/official-v4/v4-core/src/libraries/FullMath.sol";
import {ProtocolFeeLibrary} from "../../reference/official-v4/v4-core/src/libraries/ProtocolFeeLibrary.sol";
import {RobinhoodPermit2} from "./fixtures/RobinhoodPermit2.sol";
import {
    AssistedSwapHarness,
    IV4PoolManagerTest,
    MockDominoRegistry,
    TestToken,
    V2TestBase,
    V4LiquidityHelper
} from "./V2RouteTestKit.sol";
import {V2VendoredFixtures} from "./V2VendoredFixtures.sol";

/// The floor library's internal functions, callable from outside.
contract SwapFloorProbe {
    function quote(uint256 amountIn, uint160 sqrtPriceX96, bool zeroForOne) external pure returns (uint256) {
        return DominoSwapFloor.quote(amountIn, sqrtPriceX96, zeroForOne);
    }

    function minimumOutput(uint256 amountIn, uint160 sqrtPriceX96, bool zeroForOne, uint24 poolFeePips, uint16 slippageBps)
        external
        pure
        returns (uint256)
    {
        return DominoSwapFloor.minimumOutput(amountIn, sqrtPriceX96, zeroForOne, poolFeePips, slippageBps);
    }

    function v4SwapFeePips(uint24 protocolFee, uint24 lpFee, bool zeroForOne) external pure returns (uint24) {
        return DominoSwapFloor.v4SwapFeePips(protocolFee, lpFee, zeroForOne);
    }

    function v4SpotAndFee(address manager, DominoV2Types.PoolRef calldata pool, bool zeroForOne)
        external
        view
        returns (uint160, uint24)
    {
        return DominoSwapFloor.v4SpotAndFee(manager, pool, zeroForOne);
    }

    function v4Slot0(address manager, bytes32 poolId) external view returns (uint160, uint24, uint24) {
        return DominoSwapFloor.v4Slot0(manager, poolId);
    }

    function v3SpotAndFee(address pool) external view returns (uint160, uint24) {
        return DominoSwapFloor.v3SpotAndFee(pool);
    }

    function mulDiv(uint256 a, uint256 b, uint256 d) external pure returns (uint256) {
        return DominoFullMath.mulDiv(a, b, d);
    }
}

/// A v3 pool's two views the floor reads.
contract FeeReportingV3Pool {
    function slot0() external pure returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (uint160(1 << 96), 0, 0, 1, 1, 0x44, true); // feeProtocol 1/4 on both sides
    }

    function fee() external pure returns (uint24) {
        return 3000;
    }
}

/// The fee-aware floor: quote × (1 − pool fee) × (1 − maxSlippageBps), with
/// the pool fee read as v4-core charges it (protocol fee first, then LP) and
/// as v3 charges it (the protocol share is inside the LP fee). Ends with the
/// #3409682 case: a 2% pool and a 1% owner limit.
contract DominoSwapFloorTest is V2TestBase {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint160 internal constant PRICE_ONE = uint160(1 << 96);
    int24 internal constant FULL = 886800; // a multiple of both spacings used here (60, 400)

    SwapFloorProbe internal probe;

    function setUp() public {
        probe = new SwapFloorProbe();
    }

    // ---------------------------------------------------------------- math
    function testTheQuoteAtSimplePrices() public view {
        _eq(probe.quote(1e18, PRICE_ONE, true), 1e18, "1:1");
        _eq(probe.quote(1e18, PRICE_ONE * 2, true), 4e18, "price 4, token0 in");
        _eq(probe.quote(1e18, PRICE_ONE * 2, false), 0.25e18, "price 4, token1 in");
        // Above 2^128 the ratio is taken in Q128 to stay in range.
        uint160 high = uint160(1) << 140; // price 2^88
        _eq(probe.quote(1, high, true), 1 << 88, "high price, token0 in");
        _eq(probe.quote(1 << 88, high, false), 1, "high price, token1 in");
    }

    /// Below 2^128 the exact sqrtP^2 is used: the Q128 shortcut would drop
    /// the low 64 bits of the ratio and quote one unit less here.
    function testLowPricesKeepTheFullRatio() public view {
        uint160 price = uint160((1 << 40) + (1 << 31));
        _eq(probe.quote(1 << 130, price, true), 263_169, "2^18 + 2^10 + 1, not 2^18 + 2^10");
    }

    function testFuzzTheQuoteAgreesAcrossTheBoundary(uint256 amount, uint160 sqrtPriceX96) public view {
        amount = amount % (1 << 96) + 1;
        sqrtPriceX96 = uint160(sqrtPriceX96 % (uint256(1) << 159)) + 4295128739;
        // Reference: amount × sqrtP² / 2^192 computed in two mulDivs.
        uint256 reference0 = FullMath.mulDiv(FullMath.mulDiv(amount, sqrtPriceX96, 1 << 96), sqrtPriceX96, 1 << 96);
        uint256 q = probe.quote(amount, sqrtPriceX96, true);
        // The two-step reference rounds twice; the library once (or, above
        // 2^128, truncates the ratio in Q128 first): both within a few units.
        uint256 gap = q > reference0 ? q - reference0 : reference0 - q;
        _check(gap <= sqrtPriceX96 / (1 << 96) + 2, "token0 in");
    }

    function testFuzzMulDivIsUniswapsFullMath(uint256 a, uint256 b, uint256 d) public view {
        d = d == 0 ? 1 : d;
        (bool expectedOk, bytes memory expected) =
            address(this).staticcall(abi.encodeCall(this.referenceMulDiv, (a, b, d)));
        (bool ok, bytes memory actual) = address(probe).staticcall(abi.encodeCall(SwapFloorProbe.mulDiv, (a, b, d)));
        _check(ok == expectedOk && (!ok || keccak256(actual) == keccak256(expected)), "mulDiv differs");
    }

    function referenceMulDiv(uint256 a, uint256 b, uint256 d) external pure returns (uint256) {
        return FullMath.mulDiv(a, b, d);
    }

    function testTheFloorExcludesThePoolFeeThenTheSlippage() public view {
        _eq(probe.minimumOutput(100e6, PRICE_ONE, true, 20_000, 100), 97.02e6, "2% pool, 1% limit: 98% x 99%");
        _eq(probe.minimumOutput(100e6, PRICE_ONE, true, 0, 0), 100e6, "no fee, no slippage: the quote");
        _eq(probe.minimumOutput(100e6, PRICE_ONE, false, 3000, 50), uint256(100e6) * 997_000 * 9_950 / 1e10, "one rounding");
        _eq(probe.minimumOutput(3, PRICE_ONE, true, 3000, 50), 2, "rounded down");
    }

    function testTheFloorRefusesNonsense() public {
        _expectRevert(address(probe), abi.encodeCall(SwapFloorProbe.minimumOutput, (1, 0, true, 3000, 50)),
            DominoSwapFloor.InvalidFloor.selector, "no price");
        _expectRevert(address(probe), abi.encodeCall(SwapFloorProbe.minimumOutput, (1, PRICE_ONE, true, 1_000_000, 50)),
            DominoSwapFloor.InvalidFloor.selector, "a 100% pool fee");
        _expectRevert(address(probe), abi.encodeCall(SwapFloorProbe.minimumOutput, (1, PRICE_ONE, true, 3000, 10_000)),
            DominoSwapFloor.InvalidFloor.selector, "a 100% slippage");
        _eq(probe.minimumOutput(1e6, PRICE_ONE, true, 999_999, 9_999), 0, "just below both limits");
    }

    // ------------------------------------------------------------ pool fees
    function testTheV4FeeIsTheProtocolFeeThenTheLpFee() public view {
        _eq(probe.v4SwapFeePips(0, 3000, true), 3000, "no protocol fee");
        uint24 packed = 500 | (1000 << 12); // zeroForOne 500 pips, oneForZero 1000 pips
        _eq(probe.v4SwapFeePips(packed, 3000, true), 3499, "500 + 3000 - 1.5, rounded up");
        _eq(probe.v4SwapFeePips(packed, 3000, false), 3997, "1000 + 3000 - 3");
        _eq(probe.v4SwapFeePips(packed, 0, true), 500, "a protocol fee alone");
    }

    function testFuzzTheV4FeeIsV4CoresCalculation(uint24 protocolFee, uint24 lpFee, bool zeroForOne) public view {
        protocolFee = uint24((protocolFee & 0xfff) % 1001 | (((protocolFee >> 12) % 1001) << 12));
        lpFee = lpFee % 1_000_001;
        uint16 direction = zeroForOne
            ? ProtocolFeeLibrary.getZeroForOneFee(protocolFee)
            : ProtocolFeeLibrary.getOneForZeroFee(protocolFee);
        uint24 expected = direction == 0 ? lpFee : ProtocolFeeLibrary.calculateSwapFee(direction, lpFee);
        _eq(probe.v4SwapFeePips(protocolFee, lpFee, zeroForOne), expected, "v4-core's swap fee");
    }

    function testAV3PoolChargesExactlyItsFee() public {
        (uint160 price, uint24 fee) = probe.v3SpotAndFee(address(new FeeReportingV3Pool()));
        _check(price == PRICE_ONE && fee == 3000, "the protocol share (1/4) is inside the 0.3%, not added");
    }

    // ------------------------------------------------- on the PoolManager
    function _stack(uint24 lpFee, int24 spacing)
        internal
        returns (IV4PoolManagerTest manager, AssistedSwapHarness host, TestToken token0, TestToken token1, DominoV2Types.PoolRef memory ref)
    {
        vm.etch(PERMIT2, RobinhoodPermit2.RUNTIME);
        manager = IV4PoolManagerTest(address(V2VendoredFixtures.deployPoolManager(address(this))));
        host = new AssistedSwapHarness(DominoSwapExecutor.RouteConfig(
            IDominoRegistry(address(new MockDominoRegistry())), PERMIT2, address(0), bytes32(0), address(manager)));
        (token0, token1) = (new TestToken(), new TestToken());
        if (address(token1) < address(token0)) (token0, token1) = (token1, token0);
        V4LiquidityHelper liquidity = new V4LiquidityHelper(address(manager));
        token0.mint(address(liquidity), 1e36);
        token1.mint(address(liquidity), 1e36);
        token0.mint(address(host), 1e24);
        IV4PoolManagerMinimal.PoolKey memory key =
            IV4PoolManagerMinimal.PoolKey(address(token0), address(token1), lpFee, spacing, address(0));
        manager.initialize(key, PRICE_ONE);
        liquidity.add(key, -FULL, FULL, 1e30);
        ref = DominoV2Types.PoolRef(DominoV2Types.DEX_V4, address(token0), address(token1), lpFee, spacing, address(0));
    }

    function _leg(DominoV2Types.PoolRef memory ref, uint128 amountIn, uint256 minOut)
        internal
        pure
        returns (DominoV2Types.SwapLeg[] memory legs)
    {
        DominoV2Types.PoolRef[] memory pools = new DominoV2Types.PoolRef[](1);
        pools[0] = ref;
        legs = new DominoV2Types.SwapLeg[](1);
        legs[0] = DominoV2Types.SwapLeg(DominoV2Types.LEG_V4_POOL, address(0), ref.currency0, ref.currency1, amountIn,
            uint128(minOut), abi.encode(pools));
    }

    function testTheSlot0ReadIsThePoolManagersState() public {
        (IV4PoolManagerTest manager,,,, DominoV2Types.PoolRef memory ref) = _stack(3000, 60);
        manager.setProtocolFeeController(address(this));
        IV4PoolManagerMinimal.PoolKey memory key =
            IV4PoolManagerMinimal.PoolKey(ref.currency0, ref.currency1, ref.fee, ref.tickSpacing, ref.hooks);
        manager.setProtocolFee(key, 1000 | (200 << 12));
        bytes32 poolId = keccak256(abi.encode(key));
        (uint160 price, uint24 protocolFee, uint24 lpFee) = probe.v4Slot0(address(manager), poolId);
        _check(price == PRICE_ONE && protocolFee == (1000 | (200 << 12)) && lpFee == 3000, "slot0 fields");
        (uint160 spot, uint24 fee) = probe.v4SpotAndFee(address(manager), ref, true);
        _check(spot == PRICE_ONE && fee == 3997, "zeroForOne: 1000 + 3000 - 3");
        (, fee) = probe.v4SpotAndFee(address(manager), ref, false);
        _eq(fee, 3200, "oneForZero: 200 + 3000 - 0 (0.6 rounds the total up)");
    }

    /// V1 audit A7: the protocol fee comes before the LP fee and consumes the
    /// owner's slippage unless the floor counts it.
    function testTheFloorMustCountTheProtocolFee() public {
        (IV4PoolManagerTest manager, AssistedSwapHarness host,,, DominoV2Types.PoolRef memory ref) = _stack(3000, 60);
        manager.setProtocolFeeController(address(this));
        manager.setProtocolFee(
            IV4PoolManagerMinimal.PoolKey(ref.currency0, ref.currency1, ref.fee, ref.tickSpacing, ref.hooks), 1000);
        uint128 amountIn = 1e18;
        (uint160 spot, uint24 fee) = probe.v4SpotAndFee(address(manager), ref, true);
        uint256 lpOnly = probe.minimumOutput(amountIn, spot, true, ref.fee, 5);
        _expectRevert(address(host), abi.encodeCall(AssistedSwapHarness.executeLegs, (_leg(ref, amountIn, lpOnly),
            new address[](0))), IDominoPositionActions.SwapEffectMismatch.selector, "a floor without the protocol fee");
        uint256 floor = probe.minimumOutput(amountIn, spot, true, fee, 5);
        uint256 out = host.executeLegs(_leg(ref, amountIn, floor), new address[](0))[0];
        _check(out >= floor && out < lpOnly, "the protocol fee's floor passes, 0.05% from the quote net of fees");
    }

    /// #3409682: in a 2% pool a 1% owner limit let no swap through in V1
    /// (97.8% of spot against a 99% floor). The V2 floor excludes the pool's fee.
    function testThe3409682Case() public {
        (IV4PoolManagerTest manager, AssistedSwapHarness host,,, DominoV2Types.PoolRef memory ref) = _stack(20_000, 400);
        uint128 amountIn = 25e6;
        (uint160 spot, uint24 fee) = probe.v4SpotAndFee(address(manager), ref, true);
        _eq(fee, 20_000, "the pool's 2%");
        uint256 v1Floor = probe.quote(amountIn, spot, true) * 9_900 / 10_000;
        _expectRevert(address(host), abi.encodeCall(AssistedSwapHarness.executeLegs, (_leg(ref, amountIn, v1Floor),
            new address[](0))), IDominoPositionActions.SwapEffectMismatch.selector, "V1's floor: no swap passes");
        uint256 v2Floor = probe.minimumOutput(amountIn, spot, true, fee, 100);
        _eq(v2Floor, 24.255e6, "25 x 98% x 99%");
        uint256 out = host.executeLegs(_leg(ref, amountIn, v2Floor), new address[](0))[0];
        _check(out >= 24.49e6 && out < v1Floor, "about 98% of spot, accepted");
    }
}
