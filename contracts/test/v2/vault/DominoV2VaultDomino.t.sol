// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoVault} from "../../../src/v2/interfaces/IDominoVault.sol";
import {IDominoVaultLedger} from "../../../src/v2/interfaces/IDominoVaultLedger.sol";
import {DominoV2VaultStorage} from "../../../src/v2/vault/DominoV2VaultStorage.sol";
import {DominoPositionMath} from "../../../src/v2/positions/DominoPositionMath.sol";
import {TickMath} from "../../../src/v2/positions/uniswap/TickMath.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {VaultHarness, HarnessV3} from "./VaultHarness.sol";

/// Domino-compound: the executor's routing and geometry, the same code on both
/// DEXes, with exact amounts on the v3 unit model (DominoV2VaultV4.t.sol mints
/// a successor on the deployed v4 managers). With the root at [-6000, 6000) (spacing 60),
/// a 5% trigger, 20% overlap and 50% upside, quote currency1: the ceiling is
/// tick 6000; the first successor floor may be anywhere in [3780, 6000] and
/// its ceiling must be 10080, the first tick at least 1.5x the ceiling price.
abstract contract DominoSuite is VaultHarness {
    int24 internal constant SUCCESSOR_LOWER = 5400;
    int24 internal constant SUCCESSOR_UPPER = 10080;

    function _anchorAt(int24 tick) internal {
        uint160 price = TickMath.getSqrtPriceAtTick(tick);
        anchor.set(price, price);
    }

    function _mintPlan(int24 lower, int24 upper) internal view returns (Plan.PlanV1 memory p) {
        p = _plan();
        p.action = Plan.ACTION_MINT;
        p.tickLower = lower;
        p.tickUpper = upper;
    }

    function _nextTokenId() internal view virtual returns (uint256);

    function _mintSuccessor() internal returns (uint256 child) {
        _domino(3);
        _accrue(rootId, 1000, 1000);
        _anchorAt(5800);
        child = _nextTokenId();
        _execute(_mintPlan(SUCCESSOR_LOWER, SUCCESSOR_UPPER));
        vm.warp(block.timestamp + 600);
    }

    function _mintFails(int24 lower, int24 upper, bytes4 selector) internal {
        _mintFailsWith(lower, upper, abi.encodeWithSelector(selector));
    }

    function _mintFailsWith(int24 lower, int24 upper, bytes memory reason) internal {
        Plan.PlanV1 memory p = _mintPlan(lower, upper);
        vm.expectRevert(reason);
        _execute(p);
    }

    function testMintsASuccessorNearTheCeiling() public {
        _domino(3);
        _accrue(rootId, 1000, 1000);
        _anchorAt(5800);
        uint256 child = _nextTokenId();
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.SuccessorCreated(rootId, child, 2);
        _execute(_mintPlan(SUCCESSOR_LOWER, SUCCESSOR_UPPER));
        uint256[] memory members = vault.positions();
        _true(members.length == 2 && members[1] == child, "registered");
        IDominoVaultLedger.Member memory created = vault.member(child);
        _true(
            created.active && created.parent == rootId && created.tickLower == SUCCESSOR_LOWER
                && created.tickUpper == SUCCESSOR_UPPER,
            "member"
        );
        _eq(vault.member(rootId).successor, child, "the parent's successor");
        _true(_ownerOfNft(child) == address(vault), "held by the vault");
        _eq(_liquidityOf(child), 960, "funded by the parent's fees at 4%");
        _eq(token0.balanceOf(RECIPIENT), 39, "Domino tariff");
    }

    function testNoSuccessorBelowTheTrigger() public {
        _domino(3);
        _accrue(rootId, 1000, 1000);
        // 95% of the ceiling price is tick 5487.04: 5487 is short, 5488 is in.
        _anchorAt(5400);
        _mintFails(SUCCESSOR_LOWER, SUCCESSOR_UPPER, DominoV2VaultStorage.InvalidRoute.selector);
        _anchorAt(5487);
        _mintFails(SUCCESSOR_LOWER, SUCCESSOR_UPPER, DominoV2VaultStorage.InvalidRoute.selector);
        _anchorAt(5488);
        _execute(_mintPlan(SUCCESSOR_LOWER, SUCCESSOR_UPPER));
    }

    function testSuccessorGeometry() public {
        _domino(3);
        _accrue(rootId, 1000, 1000);
        _anchorAt(5800);
        bytes4 invalid = DominoV2VaultStorage.InvalidRoute.selector;
        _mintFails(6060, SUCCESSOR_UPPER, invalid); // floor above the ceiling
        _mintFails(3720, SUCCESSOR_UPPER, invalid); // floor more than 20% below
        _mintFails(SUCCESSOR_LOWER, 10020, invalid); // ceiling short of +50%
        _mintFails(SUCCESSOR_LOWER, 10140, invalid); // not the first such tick
        _mintFails(SUCCESSOR_UPPER, SUCCESSOR_LOWER, invalid); // inverted
        // The range itself is the position adapter's check (F1c), at the mint.
        bytes4 range = DominoPositionMath.InvalidRange.selector;
        _mintFailsWith(5410, SUCCESSOR_UPPER, abi.encodeWithSelector(range, 5410, SUCCESSOR_UPPER, 60)); // misaligned floor
        _mintFailsWith(SUCCESSOR_LOWER, 10090, abi.encodeWithSelector(range, SUCCESSOR_LOWER, 10090, 60)); // misaligned ceiling
        bytes4 tick = TickMath.InvalidTick.selector;
        _mintFailsWith(-887280, SUCCESSOR_UPPER, abi.encodeWithSelector(tick, -887280)); // below the tick range
        _mintFailsWith(SUCCESSOR_LOWER, 887280, abi.encodeWithSelector(tick, 887280)); // above the tick range
        _execute(_mintPlan(3780, SUCCESSOR_UPPER)); // the widest overlap
    }

    /// After a jump past the ceiling the geometry is measured from the anchor,
    /// so the successor is never minted wholly below the price (A3).
    function testGeometryFollowsAPriceAboveTheCeiling() public {
        _domino(3);
        _accrue(rootId, 1000, 1000);
        _anchorAt(7000);
        _mintFails(SUCCESSOR_LOWER, SUCCESSOR_UPPER, DominoV2VaultStorage.InvalidRoute.selector);
        uint256 child = _nextTokenId();
        _execute(_mintPlan(6960, 11100));
        _eq(vault.member(rootId).successor, child, "minted at the anchor");
    }

    function testOneSuccessorPerParentAndTheCap() public {
        _mintSuccessor();
        _accrue(rootId, 1000, 1000);
        _mintFails(SUCCESSOR_LOWER, SUCCESSOR_UPPER, DominoV2VaultStorage.InvalidRoute.selector);
    }

    function testTheSequenceCap() public {
        _domino(1);
        _accrue(rootId, 1000, 1000);
        _anchorAt(5800);
        _mintFails(SUCCESSOR_LOWER, SUCCESSOR_UPPER, DominoV2VaultStorage.InvalidRoute.selector);
    }

    function testSimpleModeNeverMints() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        _anchorAt(5800);
        _mintFails(SUCCESSOR_LOWER, SUCCESSOR_UPPER, DominoV2VaultStorage.InvalidRoute.selector);
    }

    function testMintNeedsAnActiveParent() public {
        _domino(3);
        _accrue(rootId, 1000, 1000);
        _anchorAt(5800);
        Plan.PlanV1 memory p = _mintPlan(SUCCESSOR_LOWER, SUCCESSOR_UPPER);
        p.target = rootId + 50;
        vm.expectRevert(DominoV2VaultStorage.InvalidRoute.selector);
        _execute(p);
    }

    /// A retired successor keeps its range in storage but is no parent, even
    /// for a plan otherwise valid: the root, which the price has left, funding
    /// a range the price is in, with the anchor at the retired one's trigger.
    function testARetiredSuccessorIsNoParent() public {
        uint256 child = _mintSuccessor();
        vm.prank(OWNER);
        vault.withdrawChild(child);
        _accrue(rootId, 1000, 1000);
        _anchorAt(10000);
        Plan.PlanV1 memory p = _mintPlan(9000, 14160);
        p.target = child;
        vm.expectRevert(DominoV2VaultStorage.InvalidRoute.selector);
        _execute(p);
    }

    /// The trigger is the parent's, whoever funds the mint: below it, not even
    /// a position the price has left may fund a successor the price is in.
    function testNoSuccessorBelowTheTriggerWhateverFundsIt() public {
        uint256 child = _mintSuccessor();
        _accrue(rootId, 1000, 1000);
        _anchorAt(8000);
        // [7860, 14160): floor 20% below the child's ceiling 10080, ceiling the
        // first tick 50% above it; the price is in it, the root is left behind.
        Plan.PlanV1 memory p = _mintPlan(7860, 14160);
        p.target = child;
        vm.expectRevert(DominoV2VaultStorage.InvalidRoute.selector);
        _execute(p);
    }

    function testRecoverPositionRefusesAnActiveChild() public {
        uint256 child = _mintSuccessor();
        vm.prank(OWNER);
        vm.expectRevert(DominoV2VaultStorage.InvalidPosition.selector);
        vault.recoverPosition(child);
    }

    /// A withdrawn successor frees its parent's slot (A3) and its leftovers
    /// stay the owner's, as idle reserves automation never spends.
    function testWithdrawingASuccessorFreesTheSlot() public {
        uint256 child = _mintSuccessor();
        // The child compounds its own 100 + 100 at 4%: 96 added, 1 + 1 left.
        _accrue(child, 100, 100);
        Plan.PlanV1 memory p = _plan();
        p.target = child;
        p.collect = _one(child);
        p.budgets[0] = _budget(child);
        _execute(p);
        (uint128 left0,) = _lot(child, address(token0));
        _eq(left0, 1, "the child kept a remainder");
        vm.prank(STRANGER);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.withdrawChild(child);
        vm.prank(OWNER);
        vm.expectRevert(DominoV2VaultStorage.InvalidPosition.selector);
        vault.withdrawChild(rootId);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.ChildWithdrawn(child, 4);
        vm.prank(OWNER);
        vault.withdrawChild(child);
        _true(_ownerOfNft(child) == OWNER, "the child is the owner's");
        _true(!vault.member(child).active, "retired");
        _eq(vault.member(rootId).successor, 0, "slot free");
        _eq(vault.idleReserves(address(token0)), 1, "leftovers idle");
        _eq(vault.positions().length, 1, "root alone");
        vm.prank(OWNER);
        vm.expectRevert(DominoV2VaultStorage.InvalidPosition.selector);
        vault.withdrawChild(child);
        // The slot is free again, and idle reserves never fund automation.
        _accrue(rootId, 1000, 1000);
        vm.warp(block.timestamp + 600);
        _execute(_mintPlan(SUCCESSOR_LOWER, SUCCESSOR_UPPER));
        _eq(vault.idleReserves(address(token0)), 1, "idle untouched");
    }

    function testParentNearItsCeilingFundsItsSuccessor() public {
        uint256 child = _mintSuccessor();
        _accrue(rootId, 1000, 1000);
        Plan.PlanV1 memory p = _plan();
        p.target = child;
        p.collect = _two(rootId, child);
        uint128 before = _liquidityOf(child);
        _execute(p);
        // 1000 new plus the 1 left by the mint: netOf(1001) at 4% = 961.
        _eq(_liquidityOf(child) - before, 961, "the root's fees went to its successor");
    }

    function testParentFarFromItsCeilingCannotFundItsSuccessor() public {
        uint256 child = _mintSuccessor();
        _accrue(rootId, 1000, 1000);
        _anchorAt(0);
        Plan.PlanV1 memory p = _plan();
        p.target = child;
        p.collect = _two(rootId, child);
        vm.expectRevert(DominoV2VaultStorage.InvalidRoute.selector);
        _execute(p);
    }

    function testAPositionThePriceLeftFundsOneThePriceIsIn() public {
        uint256 child = _mintSuccessor();
        _accrue(child, 1000, 1000);
        _accrue(rootId, 10, 10);
        _anchorAt(0);
        Plan.PlanV1 memory p = _plan();
        p.collect = _two(rootId, child);
        p.budgets = new Plan.Budget[](2);
        (p.budgets[0], p.budgets[1]) = (_budget(rootId), _budget(child));
        uint128 before = _liquidityOf(rootId);
        _execute(p);
        _true(_liquidityOf(rootId) - before > 900, "the child's fees reached the root");
    }

    function testAPositionThePriceIsInFundsNothingElse() public {
        uint256 child = _mintSuccessor();
        _accrue(child, 1000, 1000);
        _anchorAt(5800);
        Plan.PlanV1 memory p = _plan();
        p.collect = _two(rootId, child);
        p.budgets = new Plan.Budget[](2);
        (p.budgets[0], p.budgets[1]) = (_budget(rootId), _budget(child));
        vm.expectRevert(DominoV2VaultStorage.InvalidRoute.selector);
        _execute(p);
    }

    /// Near its own ceiling a position may fund its successor, and only it.
    function testAPositionNearItsCeilingFundsOnlyItsSuccessor() public {
        uint256 child = _mintSuccessor();
        _accrue(child, 1000, 1000);
        _anchorAt(9800);
        Plan.PlanV1 memory p = _plan();
        p.collect = _two(rootId, child);
        p.budgets[0] = _budget(child);
        vm.expectRevert(DominoV2VaultStorage.InvalidRoute.selector);
        _execute(p);
    }

    function testNothingFundsAPositionThePriceIsNotIn() public {
        uint256 child = _mintSuccessor();
        _accrue(child, 1000, 1000);
        _anchorAt(20000);
        Plan.PlanV1 memory p = _plan();
        p.collect = _two(rootId, child);
        p.budgets = new Plan.Budget[](2);
        (p.budgets[0], p.budgets[1]) = (_budget(rootId), _budget(child));
        vm.expectRevert(DominoV2VaultStorage.InvalidRoute.selector);
        _execute(p);
    }

    function testDowngradeNeedsTheChildrenWithdrawn() public {
        uint256 child = _mintSuccessor();
        vm.prank(OWNER);
        vm.expectRevert(IDominoVault.InvalidPolicy.selector);
        vault.setPolicy(_policy(DominoV2Types.MODE_SIMPLE, 1));
        vm.prank(OWNER);
        vm.expectRevert(IDominoVault.InvalidPolicy.selector);
        vault.setPolicy(_policy(DominoV2Types.MODE_DOMINO, 1));
        vm.prank(OWNER);
        vault.withdrawChild(child);
        vm.prank(OWNER);
        vault.setPolicy(_policy(DominoV2Types.MODE_SIMPLE, 1));
    }

    function testChildExitGoesToTheModuleAndTheChildToTheOwner() public {
        uint256 child = _mintSuccessor();
        vm.prank(OWNER);
        vault.setExitModule(EXIT_MODULE);
        _accrue(child, 30, 30);
        vm.prank(EXIT_MODULE);
        (uint256 amount0,) = vault.executeExit(child, _exitInstruction(0, 0));
        _eq(amount0, 990, "principal and the child's fees to the module");
        _eq(token0.balanceOf(OWNER), 0, "the child had no reserves");
        _true(_ownerOfNft(child) == OWNER, "the empty child to the owner");
        _true(!vault.member(child).active && vault.member(rootId).successor == 0, "retired");
        _true(vault.rootArmed(), "the root is not affected");
    }

    function testExitAllReturnsTheChildren() public {
        uint256 child = _mintSuccessor();
        vm.prank(OWNER);
        vault.exitAll();
        _true(_ownerOfNft(child) == OWNER, "child returned");
        _eq(vault.positions().length, 1, "root alone");
    }

    /// With the quote in currency0 prices are read upside down: the ceiling is
    /// the lower tick and the ladder grows toward lower ticks.
    function testQuoteInCurrency0LaddersTowardLowerTicks() public {
        registry.setRank(address(token0), 1);
        _domino(3);
        _accrue(rootId, 1000, 1000);
        _anchorAt(-5800);
        _mintFails(SUCCESSOR_LOWER, SUCCESSOR_UPPER, DominoV2VaultStorage.InvalidRoute.selector);
        _mintFails(-10020, -5400, DominoV2VaultStorage.InvalidRoute.selector);
        uint256 child = _nextTokenId();
        _execute(_mintPlan(-10080, -5400));
        _eq(vault.member(rootId).successor, child, "mirrored successor");
    }
}

contract DominoV2VaultDominoV3Test is DominoSuite, HarnessV3 {
    function _nextTokenId() internal view override returns (uint256) {
        return npm.nextId();
    }

    /// Members are recorded in 96 bits; a successor id beyond is refused.
    function testMintedTokenIdMustFitTheLedger() public {
        _domino(3);
        _accrue(rootId, 1000, 1000);
        _anchorAt(5800);
        npm.setNextId(uint256(type(uint96).max) + 1);
        _mintFails(SUCCESSOR_LOWER, SUCCESSOR_UPPER, DominoV2VaultStorage.InvalidPosition.selector);
        npm.setNextId(type(uint96).max);
        _execute(_mintPlan(SUCCESSOR_LOWER, SUCCESSOR_UPPER));
        _eq(vault.member(rootId).successor, type(uint96).max, "the largest id fits");
    }
}
