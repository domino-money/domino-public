// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoVault} from "../../../src/v2/interfaces/IDominoVault.sol";
import {IDominoVaultLedger} from "../../../src/v2/interfaces/IDominoVaultLedger.sol";
import {IUniswapV3PositionManagerMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {IV4PositionManagerMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {DominoActionLock} from "../../../src/v2/route/DominoActionLock.sol";
import {DominoV2VaultStorage} from "../../../src/v2/vault/DominoV2VaultStorage.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {MockToken, MockV3PositionManager} from "./VaultMocks.sol";
import {VaultHarness, VaultVm, HarnessV3} from "./VaultHarness.sol";
import {HarnessV3Base} from "./VaultHarnessV3Base.sol";
import {HarnessV4} from "./VaultHarnessV4.sol";

/// The cheat codes this suite adds to VaultVm.
interface ReturnVm {
    function snapshotState() external returns (uint256 snapshotId);
    function revertToState(uint256 snapshotId) external returns (bool);
}

/// Refuses native currency.
contract ReturnNativeRefuser {
    receive() external payable {
        revert("no");
    }
}

/// An owner whose wallet calls back into the vault when native currency
/// arrives, and keeps what the vault answered.
contract ReturnReentrantOwner {
    address internal immutable VAULT;
    bytes public reentry;

    constructor(address vault_) {
        VAULT = vault_;
    }

    receive() external payable {
        (bool ok, bytes memory result) = VAULT.call(abi.encodeCall(IDominoVaultLedger.returnReserves, ()));
        reentry = ok ? bytes("reentered") : result;
    }
}

/// returnReserves: anyone returns a closed vault's reserves to its owner.
///
/// The V1 incident of 2 Oct 2026: an owner closed an automated position on
/// Uniswap itself (liquidity 0, the NFT kept in the wallet). The vault, its
/// subscriber, only disarmed, and the fees the automation had collected and
/// not reinvested stayed in its ledger, withdrawable only through a function
/// no screen calls. V2 has the same custody, so the same close strands the
/// root's lots and the idle reserves; this is the way out that needs no one
/// but a caller, and pays no one but the owner.
///
/// The suite runs on three worlds: the exact-number v3 unit model
/// (HarnessV3), the NonfungiblePositionManager deployed on Base (HarnessV3Base)
/// and the v4 PoolManager and PositionManager deployed on Base (HarnessV4).
/// Reserves come from a real compound whose add is capped, so both tokens
/// stay in the root's lots.
abstract contract ReturnSuite is VaultHarness {
    ReturnVm internal constant cheats = ReturnVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint128 internal constant LIQUIDITY = 1e18;
    uint128 internal constant FEES = 100_000;
    uint128 internal constant ADD_CAP = 30_000;
    bytes32 internal constant RESERVES_WITHDRAWN = keccak256("ReservesWithdrawn(address,uint256,uint64)");

    // ============================================================ DEX hooks

    /// The owner removes all of the root's liquidity, as through the Uniswap
    /// app, and keeps the NFT.
    function _closeRoot() internal virtual;

    /// The owner empties the root and burns the NFT.
    function _ownerBurnsRoot() internal virtual;

    // ============================================================== helpers

    /// A simple vault whose root compounded once with the add capped: what the
    /// add did not take stays in the root's lots, in both tokens.
    function _vaultWithReserves() internal returns (uint256 reserve0, uint256 reserve1) {
        rootId = _mintPosition(OWNER, LOWER, UPPER, LIQUIDITY);
        vault = _createVaultFor(rootId, DominoV2Types.MODE_SIMPLE, 1);
        _accrue(rootId, FEES, FEES);
        Plan.PlanV1 memory p = _plan();
        p.amount0Max = ADD_CAP;
        p.amount1Max = ADD_CAP;
        _execute(p);
        reserve0 = vault.reserves(_currency0());
        reserve1 = vault.reserves(address(token1));
        _true(reserve0 > ADD_CAP && reserve1 > ADD_CAP, "reserves in both tokens");
    }

    /// A Domino vault with a successor the root funded near its ceiling: the
    /// root at [-600, 120) with the anchor at tick 0, the successor [0, 4200),
    /// its floor at most 20% below the root's ceiling and its ceiling the first
    /// tick 50% above it. The mint is capped, so the root keeps lots.
    function _vaultWithSuccessor() internal returns (uint256 child) {
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
    }

    function _vaultLogs(VaultVm.Log[] memory logs) internal view returns (uint256 count) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault)) ++count;
        }
    }

    function _withdrawals(VaultVm.Log[] memory logs) internal view returns (uint256 count) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == RESERVES_WITHDRAWN) ++count;
        }
    }

    function _noLots(string memory what) internal view {
        (uint128 uncharged0, uint128 charged0) = _lot(rootId, _currency0());
        (uint128 uncharged1, uint128 charged1) = _lot(rootId, address(token1));
        _eq(uint256(uncharged0) + charged0 + uncharged1 + charged1, 0, what);
    }

    // ================================================================ tests

    /// The incident's close: liquidity to zero, the NFT kept. Whoever calls,
    /// every reserve goes to the owner, without any charge.
    function testReturnsEveryReserveToTheOwnerOnceTheRootIsClosed() public {
        (uint256 reserve0, uint256 reserve1) = _vaultWithReserves();
        address currency0 = _currency0();
        _closeRoot();
        _eq(_liquidityOf(rootId), 0, "closed");
        _true(_ownerOfNft(rootId) == OWNER, "the NFT stays in the wallet");
        uint64 nonce = vault.stateNonce();
        uint256 owner0 = _balance(currency0, OWNER);
        uint256 owner1 = _balance(address(token1), OWNER);
        uint256 fee0 = _balance(currency0, RECIPIENT);
        uint256 fee1 = _balance(address(token1), RECIPIENT);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.ReservesWithdrawn(currency0, reserve0, nonce + 1);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.ReservesWithdrawn(address(token1), reserve1, nonce + 1);
        vm.prank(STRANGER);
        (uint256 paid0, uint256 paid1) = vault.returnReserves();
        _eq(paid0, reserve0, "paid0");
        _eq(paid1, reserve1, "paid1");
        _eq(_balance(currency0, OWNER) - owner0, reserve0, "reserve0 to the owner");
        _eq(_balance(address(token1), OWNER) - owner1, reserve1, "reserve1 to the owner");
        _eq(_balance(currency0, RECIPIENT), fee0, "no tariff0");
        _eq(_balance(address(token1), RECIPIENT), fee1, "no tariff1");
        _eq(vault.owedFees(currency0) + vault.owedFees(address(token1)), 0, "nothing owed either");
        _eq(vault.reserves(currency0) + vault.reserves(address(token1)), 0, "no reserves left");
        _eq(vault.idleReserves(currency0) + vault.idleReserves(address(token1)), 0, "no idle left");
        _noLots("no lots left");
        _eq(_balance(currency0, address(vault)) + _balance(address(token1), address(vault)), 0, "the vault is empty");
        _eq(vault.stateNonce(), nonce + 1, "one state change");
    }

    function testReturnsEveryReserveAfterTheOwnerBurnsTheRoot() public {
        (uint256 reserve0, uint256 reserve1) = _vaultWithReserves();
        _ownerBurnsRoot();
        (bool exists,) = manager.staticcall(abi.encodeWithSignature("ownerOf(uint256)", rootId));
        _true(!exists, "burned");
        uint256 owner0 = _balance(_currency0(), OWNER);
        uint256 owner1 = _balance(address(token1), OWNER);
        vm.prank(STRANGER);
        (uint256 paid0, uint256 paid1) = vault.returnReserves();
        _eq(paid0, reserve0, "paid0");
        _eq(paid1, reserve1, "paid1");
        _eq(_balance(_currency0(), OWNER) - owner0, reserve0, "reserve0 to the owner");
        _eq(_balance(address(token1), OWNER) - owner1, reserve1, "reserve1 to the owner");
        _eq(vault.reserves(_currency0()) + vault.reserves(address(token1)), 0, "no reserves left");
    }

    /// Only the owner can close a root; while it has liquidity, no one, the
    /// owner included, can use this way out.
    function testRefusedWhileTheRootHasLiquidity() public {
        (uint256 reserve0, uint256 reserve1) = _vaultWithReserves();
        uint64 nonce = vault.stateNonce();
        vm.prank(STRANGER);
        vm.expectRevert(IDominoVaultLedger.RootOpen.selector);
        vault.returnReserves();
        // A partial decrease leaves the root open.
        _ownerChangesRoot();
        _true(_liquidityOf(rootId) != 0, "still open");
        vm.prank(OPERATOR);
        vm.expectRevert(IDominoVaultLedger.RootOpen.selector);
        vault.returnReserves();
        vm.prank(OWNER);
        vm.expectRevert(IDominoVaultLedger.RootOpen.selector);
        vault.returnReserves();
        _eq(vault.reserves(_currency0()), reserve0, "reserve0 kept");
        _eq(vault.reserves(address(token1)), reserve1, "reserve1 kept");
        _eq(vault.stateNonce(), nonce + (_dex() == DominoV2Types.DEX_V4 ? 1 : 0), "only the v4 disarm changed state");
    }

    /// Successors keep compounding with the sequence's reserves (A14) while
    /// one is active; once the owner takes it back, its leftovers are idle
    /// and the closed vault returns everything.
    function testRefusedWhileASuccessorIsActive() public {
        uint256 child = _vaultWithSuccessor();
        _closeRoot();
        vm.prank(STRANGER);
        vm.expectRevert(IDominoVaultLedger.SuccessorActive.selector);
        vault.returnReserves();
        vm.prank(OWNER);
        vault.withdrawChild(child);
        uint256 reserve0 = vault.reserves(_currency0());
        uint256 reserve1 = vault.reserves(address(token1));
        _true(reserve0 + reserve1 > 0, "something to return");
        uint256 owner0 = _balance(_currency0(), OWNER);
        uint256 owner1 = _balance(address(token1), OWNER);
        vm.prank(STRANGER);
        (uint256 paid0, uint256 paid1) = vault.returnReserves();
        _eq(paid0, reserve0, "paid0");
        _eq(paid1, reserve1, "paid1");
        _eq(_balance(_currency0(), OWNER) - owner0, reserve0, "to the owner0");
        _eq(_balance(address(token1), OWNER) - owner1, reserve1, "to the owner1");
        _eq(vault.reserves(_currency0()) + vault.reserves(address(token1)), 0, "no reserves left");
    }

    /// Whoever calls, the owner alone is paid: the caller, the operator, the
    /// fee recipient, the exit module and a contract get nothing.
    function testPaysOnlyTheOwnerWhoeverCalls() public {
        (uint256 reserve0, uint256 reserve1) = _vaultWithReserves();
        _closeRoot();
        address currency0 = _currency0();
        address[5] memory callers = [STRANGER, OPERATOR, RECIPIENT, EXIT_MODULE, address(this)];
        uint256 owner0 = _balance(currency0, OWNER);
        uint256 owner1 = _balance(address(token1), OWNER);
        uint256 snapshot = cheats.snapshotState();
        for (uint256 i; i < callers.length; ++i) {
            _true(cheats.revertToState(snapshot), "back to the closed vault");
            address caller = callers[i];
            uint256 caller0 = _balance(currency0, caller);
            uint256 caller1 = _balance(address(token1), caller);
            vm.prank(caller);
            vault.returnReserves();
            _eq(_balance(currency0, caller), caller0, "the caller gets no token0");
            _eq(_balance(address(token1), caller), caller1, "the caller gets no token1");
            _eq(_balance(currency0, OWNER) - owner0, reserve0, "the owner gets reserve0");
            _eq(_balance(address(token1), OWNER) - owner1, reserve1, "the owner gets reserve1");
        }
    }

    /// A8, as exitAll pays: a token the owner cannot receive stays idle, the
    /// other is paid, and the call never reverts for it. A later call pays it.
    function testATokenTheOwnerCannotReceiveStaysIdle() public {
        (uint256 reserve0, uint256 reserve1) = _vaultWithReserves();
        _closeRoot();
        token1.setBlocked(OWNER, true);
        uint64 nonce = vault.stateNonce();
        uint256 owner0 = _balance(_currency0(), OWNER);
        vm.recordLogs();
        (uint256 paid0, uint256 paid1) = vault.returnReserves();
        _eq(_withdrawals(vm.getRecordedLogs()), 1, "one payment");
        _eq(paid0, reserve0, "token0 paid");
        _eq(paid1, 0, "token1 not");
        _eq(_balance(_currency0(), OWNER) - owner0, reserve0, "reserve0 to the owner");
        _eq(vault.idleReserves(address(token1)), reserve1, "reserve1 kept idle");
        _eq(vault.reserves(address(token1)), reserve1, "still the owner's reserve");
        _noLots("the root's lots became idle");
        _eq(vault.stateNonce(), nonce + 1, "one state change");
        token1.setBlocked(OWNER, false);
        uint256 owner1 = token1.balanceOf(OWNER);
        vm.prank(STRANGER);
        (paid0, paid1) = vault.returnReserves();
        _eq(paid0, 0, "nothing more in token0");
        _eq(paid1, reserve1, "token1 paid once the owner can receive it");
        _eq(token1.balanceOf(OWNER) - owner1, reserve1, "reserve1 to the owner");
        _eq(vault.reserves(address(token1)), 0, "nothing left");
        _eq(vault.stateNonce(), nonce + 2, "and one more");
    }

    /// Neither token can reach the owner: nothing is paid, but the root's lots
    /// still become idle (the owner's, never spent by automation), once.
    function testNothingTheOwnerCanReceiveStillRetiresTheRootsLots() public {
        (uint256 reserve0, uint256 reserve1) = _vaultWithReserves();
        _closeRoot();
        MockToken(_currency0()).setBlocked(OWNER, true);
        token1.setBlocked(OWNER, true);
        uint64 nonce = vault.stateNonce();
        vm.recordLogs();
        (uint256 paid0, uint256 paid1) = vault.returnReserves();
        _eq(paid0 + paid1, 0, "nothing paid");
        _eq(_vaultLogs(vm.getRecordedLogs()), 0, "nothing paid, nothing emitted");
        _eq(vault.idleReserves(_currency0()), reserve0, "idle0");
        _eq(vault.idleReserves(address(token1)), reserve1, "idle1");
        _noLots("the lots moved");
        _eq(vault.stateNonce(), nonce + 1, "the move is a state change");
        vault.returnReserves();
        _eq(vault.stateNonce(), nonce + 1, "nothing moves twice");
        _eq(vault.idleReserves(_currency0()) + vault.idleReserves(address(token1)), reserve0 + reserve1, "still idle");
    }

    /// Only the first token holds reserves: its payment alone is a state change.
    function testAPaymentInTheFirstTokenAloneAdvancesTheNonce() public {
        (uint256 reserve0, uint256 reserve1) = _vaultWithReserves();
        _closeRoot();
        vm.prank(OWNER);
        vault.withdrawReserves(address(token1), reserve1);
        uint64 nonce = vault.stateNonce();
        (uint256 paid0, uint256 paid1) = vault.returnReserves();
        _eq(paid0, reserve0, "token0 paid");
        _eq(paid1, 0, "nothing in token1");
        _eq(vault.stateNonce(), nonce + 1, "advanced");
    }

    /// Only the second token holds reserves: its move alone is a state change.
    function testAMoveInTheSecondTokenAloneAdvancesTheNonce() public {
        (, uint256 reserve1) = _vaultWithReserves();
        _closeRoot();
        // The owner takes token0's reserve itself; token1's cannot reach it.
        uint256 reserve0 = vault.reserves(_currency0());
        vm.prank(OWNER);
        vault.withdrawReserves(_currency0(), reserve0);
        token1.setBlocked(OWNER, true);
        uint64 nonce = vault.stateNonce();
        (uint256 paid0, uint256 paid1) = vault.returnReserves();
        _eq(paid0 + paid1, 0, "nothing paid");
        _eq(vault.idleReserves(address(token1)), reserve1, "token1's lot is idle");
        _eq(vault.stateNonce(), nonce + 1, "advanced");
    }

    function testASecondCallPaysNothingAndChangesNothing() public {
        _vaultWithReserves();
        _closeRoot();
        vault.returnReserves();
        uint64 nonce = vault.stateNonce();
        uint256 owner0 = _balance(_currency0(), OWNER);
        uint256 owner1 = _balance(address(token1), OWNER);
        vm.recordLogs();
        vm.prank(STRANGER);
        (uint256 paid0, uint256 paid1) = vault.returnReserves();
        _eq(paid0 + paid1, 0, "nothing paid");
        _eq(_vaultLogs(vm.getRecordedLogs()), 0, "nothing emitted");
        _eq(vault.stateNonce(), nonce, "no state change");
        _eq(_balance(_currency0(), OWNER), owner0, "owner0 unchanged");
        _eq(_balance(address(token1), OWNER), owner1, "owner1 unchanged");
    }

    /// The payout calls a token, and a token can call back: F1b's one lock
    /// refuses any vault entry point inside it, so the reserves are paid once.
    function testTheLockRefusesReentry() public {
        (uint256 reserve0, uint256 reserve1) = _vaultWithReserves();
        _closeRoot();
        token1.setHook(OWNER, address(vault), abi.encodeCall(IDominoVaultLedger.returnReserves, ()));
        uint256 owner0 = _balance(_currency0(), OWNER);
        uint256 owner1 = token1.balanceOf(OWNER);
        vm.prank(STRANGER);
        vault.returnReserves();
        _true(
            keccak256(token1.hookResult()) == keccak256(abi.encodeWithSelector(DominoActionLock.ReentrantCall.selector)),
            "the reentrant call was refused"
        );
        _eq(_balance(_currency0(), OWNER) - owner0, reserve0, "reserve0 paid once");
        _eq(token1.balanceOf(OWNER) - owner1, reserve1, "reserve1 paid once");
        _eq(vault.reserves(_currency0()) + vault.reserves(address(token1)), 0, "nothing left");
    }

    /// reserves() is idle plus the lots, recoverToken releases only what the
    /// vault holds beyond reserves and owed fees, before and after a return.
    function testTheLedgerStaysConsistentWithReservesAndRecoverToken() public {
        address currency0 = _currency0();
        rootId = _mintPosition(OWNER, LOWER, UPPER, LIQUIDITY);
        vault = _createVaultFor(rootId, DominoV2Types.MODE_SIMPLE, 1);
        _accrue(rootId, FEES, FEES);
        // The tariff in token1 cannot reach the recipient: it is owed (F1b).
        token1.setBlocked(RECIPIENT, true);
        Plan.PlanV1 memory p = _plan();
        p.amount0Max = ADD_CAP;
        p.amount1Max = ADD_CAP;
        _execute(p);
        uint256 owed1 = vault.owedFees(address(token1));
        _true(owed1 > 0, "a tariff is owed");
        uint256 reserve0 = vault.reserves(currency0);
        uint256 reserve1 = vault.reserves(address(token1));
        // A donation is unaccounted.
        token1.mint(address(vault), 7);
        _closeRoot();
        token1.setBlocked(OWNER, true);
        (uint256 paid0, uint256 paid1) = vault.returnReserves();
        _eq(paid0, reserve0, "reserve0 paid");
        _eq(paid1, 0, "reserve1 kept");
        _eq(vault.reserves(currency0), 0, "reserves0");
        _eq(_balance(currency0, address(vault)), vault.owedFees(currency0), "token0: only what is owed");
        _eq(vault.reserves(address(token1)), vault.idleReserves(address(token1)), "reserves1 are idle");
        _eq(vault.reserves(address(token1)), reserve1, "reserve1");
        _eq(token1.balanceOf(address(vault)), reserve1 + owed1 + 7, "token1: idle, owed and the donation");
        vm.prank(OWNER);
        vm.expectRevert(DominoV2VaultStorage.InsufficientReserves.selector);
        vault.recoverToken(address(token1), 8);
        token1.setBlocked(OWNER, false);
        uint256 owner1 = token1.balanceOf(OWNER);
        vm.prank(OWNER);
        vault.recoverToken(address(token1), 7);
        _eq(token1.balanceOf(OWNER) - owner1, 7, "the donation, recovered");
        _eq(vault.owedFees(address(token1)), owed1, "owed untouched");
        vm.prank(OWNER);
        vault.withdrawReserves(address(token1), reserve1);
        _eq(token1.balanceOf(OWNER) - owner1, 7 + reserve1, "the idle reserve, withdrawn");
        _eq(token1.balanceOf(address(vault)), owed1, "only the owed fee is left");
    }

    /// It never reads the registry: neither a pause nor the global halt holds
    /// the owner's money back.
    function testNeitherAPauseNorTheHaltHoldsItBack() public {
        (uint256 reserve0, uint256 reserve1) = _vaultWithReserves();
        _closeRoot();
        vm.prank(OPERATOR);
        vault.pause();
        registry.setHalted(true);
        (uint256 paid0, uint256 paid1) = vault.returnReserves();
        _eq(paid0, reserve0, "paid0");
        _eq(paid1, reserve1, "paid1");
    }

    /// No policy, arming or custody changes: only the reserves.
    function testItChangesNothingButTheReserves() public {
        _vaultWithReserves();
        vm.prank(OWNER);
        vault.setExitModule(EXIT_MODULE);
        _closeRoot();
        bytes32 before = keccak256(
            abi.encode(
                vault.policy(), vault.limits(), vault.paused(), vault.rootArmed(), vault.exitModule(),
                vault.positions(), vault.member(rootId), vault.lastExecutionAt(), vault.owner(), vault.root()
            )
        );
        vm.recordLogs();
        vault.returnReserves();
        VaultVm.Log[] memory logs = vm.getRecordedLogs();
        _eq(_withdrawals(logs), 2, "two payments");
        _eq(_vaultLogs(logs), 2, "and nothing else");
        bytes32 afterwards = keccak256(
            abi.encode(
                vault.policy(), vault.limits(), vault.paused(), vault.rootArmed(), vault.exitModule(),
                vault.positions(), vault.member(rootId), vault.lastExecutionAt(), vault.owner(), vault.root()
            )
        );
        _true(before == afterwards, "nothing else changed");
    }

    /// exitAll pays what it can and keeps the rest idle (A8); once the owner
    /// closes the root, anyone can retry what it could not pay.
    function testAfterExitAllItRetriesWhatTheOwnerCouldNotReceive() public {
        (, uint256 reserve1) = _vaultWithReserves();
        token1.setBlocked(OWNER, true);
        vm.prank(OWNER);
        vault.exitAll();
        _eq(vault.idleReserves(address(token1)), reserve1, "kept idle by exitAll");
        token1.setBlocked(OWNER, false);
        _closeRoot();
        uint256 owner1 = token1.balanceOf(OWNER);
        vm.prank(STRANGER);
        (, uint256 paid1) = vault.returnReserves();
        _eq(paid1, reserve1, "returned");
        _eq(token1.balanceOf(OWNER) - owner1, reserve1, "to the owner");
    }

    /// The auto-exit pays the root's lots to the owner, or keeps them idle
    /// (F4); the exited root has no liquidity, so the idle part comes back too.
    function testAfterAnAutoExitItReturnsWhatTheOwnerCouldNotReceive() public {
        (, uint256 reserve1) = _vaultWithReserves();
        vm.prank(OWNER);
        vault.setExitModule(EXIT_MODULE);
        token1.setBlocked(OWNER, true);
        vm.prank(EXIT_MODULE);
        vault.executeExit(rootId, _exitInstruction(0, 0));
        _eq(_liquidityOf(rootId), 0, "exited");
        _eq(vault.idleReserves(address(token1)), reserve1, "kept idle by the exit");
        token1.setBlocked(OWNER, false);
        uint256 owner1 = token1.balanceOf(OWNER);
        vm.prank(STRANGER);
        (, uint256 paid1) = vault.returnReserves();
        _eq(paid1, reserve1, "returned");
        _eq(token1.balanceOf(OWNER) - owner1, reserve1, "to the owner");
    }
}

