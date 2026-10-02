// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoFeeSettlement} from "../../../src/v2/interfaces/IDominoFees.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {DominoActionLock} from "../../../src/v2/route/DominoActionLock.sol";
import {DominoSwapExecutor, IPermit2AllowanceMinimal} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {DominoTokenOps} from "../../../src/v2/route/DominoTokenOps.sol";
import {RobinhoodPermit2} from "./fixtures/RobinhoodPermit2.sol";
import {ScriptedRouter} from "./RouteAdversaries.sol";
import {AssistedSwapHarness, MockDominoRegistry, TestToken, V2TestBase, V2Vm} from "./V2RouteTestKit.sol";

/// A host with the executor and no fee ledger.
contract SwapOnlyHost is DominoSwapExecutor {
    constructor(RouteConfig memory config) DominoSwapExecutor(config) {}
}

/// Reads the executor's in-progress flag from inside a leg.
contract SwapFlagProbe {
    bool public seen;

    function record(AssistedSwapHarness host) external {
        seen = host.swapInProgress();
    }
}

/// LEG_UNIVERSAL_ROUTER against scripted adversarial routers and the deployed
/// Permit2 (Robinhood's runtime, codehash from the chain profile). A leg is
/// accepted by its effect: exactly amountIn leaves, at least minAmountOut
/// arrives, no other tracked balance moves and no allowance survives.
contract DominoSwapExecutorRouterTest is V2TestBase {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant ETH = address(0);
    uint128 internal constant IN = 1_000e6;
    uint128 internal constant MIN = 990e6;
    bytes32 internal constant LEG_EXECUTED =
        keccak256("SwapLegExecuted(uint8,address,address,address,uint256,uint256)");

    MockDominoRegistry internal registry;
    AssistedSwapHarness internal host;
    ScriptedRouter internal router;
    TestToken internal tokenA;
    TestToken internal tokenB;
    TestToken internal tokenC;

    function setUp() public {
        vm.warp(1_790_000_000); // a real clock: Permit2 reads expiration 0 as "this block"
        vm.etch(PERMIT2, RobinhoodPermit2.RUNTIME);
        registry = new MockDominoRegistry();
        router = new ScriptedRouter(PERMIT2);
        registry.setRouter(address(router), 212);
        host = new AssistedSwapHarness(
            DominoSwapExecutor.RouteConfig(IDominoRegistry(address(registry)), PERMIT2, address(0), bytes32(0), address(0))
        );
        tokenA = new TestToken();
        tokenB = new TestToken();
        tokenC = new TestToken();
        tokenA.mint(address(host), 10 * uint256(IN));
        tokenC.mint(address(host), 7);
        tokenB.mint(address(router), 100 * uint256(IN));
        tokenC.mint(address(router), 100 * uint256(IN));
        tokenA.mint(address(router), 100 * uint256(IN));
        vm.deal(address(host), 10 ether);
        vm.deal(address(router), 100 ether);
    }

    function _honest(address tokenIn, address tokenOut, uint256 pay) internal pure returns (ScriptedRouter.Script memory s) {
        s.tokenIn = tokenIn;
        s.pull = tokenIn == ETH ? 0 : IN;
        s.tokenOut = tokenOut;
        s.pay = pay;
    }

    function _leg(address tokenIn, address tokenOut, uint128 minOut, ScriptedRouter.Script memory script)
        internal
        view
        returns (DominoV2Types.SwapLeg memory)
    {
        return DominoV2Types.SwapLeg({
            kind: DominoV2Types.LEG_UNIVERSAL_ROUTER,
            router: address(router),
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: IN,
            minAmountOut: minOut,
            data: abi.encodeCall(ScriptedRouter.run, (script))
        });
    }

    function _one(DominoV2Types.SwapLeg memory leg) internal pure returns (DominoV2Types.SwapLeg[] memory legs) {
        legs = new DominoV2Types.SwapLeg[](1);
        legs[0] = leg;
    }

    function _call(DominoV2Types.SwapLeg[] memory legs, address[] memory extra) internal pure returns (bytes memory) {
        return abi.encodeCall(AssistedSwapHarness.executeLegs, (legs, extra));
    }

    function _refused(DominoV2Types.SwapLeg memory leg, bytes4 selector, string memory what) internal {
        _expectRevert(address(host), _call(_one(leg), new address[](0)), selector, what);
    }

    function _noAllowanceLeft(address token) internal view {
        (uint160 left,,) = IPermit2AllowanceMinimal(PERMIT2).allowance(address(host), token, address(router));
        _check(left == 0 && TestToken(token).allowance(address(host), PERMIT2) == 0, "an allowance survived");
    }

    // ------------------------------------------------------------ accepted
    function testThePermit2FixtureIsTheDeployedRuntime() public view {
        _check(keccak256(RobinhoodPermit2.RUNTIME) == RobinhoodPermit2.CODEHASH, "fixture bytes hash to the profile");
        _check(PERMIT2.codehash == RobinhoodPermit2.CODEHASH, "etched at the canonical address");
    }

    function testAnHonestRouterLegIsAcceptedByItsEffect() public {
        vm.recordLogs();
        uint256[] memory out = host.executeLegs(_one(_leg(address(tokenA), address(tokenB), MIN,
            _honest(address(tokenA), address(tokenB), 995e6))), new address[](0));
        V2Vm.Log[] memory logs = vm.getRecordedLogs();
        _eq(out[0], 995e6, "measured output");
        _eq(tokenA.balanceOf(address(host)), 9 * uint256(IN), "exactly amountIn left");
        _eq(tokenB.balanceOf(address(host)), 995e6, "the output arrived");
        _noAllowanceLeft(address(tokenA));
        V2Vm.Log memory leg = _first(logs, address(host), LEG_EXECUTED);
        _check(leg.topics[1] == bytes32(uint256(DominoV2Types.LEG_UNIVERSAL_ROUTER)), "event kind");
        _check(leg.topics[2] == bytes32(uint256(uint160(address(tokenA)))), "event tokenIn");
        _check(leg.topics[3] == bytes32(uint256(uint160(address(tokenB)))), "event tokenOut");
        (address venue, uint256 amountIn, uint256 amountOut) = abi.decode(leg.data, (address, uint256, uint256));
        _check(venue == address(router) && amountIn == IN && amountOut == 995e6, "event venue and amounts");
        _check(!host.swapInProgress(), "the in-progress flag is cleared");
    }

    function testTheMinimumIsInclusive() public {
        uint256[] memory out = host.executeLegs(_one(_leg(address(tokenA), address(tokenB), MIN,
            _honest(address(tokenA), address(tokenB), MIN))), new address[](0));
        _eq(out[0], MIN, "exactly the minimum passes");
    }

    function testLegsRunInOrderEachCheckedOnItsOwn() public {
        DominoV2Types.SwapLeg[] memory legs = new DominoV2Types.SwapLeg[](2);
        legs[0] = _leg(address(tokenA), address(tokenB), MIN, _honest(address(tokenA), address(tokenB), IN));
        // The second leg spends what the first delivered.
        ScriptedRouter.Script memory second = _honest(address(tokenB), address(tokenC), 3);
        legs[1] = _leg(address(tokenB), address(tokenC), 3, second);
        uint256[] memory out = host.executeLegs(legs, new address[](0));
        _check(out.length == 2 && out[0] == IN && out[1] == 3, "one measured amount per leg");
        _eq(tokenB.balanceOf(address(host)), 0, "the hop was spent");
        _eq(tokenC.balanceOf(address(host)), 10, "7 held + 3 delivered");
        _noAllowanceLeft(address(tokenA));
        _noAllowanceLeft(address(tokenB));
    }

    function testNoLegsDoNothing() public {
        address[] memory watched = new address[](1);
        watched[0] = address(0x1234); // not even read
        uint256[] memory out = host.executeLegs(new DominoV2Types.SwapLeg[](0), watched);
        _eq(out.length, 0, "nothing executed");
    }

    function testATokenThatRefusesTheApprovalStopsTheLeg() public {
        tokenA.setBroken(4);
        _refused(_leg(address(tokenA), address(tokenB), MIN, _honest(address(tokenA), address(tokenB), IN)),
            DominoTokenOps.TokenCallFailed.selector, "approve returned false");
    }

    function testAnAllowanceThatCannotBeReadStopsTheLeg() public {
        tokenA.setBroken(2);
        _refused(_leg(address(tokenA), address(tokenB), MIN, _honest(address(tokenA), address(tokenB), IN)),
            DominoTokenOps.TokenCallFailed.selector, "the allowance view reverts");
    }

    function testABalanceThatCannotBeReadStopsTheAction() public {
        address[] memory watched = new address[](1);
        watched[0] = address(tokenC);
        tokenC.setBroken(1);
        _expectRevert(address(host), _call(_one(_leg(address(tokenA), address(tokenB), MIN,
            _honest(address(tokenA), address(tokenB), IN))), watched), DominoTokenOps.TokenCallFailed.selector,
            "a watched token's balanceOf reverts");
        watched[0] = address(0x1234);
        _expectRevert(address(host), _call(_one(_leg(address(tokenA), address(tokenB), MIN,
            _honest(address(tokenA), address(tokenB), IN))), watched), DominoTokenOps.TokenCallFailed.selector,
            "a watched address without code");
    }

    function testANativeInputIsSentAsValue() public {
        uint256 before = address(host).balance;
        uint256[] memory out = host.executeLegs(_one(_leg(ETH, address(tokenB), MIN, _honest(ETH, address(tokenB), MIN))),
            new address[](0));
        _eq(out[0], MIN, "output");
        _eq(before - address(host).balance, IN, "exactly amountIn of ETH left");
        _eq(address(router).balance, 100 ether + IN, "as call value");
    }

    function testANativeOutputArrives() public {
        uint256 before = address(host).balance;
        uint256[] memory out = host.executeLegs(_one(_leg(address(tokenA), ETH, MIN,
            _honest(address(tokenA), ETH, 0.5 ether))), new address[](0));
        _eq(out[0], 0.5 ether, "measured native output");
        _eq(address(host).balance - before, 0.5 ether, "received");
    }

    // ------------------------------------------------------------- refused
    function testOnlyAdmittedRoutersRun() public {
        DominoV2Types.SwapLeg memory leg =
            _leg(address(tokenA), address(tokenB), MIN, _honest(address(tokenA), address(tokenB), IN));
        registry.setRouter(address(router), 0); // the guardian removed it
        _refused(leg, IDominoPositionActions.InvalidPlan.selector, "a removed router");
        leg.router = address(0xBAD);
        _refused(leg, IDominoPositionActions.InvalidPlan.selector, "an unknown router");
        leg.router = address(0);
        _refused(leg, IDominoPositionActions.InvalidPlan.selector, "no router");
    }

    function testARouterCannotPullMoreThanTheInput() public {
        ScriptedRouter.Script memory greedy = _honest(address(tokenA), address(tokenB), IN);
        greedy.pull = uint256(IN) + 1;
        _refused(_leg(address(tokenA), address(tokenB), MIN, greedy),
            bytes4(keccak256("InsufficientAllowance(uint256)")), "Permit2 holds the router to amountIn");
        greedy.pull = IN;
        greedy.backdoorPull = 1; // a normal token has no backdoor
        (bool ok, bytes memory reason) =
            address(host).call(_call(_one(_leg(address(tokenA), address(tokenB), MIN, greedy)), new address[](0)));
        _check(!ok && keccak256(reason) == keccak256(abi.encodeWithSignature("Error(string)", "allowance")),
            "no ERC-20 allowance to the router itself");
    }

    function testAnInputThatComesBackIsNotExactInput() public {
        ScriptedRouter.Script memory script = _honest(address(tokenA), address(tokenB), IN);
        script.refundIn = 1;
        _refused(_leg(address(tokenA), address(tokenB), MIN, script), IDominoPositionActions.SwapEffectMismatch.selector,
            "amountIn - 1 left");
    }

    function testANativeInputThatComesBackIsNotExactInput() public {
        ScriptedRouter.Script memory script = _honest(ETH, address(tokenB), MIN);
        script.refundIn = 1;
        _refused(_leg(ETH, address(tokenB), MIN, script), IDominoPositionActions.SwapEffectMismatch.selector,
            "1 wei of ETH came back");
    }

    function testLessThanTheMinimumIsRefused() public {
        _refused(_leg(address(tokenA), address(tokenB), MIN, _honest(address(tokenA), address(tokenB), MIN - 1)),
            IDominoPositionActions.SwapEffectMismatch.selector, "one unit short");
        _refused(_leg(address(tokenA), ETH, 1 ether, _honest(address(tokenA), ETH, 1 ether - 1)),
            IDominoPositionActions.SwapEffectMismatch.selector, "one wei short");
    }

    /// The output is measured: a transfer tax on the way in counts against the floor.
    function testATaxedOutputIsMeasured() public {
        tokenB.setTax(100);
        _refused(_leg(address(tokenA), address(tokenB), MIN, _honest(address(tokenA), address(tokenB), MIN)),
            IDominoPositionActions.SwapEffectMismatch.selector, "MIN paid, 1% taxed");
        uint256[] memory out = host.executeLegs(_one(_leg(address(tokenA), address(tokenB), MIN,
            _honest(address(tokenA), address(tokenB), 1_000e6))), new address[](0));
        _eq(out[0], 990e6, "what actually arrived");
    }

    function testAnotherTrackedBalanceMustNotMove() public {
        ScriptedRouter.Script memory script = _honest(address(tokenA), address(tokenB), IN);
        (script.extraToken, script.extraAmount) = (address(tokenC), 1);
        address[] memory watched = new address[](1);
        watched[0] = address(tokenC);
        _expectRevert(address(host), _call(_one(_leg(address(tokenA), address(tokenB), MIN, script)), watched),
            IDominoPositionActions.SwapEffectMismatch.selector, "a watched token moved");
        // Native currency is watched like any token when the action names it.
        (script.extraToken, script.extraAmount) = (ETH, 1);
        watched[0] = ETH;
        _expectRevert(address(host), _call(_one(_leg(address(tokenA), address(tokenB), MIN, script)), watched),
            IDominoPositionActions.SwapEffectMismatch.selector, "ETH moved during an ERC-20 leg");
        // Every leg's own tokens are watched without being named: here the
        // first leg moves the second leg's output.
        DominoV2Types.SwapLeg[] memory legs = new DominoV2Types.SwapLeg[](2);
        (script.extraToken, script.extraAmount) = (address(tokenC), 1);
        legs[0] = _leg(address(tokenA), address(tokenB), MIN, script);
        legs[1] = _leg(address(tokenB), address(tokenC), 1, _honest(address(tokenB), address(tokenC), 1));
        _expectRevert(address(host), _call(legs, new address[](0)), IDominoPositionActions.SwapEffectMismatch.selector,
            "a later leg's token moved");
        // A token the action does not name is outside the check.
        legs = _one(_leg(address(tokenA), address(tokenB), MIN, script));
        host.executeLegs(legs, new address[](0));
    }

    function testAnErc20AllowanceMustNotSurvive() public {
        tokenA.setAllowanceQuirks(address(0), false, true); // transferFrom never spends the allowance
        _refused(_leg(address(tokenA), address(tokenB), MIN, _honest(address(tokenA), address(tokenB), IN)),
            IDominoPositionActions.SwapEffectMismatch.selector, "the ERC-20 allowance to Permit2 survived");
    }

    function testAPermit2AllowanceMustNotSurvive() public {
        // A hostile token: Permit2's pull zeroes the ERC-20 allowance and the
        // router takes the last unit through a backdoor, so exactly amountIn
        // leaves and only the router's Permit2 allowance is left over.
        tokenA.setAllowanceQuirks(address(router), true, false);
        ScriptedRouter.Script memory script = _honest(address(tokenA), address(tokenB), IN);
        (script.pull, script.backdoorPull) = (uint256(IN) - 1, 1);
        _refused(_leg(address(tokenA), address(tokenB), MIN, script), IDominoPositionActions.SwapEffectMismatch.selector,
            "the router's Permit2 allowance survived");
    }

    function testARouterFailureIsBubbled() public {
        DominoV2Types.SwapLeg memory leg = _leg(address(tokenA), address(tokenB), MIN, _honest(address(tokenA), address(tokenB), IN));
        leg.data = abi.encodeCall(ScriptedRouter.fail, ());
        (bool ok, bytes memory reason) = address(host).call(_call(_one(leg), new address[](0)));
        _check(!ok && keccak256(reason) == keccak256(abi.encodeWithSignature("Error(string)", "router says no")),
            "the router's own reason");
    }

    function testARouterCannotReenter() public {
        DominoV2Types.SwapLeg[] memory inner = _one(_leg(address(tokenA), address(tokenB), MIN,
            _honest(address(tokenA), address(tokenB), IN)));
        bytes[5] memory calls = [
            _call(inner, new address[](0)),
            abi.encodeCall(AssistedSwapHarness.executeLegsUnlocked, (inner, new address[](0))),
            abi.encodeCall(IDominoFeeSettlement.flushOwedFees, (address(tokenA))),
            abi.encodeWithSignature("uniswapV3SwapCallback(int256,int256,bytes)", int256(1), int256(-1), bytes("")),
            abi.encodeWithSignature("unlockCallback(bytes)", bytes(""))
        ];
        bytes4[5] memory expected = [
            DominoActionLock.ReentrantCall.selector,
            IDominoPositionActions.Unauthorized.selector, // the lock is held, but a leg is already running
            DominoActionLock.ReentrantCall.selector,
            IDominoPositionActions.Unauthorized.selector,
            IDominoPositionActions.Unauthorized.selector
        ];
        for (uint256 i; i < calls.length; ++i) {
            ScriptedRouter.Script memory script = _honest(address(tokenA), address(tokenB), IN);
            (script.callTarget, script.callData) = (address(host), calls[i]);
            _refused(_leg(address(tokenA), address(tokenB), MIN, script), expected[i], "a reentrant call");
        }
    }

    function testTheInProgressFlagCoversTheLegOnly() public {
        SwapFlagProbe probe = new SwapFlagProbe();
        ScriptedRouter.Script memory script = _honest(address(tokenA), address(tokenB), IN);
        (script.callTarget, script.callData) = (address(probe), abi.encodeCall(SwapFlagProbe.record, (host)));
        host.executeLegs(_one(_leg(address(tokenA), address(tokenB), MIN, script)), new address[](0));
        _check(probe.seen(), "set while the leg runs");
        _check(!host.swapInProgress(), "cleared afterwards");
    }

    function testMalformedLegsAreRefused() public {
        ScriptedRouter.Script memory script = _honest(address(tokenA), address(tokenB), IN);
        DominoV2Types.SwapLeg memory leg = _leg(address(tokenA), address(tokenB), MIN, script);
        leg.tokenOut = address(tokenA);
        _refused(leg, IDominoPositionActions.InvalidPlan.selector, "tokenIn == tokenOut");
        leg = _leg(address(tokenA), address(tokenB), MIN, script);
        leg.amountIn = 0;
        _refused(leg, IDominoPositionActions.InvalidPlan.selector, "zero input");
        leg = _leg(address(tokenA), address(tokenB), 0, script);
        _refused(leg, IDominoPositionActions.InvalidPlan.selector, "zero minimum");
        leg = _leg(address(tokenA), address(tokenB), MIN, script);
        leg.kind = 0;
        _refused(leg, IDominoPositionActions.InvalidPlan.selector, "kind 0");
        leg.kind = 4;
        _refused(leg, IDominoPositionActions.InvalidPlan.selector, "kind 4");
        leg.router = address(0);
        _refused(leg, IDominoPositionActions.InvalidPlan.selector, "kind 4 without a router");
        // Pool kinds are unavailable on a host configured without v3 and v4.
        leg.kind = DominoV2Types.LEG_V3_POOL;
        leg.router = address(0);
        leg.data = abi.encodePacked(address(tokenA), uint24(500), address(tokenB));
        _refused(leg, IDominoPositionActions.InvalidPlan.selector, "no v3 factory");
        leg.kind = DominoV2Types.LEG_V4_POOL;
        leg.data = abi.encode(new DominoV2Types.PoolRef[](1));
        _refused(leg, IDominoPositionActions.InvalidPlan.selector, "no v4 pool manager");
    }

    function testAtMostEightLegs() public {
        DominoV2Types.SwapLeg[] memory legs = new DominoV2Types.SwapLeg[](9);
        for (uint256 i; i < 9; ++i) {
            legs[i] = _leg(address(tokenA), address(tokenB), MIN, _honest(address(tokenA), address(tokenB), IN));
        }
        _expectRevert(address(host), _call(legs, new address[](0)), IDominoPositionActions.InvalidPlan.selector, "nine legs");
        assembly ("memory-safe") {
            mstore(legs, 8)
        }
        uint256[] memory out = host.executeLegs(legs, new address[](0));
        _eq(out.length, 8, "eight legs run");
    }

    function testTheExecutorOnlyRunsInsideAnAction() public {
        DominoV2Types.SwapLeg[] memory legs = _one(_leg(address(tokenA), address(tokenB), MIN,
            _honest(address(tokenA), address(tokenB), IN)));
        _expectRevert(address(host), abi.encodeCall(AssistedSwapHarness.executeLegsUnlocked, (legs, new address[](0))),
            IDominoPositionActions.Unauthorized.selector, "outside the lock");
    }

    function testTheConstructorNeedsTheChainProfile() public {
        DominoSwapExecutor.RouteConfig memory config =
            DominoSwapExecutor.RouteConfig(IDominoRegistry(address(registry)), PERMIT2, address(0), bytes32(0), address(0));
        _check(_deploys(config), "registry and Permit2 suffice");
        config.registry = IDominoRegistry(address(0x1234));
        _check(!_deploys(config), "a registry without code");
        config.registry = IDominoRegistry(address(registry));
        config.permit2 = address(0x1234);
        _check(!_deploys(config), "Permit2 without code");
        config.permit2 = PERMIT2;
        config.v3Factory = address(0x1234);
        config.v3PoolInitCodeHash = keccak256("init");
        _check(!_deploys(config), "a v3 factory without code");
        config.v3Factory = address(registry);
        config.v3PoolInitCodeHash = bytes32(0);
        _check(!_deploys(config), "a v3 factory without its init code hash");
        config.v3PoolInitCodeHash = keccak256("init");
        _check(_deploys(config), "a v3 factory with code and hash");
        config.v4PoolManager = address(0x1234);
        _check(!_deploys(config), "a PoolManager without code");
        config.v4PoolManager = address(registry);
        _check(_deploys(config), "a PoolManager with code");
    }

    /// The executor checks the registry itself, for hosts without the fee ledger.
    function testAnExecutorOnlyHostNeedsARegistryWithCode() public {
        DominoSwapExecutor.RouteConfig memory config =
            DominoSwapExecutor.RouteConfig(IDominoRegistry(address(registry)), PERMIT2, address(0), bytes32(0), address(0));
        (bool ok,) = address(this).call(abi.encodeCall(this.deploySwapOnly, (config)));
        _check(ok, "a registry with code");
        config.registry = IDominoRegistry(address(0x1234));
        (ok,) = address(this).call(abi.encodeCall(this.deploySwapOnly, (config)));
        _check(!ok, "a registry without code");
    }

    function deploySwapOnly(DominoSwapExecutor.RouteConfig memory config) external {
        new SwapOnlyHost(config);
    }

    function _deploys(DominoSwapExecutor.RouteConfig memory config) internal returns (bool ok) {
        (ok,) = address(this).call(abi.encodeCall(this.deploy, (config)));
    }

    function deploy(DominoSwapExecutor.RouteConfig memory config) external {
        new AssistedSwapHarness(config);
    }
}
