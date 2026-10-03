// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IUniswapV3PoolMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {IDominoAutoExit} from "../../../src/v2/interfaces/IDominoAutoExit.sol";
import {IDominoAutoExitExtension} from "../../../src/v2/interfaces/IDominoAutoExitExtension.sol";
import {IDominoPriceAnchor} from "../../../src/v2/interfaces/IDominoPriceAnchor.sol";
import {IDominoVault} from "../../../src/v2/interfaces/IDominoVault.sol";
import {DominoActionLock} from "../../../src/v2/route/DominoActionLock.sol";
import {DominoFeeLedger} from "../../../src/v2/fees/DominoFeeLedger.sol";
import {DominoSwapFloor} from "../../../src/v2/route/DominoSwapFloor.sol";
import {DominoTokenOps} from "../../../src/v2/route/DominoTokenOps.sol";
import {IPermit2AllowanceMinimal} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {IPositionNft, ZapVm} from "../zap/ZapTestKit.sol";
import {IIntegrationAutoExit, IIntegrationProbe} from "./IntegrationInterfaces.sol";
import {IntegrationWorld} from "./IntegrationWorld.sol";

/// @notice Auto-exit (F4) on the wired world: the owner's signed mandate, the
/// vault's consent, real swaps moving the pool across a trigger of the real
/// anchor, the vault's executeExit, the conversion and the 0.2% tariff.
abstract contract AutoExitJourney is IntegrationWorld {
    bytes32 private constant VAULT_EXITED = keccak256("ExitExecuted(address,uint256,uint256,uint256,uint64)");

    IIntegrationAutoExit internal autoExit;

    struct ExitAccounting {
        uint256 fee0;
        uint256 fee1;
        uint256 tariffs;
        uint256 gross0;
        uint256 gross1;
    }

    function setUp() public virtual override {
        super.setUp();
        autoExit = _autoExitModule();
        stack = _vaultStack(address(autoExit));
    }

    function _autoExitModule() internal returns (IIntegrationAutoExit module) {
        module = IIntegrationAutoExit(
            _deploy(
                abi.encodePacked(
                    vm.getCode("DominoAutoExit.sol:DominoAutoExit"),
                    abi.encode(_route(), address(priceAnchor), ANCHOR_MAX_AGE, ANCHOR_MIN_TWAP)
                )
            )
        );
        _check(module.registry() == address(registry) && module.priceAnchor() == address(priceAnchor), "module wiring");
    }

    // ============================================================= helpers

    function _mandate(uint160 below, uint160 above, uint8 mode, address convertTo, uint256 nonce)
        internal
        view
        returns (DominoV2Types.ExitMandate memory)
    {
        return DominoV2Types.ExitMandate(
            owner, address(vault), rootId, below, above, mode, convertTo, 1000, uint64(clock + 600), nonce
        );
    }

    /// Triggers 0.2% on either side of the market's current price.
    function _bothTriggers(uint8 mode, address convertTo) internal view returns (DominoV2Types.ExitMandate memory) {
        uint160 price = _spot(market);
        return _mandate(uint160(uint256(price) * 999 / 1000), uint160(uint256(price) * 1001 / 1000), mode, convertTo, 1);
    }

    function _register(DominoV2Types.ExitMandate memory m) internal returns (bytes32 id) {
        bytes32 expected = DominoV2Types.hashExitMandate(m);
        bytes memory signature = _signature(OWNER_KEY, DominoV2Types.digest(autoExit.domainSeparator(), expected));
        vm.prank(RELAYER);
        id = autoExit.registerMandate(m, signature);
        _check(id == expected && autoExit.mandateStatus(id) == 1, "owner-signed struct hash registered");
        _check(autoExit.nonceUsed(owner, m.nonce), "owner nonce consumed");
    }

    function _enable() internal {
        vm.prank(owner);
        vault.setExitModule(address(autoExit));
        _check(vault.exitModule() == address(autoExit), "the owner's second consent");
    }

    function _execution(uint160 price, DominoV2Types.SwapLeg[] memory legs)
        internal
        view
        returns (IDominoAutoExit.Execution memory e)
    {
        e.anchorEvidence = _evidence(market.pool, price);
        e.legs = legs;
        e.amount0MinRemoved = 1;
        e.amount1MinRemoved = 1;
    }

    /// Every unit of `from` into `to` (amountIn zero: all the module holds) through `pool`.
    function _convertAll(DominoV2Types.PoolRef memory pool, address from, address to)
        internal
        pure
        returns (DominoV2Types.SwapLeg[] memory)
    {
        return _oneLeg(_poolLeg(pool, from, to, 0, 1));
    }

    function _exit(bytes32 id, IDominoAutoExit.Execution memory e) internal returns (uint256, uint256) {
        vm.prank(OPERATOR);
        return autoExit.execute(id, e);
    }

    /// A real swap lifts the market's pool past the upper trigger.
    function _crossUpper(DominoV2Types.ExitMandate memory m) internal returns (uint160 price) {
        _trade(market, false, 1e20);
        price = _spot(market);
        _check(price >= m.triggerAboveSqrtPriceX96, "a real swap crosses the upper trigger");
    }

    function _prepare(Market memory m, uint8 mode, address convertTo)
        internal
        returns (bytes32 id, DominoV2Types.ExitMandate memory mandate, uint160 price)
    {
        _createVault(m, DominoV2Types.MODE_SIMPLE, -600, 600);
        mandate = _bothTriggers(mode, convertTo);
        id = _register(mandate);
        _enable();
        price = _crossUpper(mandate);
    }

    function _accounting(ZapVm.Log[] memory logs, bytes32 id) internal view returns (ExitAccounting memory a) {
        uint256 exits;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == VAULT_EXITED) {
                _check(address(uint160(uint256(logs[i].topics[1]))) == address(autoExit), "the vault pays the module");
                _eq(uint256(logs[i].topics[2]), rootId, "the vault exits the root");
                (a.gross0, a.gross1,) = abi.decode(logs[i].data, (uint256, uint256, uint64));
                ++exits;
            }
            if (logs[i].emitter != address(autoExit) || logs[i].topics[0] != FEE_CHARGED) continue;
            ++a.tariffs;
            _eq(uint256(logs[i].topics[1]), DominoV2Types.FEE_KIND_AUTO_EXIT, "only the auto-exit tariff");
            _check(address(uint160(uint256(logs[i].topics[3]))) == owner, "the owner pays it");
            (uint256 amount, bytes32 ref) = abi.decode(logs[i].data, (uint256, bytes32));
            _check(ref == id, "the tariff belongs to the mandate");
            address token = address(uint160(uint256(logs[i].topics[2])));
            if (token == market.pool.currency0) a.fee0 += amount;
            else if (token == market.pool.currency1) a.fee1 += amount;
            else revert Unexpected("tariff in a foreign currency");
        }
        _eq(exits, 1, "one full withdrawal");
        _check(a.gross0 > 0 && a.gross1 > 0, "both currencies withdrawn");
    }

    /// The module holds only backed debt and deferred deliveries, and no allowance.
    function _cleanModule() internal view {
        address[3] memory currencies = [address(base), address(quote), address(second)];
        for (uint256 i; i < 3; ++i) {
            address token = currencies[i];
            _eq(
                _balance(token, address(autoExit)),
                autoExit.owedFees(token) + autoExit.unclaimed(owner, token),
                "module holds only debt and claims"
            );
            _eq(_allowance(token, address(autoExit), PERMIT2), 0, "module Permit2 allowance cleared");
            (uint160 permitted,,) = IPermit2AllowanceMinimal(PERMIT2).allowance(address(autoExit), token, chain.router);
            _eq(permitted, 0, "module router allowance cleared");
        }
        _eq(address(autoExit).balance, 0, "module holds no native currency");
    }

    function _assertExited(bytes32 id) internal view {
        _eq(autoExit.mandateStatus(id), 3, "executed once");
        _eq(_liquidity(rootId), 0, "all of the real liquidity removed");
        _check(!vault.rootArmed() && IPositionNft(manager).ownerOf(rootId) == owner, "disarmed; the owner keeps the NFT");
        _ledgerBalanced();
        _cleanModule();
    }

    function _assertIntact(bytes32 id, uint128 liquidity) internal view {
        _eq(autoExit.mandateStatus(id), 1, "the mandate stays active");
        _eq(_liquidity(rootId), liquidity, "the position is untouched");
        _ledgerBalanced();
        _cleanModule();
    }

    // ============================================================ journeys

    function testSignedConvertedExitChargesTwentyBpsOnceAndDeliversExactly() public {
        (bytes32 id,, uint160 price) = _prepare(main, DominoV2Types.RECEIVE_CONVERTED, address(quote));
        IDominoAutoExit.Execution memory e = _execution(price, _convertAll(main.deep, address(base), address(quote)));
        uint256[3] memory before = _holdings(owner);
        vm.recordLogs();
        uint256 start = gasleft();
        (uint256 delivered0, uint256 delivered1) = _exit(id, e);
        _logGas(_dex() == DominoV2Types.DEX_V3 ? "v3 signed converted auto-exit" : "v4 signed converted auto-exit", start - gasleft());
        ExitAccounting memory a = _accounting(vm.getRecordedLogs(), id);
        uint256[3] memory now_ = _holdings(owner);
        _eq(delivered0, 0, "all of currency0 converted");
        _eq(now_[0], before[0], "no currency0 delivered");
        _eq(now_[1] - before[1], delivered1, "exact converted delivery");
        _eq(a.tariffs, 1, "one tariff, conversion included");
        _eq(a.fee0, 0, "nothing charged in the source currency");
        _eq(a.fee1, (delivered1 + a.fee1) * 20 / 10_000, "20 bps of the converted gross output");
        _eq(quote.balanceOf(FEE_RECIPIENT), a.fee1, "recipient paid exactly");
        _check(
            delivered1 + a.fee1 - a.gross1
                >= DominoSwapFloor.minimumOutput(a.gross0, price, true, _poolFeePips(main, true), 1000),
            "conversion above the anchor's floor"
        );
        _assertExited(id);
        vm.expectRevert(IDominoAutoExit.MandateNotActive.selector);
        _exit(id, e);
    }

    function testFallingPriceCrossesTheLowerTrigger() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        uint160 below = uint160(uint256(_spot(main)) * 999 / 1000);
        bytes32 id = _register(_mandate(below, 0, DominoV2Types.RECEIVE_BOTH, address(0), 1));
        _enable();
        uint128 liquidity = _liquidity(rootId);
        IDominoAutoExit.Execution memory early = _execution(_spot(main), _noLegs());
        vm.expectRevert(IDominoAutoExit.TriggerNotReached.selector);
        _exit(id, early);
        _assertIntact(id, liquidity);
        _trade(main, true, 1e20);
        uint160 price = _spot(main);
        _check(price <= below, "a real swap takes the pool under the lower trigger");
        vm.recordLogs();
        (uint256 delivered0, uint256 delivered1) = _exit(id, _execution(price, _noLegs()));
        ExitAccounting memory a = _accounting(vm.getRecordedLogs(), id);
        // main is led by its rank-1 currency1: the tariff is 20 bps of both
        // currencies valued in it at the anchor, taken from it.
        _eq(a.tariffs, 1, "one tariff");
        _eq(a.fee0, 0, "nothing charged in the unlisted currency");
        _eq(a.fee1, (a.gross1 + DominoSwapFloor.quote(a.gross0, price, true)) * 20 / 10_000, "20 bps led by currency1");
        _eq(delivered0, a.gross0, "currency0 delivered whole");
        _eq(delivered1, a.gross1 - a.fee1, "currency1 delivered net");
        _assertExited(id);
    }

    function testConversionBelowTheAnchorFloorIsRefused() public {
        (bytes32 id,, uint160 price) = _prepare(main, DominoV2Types.RECEIVE_CONVERTED, address(quote));
        uint128 liquidity = _liquidity(rootId);
        // Each leg meets its own minimum of one unit; the 1% pool with almost
        // no liquidity cannot pay what the anchor says the source is worth.
        IDominoAutoExit.Execution memory e = _execution(price, _convertAll(thin, address(base), address(quote)));
        vm.expectRevert(IDominoAutoExitExtension.BelowMinimum.selector);
        _exit(id, e);
        _assertIntact(id, liquidity);
        _exit(id, _execution(price, _convertAll(main.deep, address(base), address(quote))));
        _assertExited(id);
    }

    function testConversionIntoAnUnlistedCurrencyChargesEachWithdrawnCurrency() public {
        (bytes32 id,, uint160 price) = _prepare(main, DominoV2Types.RECEIVE_CONVERTED, address(base));
        uint256[3] memory before = _holdings(owner);
        vm.recordLogs();
        (uint256 delivered0, uint256 delivered1) =
            _exit(id, _execution(price, _convertAll(main.deep, address(quote), address(base))));
        ExitAccounting memory a = _accounting(vm.getRecordedLogs(), id);
        // No charge currency to convert into: 20 bps of each withdrawn
        // currency, taken before the conversion, and nothing on its output.
        _eq(a.tariffs, 2, "one tariff per withdrawn currency");
        _eq(a.fee0, a.gross0 * 20 / 10_000, "20 bps of the withdrawn currency0");
        _eq(a.fee1, a.gross1 * 20 / 10_000, "20 bps of the withdrawn currency1");
        uint256[3] memory now_ = _holdings(owner);
        _eq(delivered1, 0, "all of currency1 converted");
        _eq(now_[1], before[1], "no currency1 delivered");
        _eq(now_[0] - before[0], delivered0, "exact delivery in the unlisted currency");
        uint256 converted = delivered0 - (a.gross0 - a.fee0);
        _check(
            converted >= DominoSwapFloor.minimumOutput(a.gross1 - a.fee1, price, false, _poolFeePips(main, false), 1000),
            "conversion above the anchor's floor"
        );
        _assertExited(id);
    }

    function testReceiveBothOnTheInversePoolChargesCurrency0First() public {
        (bytes32 id,, uint160 price) = _prepare(inverse, DominoV2Types.RECEIVE_BOTH, address(0));
        vm.recordLogs();
        (uint256 delivered0, uint256 delivered1) = _exit(id, _execution(price, _noLegs()));
        ExitAccounting memory a = _accounting(vm.getRecordedLogs(), id);
        // (quote, second): the rank-1 currency is currency0, so it leads.
        uint256 due = (a.gross0 + DominoSwapFloor.quote(a.gross1, price, false)) * 20 / 10_000;
        _check(due <= a.gross0, "currency0 alone covers the tariff");
        _eq(a.tariffs, 1, "one tariff");
        _eq(a.fee0, due, "20 bps of both currencies valued in currency0");
        _eq(a.fee1, 0, "nothing charged in the rank-2 currency1");
        _eq(delivered0, a.gross0 - a.fee0, "currency0 delivered net");
        _eq(delivered1, a.gross1, "currency1 delivered whole");
        _eq(quote.balanceOf(FEE_RECIPIENT), due, "recipient paid exactly");
        _assertExited(id);
    }

    function testTwapAnchorsTheExitOnV3AndIsRefusedOnV4() public {
        if (_dex() == DominoV2Types.DEX_V3) IUniswapV3PoolMinimal(main.v3Pool).increaseObservationCardinalityNext(16);
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        DominoV2Types.ExitMandate memory m = _bothTriggers(DominoV2Types.RECEIVE_BOTH, address(0));
        bytes32 id = _register(m);
        _enable();
        uint128 liquidity = _liquidity(rootId);
        // The pool stays above the trigger long enough for its own history to cross it.
        _crossUpper(m);
        _advance(200);
        _trade(main, false, 1e12);
        IDominoAutoExit.Execution memory e = _execution(_spot(main), _noLegs());
        e.anchorEvidence = abi.encode(uint32(ANCHOR_MIN_TWAP - 1));
        vm.expectRevert(IDominoAutoExitExtension.TwapWindowTooShort.selector);
        _exit(id, e);
        e.anchorEvidence = abi.encode(uint32(120));
        if (_dex() == DominoV2Types.DEX_V4) {
            vm.expectRevert(IDominoPriceAnchor.TwapUnavailable.selector);
            _exit(id, e);
            _assertIntact(id, liquidity);
            return;
        }
        _exit(id, e);
        _assertExited(id);
    }

    function testTwoOwnerConsentsOperatorRevocationAndGlobalHalt() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        DominoV2Types.ExitMandate memory m = _bothTriggers(DominoV2Types.RECEIVE_BOTH, address(0));
        bytes32 digest = DominoV2Types.digest(autoExit.domainSeparator(), DominoV2Types.hashExitMandate(m));
        vm.expectRevert(IDominoAutoExitExtension.InvalidSignature.selector);
        autoExit.registerMandate(m, _signature(PUBLISHER_KEY, digest));
        _check(!autoExit.nonceUsed(owner, m.nonce), "an invalid signature consumes nothing");
        bytes32 id = _register(m);
        uint160 price = _crossUpper(m);
        IDominoAutoExit.Execution memory e = _execution(price, _noLegs());
        vm.expectRevert(IDominoAutoExitExtension.ExitModuleNotEnabled.selector);
        _exit(id, e);
        _enable();
        vm.expectRevert(IDominoAutoExit.Unauthorized.selector);
        vm.prank(STRANGER);
        autoExit.execute(id, e);
        vm.prank(owner);
        autoExit.revokeMandate(id);
        _eq(autoExit.mandateStatus(id), 2, "the owner revokes at once");
        vm.expectRevert(IDominoAutoExit.MandateNotActive.selector);
        _exit(id, e);
        m.nonce = 2;
        id = _register(m);
        vm.prank(GUARDIAN);
        registry.haltAutomation();
        vm.expectRevert(IDominoAutoExitExtension.AutomationHalted.selector);
        _exit(id, e);
        _eq(autoExit.mandateStatus(id), 1, "the halt consumes no mandate");
        _check(_liquidity(rootId) > 0 && vault.rootArmed(), "blocked actions keep the position");
        vm.prank(owner);
        autoExit.revokeMandate(id);
        _eq(autoExit.mandateStatus(id), 2, "the halt keeps the owner's revocation");
        _ledgerBalanced();
        _cleanModule();
    }

    function testSameBlockManipulatedSpotDoesNotTriggerUncrossedSignedAnchor() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        DominoV2Types.ExitMandate memory m = _bothTriggers(DominoV2Types.RECEIVE_BOTH, address(0));
        bytes32 id = _register(m);
        _enable();
        uint160 prior = _spot(main);
        uint128 liquidity = _liquidity(rootId);
        IDominoAutoExit.Execution memory e = _execution(prior, _noLegs());
        _crossUpper(m); // no warp: the spot is moved within the same block
        (uint160 anchored,) = priceAnchor.anchor(main.pool, e.anchorEvidence, ANCHOR_MAX_AGE, m.maxSlippageBps);
        _eq(anchored, prior, "the signed pre-manipulation anchor is still valid within the band");
        vm.expectRevert(IDominoAutoExit.TriggerNotReached.selector);
        _exit(id, e);
        _assertIntact(id, liquidity);
    }

    function testMaliciousCurrencyReentryIsAtomicAndDeferredFeeRemainsBacked() public {
        (bytes32 id,, uint160 price) = _prepare(main, DominoV2Types.RECEIVE_BOTH, address(0));
        IDominoAutoExit.Execution memory e = _execution(price, _noLegs());
        uint128 liquidity = _liquidity(rootId);
        // A currency whose transfer to the module calls back into it fails
        // that transfer: the vault's payment reverts and nothing moves.
        base.setHook(address(autoExit), abi.encodeCall(autoExit.execute, (id, e)));
        base.setHookRecipient(address(autoExit));
        vm.expectRevert(abi.encodeWithSelector(DominoTokenOps.TokenCallFailed.selector, address(base)));
        _exit(id, e);
        _assertIntact(id, liquidity);
        base.setHookRecipient(address(0));
        // A currency that calls back and lets the transfer finish meets the shared lock.
        IIntegrationProbe probe = _probe();
        probe.arm(address(autoExit), abi.encodeCall(autoExit.execute, (id, e)));
        base.setHook(address(probe), abi.encodeCall(probe.fire, ()));
        quote.setBlocked(FEE_RECIPIENT, true);
        vm.recordLogs();
        (uint256 delivered0, uint256 delivered1) = _exit(id, e);
        ExitAccounting memory a = _accounting(vm.getRecordedLogs(), id);
        _check(probe.calls() > 0 && probe.successes() == 0, "every nested execution failed");
        _check(probe.lastError() == DominoActionLock.ReentrantCall.selector, "refused by the shared lock");
        _eq(a.fee1, (a.gross1 + DominoSwapFloor.quote(a.gross0, price, true)) * 20 / 10_000, "20 bps led by currency1");
        _eq(delivered0, a.gross0, "currency0 delivered whole");
        _eq(delivered1, a.gross1 - a.fee1, "currency1 delivered net");
        _eq(autoExit.owedFees(address(quote)), a.fee1, "a refused push leaves backed debt");
        _eq(quote.balanceOf(FEE_RECIPIENT), 0, "the frozen recipient receives nothing");
        base.setHook(address(0), "");
        _assertExited(id);
        vm.expectRevert(abi.encodeWithSelector(DominoFeeLedger.FeeTransferMismatch.selector, address(quote)));
        autoExit.flushOwedFees(address(quote));
        _eq(autoExit.owedFees(address(quote)), a.fee1, "a failed flush keeps the debt");
        quote.setBlocked(FEE_RECIPIENT, false);
        vm.prank(STRANGER);
        _eq(autoExit.flushOwedFees(address(quote)), a.fee1, "anyone flushes the whole fee");
        _eq(quote.balanceOf(FEE_RECIPIENT), a.fee1, "paid exactly once after recovery");
        _cleanModule();
    }

    function testFrozenOwnerDeliveryBecomesExactClaimWithoutSpendingFees() public {
        (bytes32 id,, uint160 price) = _prepare(main, DominoV2Types.RECEIVE_BOTH, address(0));
        quote.setBlocked(owner, true);
        quote.setBlocked(FEE_RECIPIENT, true);
        uint256[3] memory before = _holdings(owner);
        (uint256 delivered0, uint256 credit) = _exit(id, _execution(price, _noLegs()));
        uint256[3] memory now_ = _holdings(owner);
        _eq(now_[0] - before[0], delivered0, "the unfrozen currency delivered exactly");
        _eq(now_[1], before[1], "the frozen owner receives no currency1");
        _eq(autoExit.unclaimed(owner, address(quote)), credit, "the owner holds a delivery credit");
        uint256 fee = autoExit.owedFees(address(quote));
        _check(credit > 0 && fee > 0, "credit and debt side by side");
        _assertExited(id);
        uint256 strangerBefore = quote.balanceOf(STRANGER);
        vm.prank(owner);
        _eq(autoExit.claim(address(quote), STRANGER), credit, "the owner claims the exact credit to an account it picks");
        _eq(quote.balanceOf(STRANGER) - strangerBefore, credit, "that account receives it");
        _eq(autoExit.unclaimed(owner, address(quote)), 0, "spent once");
        _eq(autoExit.owedFees(address(quote)), fee, "a claim cannot spend the debt");
        _cleanModule();
        quote.setBlocked(FEE_RECIPIENT, false);
        autoExit.flushOwedFees(address(quote));
        _cleanModule();
    }

    function testVaultWiredToAnotherAutoExitCannotRunTheMandate() public {
        // A second, real module, and a vault implementation built for it
        // instead of the module the owner signs for.
        IIntegrationAutoExit other = _autoExitModule();
        VaultStack memory miswired = _vaultStack(address(other));
        market = main;
        (vault, rootId) = _openVault(miswired, main, DominoV2Types.MODE_SIMPLE, -600, 600);
        DominoV2Types.ExitMandate memory m = _bothTriggers(DominoV2Types.RECEIVE_BOTH, address(0));
        bytes32 id = _register(m);
        uint128 liquidity = _liquidity(rootId);
        // The vault refuses the module the owner chose: it accepts only its own.
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vm.prank(owner);
        vault.setExitModule(address(autoExit));
        vm.prank(owner);
        vault.setExitModule(address(other));
        uint160 price = _crossUpper(m);
        IDominoAutoExit.Execution memory e = _execution(price, _noLegs());
        vm.expectRevert(IDominoAutoExitExtension.ExitModuleNotEnabled.selector);
        _exit(id, e);
        // And the module it is wired to never received the owner's mandate.
        vm.expectRevert(IDominoAutoExit.MandateNotActive.selector);
        vm.prank(OPERATOR);
        other.execute(id, e);
        _assertIntact(id, liquidity);
    }
}
