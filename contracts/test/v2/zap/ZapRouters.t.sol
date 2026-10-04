// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IV4PoolManagerMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {DominoPositionMath} from "../../../src/v2/positions/DominoPositionMath.sol";
import {DominoSwapExecutor} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {DominoZapV4} from "../../../src/v2/zap/DominoZapV4.sol";
import {DominoZapV4Steps} from "../../../src/v2/zap/DominoZapV4Steps.sol";
import {PositionManager} from "../../reference/official-v4/v4-periphery/src/PositionManager.sol";
import {RobinhoodPermit2} from "../route/fixtures/RobinhoodPermit2.sol";
import {RobinhoodPoolManager} from "../route/fixtures/RobinhoodPoolManager.sol";
import {RobinhoodUniversalRouter212} from "../route/fixtures/RobinhoodUniversalRouter212.sol";
import {ScriptedRouter, scriptedCall} from "../route/RouteAdversaries.sol";
import {IV4PoolManagerTest, MockDominoRegistry, TestToken, V4LiquidityHelper} from "../route/V2RouteTestKit.sol";
import {IPermit2Views, IPositionNft, IZap, ZapTestBase} from "./ZapTestKit.sol";

/// Universal Router 2.1.2's execute (as in the F1b suite).
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

/// A "PoolManager" whose unlock lets another contract call the zap back with
/// the right data: only the zap's msg.sender check stands in the way.
contract ForwardingManager {
    function unlock(bytes calldata data) external returns (bytes memory) {
        return CallbackForwarder(address(new CallbackForwarder())).forward(msg.sender, data);
    }
}

contract CallbackForwarder {
    function forward(address zap, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory out) = zap.call(abi.encodeWithSignature("unlockCallback(bytes)", data));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(out, 0x20), mload(out))
            }
        }
        return out;
    }
}

