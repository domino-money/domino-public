// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {IV4PoolManagerMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {DominoSwapExecutor, IPermit2AllowanceMinimal} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {RobinhoodPermit2} from "./fixtures/RobinhoodPermit2.sol";
import {RobinhoodPoolManager} from "./fixtures/RobinhoodPoolManager.sol";
import {RobinhoodUniversalRouter212} from "./fixtures/RobinhoodUniversalRouter212.sol";
import {
    AssistedSwapHarness,
    IV4PoolManagerTest,
    MockDominoRegistry,
    TestToken,
    V2TestBase,
    V4LiquidityHelper
} from "./V2RouteTestKit.sol";

/// Universal Router 2.1.2's execute and the v4 router parameters it decodes
/// (v4-periphery IV4Router with minHopPriceX36, as built into 2.1.2).
interface IUniversalRouter212 {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

struct ExactInputSingleParams {
    IV4PoolManagerMinimal.PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    uint256 minHopPriceX36;
    bytes hookData;
}

/// The deployed stack, byte for byte: Robinhood's Universal Router 2.1.2,
/// Permit2 and v4 PoolManager runtimes (codehashes from the chain profile),
/// each at its own address, with test tokens. The executor approves exactly,
/// calls the router with Trading-API-shaped V4_SWAP calldata, and accepts the
/// leg by its effect.
contract DominoSwapExecutorUniversalRouterTest is V2TestBase {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant ETH = address(0);
    uint160 internal constant PRICE_ONE = uint160(1 << 96);
    uint128 internal constant IN = 1e18;
    int24 internal constant FULL = 887220;
    bytes1 internal constant V4_SWAP = 0x10;
    uint8 internal constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant SETTLE_ALL = 0x0c;
    uint8 internal constant TAKE = 0x0e;
    uint8 internal constant TAKE_ALL = 0x0f;

    address internal router = RobinhoodUniversalRouter212.ADDRESS;
    address internal manager = RobinhoodPoolManager.ADDRESS;
    AssistedSwapHarness internal host;
    TestToken internal token0;
    TestToken internal token1;

    function setUp() public {
        vm.chainId(4663);
        vm.warp(1_790_000_000);
        vm.etch(PERMIT2, RobinhoodPermit2.RUNTIME);
        vm.etch(manager, RobinhoodPoolManager.RUNTIME);
        vm.etch(router, RobinhoodUniversalRouter212.RUNTIME);
        MockDominoRegistry registry = new MockDominoRegistry();
        registry.setRouter(router, 212);
        host = new AssistedSwapHarness(DominoSwapExecutor.RouteConfig(
            IDominoRegistry(address(registry)), PERMIT2, address(0), bytes32(0), manager));
        (token0, token1) = (new TestToken(), new TestToken());
        if (address(token1) < address(token0)) (token0, token1) = (token1, token0);
        V4LiquidityHelper liquidity = new V4LiquidityHelper(manager);
        token0.mint(address(liquidity), 1e30);
        token1.mint(address(liquidity), 1e30);
        vm.deal(address(liquidity), 1e27);
        token0.mint(address(host), 100e18);
        vm.deal(address(host), 100 ether);
        IV4PoolManagerMinimal.PoolKey memory key = _key(address(token0), address(token1));
        IV4PoolManagerTest(manager).initialize(key, PRICE_ONE);
        liquidity.add(key, -FULL, FULL, 1e21);
        key = _key(ETH, address(token0));
        IV4PoolManagerTest(manager).initialize(key, PRICE_ONE);
        liquidity.add(key, -FULL, FULL, 1e21);
    }

    function _key(address c0, address c1) internal pure returns (IV4PoolManagerMinimal.PoolKey memory) {
        return IV4PoolManagerMinimal.PoolKey(c0, c1, 3000, 60, address(0));
    }

    /// V4_SWAP: SWAP_EXACT_IN_SINGLE, SETTLE_ALL from the caller, then TAKE_ALL
    /// to the caller (or TAKE to `takeTo` when it is set).
    function _calldata(address tokenIn, address tokenOut, uint128 swapAmount, address takeTo)
        internal
        view
        returns (bytes memory)
    {
        (address c0, address c1) = tokenIn < tokenOut ? (tokenIn, tokenOut) : (tokenOut, tokenIn);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams(_key(c0, c1), tokenIn == c0, swapAmount, 0, 0, ""));
        params[1] = abi.encode(tokenIn, uint256(swapAmount));
        bytes memory actions;
        if (takeTo == address(0)) {
            params[2] = abi.encode(tokenOut, uint256(0));
            actions = abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL);
        } else {
            params[2] = abi.encode(tokenOut, takeTo, uint256(0));
            actions = abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE);
        }
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        return abi.encodeCall(IUniversalRouter212.execute, (abi.encodePacked(V4_SWAP), inputs, block.timestamp + 60));
    }

    function _leg(address tokenIn, address tokenOut, uint128 minOut, bytes memory data)
        internal
        view
        returns (DominoV2Types.SwapLeg[] memory legs)
    {
        legs = new DominoV2Types.SwapLeg[](1);
        legs[0] = DominoV2Types.SwapLeg(DominoV2Types.LEG_UNIVERSAL_ROUTER, router, tokenIn, tokenOut, IN, minOut, data);
    }

    function testTheFixturesAreTheDeployedRuntimes() public view {
        _check(keccak256(RobinhoodUniversalRouter212.RUNTIME) == RobinhoodUniversalRouter212.CODEHASH, "router bytes");
        _check(keccak256(RobinhoodPoolManager.RUNTIME) == RobinhoodPoolManager.CODEHASH, "PoolManager bytes");
        _check(router.codehash == RobinhoodUniversalRouter212.CODEHASH && manager.codehash == RobinhoodPoolManager.CODEHASH
            && PERMIT2.codehash == RobinhoodPermit2.CODEHASH, "each at its own address");
    }

    function testAV4SwapThroughTheDeployedRouter() public {
        uint256 out = host.executeLegs(_leg(address(token0), address(token1), 0.99e18,
            _calldata(address(token0), address(token1), IN, address(0))), new address[](0))[0];
        _check(out > 0.99e18 && out < 0.997e18, "1:1 less the 0.3% fee");
        _eq(token0.balanceOf(address(host)), 99e18, "Permit2 pulled exactly amountIn");
        _eq(token1.balanceOf(address(host)), out, "TAKE_ALL paid the caller");
        (uint160 left,,) = IPermit2AllowanceMinimal(PERMIT2).allowance(address(host), address(token0), router);
        _check(left == 0 && token0.allowance(address(host), PERMIT2) == 0, "no allowance survived");
    }

    function testNativeCurrencyThroughTheDeployedRouter() public {
        uint256 before = address(host).balance;
        uint256 out = host.executeLegs(_leg(ETH, address(token0), 0.99e18, _calldata(ETH, address(token0), IN, address(0))),
            new address[](0))[0];
        _eq(before - address(host).balance, IN, "the value paid the swap");
        _eq(token0.balanceOf(address(host)), 100e18 + out, "token arrived");
        before = address(host).balance;
        out = host.executeLegs(_leg(address(token0), ETH, 0.99e18, _calldata(address(token0), ETH, IN, address(0))),
            new address[](0))[0];
        _eq(address(host).balance - before, out, "ETH arrived from TAKE_ALL");
    }

    /// Calldata that asks to swap more than the leg's amountIn: Permit2 holds
    /// the router to the exact allowance.
    function testCalldataSwappingMoreThanAmountInFails() public {
        (bool ok, bytes memory reason) = address(host).call(abi.encodeCall(AssistedSwapHarness.executeLegs,
            (_leg(address(token0), address(token1), 1, _calldata(address(token0), address(token1), IN + 1, address(0))),
            new address[](0))));
        _check(!ok && bytes4(reason) == bytes4(keccak256("InsufficientAllowance(uint256)")), "Permit2 refused");
    }

    /// Calldata that swaps less than amountIn leaves part of the input home.
    function testCalldataSwappingLessThanAmountInFails() public {
        _expectRevert(address(host), abi.encodeCall(AssistedSwapHarness.executeLegs,
            (_leg(address(token0), address(token1), 1, _calldata(address(token0), address(token1), IN - 1, address(0))),
            new address[](0))), IDominoPositionActions.SwapEffectMismatch.selector, "not exact input");
    }

    /// Calldata that sends the output to someone else: nothing arrives here.
    function testCalldataPayingSomeoneElseFails() public {
        _expectRevert(address(host), abi.encodeCall(AssistedSwapHarness.executeLegs,
            (_leg(address(token0), address(token1), 1, _calldata(address(token0), address(token1), IN, address(0xBEEF))),
            new address[](0))), IDominoPositionActions.SwapEffectMismatch.selector, "output diverted");
    }

    /// The same pool, reached directly as LEG_V4_POOL on the deployed PoolManager.
    function testADirectV4LegOnTheDeployedPoolManager() public {
        DominoV2Types.PoolRef[] memory pools = new DominoV2Types.PoolRef[](1);
        pools[0] = DominoV2Types.PoolRef(DominoV2Types.DEX_V4, address(token0), address(token1), 3000, 60, address(0));
        DominoV2Types.SwapLeg[] memory legs = new DominoV2Types.SwapLeg[](1);
        legs[0] = DominoV2Types.SwapLeg(DominoV2Types.LEG_V4_POOL, address(0), address(token0), address(token1), IN, 0.99e18,
            abi.encode(pools));
        uint256 direct = host.executeLegs(legs, new address[](0))[0];
        _check(direct > 0.99e18, "swapped on the deployed build");
    }
}
