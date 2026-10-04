// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AnchorMath} from "../../../src/v2/anchor/AnchorMath.sol";
import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IUniswapV3PoolMinimal, IUniswapV3PositionManagerMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {IV4PositionManagerMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {IDominoPriceAnchor} from "../../../src/v2/interfaces/IDominoPriceAnchor.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {IDominoVault} from "../../../src/v2/interfaces/IDominoVault.sol";
import {IDominoVaultLedger} from "../../../src/v2/interfaces/IDominoVaultLedger.sol";
import {DominoActionLock} from "../../../src/v2/route/DominoActionLock.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {DominoV2VaultStorage} from "../../../src/v2/vault/DominoV2VaultStorage.sol";
import {IPositionNft, ZapVm} from "../zap/ZapTestKit.sol";
import {IIntegrationProbe} from "./IntegrationInterfaces.sol";
import {IntegrationWorld} from "./IntegrationWorld.sol";

/// @notice Automation (F3) on the wired world: the real factory, clone and
/// constructor-created executor, the operator's plans against the real price
/// anchor, router and pools, the tariff, custody and the owner's exits.
abstract contract VaultJourney is IntegrationWorld {
    bytes32 private constant RESERVES_WITHDRAWN = keccak256("ReservesWithdrawn(address,uint256,uint64)");

    /// The root's ledger and the tariff's two destinations before an execution.
    struct TariffMark {
        uint256 uncharged0;
        uint256 uncharged1;
        uint256 recipient0;
        uint256 recipient1;
        uint256 owed0;
        uint256 owed1;
    }

    function setUp() public virtual override {
        super.setUp();
        stack = _vaultStack(address(0));
    }

    function _markTariff() internal view returns (TariffMark memory t) {
        (address c0, address c1) = (market.pool.currency0, market.pool.currency1);
        (t.uncharged0, t.uncharged1) = (vault.lot(rootId, c0).uncharged, vault.lot(rootId, c1).uncharged);
        (t.recipient0, t.recipient1) = (_balance(c0, FEE_RECIPIENT), _balance(c1, FEE_RECIPIENT));
        (t.owed0, t.owed1) = (vault.owedFees(c0), vault.owedFees(c1));
    }

    /// The fees the root's collections moved into its lots during the recorded execution.
    function _collected(ZapVm.Log[] memory logs) internal view returns (uint256 amount0, uint256 amount1) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault) || logs[i].topics[0] != FEES_COLLECTED) continue;
            if (uint256(logs[i].topics[1]) != rootId) continue;
            (uint256 a0, uint256 a1) = abi.decode(logs[i].data, (uint256, uint256));
            (amount0, amount1) = (amount0 + a0, amount1 + a1);
        }
    }

    /// `bps` of the earned fees the execution consumed from the root's lots,
    /// once per currency: delivered to the fee recipient, or owed by the
    /// vault when the recipient refuses (`deferred`), never both.
    function _assertTariff(ZapVm.Log[] memory logs, TariffMark memory t, uint16 bps, bool deferred) internal view {
        (address c0, address c1) = (market.pool.currency0, market.pool.currency1);
        (uint256 collected0, uint256 collected1) = _collected(logs);
        uint256 tariff0 = (t.uncharged0 + collected0 - vault.lot(rootId, c0).uncharged) * bps / 10_000;
        uint256 tariff1 = (t.uncharged1 + collected1 - vault.lot(rootId, c1).uncharged) * bps / 10_000;
        _check(collected0 + collected1 > 0 && tariff0 + tariff1 > 0, "real trading fees consumed");
        uint256 paid0 = _balance(c0, FEE_RECIPIENT) - t.recipient0;
        uint256 paid1 = _balance(c1, FEE_RECIPIENT) - t.recipient1;
        uint256 owed0 = vault.owedFees(c0) - t.owed0;
        uint256 owed1 = vault.owedFees(c1) - t.owed1;
        _eq(deferred ? owed0 : paid0, tariff0, "currency0 tariff charged once");
        _eq(deferred ? paid0 : owed0, 0, "currency0 tariff not charged twice");
        _eq(deferred ? owed1 : paid1, tariff1, "currency1 tariff charged once");
        _eq(deferred ? paid1 : owed1, 0, "currency1 tariff not charged twice");
    }

    /// A compound whose budget spends at most 1e9 of each currency, so most earned fees stay as reserves.
    function _compoundLeavingReserves() internal {
        Plan.PlanV1 memory p = _plan();
        p.budgets[0] = Plan.Budget(rootId, 1e9, 1e9);
        _execute(p);
        _check(vault.reserves(market.pool.currency0) > 0 && vault.reserves(market.pool.currency1) > 0, "reserves left");
    }

    /// The owner takes all of the root's liquidity out on Uniswap, without the vault.
    function _closeRoot() internal {
        uint128 liquidity = _liquidity(rootId);
        vm.startPrank(owner);
        if (_dex() == DominoV2Types.DEX_V3) {
            IUniswapV3PositionManagerMinimal(manager).decreaseLiquidity(
                IUniswapV3PositionManagerMinimal.DecreaseLiquidityParams(rootId, liquidity, 0, 0, clock)
            );
            IUniswapV3PositionManagerMinimal(manager).collect(
                IUniswapV3PositionManagerMinimal.CollectParams(rootId, owner, type(uint128).max, type(uint128).max)
            );
        } else {
            _ownerV4Decrease(liquidity);
        }
        vm.stopPrank();
        _eq(_liquidity(rootId), 0, "the owner closed the root on Uniswap");
    }

    /// DECREASE_LIQUIDITY then TAKE_PAIR to the owner, as the owner's wallet sends it.
    function _ownerV4Decrease(uint128 liquidity) internal {
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(rootId, uint256(liquidity), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(market.pool.currency0, market.pool.currency1, owner);
        IV4PositionManagerMinimal(manager).modifyLiquidities(abi.encode(hex"0111", params), clock);
    }

    /// Whether `actual` runs `model`'s code: equal once `model`'s own
    /// address (the executor's SELF immutable) reads as `actual`'s.
    function _sameCodeBut(address actual, address model) internal view returns (bool) {
        bytes memory want = model.code;
        bytes memory got = actual.code;
        if (want.length != got.length) return false;
        bytes32 from = bytes32(uint256(uint160(model)));
        bytes32 to = bytes32(uint256(uint160(actual)));
        uint256 replaced;
        for (uint256 i; i + 32 <= want.length; ++i) {
            bytes32 word;
            assembly ("memory-safe") {
                word := mload(add(add(want, 0x20), i))
            }
            if (word == from) {
                assembly ("memory-safe") {
                    mstore(add(add(want, 0x20), i), to)
                }
                ++replaced;
                i += 31;
            }
        }
        return replaced != 0 && keccak256(want) == keccak256(got);
    }

    // ============================================================ journeys

    function testCloneAndConstructorCreatedExecutorCarryThisWorldsWiring() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        DominoV2VaultStorage.Deployment memory wired = vault.wiring();
        address model = _deploy(abi.encodePacked(vm.getCode(_executorArtifact()), abi.encode(wired)));
        _check(_sameCodeBut(vault.executor(), model), "the executor is this build, with this world's wiring");
        wired.swapModule = address(1);
        address other = _deploy(abi.encodePacked(vm.getCode(_executorArtifact()), abi.encode(wired)));
        _check(!_sameCodeBut(vault.executor(), other), "another swap module is another executor");
        if (_dex() == DominoV2Types.DEX_V4) {
            _check(IV4PositionManagerMinimal(manager).subscriber(rootId) == address(vault), "the clone subscribes to the root");
        }
    }

    function testSimpleCompoundThroughRouterDefersTariffTheOwnerCannotSpend() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        _accrueFees(main);
        base.setBlocked(FEE_RECIPIENT, true);
        quote.setBlocked(FEE_RECIPIENT, true);
        Plan.PlanV1 memory p = _plan();
        p.swap = Plan.Swap(
            rootId,
            true,
            1e12,
            _floor(main, 1e12, _spot(main), true, 100),
            _oneLeg(_routerLeg(address(base), address(quote), 1e12))
        );
        uint128 before = _liquidity(rootId);
        TariffMark memory t = _markTariff();
        vm.recordLogs();
        uint256 start = gasleft();
        _execute(p);
        _logGas(_dex() == DominoV2Types.DEX_V3 ? "v3 auto compound+router" : "v4 auto compound+router", start - gasleft());
        _assertTariff(vm.getRecordedLogs(), t, 200, true);
        _check(_liquidity(rootId) > before && vault.rootArmed(), "compounded, still armed");
        _ledgerBalanced();
        uint256 owed = vault.owedFees(address(base));
        _check(owed > 0, "deferred debt exists");
        vm.expectRevert(DominoV2VaultStorage.InsufficientReserves.selector);
        vm.prank(owner);
        vault.recoverToken(address(base), owed);
        uint256 reserve = vault.reserves(address(base));
        vm.expectRevert(DominoV2VaultStorage.InsufficientReserves.selector);
        vm.prank(owner);
        vault.withdrawReserves(address(base), reserve + owed, owner);
        _ledgerBalanced();
        base.setBlocked(FEE_RECIPIENT, false);
        quote.setBlocked(FEE_RECIPIENT, false);
        uint256 owedQuote = vault.owedFees(address(quote));
        vm.prank(STRANGER);
        _eq(vault.flushOwedFees(address(base)), owed, "anyone flushes the whole debt");
        vm.prank(STRANGER);
        vault.flushOwedFees(address(quote));
        _eq(base.balanceOf(FEE_RECIPIENT), owed, "recipient paid the deferred currency0 tariff");
        _eq(quote.balanceOf(FEE_RECIPIENT), owedQuote, "recipient paid the deferred currency1 tariff");
        _ledgerBalanced();
        start = gasleft();
        vm.prank(owner);
        vault.exitAll();
        _logGas(_dex() == DominoV2Types.DEX_V3 ? "v3 owner exitAll" : "v4 owner exitAll", start - gasleft());
        _check(!vault.rootArmed() && IPositionNft(manager).ownerOf(rootId) == owner, "exitAll: the root stays the owner's");
        _ledgerBalanced();
    }

    function testDirectDeepPoolCompoundDeliversTheTariff() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        _accrueFees(main);
        Plan.PlanV1 memory p = _plan();
        p.swap = Plan.Swap(
            rootId,
            true,
            1e12,
            _floor(main, 1e12, _spot(main), true, 100),
            _oneLeg(_poolLeg(main.deep, address(base), address(quote), 1e12, 1))
        );
        uint128 before = _liquidity(rootId);
        TariffMark memory t = _markTariff();
        vm.recordLogs();
        uint256 start = gasleft();
        _check(_execute(p) != bytes32(0), "executed through the pool's authenticated callback");
        _logGas(_dex() == DominoV2Types.DEX_V3 ? "v3 auto compound+direct pool" : "v4 auto compound+direct pool", start - gasleft());
        _assertTariff(vm.getRecordedLogs(), t, 200, false);
        _check(_liquidity(rootId) > before && vault.rootArmed(), "compounded, still armed");
        _ledgerBalanced();
    }

    function testOwnPoolSwapFeesAreCollectedBeforeTheAdd() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        _accrueFees(main);
        uint128 amountIn = 1e14;
        Plan.PlanV1 memory p = _plan();
        p.swap = Plan.Swap(
            rootId,
            true,
            amountIn,
            _floor(main, amountIn, _spot(main), true, 100),
            _oneLeg(_poolLeg(main.pool, address(base), address(quote), amountIn, 1))
        );
        TariffMark memory t = _markTariff();
        vm.recordLogs();
        _execute(p);
        ZapVm.Log[] memory logs = vm.getRecordedLogs();
        uint256 before;
        uint256 afterSwap;
        bool swapped;
        uint256 ownFee0;
        uint256 ownFee1;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault)) continue;
            if (logs[i].topics[0] == SWAPPED) swapped = true;
            if (logs[i].topics[0] != FEES_COLLECTED || uint256(logs[i].topics[1]) != rootId) continue;
            if (!swapped) {
                ++before;
            } else {
                ++afterSwap;
                (ownFee0, ownFee1) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
        _check(swapped, "the vault swapped through its own pool");
        _eq(before, 1, "collected once before the swap");
        if (_dex() == DominoV2Types.DEX_V4) {
            // The swap paid the root its share of the fee; an increase would
            // settle it unseen, so the vault collects it into the root's lots.
            _eq(afterSwap, 1, "v4: collected again after its own swap");
            _check(ownFee0 > 0 && ownFee1 == 0, "the fee its own currency0 swap paid the root");
        } else {
            // v3 pokes the new fees into tokensOwed and never settles them:
            // they wait in the position for the next collection.
            _eq(afterSwap, 0, "v3: no second collection");
            (,,,,,,,,,, uint128 owed0,) = IUniswapV3PositionManagerMinimal(manager).positions(rootId);
            _check(owed0 > 0, "v3: the own swap's fee stays owed to the root");
        }
        _assertTariff(logs, t, 200, false);
        _check(vault.rootArmed(), "its own steps keep the root armed");
        _ledgerBalanced();
    }

    function testAnchorOutsideTheOwnersBandIsRefused() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        _accrueFees(main);
        uint160 spot = _spot(main);
        uint64 nonce = vault.stateNonce();
        Plan.PlanV1 memory p = _plan();
        p.anchorEvidence = _evidence(main.pool, _scaled(spot, 10_300));
        vm.expectRevert(IDominoPriceAnchor.SpotOutsideBand.selector);
        _execute(p);
        p.anchorEvidence = _evidence(main.pool, _scaled(spot, 9_700));
        vm.expectRevert(IDominoPriceAnchor.SpotOutsideBand.selector);
        _execute(p);
        _check(vault.stateNonce() == nonce && vault.rootArmed(), "a refused plan changes nothing");
        // Within the owner's 2% the same compound runs.
        p.anchorEvidence = _evidence(main.pool, _scaled(spot, 10_190));
        _execute(p);
        _eq(vault.stateNonce(), nonce + 1, "executed inside the band");
        _ledgerBalanced();
    }

    function testAnchorNotSpotBoundsTheSwapFloor() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        _accrueFees(main);
        uint160 spot = _spot(main);
        uint128 amountIn = 1e12;
        Plan.PlanV1 memory p = _plan();
        // The anchor sits 1.5% above the spot, inside the band: a minimum the
        // spot would justify is under the anchor's floor.
        p.anchorEvidence = _evidence(main.pool, _scaled(spot, 10_150));
        p.swap = Plan.Swap(
            rootId,
            true,
            amountIn,
            _floor(main, amountIn, spot, true, 100),
            _oneLeg(_poolLeg(main.deep, address(base), address(quote), amountIn, 1))
        );
        vm.expectRevert(DominoV2VaultStorage.InvalidRoute.selector);
        _execute(p);
        p.anchorEvidence = _evidence(main.pool, spot);
        _execute(p);
        _ledgerBalanced();
    }

    function testOwnPoolSwapThatMovesTheSpotOutOfBandIsReanchored() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        _accrueFees(main);
        vm.prank(owner);
        vault.setLimits(IDominoVault.Limits(100, 50, ANCHOR_MAX_AGE, 5000));
        uint160 edge = _bandEdge(_spot(main), 50);
        uint128 amountIn = 1e12;
        Plan.PlanV1 memory p = _plan();
        // At the edge of the owner's 0.5% band the anchor passes the first
        // read; the vault's own swap lowers its pool, and the second read
        // must refuse the add.
        p.anchorEvidence = _evidence(main.pool, edge);
        p.swap = Plan.Swap(
            rootId,
            true,
            amountIn,
            _floor(main, amountIn, edge, true, 100),
            _oneLeg(_poolLeg(main.pool, address(base), address(quote), amountIn, 1))
        );
        vm.expectRevert(IDominoPriceAnchor.SpotOutsideBand.selector);
        _execute(p);
        // The same swap through the deep pool leaves the vault's pool where
        // it was: both reads pass.
        p.swap.legs = _oneLeg(_poolLeg(main.deep, address(base), address(quote), amountIn, 1));
        _execute(p);
        _ledgerBalanced();
    }

    function testDominoSuccessorChargesFourPercentThenExitAllReturnsTheNft() public {
        _createVault(main, DominoV2Types.MODE_DOMINO, -600, 120);
        _accrueFees(main);
        Plan.PlanV1 memory p = _plan();
        p.action = Plan.ACTION_MINT;
        p.tickLower = 0;
        p.tickUpper = 4200;
        TariffMark memory t = _markTariff();
        vm.recordLogs();
        uint256 start = gasleft();
        _execute(p);
        _logGas(_dex() == DominoV2Types.DEX_V3 ? "v3 Domino successor" : "v4 Domino successor", start - gasleft());
        _assertTariff(vm.getRecordedLogs(), t, 400, false);
        uint256 child = vault.member(rootId).successor;
        _check(child != 0 && IPositionNft(manager).ownerOf(child) == address(vault), "the clone holds the successor");
        _check(vault.member(child).parent == rootId && _liquidity(child) > 0, "successor linked and funded");
        _ledgerBalanced();
        vm.prank(owner);
        vault.exitAll();
        _check(IPositionNft(manager).ownerOf(child) == owner && !vault.member(child).active, "exitAll delivers the child");
        _ledgerBalanced();
    }

    function testInverseGeometrySuccessorFollowsTheAnchorNotTheSpot() public {
        // On (quote, second) the rank-1 currency is currency0: prices are
        // read as currency0 per currency1, and a root's ceiling is its lower tick.
        _createVault(inverse, DominoV2Types.MODE_DOMINO, -120, 600);
        _check(vault.quoteCurrency() == address(quote) && inverse.pool.currency0 == address(quote), "inverse geometry");
        _accrueFees(inverse);
        _tradeTo(inverse, AnchorMath.getSqrtPriceAtTick(300));
        Plan.PlanV1 memory p = _plan();
        p.action = Plan.ACTION_MINT;
        (p.tickLower, p.tickUpper) = (-4200, 0);
        // The spot (tick 300) is within the 5% trigger distance of the
        // ceiling; an anchor 1.5% away (tick 450), still inside the band, is not.
        p.anchorEvidence = _evidence(inverse.pool, AnchorMath.getSqrtPriceAtTick(450));
        vm.expectRevert(DominoV2VaultStorage.InvalidRoute.selector);
        _execute(p);
        // At the spot, the side a currency1-quoted vault would take is refused.
        p.anchorEvidence = _evidence(inverse.pool, _spot(inverse));
        (p.tickLower, p.tickUpper) = (600, 4740);
        vm.expectRevert(DominoV2VaultStorage.InvalidRoute.selector);
        _execute(p);
        (p.tickLower, p.tickUpper) = (-4200, 0);
        TariffMark memory t = _markTariff();
        vm.recordLogs();
        _execute(p);
        _assertTariff(vm.getRecordedLogs(), t, 400, false);
        uint256 child = vault.member(rootId).successor;
        IDominoVaultLedger.Member memory successor = vault.member(child);
        _check(child != 0 && IPositionNft(manager).ownerOf(child) == address(vault), "the clone holds the successor");
        _check(successor.tickLower == -4200 && successor.tickUpper == 0 && _liquidity(child) > 0, "below in ticks, above in price");
        _ledgerBalanced();
    }

    function testOwnerChangeDisarmsAndTransferUnsubscribes() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        if (_dex() == DominoV2Types.DEX_V3) {
            vm.prank(owner);
            IUniswapV3PositionManagerMinimal(manager).decreaseLiquidity(
                IUniswapV3PositionManagerMinimal.DecreaseLiquidityParams(rootId, 1, 0, 0, clock)
            );
            _check(_execute(_plan()) == bytes32(0), "a changed checkpoint disarms without spending");
        } else {
            vm.prank(owner);
            _ownerV4Decrease(1);
        }
        _check(!vault.rootArmed(), "the owner's own change disarms");
        _ledgerBalanced();
        vm.prank(owner);
        vault.rearm(true);
        _check(vault.rootArmed(), "the owner's consent rearms");
        vm.prank(owner);
        IPositionNft(manager).transferFrom(owner, STRANGER, rootId);
        if (_dex() == DominoV2Types.DEX_V4) {
            _check(
                IV4PositionManagerMinimal(manager).subscriber(rootId) == address(0) && !vault.rootArmed(),
                "a transfer unsubscribes and disarms"
            );
        } else {
            _check(_execute(_plan()) == bytes32(0) && !vault.rootArmed(), "v3: the checkpoint sees the transfer");
        }
        _ledgerBalanced();
    }

    function testExitAllHoldsTheLockAgainstPermissionlessReentry() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        _accrueFees(main);
        _compoundLeavingReserves();
        uint256 reserve = vault.reserves(address(base));
        IIntegrationProbe probe = _probe();
        probe.arm(address(vault), abi.encodeCall(vault.flushOwedFees, (address(base))));
        base.setHook(address(probe), abi.encodeCall(probe.fire, ()));
        base.setHookRecipient(owner);
        uint256 before = base.balanceOf(owner);
        vm.prank(owner);
        vault.exitAll();
        base.setHook(address(0), "");
        _eq(probe.calls(), 1, "the payout's transfer called back once");
        _check(probe.successes() == 0 && probe.lastError() == DominoActionLock.ReentrantCall.selector, "exitAll held the lock");
        _eq(base.balanceOf(owner) - before, reserve, "exitAll paid the reserve");
        _ledgerBalanced();
    }

    function testReturnReservesAfterTheOwnerClosesTheRootOnUniswap() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        _accrueFees(main);
        _compoundLeavingReserves();
        (address c0, address c1) = (main.pool.currency0, main.pool.currency1);
        (uint256 reserve0, uint256 reserve1) = (vault.reserves(c0), vault.reserves(c1));
        vm.expectRevert(IDominoVaultLedger.RootOpen.selector);
        vm.prank(STRANGER);
        vault.returnReserves();
        _closeRoot();
        uint256[3] memory ownerBefore = _holdings(owner);
        uint256[3] memory strangerBefore = _holdings(STRANGER);
        uint64 nonce = vault.stateNonce();
        vm.recordLogs();
        vm.prank(STRANGER);
        (uint256 paid0, uint256 paid1) = vault.returnReserves();
        _eq(paid0, reserve0, "currency0: every reserve");
        _eq(paid1, reserve1, "currency1: every reserve");
        uint256[3] memory ownerNow = _holdings(owner);
        uint256[3] memory strangerNow = _holdings(STRANGER);
        // main is (base, quote): currency0 is base, currency1 is quote.
        _eq(ownerNow[0] - ownerBefore[0], reserve0, "the owner received currency0");
        _eq(ownerNow[1] - ownerBefore[1], reserve1, "the owner received currency1");
        _check(
            strangerNow[0] == strangerBefore[0] && strangerNow[1] == strangerBefore[1],
            "whoever calls receives nothing"
        );
        _eq(_count(vm.getRecordedLogs(), address(vault), RESERVES_WITHDRAWN), 2, "one receipt per currency");
        _check(vault.reserves(c0) == 0 && vault.reserves(c1) == 0 && vault.stateNonce() == nonce + 1, "emptied, one change");
        vm.prank(STRANGER);
        (paid0, paid1) = vault.returnReserves();
        _check(paid0 == 0 && paid1 == 0 && vault.stateNonce() == nonce + 1, "nothing left: nothing changes");
        _ledgerBalanced();
    }

    function testTwapAnchorsTheCompoundOnV3AndIsRefusedOnV4() public {
        if (_dex() == DominoV2Types.DEX_V3) IUniswapV3PoolMinimal(main.v3Pool).increaseObservationCardinalityNext(16);
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        _accrueFees(main);
        _advance(100);
        _trade(main, true, 1e15);
        _advance(100);
        Plan.PlanV1 memory p = _plan();
        p.anchorEvidence = abi.encode(uint32(180));
        if (_dex() == DominoV2Types.DEX_V4) {
            vm.expectRevert(IDominoPriceAnchor.TwapUnavailable.selector);
            _execute(p);
            return;
        }
        // Windows outside [minTwapSeconds, the owner's maximum age] are refused.
        p.anchorEvidence = abi.encode(uint32(ANCHOR_MIN_TWAP - 1));
        vm.expectRevert(IDominoPriceAnchor.TwapUnavailable.selector);
        _execute(p);
        p.anchorEvidence = abi.encode(uint32(ANCHOR_MAX_AGE + 1));
        vm.expectRevert(IDominoPriceAnchor.TwapUnavailable.selector);
        _execute(p);
        // A same-block move of the spot earns no seconds in the oracle: the
        // pool's own history no longer agrees with it.
        uint256 snapshot = vm.snapshotState();
        _trade(main, true, 3e20);
        p.anchorEvidence = abi.encode(uint32(180));
        vm.expectRevert(IDominoPriceAnchor.SpotOutsideBand.selector);
        _execute(p);
        vm.revertToState(snapshot);
        TariffMark memory t = _markTariff();
        vm.recordLogs();
        _execute(p);
        _assertTariff(vm.getRecordedLogs(), t, 200, false);
        _ledgerBalanced();
    }

    function testGovernedOperatorAndPublisherReachTheVault() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        _accrueFees(main);
        address nextPublisher = vm.addr(NEXT_PUBLISHER_KEY);
        Plan.PlanV1 memory p = _plan();
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vm.prank(NEXT_OPERATOR);
        vault.execute(Plan.encode(p));
        p.anchorEvidence = _evidenceBy(NEXT_PUBLISHER_KEY, main.pool, _spot(main));
        vm.expectRevert(IDominoPriceAnchor.InvalidObservation.selector);
        _execute(p);
        bytes32 operatorChange =
            registry.scheduleChange(DominoV2Types.REGISTRY_OPERATOR, abi.encode(NEXT_OPERATOR, true));
        bytes32 publisherChange =
            registry.scheduleChange(DominoV2Types.REGISTRY_PUBLISHER, abi.encode(nextPublisher, true));
        _advance(TIMELOCK - 1);
        vm.expectRevert(IDominoRegistry.ChangeNotReady.selector);
        registry.executeChange(operatorChange);
        _advance(1);
        registry.executeChange(operatorChange);
        registry.executeChange(publisherChange);
        p = _plan();
        p.anchorEvidence = _evidenceBy(NEXT_PUBLISHER_KEY, main.pool, _spot(main));
        vm.prank(NEXT_OPERATOR);
        vault.execute(Plan.encode(p));
        // The guardian narrows at once: the removed operator is refused.
        vm.prank(GUARDIAN);
        registry.removeOperator(NEXT_OPERATOR);
        _advance(600);
        p = _plan();
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vm.prank(NEXT_OPERATOR);
        vault.execute(Plan.encode(p));
        _ledgerBalanced();
    }
}
