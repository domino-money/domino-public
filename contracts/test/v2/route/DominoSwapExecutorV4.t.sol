// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {IV4PoolManagerMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {DominoSwapExecutor} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {RobinhoodPermit2} from "./fixtures/RobinhoodPermit2.sol";
import {OutputSkimmingHook} from "./RouteAdversaries.sol";
import {
    AssistedSwapHarness,
    IV4PoolManagerTest,
    MockDominoRegistry,
    TestToken,
    V2TestBase,
    V2Vm,
    V4LiquidityHelper
} from "./V2RouteTestKit.sol";
import {V2VendoredFixtures} from "./V2VendoredFixtures.sol";

/// Calls a host's unlockCallback on behalf of the manager.
contract CallbackForwarder {
    function forward(address host, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory out) = host.call(abi.encodeWithSignature("unlockCallback(bytes)", data));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(out, 0x20), mload(out))
            }
        }
        return out;
    }
}

/// A "manager" whose unlock lets someone else call the host back with the
/// right data: only the msg.sender check stands between it and a swap.
contract ForwardingManager {
    CallbackForwarder public immutable forwarder = new CallbackForwarder();

    function unlock(bytes calldata data) external returns (bytes memory) {
        return forwarder.forward(msg.sender, data);
    }

    function swap(IV4PoolManagerMinimal.PoolKey memory, IV4PoolManagerMinimal.SwapParams memory, bytes calldata)
        external
        pure
        returns (int256)
    {
        revert("reached swap");
    }
}

