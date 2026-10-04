// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoVault} from "../../../src/v2/interfaces/IDominoVault.sol";
import {IDominoVaultLedger} from "../../../src/v2/interfaces/IDominoVaultLedger.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {HarnessV3} from "../vault/VaultHarness.sol";
import {MockV3PositionManager} from "../vault/VaultMocks.sol";

/// @notice Attack map item 13: the global halt against the owner's exits, on
/// the vault harness (v3 unit model, MockRegistry).
///
/// What the docs promise:
/// - IDominoRegistry.automationHalted: "When true, operator executions stop
///   on every vault; owner actions continue";
/// - F3_VAULT.md: "Exits never depend on the operator, the publisher, the
///   anchor, the registry, the executor or the swap module. Only pause reads
///   the registry, and only for a caller that is not the owner", and
///   returnReserves "never reads the registry: like the owner's exits,
///   neither a pause nor the global halt holds the owner's money back";
/// - F3_VAULT.md, decision 9: the registry's global halt stops executeExit.
///
/// Two worlds: the registry halted, and the registry broken (every call to
/// it reverts), where vm.expectCall(registry, "", 0) also pins that the
/// owner's exits never call it at all.
contract DominoHaltOwnerExitsTest is HarnessV3 {
    uint128 internal constant LIQUIDITY = 1e18;
    uint128 internal constant FEES = 100_000;
    uint128 internal constant ADD_CAP = 30_000;
    uint256 internal constant DONATION = 777;
    address internal constant OTHER_WALLET = address(0xC0FFEE);

    /// A Domino vault whose root minted a successor near its ceiling with the
    /// mint capped, so the root keeps lots in both tokens; then fees to
    /// compound, a donation, and the auto-exit module enabled.
    function _world() internal returns (uint256 child) {
        rootId = _mintPosition(OWNER, -600, 120, LIQUIDITY);
        vault = _createVaultFor(rootId, DominoV2Types.MODE_DOMINO, 3);
        _accrue(rootId, FEES, FEES);
        Plan.PlanV1 memory p = _plan();
        p.action = Plan.ACTION_MINT;
        p.tickLower = 0;
        p.tickUpper = 4200;
        p.amount0Max = ADD_CAP;
        p.amount1Max = ADD_CAP;
        _execute(p);
        child = vault.member(rootId).successor;
        _true(child != 0 && vault.member(child).active, "a successor");
        _true(vault.reserves(address(token0)) > 0 && vault.reserves(address(token1)) > 0, "reserves in both tokens");
        _accrue(rootId, FEES, FEES);
        token0.mint(address(vault), DONATION);
        vm.prank(OWNER);
        vault.setExitModule(EXIT_MODULE);
        vm.warp(block.timestamp + 600);
    }

    /// The operator's compound, the exit module's executeExit and the
    /// operator's rearm, each refused with `selector` (zero: any revert),
    /// and nothing moved.
    function _automationRefused(bytes4 selector) internal {
        bytes memory plan = Plan.encode(_plan());
        IDominoVaultLedger.RootCheckpoint memory none;
        uint64 nonce = vault.stateNonce();
        uint128 liquidity = _liquidityOf(rootId);
        uint256 held0 = token0.balanceOf(address(vault));
        uint256 held1 = token1.balanceOf(address(vault));
        _expectRevert(selector);
        vm.prank(OPERATOR);
        vault.execute(plan);
        _expectRevert(selector);
        vm.prank(EXIT_MODULE);
        vault.executeExit(rootId, _exitInstruction(0, 0));
        _expectRevert(selector);
        vm.prank(OPERATOR);
        vault.operatorRearm(none);
        _eq(vault.stateNonce(), nonce, "a refused automation moved the nonce");
        _eq(_liquidityOf(rootId), liquidity, "a refused automation touched the root");
        _eq(token0.balanceOf(address(vault)), held0, "a refused automation moved token0");
        _eq(token1.balanceOf(address(vault)), held1, "a refused automation moved token1");
    }

    function _expectRevert(bytes4 selector) internal {
        if (selector == bytes4(0)) vm.expectRevert();
        else vm.expectRevert(selector);
    }

    /// The owner removes all of the root's liquidity on Uniswap, without the vault.
    function _closeRoot() internal {
        uint128 liquidity = _liquidityOf(rootId);
        vm.prank(OWNER);
        npm.decreaseLiquidity(MockV3PositionManager.DecreaseLiquidityParams(rootId, liquidity, 0, 0, block.timestamp));
    }

    /// Every exit the owner has, in an order that leaves nothing: half the
    /// token0 reserve to another wallet, the successor, the donation; then
    /// the owner closes the root on Uniswap and a stranger returns the rest;
    /// exitAll ends the sequence. Each pays exactly, to the owner (or the
    /// wallet it names), and the vault ends holding only owed fees.
    function _ownerExitsEverything(uint256 child) internal {
        uint256 reserve0 = vault.reserves(address(token0));
        uint256 reserve1 = vault.reserves(address(token1));
        uint256 owner0 = token0.balanceOf(OWNER);
        uint256 owner1 = token1.balanceOf(OWNER);
        vm.startPrank(OWNER);
        vault.pause();
        vault.resume();
        vault.setLimits(_limits());
        vault.setExitModule(address(0));
        vault.withdrawReserves(address(token0), reserve0 / 2, OTHER_WALLET);
        vault.withdrawChild(child);
        vault.recoverToken(address(token0), DONATION);
        vm.stopPrank();
        _eq(token0.balanceOf(OTHER_WALLET), reserve0 / 2, "withdrawReserves paid the named wallet exactly");
        _true(npm.ownerOf(child) == OWNER && !vault.member(child).active, "withdrawChild: the successor is the owner's");
        _closeRoot();
        vm.prank(STRANGER);
        (uint256 paid0, uint256 paid1) = vault.returnReserves();
        vm.prank(OWNER);
        vault.exitAll();
        _eq(token0.balanceOf(OWNER) - owner0, reserve0 - reserve0 / 2 + DONATION, "every token0 unit to the owner");
        _eq(token1.balanceOf(OWNER) - owner1, reserve1, "every token1 unit to the owner");
        _eq(paid0 + paid1 + reserve0 / 2, reserve0 + reserve1, "returnReserves paid what withdrawReserves left");
        _eq(vault.reserves(address(token0)) + vault.reserves(address(token1)), 0, "nothing left to the owner");
        _eq(token0.balanceOf(address(vault)), vault.owedFees(address(token0)), "only owed fees stay (token0)");
        _eq(token1.balanceOf(address(vault)), vault.owedFees(address(token1)), "only owed fees stay (token1)");
        _true(vault.paused() && !vault.rootArmed() && npm.ownerOf(rootId) == OWNER, "exitAll ended the sequence");
    }

    /// The halt refuses the operator's compound, the exit module's exit and
    /// the operator's rearm, and none of the owner's exits.
    function testTheHaltStopsAutomationButNoneOfTheOwnersExits() public {
        uint256 child = _world();
        registry.setHalted(true);
        _automationRefused(IDominoVault.AutomationUnavailable.selector);
        _ownerExitsEverything(child);
    }

    /// The halt is lifted where the registry lifts it: the same compound
    /// that was refused runs once automationHalted is false again.
    function testAutomationRunsAgainOnceTheHaltIsLifted() public {
        _world();
        registry.setHalted(true);
        _automationRefused(IDominoVault.AutomationUnavailable.selector);
        registry.setHalted(false);
        uint128 before = _liquidityOf(rootId);
        _execute(_plan());
        _true(_liquidityOf(rootId) > before, "compounded once the halt was lifted");
    }

    /// A registry that answers nothing (every call reverts): automation
    /// fails closed, and the owner exits exactly as before without a single
    /// call to the registry.
    function testTheOwnersExitsNeverCallTheRegistry() public {
        uint256 child = _world();
        vm.etch(address(registry), hex"5f5ffd");
        _automationRefused(bytes4(0));
        // An operator's pause reads the registry; the owner's never does.
        vm.prank(OPERATOR);
        vm.expectRevert();
        vault.pause();
        vm.expectCall(address(registry), "", 0);
        _ownerExitsEverything(child);
    }
}