/// The v3 unit model: the NonfungiblePositionManager mock under F1c's library.
contract DominoV2VaultReturnV3Test is ReturnSuite, HarnessV3 {
    function _closeRoot() internal override {
        uint128 liquidity = _liquidityOf(rootId);
        vm.prank(OWNER);
        npm.decreaseLiquidity(MockV3PositionManager.DecreaseLiquidityParams(rootId, liquidity, 0, 0, block.timestamp));
    }

    function _ownerBurnsRoot() internal override {
        _closeRoot();
        vm.startPrank(OWNER);
        npm.collect(MockV3PositionManager.CollectParams(rootId, OWNER, type(uint128).max, type(uint128).max));
        npm.burn(rootId);
        vm.stopPrank();
    }

    /// Only the manager's refusal of an unknown token counts as burned; any
    /// other failure to read the root (another reason, or none, as out of gas
    /// gives) leaves it open.
    function testOnlyTheManagersRefusalOfAnUnknownTokenIsABurn() public {
        _vaultWithReserves();
        bytes memory read = abi.encodeCall(IUniswapV3PositionManagerMinimal.positions, (rootId));
        vm.mockCallRevert(manager, read, abi.encodeWithSignature("Error(string)", "Invalid token"));
        vm.expectRevert(IDominoVaultLedger.RootOpen.selector);
        vault.returnReserves();
        vm.mockCallRevert(manager, read, "");
        vm.expectRevert(IDominoVaultLedger.RootOpen.selector);
        vault.returnReserves();
        vm.mockCallRevert(manager, read, abi.encodeWithSignature("Error(string)", "Invalid token ID"));
        vault.returnReserves();
    }
}

