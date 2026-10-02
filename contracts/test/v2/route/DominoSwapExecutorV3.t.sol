// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {IUniswapV3CallbacksMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {DominoSwapExecutor} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {DominoTokenOps} from "../../../src/v2/route/DominoTokenOps.sol";
import {RobinhoodPermit2} from "./fixtures/RobinhoodPermit2.sol";
import {RobinhoodUniswapV3PoolWethUsdg500} from "./fixtures/RobinhoodUniswapV3PoolWethUsdg500.sol";
import {AssistedSwapHarness, MockDominoRegistry, TestToken, V2TestBase} from "./V2RouteTestKit.sol";

interface IUniswapV3PoolTest {
    function initialize(uint160 sqrtPriceX96) external;
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// Pays for liquidity minted on a v3 pool.
contract V3MintHelper {
    function mint(address pool, int24 tickLower, int24 tickUpper, uint128 amount) external {
        IUniswapV3PoolTest(pool).mint(address(this), tickLower, tickUpper, amount, "");
    }

    function uniswapV3MintCallback(uint256 owed0, uint256 owed1, bytes calldata) external {
        if (owed0 > 0) TestToken(IUniswapV3PoolTest(msg.sender).token0()).transfer(msg.sender, owed0);
        if (owed1 > 0) TestToken(IUniswapV3PoolTest(msg.sender).token1()).transfer(msg.sender, owed1);
    }
}

/// Calls the swap callback on behalf of a pool that is not itself.
contract V3Accomplice {
    function callBack(address target, int256 amount0, int256 amount1, bytes calldata data) external {
        IUniswapV3CallbacksMinimal(target).uniswapV3SwapCallback(amount0, amount1, data);
    }
}

/// A pool at a canonical CREATE2 address, scripted to misbehave in one way.
contract ScriptedV3Pool {
    uint8 internal constant HONEST = 0;
    uint8 internal constant ASK_MORE = 1;
    uint8 internal constant ASK_LESS = 2;
    uint8 internal constant ASK_OTHER_TOKEN = 3;
    uint8 internal constant NO_CALLBACK = 4;
    uint8 internal constant ACCOMPLICE = 5;
    uint8 internal constant DOUBLE_CALLBACK = 6;
    uint8 internal constant NO_OUTPUT = 7;

    address public token0;
    address public token1;
    uint8 public mode;
    address public accomplice;

    function configure(address token0_, address token1_, uint8 mode_, address accomplice_) external {
        (token0, token1, mode, accomplice) = (token0_, token1_, mode_, accomplice_);
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amountIn = uint256(amountSpecified);
        uint256 out = mode == NO_OUTPUT ? 0 : amountIn * 99 / 100;
        if (out > 0) TestToken(zeroForOne ? token1 : token0).transfer(recipient, out);
        uint256 ask = mode == ASK_MORE ? amountIn + 1 : (mode == ASK_LESS ? amountIn - 1 : amountIn);
        (amount0, amount1) = zeroForOne ? (int256(ask), -int256(out)) : (-int256(out), int256(ask));
        if (mode == ASK_OTHER_TOKEN) (amount0, amount1) = (amount1, amount0);
        if (mode == ACCOMPLICE) {
            V3Accomplice(accomplice).callBack(msg.sender, amount0, amount1, data);
        } else if (mode != NO_CALLBACK) {
            IUniswapV3CallbacksMinimal(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
            if (mode == DOUBLE_CALLBACK) IUniswapV3CallbacksMinimal(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        }
    }
}

/// LEG_V3_POOL: each hop swaps exact input on the pool at CREATE2(factory,
/// salt, init code hash) from the chain profile, and pays only that pool,
/// only inside that swap, only the hop's input. Run on Robinhood's deployed
/// WETH/USDG 0.05% pool runtime (codehash from the chain profile) and on
/// scripted pools placed at canonical addresses.
contract DominoSwapExecutorV3Test is V2TestBase {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    // api-contracts/v2/chains/robinhood-4663.json
    address internal constant FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    bytes32 internal constant INIT_CODE_HASH = 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint160 internal constant PRICE_ONE = uint160(1 << 96);
    uint128 internal constant IN = 1e18;

    AssistedSwapHarness internal host;
    address internal pool;
    TestToken internal tokenA;
    TestToken internal tokenB;
    TestToken internal tokenC;
    V3Accomplice internal accomplice;

    function setUp() public {
        vm.etch(PERMIT2, RobinhoodPermit2.RUNTIME);
        vm.etch(FACTORY, hex"00"); // the executor only needs its address to have code
        host = new AssistedSwapHarness(DominoSwapExecutor.RouteConfig(
            IDominoRegistry(address(new MockDominoRegistry())), PERMIT2, FACTORY, INIT_CODE_HASH, address(0)));
        // Robinhood's WETH/USDG 0.05% pool, with test tokens at the real token addresses.
        bytes memory tokenCode = address(new TestToken()).code;
        vm.etch(WETH, tokenCode);
        vm.etch(USDG, tokenCode);
        pool = RobinhoodUniswapV3PoolWethUsdg500.ADDRESS;
        vm.etch(pool, RobinhoodUniswapV3PoolWethUsdg500.RUNTIME);
        IUniswapV3PoolTest(pool).initialize(PRICE_ONE);
        V3MintHelper minter = new V3MintHelper();
        TestToken(WETH).mint(address(minter), 1e30);
        TestToken(USDG).mint(address(minter), 1e30);
        minter.mint(pool, -887270, 887270, 1e21);
        TestToken(WETH).mint(address(host), 100e18);
        TestToken(USDG).mint(address(host), 100e18);
        // Scripted pools for paths and failures.
        tokenA = new TestToken();
        tokenB = new TestToken();
        tokenC = new TestToken();
        accomplice = new V3Accomplice();
        tokenA.mint(address(host), 100e18);
        _scripted(address(tokenA), address(tokenB), 500, 0);
        _scripted(address(tokenB), address(tokenC), 3000, 0);
    }

    function _address(address x, address y, uint24 fee) internal pure returns (address) {
        (address a, address b) = x < y ? (x, y) : (y, x);
        return address(uint160(uint256(keccak256(abi.encodePacked(
            hex"ff", FACTORY, keccak256(abi.encode(a, b, fee)), INIT_CODE_HASH)))));
    }

    function _scripted(address x, address y, uint24 fee, uint8 mode) internal returns (address at) {
        at = _address(x, y, fee);
        vm.etch(at, type(ScriptedV3Pool).runtimeCode);
        (address a, address b) = x < y ? (x, y) : (y, x);
        ScriptedV3Pool(at).configure(a, b, mode, address(accomplice));
        TestToken(x).mint(at, 1e30);
        TestToken(y).mint(at, 1e30);
    }

    function _leg(address tokenIn, address tokenOut, uint128 minOut, bytes memory path)
        internal
        pure
        returns (DominoV2Types.SwapLeg memory)
    {
        return DominoV2Types.SwapLeg(DominoV2Types.LEG_V3_POOL, address(0), tokenIn, tokenOut, IN, minOut, path);
    }

    function _one(DominoV2Types.SwapLeg memory leg) internal pure returns (DominoV2Types.SwapLeg[] memory legs) {
        legs = new DominoV2Types.SwapLeg[](1);
        legs[0] = leg;
    }

    function _run(DominoV2Types.SwapLeg memory leg) internal returns (uint256) {
        return host.executeLegs(_one(leg), new address[](0))[0];
    }

    function _refused(DominoV2Types.SwapLeg memory leg, bytes4 selector, string memory what) internal {
        _expectRevert(address(host), abi.encodeCall(AssistedSwapHarness.executeLegs, (_one(leg), new address[](0))),
            selector, what);
    }

    function _abPath() internal view returns (bytes memory) {
        return abi.encodePacked(address(tokenA), uint24(500), address(tokenB));
    }

    // ------------------------------------------------- the deployed pool code
    function testTheFixtureIsRobinhoodsPoolAtItsCanonicalAddress() public pure {
        _check(keccak256(RobinhoodUniswapV3PoolWethUsdg500.RUNTIME) == RobinhoodUniswapV3PoolWethUsdg500.CODEHASH,
            "fixture bytes hash to the profile");
        _check(_address(WETH, USDG, 500) == RobinhoodUniswapV3PoolWethUsdg500.ADDRESS,
            "CREATE2(factory, salt, init code hash) is the deployed pool");
    }

    function testASwapOnTheDeployedPoolCode() public {
        uint256 out = _run(_leg(WETH, USDG, 0.99e18, abi.encodePacked(WETH, uint24(500), USDG)));
        _check(out > 0.99e18 && out < 0.9995e18, "1:1 less the 0.05% fee");
        _eq(TestToken(WETH).balanceOf(address(host)), 99e18, "exactly amountIn left");
        _eq(TestToken(USDG).balanceOf(address(host)), 100e18 + out, "the output arrived");
        out = _run(_leg(USDG, WETH, 0.99e18, abi.encodePacked(USDG, uint24(500), WETH)));
        _eq(TestToken(WETH).balanceOf(address(host)), 99e18 + out, "oneForZero on the same pool");
    }

    function testAMultiHopPathPaysEachPoolInItsOwnCallback() public {
        uint256 out = host.executeLegs(_one(DominoV2Types.SwapLeg(DominoV2Types.LEG_V3_POOL, address(0), address(tokenA),
            address(tokenC), IN, 1, abi.encodePacked(address(tokenA), uint24(500), address(tokenB), uint24(3000),
            address(tokenC)))), new address[](0))[0];
        _eq(out, uint256(IN) * 99 / 100 * 99 / 100, "two hops of 1%");
        _eq(tokenB.balanceOf(address(host)), 0, "the hop came in and went out");
        _eq(tokenA.balanceOf(address(host)), 99e18, "exactly amountIn left");
    }

    // ------------------------------------------------------------ callbacks
    function testAForgedCallbackIsRefused() public {
        _expectRevert(address(host),
            abi.encodeCall(IUniswapV3CallbacksMinimal.uniswapV3SwapCallback, (int256(1e18), int256(-1), "")),
            IDominoPositionActions.Unauthorized.selector, "no swap in progress");
        vm.prank(pool);
        _expectRevert(address(host),
            abi.encodeCall(IUniswapV3CallbacksMinimal.uniswapV3SwapCallback, (int256(1e18), int256(-1), "")),
            IDominoPositionActions.Unauthorized.selector, "even from a real pool, outside our swap");
    }

    function testOnlyThePoolBeingSwappedOnIsPaid() public {
        _scripted(address(tokenA), address(tokenB), 500, 5);
        _refused(_leg(address(tokenA), address(tokenB), 1, _abPath()), IDominoPositionActions.Unauthorized.selector,
            "an accomplice calling back for the pool");
        _scripted(address(tokenA), address(tokenB), 500, 6);
        _refused(_leg(address(tokenA), address(tokenB), 1, _abPath()), IDominoPositionActions.Unauthorized.selector,
            "a second callback");
    }

    function testThePoolIsPaidExactlyTheHopsInput() public {
        _scripted(address(tokenA), address(tokenB), 500, 1);
        _refused(_leg(address(tokenA), address(tokenB), 1, _abPath()), IDominoPositionActions.SwapEffectMismatch.selector,
            "asked for one more");
        _scripted(address(tokenA), address(tokenB), 500, 2);
        _refused(_leg(address(tokenA), address(tokenB), 1, _abPath()), IDominoPositionActions.SwapEffectMismatch.selector,
            "asked for one less (a partial fill)");
        _scripted(address(tokenA), address(tokenB), 500, 3);
        _refused(_leg(address(tokenA), address(tokenB), 1, _abPath()), IDominoPositionActions.SwapEffectMismatch.selector,
            "asked in the output token");
    }

    function testAPoolThatNeverAsksOrNeverPaysIsRefused() public {
        _scripted(address(tokenA), address(tokenB), 500, 4);
        _refused(_leg(address(tokenA), address(tokenB), 1, _abPath()), IDominoPositionActions.SwapEffectMismatch.selector,
            "no callback: the swap did not happen as asked");
        _scripted(address(tokenA), address(tokenB), 500, 7);
        _refused(_leg(address(tokenA), address(tokenB), 1, _abPath()), IDominoPositionActions.SwapEffectMismatch.selector,
            "no output");
    }

    function testAPaymentTheTokenRefusesStopsTheSwap() public {
        tokenA.setMode(1); // transfer returns false
        _refused(_leg(address(tokenA), address(tokenB), 1, _abPath()), DominoTokenOps.TokenCallFailed.selector,
            "the input token refused to move");
    }

    // ------------------------------------------------------------- paths
    function testMalformedPathsAreRefused() public {
        bytes memory ab = _abPath();
        DominoV2Types.SwapLeg memory leg = _leg(address(tokenA), address(tokenB), 1, ab);
        leg.router = address(0x1234);
        _refused(leg, IDominoPositionActions.InvalidPlan.selector, "a router on a pool leg");
        _refused(_leg(address(tokenA), address(tokenB), 1, abi.encodePacked(address(tokenA), uint24(500))),
            IDominoPositionActions.InvalidPlan.selector, "shorter than one hop");
        _refused(_leg(address(tokenA), address(tokenB), 1, abi.encodePacked(bytes19(0))),
            IDominoPositionActions.InvalidPlan.selector, "shorter than one token");
        _refused(_leg(address(tokenA), address(tokenB), 1, abi.encodePacked(ab, uint8(0))),
            IDominoPositionActions.InvalidPlan.selector, "a trailing byte");
        bytes memory five = abi.encodePacked(address(tokenA));
        for (uint256 i; i < 5; ++i) five = abi.encodePacked(five, uint24(500), i % 2 == 0 ? address(tokenB) : address(tokenA));
        _refused(_leg(address(tokenA), address(tokenB), 1, five), IDominoPositionActions.InvalidPlan.selector, "five hops");
        _refused(_leg(address(tokenB), address(tokenC), 1, abi.encodePacked(ab, uint24(3000), address(tokenC))),
            IDominoPositionActions.InvalidPlan.selector, "the path does not start at tokenIn");
        _refused(_leg(address(tokenA), address(tokenC), 1, ab), IDominoPositionActions.InvalidPlan.selector,
            "the path does not end at tokenOut");
        _refused(_leg(address(tokenA), address(tokenB), 1, abi.encodePacked(address(tokenA), uint24(10000), address(tokenB))),
            IDominoPositionActions.InvalidPlan.selector, "no pool for that fee");
        _refused(_leg(address(0), address(tokenB), 1, abi.encodePacked(address(0), uint24(500), address(tokenB))),
            IDominoPositionActions.InvalidPlan.selector, "native currency: v3 uses WETH");
    }

    function testFourHopsAreTheLimit() public {
        _scripted(address(tokenC), address(tokenA), 100, 0);
        bytes memory four = abi.encodePacked(address(tokenA), uint24(500), address(tokenB), uint24(3000), address(tokenC));
        four = abi.encodePacked(four, uint24(100), address(tokenA), uint24(500), address(tokenB));
        uint256 out = host.executeLegs(_one(_leg(address(tokenA), address(tokenB), 1, four)), new address[](0))[0];
        _check(out > 0, "four hops run");
    }
}
