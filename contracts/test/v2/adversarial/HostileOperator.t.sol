// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IUniswapV3PositionManagerMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IV3PoolInitializerMinimal} from "../../../src/v2/positions/DominoV3Positions.sol";
import {DominoSwapFloor} from "../../../src/v2/route/DominoSwapFloor.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {DominoV2VaultStorage} from "../../../src/v2/vault/DominoV2VaultStorage.sol";
import {IntegrationWorld} from "../integration/IntegrationWorld.sol";
import {ScriptedRouter, scriptedCall} from "../route/RouteAdversaries.sol";
import {ZapVm} from "../zap/ZapTestKit.sol";
import {BuyTaxToken} from "./BuyTaxToken.sol";

/// The operator is trusted only up to the owner's limits (docs/v2/F3_VAULT.md,
/// A4; the vault's ceilings of 3 Oct 2026). These tests measure that trust on
/// the wired world (real registry, anchor, swap module and Uniswap bytecode):
/// what an operator's route may keep is the floor's margin and no more, an
/// observation it picks moves the floor by at most the owner's band, and a
/// pause never holds the owner's money.
abstract contract HostileOperatorSuite is IntegrationWorld {
    function setUp() public virtual override {
        super.setUp();
        stack = _vaultStack(address(0));
    }

    /// A router governance admitted (after the timelock), funded to pay out.
    function _admittedRouter() internal returns (ScriptedRouter router) {
        router = new ScriptedRouter(PERMIT2);
        _governed(DominoV2Types.REGISTRY_ROUTER, abi.encode(address(router), uint16(212)));
        quote.mint(address(router), 1e24);
    }

    /// A base -> quote leg through `router`, which pulls `amountIn` and pays `pay`.
    function _scriptedLeg(ScriptedRouter router, uint128 amountIn, uint256 pay)
        internal
        view
        returns (DominoV2Types.SwapLeg memory)
    {
        ScriptedRouter.Script memory script;
        (script.tokenIn, script.pull, script.tokenOut, script.pay) = (address(base), amountIn, address(quote), pay);
        return DominoV2Types.SwapLeg(
            DominoV2Types.LEG_UNIVERSAL_ROUTER, address(router), address(base), address(quote), amountIn, 1, scriptedCall(script)
        );
    }

    /// What the Swapped event says the vault's swap delivered.
    function _swappedOut(ZapVm.Log[] memory logs) internal view returns (uint256 amountOut) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault) || logs[i].topics[0] != SWAPPED) continue;
            (,, amountOut) = abi.decode(logs[i].data, (bool, uint256, uint256));
        }
    }

    function _swapPlan(DominoV2Types.SwapLeg memory leg, uint128 amountIn, uint128 minOut)
        internal
        view
        returns (Plan.PlanV1 memory p)
    {
        p = _plan();
        p.swap = Plan.Swap(rootId, true, amountIn, minOut, _oneLeg(leg));
    }

    /// The floor (anchor quote, less the pool's fee and the owner's 1%
    /// slippage) is all a route must deliver: one unit under it is refused,
    /// and a route paying exactly it keeps the rest, at most the pool fee plus
    /// the slippage of the quote.
    function testARouteMustDeliverTheFloorAndMayKeepOnlyItsMargin() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        _accrueFees(main);
        ScriptedRouter router = _admittedRouter();
        uint128 amountIn = 1e12;
        uint160 spot = _spot(main);
        uint128 floor = _floor(main, amountIn, spot, true, 100);
        Plan.PlanV1 memory p = _swapPlan(_scriptedLeg(router, amountIn, floor - 1), amountIn, floor);
        vm.expectRevert(DominoV2VaultStorage.InvalidAmount.selector);
        _execute(p);
        p = _swapPlan(_scriptedLeg(router, amountIn, floor), amountIn, floor);
        vm.recordLogs();
        _execute(p);
        _eq(_swappedOut(vm.getRecordedLogs()), floor, "the route delivered exactly the floor");
        uint256 quoted = DominoSwapFloor.quote(amountIn, spot, true);
        uint256 marginPips = uint256(_poolFeePips(main, true)) + 100 * 100;
        _check((quoted - floor) * 1e6 <= quoted * marginPips + 1e6, "the route kept at most the fee and slippage margin");
        _ledgerBalanced();
    }

    /// The floor follows the signed anchor, not the spot. An operator choosing
    /// among valid observations can lower it by at most the owner's band (2%
    /// here, 5% at most): beyond the band the observation is refused.
    function testAnObservationAtTheBandEdgeLowersTheFloorByAtMostTheBand() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        _accrueFees(main);
        ScriptedRouter router = _admittedRouter();
        uint128 amountIn = 1e12;
        uint160 spot = _spot(main);
        // The lowest anchor the 2% band still accepts below the spot.
        uint160 low = _scaled(spot, 9805);
        uint128 lowFloor = _floor(main, amountIn, low, true, 100);
        Plan.PlanV1 memory p = _swapPlan(_scriptedLeg(router, amountIn, lowFloor), amountIn, lowFloor);
        p.anchorEvidence = _evidence(main.pool, _scaled(spot, 9790));
        vm.expectRevert();
        _execute(p);
        p.anchorEvidence = _evidence(main.pool, low);
        vm.recordLogs();
        _execute(p);
        _eq(_swappedOut(vm.getRecordedLogs()), lowFloor, "a band-edge anchor's floor was accepted");
        uint256 quoted = DominoSwapFloor.quote(amountIn, spot, true);
        uint256 boundPips = 200 * 100 + uint256(_poolFeePips(main, true)) + 100 * 100;
        _check((quoted - lowFloor) * 1e6 <= quoted * boundPips + 1e6, "lowered by at most band, fee and slippage");
        _ledgerBalanced();
    }

    /// Any registry operator may pause any vault (A4, accepted): the owner's
    /// withdrawals and exitAll do not wait for it, and the owner resumes.
    function testAnOperatorsPauseNeverHoldsTheOwnersMoney() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        _accrueFees(main);
        Plan.PlanV1 memory p = _plan();
        p.budgets[0] = Plan.Budget(rootId, 1e9, 1e9);
        _execute(p);
        vm.prank(OPERATOR);
        vault.pause();
        bytes memory next = Plan.encode(_plan());
        vm.prank(OPERATOR);
        vm.expectRevert();
        vault.execute(next);
        uint256 reserve = vault.reserves(address(quote));
        _check(reserve > 0, "reserves to withdraw");
        uint256 before = quote.balanceOf(owner);
        vm.prank(owner);
        vault.withdrawReserves(address(quote), reserve, owner);
        _eq(quote.balanceOf(owner) - before, reserve, "withdrawn in full while paused");
        vm.prank(owner);
        vault.resume();
        vm.prank(OPERATOR);
        vault.pause();
        vm.prank(owner);
        vault.exitAll();
        _check(!vault.rootArmed(), "exitAll while paused");
        _ledgerBalanced();
    }
}

