// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoVault} from "../../../src/v2/interfaces/IDominoVault.sol";
import {IDominoVaultLedger} from "../../../src/v2/interfaces/IDominoVaultLedger.sol";
import {DominoPositionMath} from "../../../src/v2/positions/DominoPositionMath.sol";
import {DominoV4Positions} from "../../../src/v2/positions/DominoV4Positions.sol";
import {FullMath} from "../../../src/v2/positions/uniswap/FullMath.sol";
import {DominoV2VaultBase} from "../../../src/v2/vault/DominoV2VaultBase.sol";
import {DominoV2VaultStorage} from "../../../src/v2/vault/DominoV2VaultStorage.sol";
import {DominoV2VaultExecutorV4, DominoV2VaultV4Hooks} from "../../../src/v2/vault/DominoV2VaultV4.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {VaultVm} from "./VaultHarness.sol";
import {HarnessV4, IV4PoolManagerTest} from "./VaultHarnessV4.sol";

contract NativeRefuser {
    receive() external payable {
        revert("no");
    }
}

contract NativeGasHog {
    uint256 public sink;

    receive() external payable {
        for (uint256 i; i < 1000; ++i) {
            sink += i;
        }
    }
}

/// The v4 vault's own paths on the PoolManager and PositionManager deployed
/// on Base: F1c's position steps inside the vault's own unlock, the fees the
/// PoolManager credits, native currency, the protocol fee in the swap floor,
/// successors, exits, the hooked-pool policy and the unlock callback guards.
/// Amounts come from the managers' own arithmetic (F1c's collectable and
/// DominoPositionMath), not from a model.
contract DominoV2VaultUniswapV4Test is HarnessV4 {
    bytes32 internal constant FEES_COLLECTED = keccak256("FeesCollected(uint256,uint256,uint256)");
    bytes32 internal constant IS_UNLOCKED_SLOT = 0xc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab23;
    bytes4 internal constant MINIMUM_AMOUNT = bytes4(keccak256("MinimumAmountInsufficient(uint128,uint128)"));
    uint256 internal constant SIMPLE_BPS = 200;

    function _tariff(uint256 gross) internal pure returns (uint256) {
        return gross * SIMPLE_BPS / 10_000;
    }

    function _locked() internal view returns (bool) {
        return poolManager.exttload(IS_UNLOCKED_SLOT) == bytes32(0);
    }

    /// The principal `liquidity` of the root pays out now, rounded down.
    function _principal(int24 lower, int24 upper, uint128 liquidity) internal view returns (uint256, uint256) {
        (uint160 price,,,) = DominoV4Positions.slot0(poolManager, _poolRef());
        return DominoPositionMath.amountsForLiquidity(price, lower, upper, liquidity, false);
    }

    function _setProtocolFee(uint24 fee) internal {
        IV4PoolManagerTest(address(poolManager)).setProtocolFeeController(address(this));
        IV4PoolManagerTest(address(poolManager)).setProtocolFee(_key(), fee);
    }

    // ============================================================ creation

    function testCreationReadsTheRootFromTheManagers() public {
        _domino(3);
        DominoV2Types.PoolRef memory pool = vault.pool();
        DominoV2Types.PoolRef memory expected = _poolRef();
        _true(keccak256(abi.encode(pool)) == keccak256(abi.encode(expected)), "pool");
        IDominoVaultLedger.Member memory root = vault.member(rootId);
        _true(root.active && root.tickLower == LOWER && root.tickUpper == UPPER, "range");
    }

    /// The owner has not decided on hooked pools (#283): refused by default.
    function testHookedPoolsAreRefused() public {
        hooks = address(uint160(0xC0FFEE) << 20);
        poolFee = 0x800000;
        rootId = _mintPosition(OWNER, LOWER, UPPER, ROOT_LIQUIDITY);
        _approveNft(OWNER, rootId, factory.predictVault(OWNER, 0));
        IDominoVault.Init memory init = _init(rootId, 1, 1);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(DominoV2VaultV4Hooks.HookedPool.selector, hooks));
        factory.createVault(init, 0);
    }

    // ============================================================ compound

    function testCompoundRunsInsideTheVaultsOwnUnlock() public {
        _simple();
        _accrue(rootId, 100_000, 100_000);
        (uint256 fees0, uint256 fees1) = _collectable(rootId);
        _true(fees0 > 99_000 && fees1 > 99_000, "fees accrued");
        uint128 before = _liquidityOf(rootId);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVaultLedger.FeesCollected(rootId, fees0, fees1);
        _execute(_plan());
        (uint128 left0,) = _lot(rootId, address(token0));
        (uint128 left1,) = _lot(rootId, address(token1));
        _eq(token0.balanceOf(RECIPIENT), _tariff(fees0 - left0), "tariff0 on what was consumed");
        _eq(token1.balanceOf(RECIPIENT), _tariff(fees1 - left1), "tariff1 on what was consumed");
        _eq(token0.balanceOf(address(vault)), left0, "the vault holds exactly its lots (0)");
        _eq(token1.balanceOf(address(vault)), left1, "the vault holds exactly its lots (1)");
        _true(left0 + left1 < 10, "the add took almost everything");
        _true(_liquidityOf(rootId) > before + 300_000, "added");
        (uint256 rest0, uint256 rest1) = _collectable(rootId);
        _eq(rest0 + rest1, 0, "nothing left to collect");
        _true(vault.rootArmed(), "the vault's own notifications did not disarm it");
        _true(_locked(), "the PoolManager is locked again");
    }

    /// A v4 increase credits the position's accrued fees to the caller: fees
    /// the plan's own swap accrued to the destination are collected into its
    /// lots first, so they are charged like any others.
    function testFeesAccruedDuringTheSwapAreCollectedBeforeTheAdd() public {
        _simple();
        _accrue(rootId, 2000, 0);
        config.set(8, 0);
        config.setHook(address(this), abi.encodeCall(this.donateFees, (7000, 7000)));
        uint256 share = FullMath.mulDiv(FullMath.mulDiv(7000, 1 << 128, ROOT_LIQUIDITY), ROOT_LIQUIDITY, 1 << 128);
        vm.recordLogs();
        _execute(_withSwap(_plan(), rootId, true, 970, 957));
        VaultVm.Log[] memory logs = vm.getRecordedLogs();
        uint256 collections;
        uint256 last0;
        uint256 last1;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == FEES_COLLECTED) {
                ++collections;
                (last0, last1) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
        _eq(collections, 2, "collected again after the swap");
        _eq(last0, share, "the swap's fees0");
        _eq(last1, share, "the swap's fees1");
        (uint256 rest0, uint256 rest1) = _collectable(rootId);
        _eq(rest0 + rest1, 0, "nothing settled unseen");
    }

    /// v4's protocol fee is taken before the LP fee and counts in the floor,
    /// per direction (zeroForOne in the low 12 bits): 1000 + 3000 - 3 pips.
    function testProtocolFeeCountsInTheFloorPerDirection() public {
        _simple();
        _setProtocolFee(1000);
        _accrue(rootId, 2_100_000, 0);
        // 1e6 * (1 - 0.003997) * (1 - 0.01) = 986042.97
        Plan.PlanV1 memory p = _withSwap(_plan(), rootId, true, 1_000_000, 986_041);
        vm.expectRevert(DominoV2VaultStorage.InvalidRoute.selector);
        _execute(p);
        _execute(_withSwap(_plan(), rootId, true, 1_000_000, 986_042));
        // The same fee oneForZero only leaves zeroForOne at 3000 pips: 987030.
        _setProtocolFee(1000 << 12);
        _accrue(rootId, 2_100_000, 0);
        vm.warp(block.timestamp + 600);
        p = _withSwap(_plan(), rootId, true, 1_000_000, 987_029);
        vm.expectRevert(DominoV2VaultStorage.InvalidRoute.selector);
        _execute(p);
        _execute(_withSwap(_plan(), rootId, true, 1_000_000, 987_030));
    }

    // ============================================================ native

    function testNativeCompoundPaysTheNativeTariff() public {
        nativePair = true;
        _simple();
        _accrue(rootId, 100_000, 100_000);
        (uint256 fees0,) = _collectable(rootId);
        _execute(_plan());
        (uint128 left0,) = _lot(rootId, address(0));
        _eq(RECIPIENT.balance, _tariff(fees0 - left0), "native tariff");
        _eq(address(vault).balance, left0, "the vault holds its native lot");
        _eq(vault.owedFees(address(0)), 0, "nothing owed");
        _true(vault.rootArmed(), "armed");
    }

    function testNativeTariffToARejectingRecipientIsOwed() public {
        nativePair = true;
        _simple();
        _accrue(rootId, 100_000, 100_000);
        (uint256 fees0, uint256 fees1) = _collectable(rootId);
        registry.setFeeRecipient(address(new NativeRefuser()));
        _execute(_plan());
        (uint128 left0,) = _lot(rootId, address(0));
        (uint128 left1,) = _lot(rootId, address(token1));
        uint256 owed = _tariff(fees0 - left0);
        _eq(vault.owedFees(address(0)), owed, "native owed");
        _eq(token1.balanceOf(registry.feeRecipient()), _tariff(fees1 - left1), "token1 paid");
        _eq(address(vault).balance, left0 + owed, "the lot and the owed fee stay in the vault");
    }

    function testNativeTariffToAGasHungryRecipientIsOwed() public {
        nativePair = true;
        _simple();
        _accrue(rootId, 100_000, 100_000);
        (uint256 fees0,) = _collectable(rootId);
        registry.setFeeRecipient(address(new NativeGasHog()));
        _execute(_plan());
        (uint128 left0,) = _lot(rootId, address(0));
        _eq(vault.owedFees(address(0)), _tariff(fees0 - left0), "native owed");
    }

    // ========================================================= successors

    /// Root [-600, 120) with the price at tick 0, inside the 5% trigger: the
    /// first successor is [0, 4200), floor at most 20% below the ceiling and
    /// ceiling the first tick 50% above it.
    function testSuccessorMintAndExitsOnTheDeployedManagers() public {
        rootId = _mintPosition(OWNER, -600, 120, ROOT_LIQUIDITY);
        vault = _createVaultFor(rootId, DominoV2Types.MODE_DOMINO, 3);
        _accrue(rootId, 100_000, 100_000);
        uint256 child = pm.nextTokenId();
        Plan.PlanV1 memory p = _plan();
        p.action = Plan.ACTION_MINT;
        p.tickLower = 0;
        p.tickUpper = 4200;
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.SuccessorCreated(rootId, child, 2);
        _execute(p);
        _true(pm.ownerOf(child) == address(vault), "successor held by the vault");
        _true(pm.subscriber(child) == address(0), "a held successor needs no subscription");
        uint128 childLiquidity = _liquidityOf(child);
        _true(childLiquidity > 0, "funded");
        _eq(vault.member(rootId).successor, child, "linked");
        vm.prank(OWNER);
        vault.setExitModule(EXIT_MODULE);
        (uint256 principal0, uint256 principal1) = _principal(0, 4200, childLiquidity);
        vm.prank(EXIT_MODULE);
        (uint256 amount0, uint256 amount1) = vault.executeExit(child, _exitInstruction(0, 0));
        _eq(amount0, principal0, "principal0 out");
        _eq(amount1, principal1, "principal1 out");
        _eq(token0.balanceOf(EXIT_MODULE), amount0, "to the module");
        _true(pm.ownerOf(child) == OWNER, "the empty successor goes to the owner");
        _eq(_liquidityOf(child), 0, "emptied");
        _true(!vault.member(child).active, "retired");
        vm.prank(EXIT_MODULE);
        vault.executeExit(rootId, _exitInstruction(0, 0));
        _eq(_liquidityOf(rootId), 0, "root emptied");
        _true(!vault.rootArmed(), "root disarmed by its exit");
        _true(pm.ownerOf(rootId) == OWNER, "the root stays with the owner");
        _true(_locked(), "the PoolManager is locked again");
    }

    // =============================================================== exits

    function testExitHonoursTheRemovalMinimums() public {
        _simple();
        vm.prank(OWNER);
        vault.setExitModule(EXIT_MODULE);
        (uint256 principal0, uint256 principal1) = _principal(LOWER, UPPER, ROOT_LIQUIDITY);
        bytes memory tooMuch = _exitInstruction(uint128(principal0 + 1), 0);
        vm.prank(EXIT_MODULE);
        vm.expectRevert(abi.encodeWithSelector(MINIMUM_AMOUNT, principal0 + 1, principal0));
        vault.executeExit(rootId, tooMuch);
        vm.prank(EXIT_MODULE);
        vault.executeExit(rootId, _exitInstruction(uint128(principal0), uint128(principal1)));
        _eq(token1.balanceOf(EXIT_MODULE), principal1, "exact principal");
    }

    function testNativeRootExit() public {
        nativePair = true;
        _simple();
        vm.prank(OWNER);
        vault.setExitModule(EXIT_MODULE);
        _accrue(rootId, 100_000, 60_000);
        (uint256 fees0, uint256 fees1) = _collectable(rootId);
        (uint256 principal0, uint256 principal1) = _principal(LOWER, UPPER, ROOT_LIQUIDITY);
        // The vault's own decrease is marked: the root is disarmed by the exit,
        // not by its own notification.
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootDisarmed(6, 3);
        vm.prank(EXIT_MODULE);
        (uint256 amount0, uint256 amount1) = vault.executeExit(rootId, _exitInstruction(0, 0));
        _eq(amount0, principal0 + fees0, "native principal and fees");
        _eq(amount1, principal1 + fees1, "principal1 and fees1");
        _eq(EXIT_MODULE.balance, principal0 + fees0, "native, by call, to the module");
        _eq(token1.balanceOf(EXIT_MODULE), principal1 + fees1, "token1 to the module");
        _eq(OWNER.balance + token1.balanceOf(OWNER), 0, "the root had no reserves");
        _eq(RECIPIENT.balance + token1.balanceOf(RECIPIENT), 0, "no automation tariff");
        _eq(address(vault).balance, 0, "nothing left");
    }

    // =========================================================== callbacks

    /// The PoolManager's callback reaches a position step only inside the
    /// vault's own unlock (otherwise the vault forwards it to the swap module,
    /// which authenticates it: DominoV2VaultSwapModule.t.sol).
    function testTheExecutorRunsAStepOnlyInsideTheVaultsUnlock() public {
        _simple();
        DominoV2VaultExecutorV4 executor = DominoV2VaultExecutorV4(vault.executor());
        vm.prank(address(poolManager));
        vm.expectRevert(DominoV2VaultStorage.UnexpectedCallback.selector);
        executor.unlockCallback(abi.encode(uint256(0)));
    }

    /// A token the vault pays inside its unlock may call back into the vault;
    /// it cannot run a position step there.
    function testATokenCannotRunAStepInsideTheVaultsUnlock() public {
        _simple();
        _accrue(rootId, 100_000, 100_000);
        token1.setHook(
            address(poolManager), address(vault), abi.encodeCall(DominoV2VaultBase.unlockCallback, (hex""))
        );
        _execute(_plan());
        _true(
            keccak256(token1.hookResult())
                == keccak256(abi.encodeWithSelector(DominoV2VaultStorage.UnexpectedCallback.selector)),
            "refused inside the unlock"
        );
        _true(vault.rootArmed() && _locked(), "the compound went through");
    }
}