/// The NonfungiblePositionManager, factory and pool bytecode deployed on Base.
contract DominoV2VaultReturnV3BaseTest is ReturnSuite, HarnessV3Base {
    function _closeRoot() internal override {
        _ownerEmpties(rootId, false, false);
    }

    function _ownerBurnsRoot() internal override {
        _ownerEmpties(rootId, true, true);
    }

    /// The vault recognizes a burned v3 root by the deployed manager's own
    /// refusal, byte for byte: positions() of a token that does not exist.
    function testTheDeployedManagerRefusesAnUnknownTokenAsTheVaultExpects() public view {
        (bool ok, bytes memory data) =
            manager.staticcall(abi.encodeCall(IUniswapV3PositionManagerMinimal.positions, (type(uint96).max)));
        _true(!ok, "refused");
        _true(
            keccak256(data) == 0x0c8d4288bb9236adbada2de6e0bf1807631966685254b486e230ac9d8f0a9426,
            "DominoV2VaultV3.NO_SUCH_TOKEN"
        );
        _true(keccak256(data) == keccak256(abi.encodeWithSignature("Error(string)", "Invalid token ID")), "by name");
    }

    /// A position whose principal waits in tokensOwed is closed: the reserves
    /// are the vault's ledger, what the manager owes the owner is the owner's.
    function testAClosedRootWithPrincipalStillOwedIsClosed() public {
        (uint256 reserve0, uint256 reserve1) = _vaultWithReserves();
        _closeRoot();
        (,,,,,,,,,, uint128 owed0, uint128 owed1) = v3Manager.positions(rootId);
        _true(owed0 > 0 && owed1 > 0, "principal owed to the owner");
        (uint256 paid0, uint256 paid1) = vault.returnReserves();
        _eq(paid0, reserve0, "paid0");
        _eq(paid1, reserve1, "paid1");
        (,,,,,,,,,, uint128 still0, uint128 still1) = v3Manager.positions(rootId);
        _eq(uint256(still0) + still1, uint256(owed0) + owed1, "what the manager owes is untouched");
    }
}