/// LEG_V4_POOL against the vendored v4-core PoolManager: one unlock swaps
/// every hop exact-input, settles the input and takes the output; hooks are
/// allowed on the swap and judged by what arrives.
contract DominoSwapExecutorV4Test is V2TestBase {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant ETH = address(0);
    uint160 internal constant PRICE_ONE = uint160(1 << 96);
    uint128 internal constant IN = 1e18;
    int24 internal constant FULL = 887220;

    IV4PoolManagerTest internal manager;
    V4LiquidityHelper internal liquidity;
    AssistedSwapHarness internal host;
    MockDominoRegistry internal registry;
    TestToken internal token0;
    TestToken internal token1;
    TestToken internal token2;
    OutputSkimmingHook internal hook;

    function setUp() public {
        vm.etch(PERMIT2, RobinhoodPermit2.RUNTIME);
        manager = IV4PoolManagerTest(address(V2VendoredFixtures.deployPoolManager(address(this))));
        registry = new MockDominoRegistry();
        host = new AssistedSwapHarness(DominoSwapExecutor.RouteConfig(
            IDominoRegistry(address(registry)), PERMIT2, address(0), bytes32(0), address(manager)));
        liquidity = new V4LiquidityHelper(address(manager));
        TestToken[3] memory tokens = [new TestToken(), new TestToken(), new TestToken()];
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (address(tokens[j]) < address(tokens[i])) (tokens[i], tokens[j]) = (tokens[j], tokens[i]);
            }
            tokens[i].mint(address(liquidity), 1e30);
            tokens[i].mint(address(host), 100e18);
        }
        (token0, token1, token2) = (tokens[0], tokens[1], tokens[2]);
        vm.deal(address(liquidity), 1e27);
        vm.deal(address(host), 100 ether);
        _pool(_key(address(token0), address(token1), 3000, 60, address(0)), -FULL, FULL);
        _pool(_key(address(token1), address(token2), 500, 10, address(0)), -FULL, FULL);
        _pool(_key(ETH, address(token0), 3000, 60, address(0)), -FULL, FULL);
        // Liquidity only around the price: a large swap runs out of it.
        _pool(_key(address(token0), address(token2), 3000, 60, address(0)), -60, 60);
        // The same pair behind a hook that keeps 1% of the output.
        OutputSkimmingHook template = new OutputSkimmingHook(address(manager));
        hook = OutputSkimmingHook(address(uint160(0x10044))); // afterSwap + afterSwapReturnDelta
        vm.etch(address(hook), address(template).code);
        hook.setSkim(100);
        _pool(_key(address(token0), address(token1), 3000, 60, address(hook)), -FULL, FULL);
    }

    function _key(address c0, address c1, uint24 fee, int24 spacing, address hooks)
        internal
        pure
        returns (IV4PoolManagerMinimal.PoolKey memory)
    {
        return IV4PoolManagerMinimal.PoolKey(c0, c1, fee, spacing, hooks);
    }

    function _pool(IV4PoolManagerMinimal.PoolKey memory key, int24 lower, int24 upper) internal {
        manager.initialize(key, PRICE_ONE);
        liquidity.add(key, lower, upper, 1e21);
    }

    function _ref(address c0, address c1, uint24 fee, int24 spacing, address hooks)
        internal
        pure
        returns (DominoV2Types.PoolRef memory)
    {
        return DominoV2Types.PoolRef(DominoV2Types.DEX_V4, c0, c1, fee, spacing, hooks);
    }

    function _refAB() internal view returns (DominoV2Types.PoolRef memory) {
        return _ref(address(token0), address(token1), 3000, 60, address(0));
    }

    function _leg(address tokenIn, address tokenOut, uint128 amountIn, uint128 minOut, DominoV2Types.PoolRef[] memory pools)
        internal
        pure
        returns (DominoV2Types.SwapLeg memory)
    {
        return DominoV2Types.SwapLeg(DominoV2Types.LEG_V4_POOL, address(0), tokenIn, tokenOut, amountIn, minOut, abi.encode(pools));
    }

    function _path(DominoV2Types.PoolRef memory a) internal pure returns (DominoV2Types.PoolRef[] memory pools) {
        pools = new DominoV2Types.PoolRef[](1);
        pools[0] = a;
    }

    function _path(DominoV2Types.PoolRef memory a, DominoV2Types.PoolRef memory b)
        internal
        pure
        returns (DominoV2Types.PoolRef[] memory pools)
    {
        pools = new DominoV2Types.PoolRef[](2);
        (pools[0], pools[1]) = (a, b);
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

    /// What the leg delivers now, without keeping the swap.
    function _dryRun(DominoV2Types.SwapLeg memory leg) internal returns (uint256 out) {
        uint256 snapshot = vm.snapshotState();
        out = _run(leg);
        vm.revertToState(snapshot);
    }

    // ------------------------------------------------------------ accepted
    function testASingleHopIsExactInputAndMeasured() public {
        uint256 before0 = token0.balanceOf(address(host));
        vm.recordLogs();
        uint256 out = _run(_leg(address(token0), address(token1), IN, 0.99e18, _path(_refAB())));
        V2Vm.Log memory leg = _first(vm.getRecordedLogs(), address(host),
            keccak256("SwapLegExecuted(uint8,address,address,address,uint256,uint256)"));
        _check(out > 0.99e18 && out < 0.997e18, "1:1 less the 0.3% LP fee");
        _eq(before0 - token0.balanceOf(address(host)), IN, "exactly amountIn left");
        _eq(token1.balanceOf(address(host)), 100e18 + out, "the output arrived");
        (address venue,, uint256 logged) = abi.decode(leg.data, (address, uint256, uint256));
        _check(venue == address(manager) && logged == out, "event names the PoolManager and the output");
    }

    function testTheReverseDirection() public {
        uint256 out = _run(_leg(address(token1), address(token0), IN, 0.99e18, _path(_refAB())));
        _eq(token0.balanceOf(address(host)), 100e18 + out, "oneForZero arrived");
    }

    function testAMultiHopPathNetsTheHopInsideTheManager() public {
        uint256 out = _run(_leg(address(token0), address(token2), IN, 0.98e18,
            _path(_refAB(), _ref(address(token1), address(token2), 500, 10, address(0)))));
        _check(out > 0.98e18, "two fees, small impact");
        _eq(token1.balanceOf(address(host)), 100e18, "the hop never touched this contract");
        _eq(token2.balanceOf(address(host)), 100e18 + out, "the output arrived");
    }

    function testANativeInputSettlesWithValue() public {
        uint256 before = address(host).balance;
        uint256 out = _run(_leg(ETH, address(token0), IN, 0.99e18, _path(_ref(ETH, address(token0), 3000, 60, address(0)))));
        _eq(before - address(host).balance, IN, "exactly amountIn of ETH left");
        _eq(token0.balanceOf(address(host)), 100e18 + out, "token arrived");
    }

    function testANativeOutputIsTaken() public {
        uint256 before = address(host).balance;
        uint256 out = _run(_leg(address(token0), ETH, IN, 0.99e18, _path(_ref(ETH, address(token0), 3000, 60, address(0)))));
        _eq(address(host).balance - before, out, "ETH arrived");
    }

    function testTheMinimumIsExact() public {
        DominoV2Types.SwapLeg memory leg = _leg(address(token0), address(token1), IN, 1, _path(_refAB()));
        uint256 out = _dryRun(leg);
        leg.minAmountOut = uint128(out + 1);
        _refused(leg, IDominoPositionActions.SwapEffectMismatch.selector, "one unit above what the pool gives");
        leg.minAmountOut = uint128(out);
        _eq(_run(leg), out, "exactly what the pool gives");
    }

    /// A hooked pool may take part of the output: the leg is judged by what
    /// actually arrives, against the owner's minimum.
    function testAHookOnTheSwapIsJudgedByWhatArrives() public {
        DominoV2Types.PoolRef[] memory hooked = _path(_ref(address(token0), address(token1), 3000, 60, address(hook)));
        uint256 plain = _dryRun(_leg(address(token0), address(token1), IN, 1, _path(_refAB())));
        DominoV2Types.SwapLeg memory leg = _leg(address(token0), address(token1), IN, uint128(plain), hooked);
        _refused(leg, IDominoPositionActions.SwapEffectMismatch.selector, "the hook kept 1%");
        leg.minAmountOut = uint128(plain * 98 / 100);
        uint256 out = _run(leg);
        _check(out < plain && out >= plain * 98 / 100, "what arrived, net of the hook");
        _eq(token1.balanceOf(address(hook)), plain - out, "the hook kept the difference");
    }

    /// The netting entry point F3 composes into its own unlock.
    function testAHostCanNetAPathInsideItsOwnUnlock() public {
        uint256 out = host.nettedV4Swap(address(token0), IN, _path(_refAB()));
        _check(out > 0.99e18, "swapped");
        _eq(token1.balanceOf(address(host)), 100e18 + out, "taken once");
        _eq(token0.balanceOf(address(host)), 100e18 - IN, "settled once");
    }

    // ------------------------------------------------------------- refused
    /// Exact input means the whole input: a pool that runs out of liquidity
    /// before the price limit fills partially, and that is refused.
    function testAPartialFillIsRefused() public {
        DominoV2Types.SwapLeg memory leg = _leg(address(token0), address(token2), 1e24, 1,
            _path(_ref(address(token0), address(token2), 3000, 60, address(0))));
        _refused(leg, IDominoPositionActions.SwapEffectMismatch.selector, "the pool could not take it all");
    }

    function testMalformedPathsAreRefused() public {
        DominoV2Types.PoolRef memory ab = _refAB();
        DominoV2Types.SwapLeg memory leg = _leg(address(token0), address(token1), IN, 1, _path(ab));
        leg.router = address(0x1234);
        _refused(leg, IDominoPositionActions.InvalidPlan.selector, "a router on a pool leg");
        _refused(_leg(address(token0), address(token1), IN, 1, new DominoV2Types.PoolRef[](0)),
            IDominoPositionActions.InvalidPlan.selector, "no hop");
        DominoV2Types.PoolRef[] memory five = new DominoV2Types.PoolRef[](5);
        for (uint256 i; i < 5; ++i) five[i] = ab;
        _refused(_leg(address(token0), address(token1), IN, 1, five), IDominoPositionActions.InvalidPlan.selector,
            "five hops");
        _refused(_leg(address(token2), address(token1), IN, 1, _path(ab)), IDominoPositionActions.InvalidPlan.selector,
            "the path does not start at tokenIn");
        _refused(_leg(address(token0), address(token2), IN, 1, _path(ab)), IDominoPositionActions.InvalidPlan.selector,
            "the path does not end at tokenOut");
        DominoV2Types.PoolRef memory v3 = ab;
        v3.dex = DominoV2Types.DEX_V3;
        _refused(_leg(address(token0), address(token1), IN, 1, _path(v3)), IDominoPositionActions.InvalidPlan.selector,
            "a v3 pool in a v4 path");
        // A pool that was never initialized: the PoolManager's own refusal.
        DominoV2Types.PoolRef memory missing = _ref(address(token0), address(token1), 10000, 200, address(0));
        (bool ok, bytes memory reason) = address(host).call(abi.encodeCall(AssistedSwapHarness.executeLegs,
            (_one(_leg(address(token0), address(token1), IN, 1, _path(missing))), new address[](0))));
        _check(!ok && bytes4(reason) == bytes4(keccak256("PoolNotInitialized()")), "an uninitialized pool");
    }

    /// The PoolManager credits what it received: an input taxed on the way
    /// in does not settle the swap.
    function testATaxedInputDoesNotSettle() public {
        token0.setTax(100);
        _refused(_leg(address(token0), address(token1), IN, 1, _path(_refAB())),
            IDominoPositionActions.SwapEffectMismatch.selector, "the manager was paid 1% less");
    }

    function testAnInputWithoutReturnValueSettles() public {
        token0.setMode(2);
        _run(_leg(address(token0), address(token1), IN, 0.99e18, _path(_refAB())));
        _eq(token0.balanceOf(address(host)), 100e18 - IN, "paid to the manager");
    }

    function testOnlyTheManagerItselfCanCallBack() public {
        ForwardingManager forwarding = new ForwardingManager();
        AssistedSwapHarness exposed = new AssistedSwapHarness(DominoSwapExecutor.RouteConfig(
            IDominoRegistry(address(registry)), PERMIT2, address(0), bytes32(0), address(forwarding)));
        token0.mint(address(exposed), IN);
        _expectRevert(address(exposed), abi.encodeCall(AssistedSwapHarness.executeLegs,
            (_one(_leg(address(token0), address(token1), IN, 1, _path(_refAB()))), new address[](0))),
            IDominoPositionActions.Unauthorized.selector, "the right data from the wrong caller");
    }

    /// A finished leg's callback cannot be replayed later in the transaction.
    function testAFinishedLegCannotBeReplayed() public {
        DominoV2Types.PoolRef[] memory pools = _path(_refAB());
        _run(_leg(address(token0), address(token1), IN, 1, pools));
        _check(host.lastCallbackHadLeg(), "the callback saw its pending leg");
        _expectRevert(address(host), abi.encodeCall(AssistedSwapHarness.unlockWithoutLeg,
            (abi.encode(address(token0), address(token1), uint256(IN), pools))),
            IDominoPositionActions.Unauthorized.selector, "the same unlock data again");
        host.nettedV4Swap(address(token0), IN, pools);
        _check(!host.lastCallbackHadLeg(), "a host's own unlock has no pending leg");
    }

    function testOnlyTheManagerInsideOurOwnLegCanCallBack() public {
        bytes memory data = abi.encode(address(token0), uint256(IN), _path(_refAB()));
        _expectRevert(address(host), abi.encodeWithSignature("unlockCallback(bytes)", data),
            IDominoPositionActions.Unauthorized.selector, "a stranger");
        // The real manager calling back for an unlock no leg registered.
        _expectRevert(address(host), abi.encodeCall(AssistedSwapHarness.unlockWithoutLeg, (data)),
            IDominoPositionActions.Unauthorized.selector, "an unlock without a pending leg");
    }

    function testTheNettingPathChecksEveryHop() public {
        DominoV2Types.PoolRef memory ab = _refAB();
        ab.dex = DominoV2Types.DEX_V3;
        _expectRevert(address(host), abi.encodeCall(AssistedSwapHarness.nettedV4Swap, (address(token0), IN, _path(ab))),
            IDominoPositionActions.InvalidPlan.selector, "a v3 pool");
        _expectRevert(address(host),
            abi.encodeCall(AssistedSwapHarness.nettedV4Swap, (address(token2), IN, _path(_refAB()))),
            IDominoPositionActions.InvalidPlan.selector, "a hop that does not hold the token");
        _expectRevert(address(host),
            abi.encodeCall(AssistedSwapHarness.nettedV4Swap, (address(token0), uint256(type(uint128).max), _path(_refAB()))),
            IDominoPositionActions.InvalidPlan.selector, "an input beyond int128");
        _expectRevert(address(host), abi.encodeCall(AssistedSwapHarness.nettedV4Swap, (address(token0), 1e24,
            _path(_ref(address(token0), address(token2), 3000, 60, address(0))))),
            IDominoPositionActions.SwapEffectMismatch.selector, "a partial fill");
        _expectRevert(address(host), abi.encodeCall(AssistedSwapHarness.nettedV4Swap, (address(token0), 1, _path(_refAB()))),
            IDominoPositionActions.SwapEffectMismatch.selector, "one wei is all fee: nothing comes out");
    }
}
