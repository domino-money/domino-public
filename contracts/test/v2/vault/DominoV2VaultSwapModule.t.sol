// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {DominoV2VaultStorage} from "../../../src/v2/vault/DominoV2VaultStorage.sol";
import {DominoV2VaultSwapModule} from "../../../src/v2/vault/DominoV2VaultSwapModule.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {VaultVm} from "./VaultHarness.sol";
import {HarnessV4} from "./VaultHarnessV4.sol";

/// The production swap port: DominoV2VaultSwapModule (F1b's swap-leg
/// executor) reached by DELEGATECALL from the vault, with LEG_V4_POOL legs on
/// the PoolManager deployed on Base. F1b's own suites cover every leg kind and
/// its adversaries; these pin the wiring: the lock the executor requires, the
/// callbacks the vault forwards, the route's effect the vault checks on top of
/// each leg's, and the fees a swap through the vault's own pool pays its root.
contract DominoV2VaultSwapModuleTest is HarnessV4 {
    bytes32 internal constant FEES_COLLECTED = keccak256("FeesCollected(uint256,uint256,uint256)");
    bytes32 internal constant SWAP_LEG_EXECUTED =
        keccak256("SwapLegExecuted(uint8,address,address,address,uint256,uint256)");

    address internal module;

    function setUp() public override {
        super.setUp();
        module = _useSwapModule();
    }

    /// A one-hop LEG_V4_POOL plan: `amountIn` of the source's lot through
    /// `pool`, the vault asking for `planMin` and the leg for `legMin`.
    function _poolSwap(
        Plan.PlanV1 memory p,
        DominoV2Types.PoolRef memory pool,
        bool zeroForOne,
        uint128 amountIn,
        uint128 planMin,
        uint128 legMin
    ) internal view returns (Plan.PlanV1 memory) {
        (address tokenIn, address tokenOut) =
            zeroForOne ? (pool.currency0, pool.currency1) : (pool.currency1, pool.currency0);
        DominoV2Types.PoolRef[] memory path = new DominoV2Types.PoolRef[](1);
        path[0] = pool;
        p.swap.source = rootId;
        p.swap.zeroForOne = zeroForOne;
        p.swap.amountIn = amountIn;
        p.swap.minAmountOut = planMin;
        p.swap.legs = new DominoV2Types.SwapLeg[](1);
        p.swap.legs[0] = DominoV2Types.SwapLeg({
            kind: DominoV2Types.LEG_V4_POOL,
            router: address(0),
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: legMin,
            data: abi.encode(path)
        });
        return p;
    }

    function _count(VaultVm.Log[] memory logs, bytes32 topic) internal view returns (uint256 n, bytes memory last) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == topic) {
                ++n;
                last = logs[i].data;
            }
        }
    }

    function testACompoundSwapsThroughTheModule() public {
        _simple();
        DominoV2Types.PoolRef memory deep = _deepPool();
        _accrue(rootId, 2000, 0);
        vm.recordLogs();
        _execute(_poolSwap(_plan(), deep, true, 970, 957, 957));
        VaultVm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 legs, bytes memory leg) = _count(logs, SWAP_LEG_EXECUTED);
        _eq(legs, 1, "one leg, emitted by the vault");
        (, uint256 amountIn, uint256 amountOut) = abi.decode(leg, (address, uint256, uint256));
        _eq(amountIn, 970, "the leg's input");
        _true(amountOut >= 968 && amountOut < 970, "0.05% pool, deep");
        (, uint128 charged1) = _lot(rootId, address(token1));
        _true(charged1 <= amountOut / 100, "the output funded the add");
        (uint128 left0,) = _lot(rootId, address(token0));
        _eq(token0.balanceOf(address(vault)), left0, "the vault holds exactly its lots (0)");
        _true(vault.rootArmed() && _locked(), "armed, PoolManager locked");
    }

    function testANativeSwapThroughTheModule() public {
        nativePair = true;
        _simple();
        DominoV2Types.PoolRef memory deep = _deepPool();
        _accrue(rootId, 2000, 0);
        _execute(_poolSwap(_plan(), deep, true, 970, 957, 957));
        (uint128 left0,) = _lot(rootId, address(0));
        _eq(address(vault).balance, left0 + vault.owedFees(address(0)), "the vault holds its native lot");
        _true(token1.balanceOf(RECIPIENT) == 0 && RECIPIENT.balance > 0, "the tariff is in the consumed fees");
    }

    /// The swap pays its LP fee to the root, the only liquidity in the vault's
    /// pool: the vault collects it before the increase would credit it unseen.
    function testFeesTheVaultsOwnSwapPaysToTheRootAreCollectedFirst() public {
        _simple();
        _accrue(rootId, 2000, 0);
        vm.recordLogs();
        _execute(_poolSwap(_plan(), _poolRef(), true, 970, 957, 957));
        (uint256 collections, bytes memory last) = _count(vm.getRecordedLogs(), FEES_COLLECTED);
        _eq(collections, 2, "collected again after the swap");
        (uint256 fees0, uint256 fees1) = abi.decode(last, (uint256, uint256));
        _true(fees0 > 0 && fees1 == 0, "the swap's LP fee, in its input");
        (uint256 rest0, uint256 rest1) = _collectable(rootId);
        _eq(rest0 + rest1, 0, "nothing credited unseen");
    }

    /// Each leg is F1b's to accept; the whole route is the vault's: exactly
    /// the plan's input out of the source's lot.
    function testTheRouteMustSpendExactlyThePlannedInput() public {
        _simple();
        DominoV2Types.PoolRef memory deep = _deepPool();
        _accrue(rootId, 2000, 0);
        Plan.PlanV1 memory p = _poolSwap(_plan(), deep, true, 970, 957, 957);
        p.swap.legs[0].amountIn = 969;
        vm.expectRevert(DominoV2VaultStorage.InvalidAmount.selector);
        _execute(p);
    }

    /// ... and at least the plan's minimum in, whatever the legs accepted.
    function testTheRouteMustDeliverThePlannedMinimum() public {
        _simple();
        DominoV2Types.PoolRef memory deep = _deepPool();
        _accrue(rootId, 2000, 0);
        Plan.PlanV1 memory p = _poolSwap(_plan(), deep, true, 970, 970, 957);
        vm.expectRevert(DominoV2VaultStorage.InvalidAmount.selector);
        _execute(p);
    }

    /// A leg the module refuses fails the execution with the module's reason.
    function testALegTheModuleRefusesFailsTheExecution() public {
        _simple();
        DominoV2Types.PoolRef memory deep = _deepPool();
        _accrue(rootId, 2000, 0);
        Plan.PlanV1 memory p = _poolSwap(_plan(), deep, true, 970, 957, 975);
        vm.expectRevert(IDominoPositionActions.SwapEffectMismatch.selector);
        _execute(p);
    }

    /// The executor runs only inside a locked action of its host.
    function testTheModuleRefusesToRunOutsideAVault() public {
        DominoV2Types.SwapLeg[] memory legs = new DominoV2Types.SwapLeg[](0);
        vm.expectRevert(IDominoPositionActions.Unauthorized.selector);
        DominoV2VaultSwapModule(module).swap(legs, address(token0), address(token1));
    }

    /// Outside a leg the module refuses both callbacks the vault forwards.
    function testForwardedCallbacksAreAuthenticatedByTheModule() public {
        _simple();
        vm.prank(STRANGER);
        vm.expectRevert(IDominoPositionActions.Unauthorized.selector);
        vault.unlockCallback(hex"00");
        vm.prank(address(poolManager));
        vm.expectRevert(IDominoPositionActions.Unauthorized.selector);
        vault.unlockCallback(hex"00");
        vm.prank(STRANGER);
        vm.expectRevert(IDominoPositionActions.Unauthorized.selector);
        vault.uniswapV3SwapCallback(1, -1, "");
    }

    function _locked() internal view returns (bool) {
        return poolManager.exttload(0xc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab23) == bytes32(0);
    }
}