/// @notice The v4 zap with router legs: the Universal Router 2.1.2, Permit2
/// and v4 PoolManager runtimes deployed on Robinhood (F1b fixtures, each at its
/// own address), positions on the vendored PositionManager over that same
/// PoolManager, and F1b's scripted router for the ways a router can cheat.
contract ZapRoutersTest is ZapTestBase {
    string internal constant ZAP_ARTIFACT = "DominoZapV4.sol:DominoZapV4";
    string internal constant STEPS_ARTIFACT = "DominoZapV4Steps.sol:DominoZapV4Steps";
    string internal constant POSITION_MANAGER_ARTIFACT = "PositionManager.sol:PositionManager";
    bytes1 internal constant V4_SWAP = 0x10;
    uint8 internal constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant SETTLE_ALL = 0x0c;
    uint8 internal constant TAKE_ALL = 0x0f;
    int24 internal constant FULL = 887220;
    int24 internal constant LOWER = -600;
    int24 internal constant UPPER = 600;
    uint128 internal constant IN = 50e18;

    address internal router = RobinhoodUniversalRouter212.ADDRESS;
    address internal manager = RobinhoodPoolManager.ADDRESS;
    address internal positions;
    MockDominoRegistry internal registry;
    IZap internal zap;
    ScriptedRouter internal scripted;
    TestToken internal usd;
    TestToken internal tkn;
    address internal owner = address(0xA11CE);
    DominoV2Types.PoolRef internal pool;

    function setUp() public {
        vm.warp(NOW);
        vm.etch(PERMIT2, RobinhoodPermit2.RUNTIME);
        vm.etch(manager, RobinhoodPoolManager.RUNTIME);
        vm.etch(router, RobinhoodUniversalRouter212.RUNTIME);
        positions = _deploy(
            abi.encodePacked(
                vm.getCode(POSITION_MANAGER_ARTIFACT),
                abi.encode(manager, PERMIT2, uint256(300_000), address(0x2222), address(0x3333))
            )
        );
        registry = new MockDominoRegistry();
        registry.setFeeRecipient(address(0xFEE));
        scripted = new ScriptedRouter(PERMIT2);
        registry.setRouter(router, 212);
        registry.setRouter(address(scripted), 1);
        address steps = _deploy(vm.getCode(STEPS_ARTIFACT));
        zap = IZap(
            _deploy(
                abi.encodePacked(
                    vm.getCode(ZAP_ARTIFACT),
                    abi.encode(
                        DominoSwapExecutor.RouteConfig(
                            IDominoRegistry(address(registry)), PERMIT2, address(0), bytes32(0), manager
                        ),
                        positions,
                        steps
                    )
                )
            )
        );
        (usd, tkn) = (new TestToken(), new TestToken());
        registry.setRank(address(usd), 1);
        V4LiquidityHelper liquidity = new V4LiquidityHelper(manager);
        usd.mint(address(liquidity), 1e30);
        tkn.mint(address(liquidity), 1e30);
        usd.mint(owner, 1e30);
        tkn.mint(address(scripted), 1e30);
        usd.mint(address(scripted), 1e30);
        (address c0, address c1) = _sorted(address(usd), address(tkn));
        pool = DominoV2Types.PoolRef(DominoV2Types.DEX_V4, c0, c1, 3000, 60, address(0));
        IV4PoolManagerMinimal.PoolKey memory key = IV4PoolManagerMinimal.PoolKey(c0, c1, 3000, 60, address(0));
        IV4PoolManagerTest(manager).initialize(key, PRICE_ONE);
        liquidity.add(key, -FULL, FULL, 1e24);
        vm.prank(owner);
        usd.approve(address(zap), type(uint256).max);
    }

    function testTheFixturesAreTheDeployedRuntimes() public view {
        _check(
            router.codehash == RobinhoodUniversalRouter212.CODEHASH && manager.codehash == RobinhoodPoolManager.CODEHASH
                && PERMIT2.codehash == RobinhoodPermit2.CODEHASH,
            "each at its own address"
        );
        _check(bytes(type(DominoZapV4).name).length != 0 && bytes(type(DominoZapV4Steps).name).length != 0, "artifacts");
        _check(PositionManager(payable(positions)).nextTokenId() == 1, "vendored PositionManager");
    }

    /// V4_SWAP: SWAP_EXACT_IN_SINGLE of `amount`, SETTLE_ALL from the zap, TAKE_ALL to the zap.
    function _routerCalldata(uint128 amount) internal view returns (bytes memory) {
        bool zeroForOne = address(usd) == pool.currency0;
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams(
                IV4PoolManagerMinimal.PoolKey(pool.currency0, pool.currency1, 3000, 60, address(0)),
                zeroForOne,
                amount,
                0,
                0,
                ""
            )
        );
        params[1] = abi.encode(address(usd), uint256(amount));
        params[2] = abi.encode(address(tkn), uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL), params);
        return abi.encodeCall(IUniversalRouter212.execute, (abi.encodePacked(V4_SWAP), inputs, block.timestamp + 60));
    }

    function _plan(DominoV2Types.SwapLeg memory leg, uint128 minLiquidity)
        internal
        view
        returns (IDominoPositionActions.CreatePlan memory plan)
    {
        DominoV2Types.SwapLeg[] memory legs = _oneLeg(leg);
        plan.intent = _intent(
            DominoV2Types.ACTION_CREATE, pool, 0, LOWER, UPPER, minLiquidity, legs, address(usd), owner, 0
        );
        (plan.inputs, plan.legs, plan.amount0Max, plan.amount1Max) =
            (_inputs(address(usd), 2 * IN), legs, type(uint128).max, type(uint128).max);
    }

    function _scriptedLeg(ScriptedRouter.Script memory script, uint128 minOut)
        internal
        view
        returns (DominoV2Types.SwapLeg memory)
    {
        return DominoV2Types.SwapLeg(
            DominoV2Types.LEG_UNIVERSAL_ROUTER,
            address(scripted),
            address(usd),
            address(tkn),
            IN,
            minOut,
            scriptedCall(script)
        );
    }

    function _honest() internal view returns (ScriptedRouter.Script memory s) {
        (s.tokenIn, s.pull, s.tokenOut, s.pay) = (address(usd), IN, address(tkn), IN);
    }

    function testCreateThroughTheDeployedUniversalRouter() public {
        DominoV2Types.SwapLeg memory leg = DominoV2Types.SwapLeg(
            DominoV2Types.LEG_UNIVERSAL_ROUTER, router, address(usd), address(tkn), IN, IN * 99 / 100, _routerCalldata(IN)
        );
        uint128 minLiquidity = DominoPositionMath.liquidityForAmounts(PRICE_ONE, LOWER, UPPER, 49e18, 49e18);
        IDominoPositionActions.CreatePlan memory plan = _plan(leg, minLiquidity);
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.create(plan);
        _check(IPositionNft(positions).ownerOf(r.tokenId) == owner && r.liquidity >= minLiquidity, "minted");
        _eq(r.feeAmount, IN * 65 / 10_000, "65 bps");
        (uint160 left,,) = IPermit2Views(PERMIT2).allowance(address(zap), address(usd), router);
        _check(left == 0 && usd.allowance(address(zap), PERMIT2) == 0, "no allowance survived");
        _eq(usd.balanceOf(address(zap)) + tkn.balanceOf(address(zap)), 0, "nothing held");
    }

    function testRouterCalldataThatSwapsMoreThanSignedIsRefused() public {
        DominoV2Types.SwapLeg memory leg = DominoV2Types.SwapLeg(
            DominoV2Types.LEG_UNIVERSAL_ROUTER, router, address(usd), address(tkn), IN, 1, _routerCalldata(IN + 1)
        );
        IDominoPositionActions.CreatePlan memory plan = _plan(leg, 1);
        vm.prank(owner);
        vm.expectPartialRevert(bytes4(keccak256("InsufficientAllowance(uint256)")));
        zap.create(plan);
    }

    function testAnHonestScriptedRouterPasses() public {
        IDominoPositionActions.CreatePlan memory plan = _plan(_scriptedLeg(_honest(), IN), 1);
        vm.prank(owner);
        zap.create(plan);
        _eq(usd.balanceOf(address(zap)) + tkn.balanceOf(address(zap)), 0, "nothing held");
    }

    function testARouterThatTakesMoreIsRefused() public {
        ScriptedRouter.Script memory s = _honest();
        s.pull = IN + 1;
        IDominoPositionActions.CreatePlan memory plan = _plan(_scriptedLeg(s, IN), 1);
        vm.prank(owner);
        vm.expectPartialRevert(bytes4(keccak256("InsufficientAllowance(uint256)")));
        zap.create(plan);
    }

    function testARouterThatReturnsLessIsRefused() public {
        ScriptedRouter.Script memory s = _honest();
        s.pay = IN - 1;
        IDominoPositionActions.CreatePlan memory plan = _plan(_scriptedLeg(s, IN), 1);
        vm.prank(owner);
        vm.expectRevert(IDominoPositionActions.SwapEffectMismatch.selector);
        zap.create(plan);
    }

    function testARouterThatLeavesPartOfTheInputOrAnAllowanceIsRefused() public {
        ScriptedRouter.Script memory s = _honest();
        (s.pull, s.refundIn) = (IN, 1); // gives one unit back: not exactly amountIn left
        IDominoPositionActions.CreatePlan memory plan = _plan(_scriptedLeg(s, IN), 1);
        vm.prank(owner);
        vm.expectRevert(IDominoPositionActions.SwapEffectMismatch.selector);
        zap.create(plan);
        (s.pull, s.refundIn) = (IN - 1, 0); // pulls less: a Permit2 allowance would survive
        plan = _plan(_scriptedLeg(s, IN), 1);
        vm.prank(owner);
        vm.expectRevert(IDominoPositionActions.SwapEffectMismatch.selector);
        zap.create(plan);
    }

    /// Native is tracked in every action: a router that sends ETH along is refused.
    function testARouterThatSendsEthAlongIsRefused() public {
        vm.deal(address(scripted), 1 ether);
        ScriptedRouter.Script memory s = _honest();
        (s.extraToken, s.extraAmount) = (ETH, 1);
        IDominoPositionActions.CreatePlan memory plan = _plan(_scriptedLeg(s, IN), 1);
        vm.prank(owner);
        vm.expectRevert(IDominoPositionActions.SwapEffectMismatch.selector);
        zap.create(plan);
    }

    function testARouterThatCallsBackIntoTheZapIsRefused() public {
        ScriptedRouter.Script memory s = _honest();
        (s.callTarget, s.callData) = (address(zap), abi.encodeCall(IZap.flushOwedFees, (address(usd))));
        IDominoPositionActions.CreatePlan memory plan = _plan(_scriptedLeg(s, IN), 1);
        vm.prank(owner);
        vm.expectRevert(bytes4(keccak256("ReentrantCall()")));
        zap.create(plan);
    }

    function testOnlyThePoolManagerItselfCanCallBack() public {
        ForwardingManager forwarding = new ForwardingManager();
        address fakePositions = _deploy(
            abi.encodePacked(
                vm.getCode(POSITION_MANAGER_ARTIFACT),
                abi.encode(address(forwarding), PERMIT2, uint256(300_000), address(0x2222), address(0x3333))
            )
        );
        IZap exposed = IZap(
            _deploy(
                abi.encodePacked(
                    vm.getCode(ZAP_ARTIFACT),
                    abi.encode(
                        DominoSwapExecutor.RouteConfig(
                            IDominoRegistry(address(registry)), PERMIT2, address(0), bytes32(0), address(forwarding)
                        ),
                        fakePositions,
                        _deploy(vm.getCode(STEPS_ARTIFACT))
                    )
                )
            )
        );
        IDominoPositionActions.CreatePlan memory plan;
        plan.intent = _intent(DominoV2Types.ACTION_CREATE, pool, 0, LOWER, UPPER, 1, _noLegs(), ETH, owner, 0);
        (plan.inputs, plan.legs, plan.amount0Max, plan.amount1Max) =
            (_noInputs(), _noLegs(), type(uint128).max, type(uint128).max);
        vm.expectRevert(IDominoPositionActions.Unauthorized.selector);
        exposed.create(plan);
    }

    function testARouterTheRegistryDoesNotAdmitIsRefused() public {
        registry.setRouter(address(scripted), 0);
        IDominoPositionActions.CreatePlan memory plan = _plan(_scriptedLeg(_honest(), IN), 1);
        vm.prank(owner);
        vm.expectRevert(IDominoPositionActions.InvalidPlan.selector);
        zap.create(plan);
    }
}