/// The v4 PoolManager and PositionManager bytecode deployed on Base.
contract DominoV2VaultReturnV4Test is ReturnSuite, HarnessV4 {
    function _closeRoot() internal override {
        _modify(OWNER, rootId, -int256(uint256(_liquidityOf(rootId))));
    }

    function _ownerBurnsRoot() internal override {
        _burnRoot();
    }

    /// A failed read of the root's liquidity is never a closure: the call fails.
    function testAFailedReadIsNeverAClosure() public {
        _vaultWithReserves();
        _closeRoot();
        bytes memory read = abi.encodeCall(IV4PositionManagerMinimal.getPositionLiquidity, (rootId));
        vm.mockCallRevert(manager, read, "unavailable");
        vm.expectRevert(bytes("unavailable"));
        vault.returnReserves();
    }

    function testNativeReservesReturnToTheOwner() public {
        nativePair = true;
        (uint256 reserve0, uint256 reserve1) = _vaultWithReserves();
        _closeRoot();
        uint256 owner0 = OWNER.balance;
        vm.prank(STRANGER);
        (uint256 paid0, uint256 paid1) = vault.returnReserves();
        _eq(paid0, reserve0, "native paid");
        _eq(paid1, reserve1, "token1 paid");
        _eq(OWNER.balance - owner0, reserve0, "by call, to the owner");
        _eq(address(vault).balance, 0, "nothing left");
    }

    /// Native currency an owner refuses stays idle, as A8 keeps any token.
    function testNativeTheOwnerRefusesStaysIdle() public {
        nativePair = true;
        (uint256 reserve0, uint256 reserve1) = _vaultWithReserves();
        _closeRoot();
        vm.etch(OWNER, address(new ReturnNativeRefuser()).code);
        (uint256 paid0, uint256 paid1) = vault.returnReserves();
        _eq(paid0, 0, "refused");
        _eq(paid1, reserve1, "token1 paid");
        _eq(vault.idleReserves(address(0)), reserve0, "native kept idle");
        _eq(address(vault).balance, reserve0, "and held");
        vm.etch(OWNER, "");
        (paid0,) = vault.returnReserves();
        _eq(paid0, reserve0, "paid once the owner accepts it");
    }

    /// The owner's own wallet calling back on a native payment meets the lock.
    function testANativeCallbackMeetsTheLock() public {
        nativePair = true;
        (uint256 reserve0, uint256 reserve1) = _vaultWithReserves();
        _closeRoot();
        vm.etch(OWNER, address(new ReturnReentrantOwner(address(vault))).code);
        uint256 owner0 = OWNER.balance;
        uint256 owner1 = token1.balanceOf(OWNER);
        vm.prank(STRANGER);
        vault.returnReserves();
        _true(
            keccak256(ReturnReentrantOwner(payable(OWNER)).reentry())
                == keccak256(abi.encodeWithSelector(DominoActionLock.ReentrantCall.selector)),
            "the reentrant call was refused"
        );
        _eq(OWNER.balance - owner0, reserve0, "native paid once");
        _eq(token1.balanceOf(OWNER) - owner1, reserve1, "token1 paid once");
    }
}