contract HostileOperatorV3Test is HostileOperatorSuite {
    function _dex() internal pure override returns (uint8) {
        return 3;
    }

    function _zapArtifact() internal pure override returns (string memory) {
        return "DominoZapV3.sol:DominoZapV3";
    }

    function _vaultArtifact() internal pure override returns (string memory) {
        return "DominoV2VaultV3.sol:DominoV2VaultV3";
    }

    function _executorArtifact() internal pure override returns (string memory) {
        return "DominoV2VaultV3.sol:DominoV2VaultExecutorV3";
    }

    /// F-03 in the vault: a donated token the owner may recover (here a buy-
    /// tax token) is a hop of the operator's direct v3 path. The second pool
    /// is paid what arrived from the first, never the donation.
    function testAHopTokenTheVaultHoldsIsNeverSpentByARoute() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        _accrueFees(main);
        BuyTaxToken bhop = new BuyTaxToken();
        bhop.mint(address(this), 1e30);
        address first = _openV3(address(base), address(bhop));
        address second = _openV3(address(bhop), address(quote));
        bhop.setTaxedSender(first, true);
        bhop.setTaxedSender(second, true);
        bhop.mint(address(vault), 5e15);
        uint128 amountIn = 1e12;
        uint160 spot = _spot(main);
        Plan.PlanV1 memory p = _plan();
        p.swap = Plan.Swap(
            rootId,
            true,
            amountIn,
            _floor(main, amountIn, spot, true, 100),
            _oneLeg(
                DominoV2Types.SwapLeg(
                    DominoV2Types.LEG_V3_POOL, address(0), address(base), address(quote), amountIn, 1,
                    abi.encodePacked(address(base), uint24(500), address(bhop), uint24(500), address(quote))
                )
            )
        );
        _execute(p);
        _eq(bhop.balanceOf(address(vault)), 5e15, "the owner's recoverable hop tokens are untouched");
        _ledgerBalanced();
    }

    /// Audit DV2-01 in the vault: a hop token that debits its sender (the
    /// vault, paying the second pool) one unit more than it moves would pay
    /// that pool partly out of what the owner may recover. The intermediate is
    /// tracked, so the execution reverts and the vault's hop tokens are untouched.
    function testAnOverDebitingHopTokenTheVaultHoldsIsRefused() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        _accrueFees(main);
        BuyTaxToken bhop = new BuyTaxToken();
        bhop.mint(address(this), 1e30);
        _openV3(address(base), address(bhop));
        _openV3(address(bhop), address(quote));
        bhop.mint(address(vault), 5e15);
        bhop.setOverdebited(address(vault), true);
        uint128 amountIn = 1e12;
        uint160 spot = _spot(main);
        Plan.PlanV1 memory p = _plan();
        p.swap = Plan.Swap(
            rootId,
            true,
            amountIn,
            _floor(main, amountIn, spot, true, 100),
            _oneLeg(
                DominoV2Types.SwapLeg(
                    DominoV2Types.LEG_V3_POOL, address(0), address(base), address(quote), amountIn, 1,
                    abi.encodePacked(address(base), uint24(500), address(bhop), uint24(500), address(quote))
                )
            )
        );
        vm.expectRevert(IDominoPositionActions.SwapEffectMismatch.selector);
        _execute(p);
        _eq(bhop.balanceOf(address(vault)), 5e15, "the owner's recoverable hop tokens are untouched");
        _ledgerBalanced();
    }

    /// A 0.05% v3 pool of a and b at price one, full range, deep.
    function _openV3(address a, address b) internal returns (address pool) {
        (address c0, address c1) = _sorted(a, b);
        pool = IV3PoolInitializerMinimal(chain.v3PositionManager).createAndInitializePoolIfNecessary(c0, c1, 500, PRICE_ONE);
        IBasicToken(c0).approve(chain.v3PositionManager, type(uint256).max);
        IBasicToken(c1).approve(chain.v3PositionManager, type(uint256).max);
        IUniswapV3PositionManagerMinimal(chain.v3PositionManager).mint(
            IUniswapV3PositionManagerMinimal.MintParams(c0, c1, 500, -887270, 887270, 1e25, 1e25, 0, 0, address(this), clock)
        );
    }
}

contract HostileOperatorV4Test is HostileOperatorSuite {
    function _dex() internal pure override returns (uint8) {
        return 4;
    }

    function _zapArtifact() internal pure override returns (string memory) {
        return "DominoZapV4.sol:DominoZapV4";
    }

    function _vaultArtifact() internal pure override returns (string memory) {
        return "DominoV2VaultV4.sol:DominoV2VaultV4";
    }

    function _executorArtifact() internal pure override returns (string memory) {
        return "DominoV2VaultV4.sol:DominoV2VaultExecutorV4";
    }
}

interface IBasicToken {
    function approve(address spender, uint256 amount) external returns (bool);
}
