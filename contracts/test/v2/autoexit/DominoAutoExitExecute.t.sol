// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoAutoExit} from "../../../src/v2/interfaces/IDominoAutoExit.sol";
import {IDominoAutoExitExtension} from "../../../src/v2/interfaces/IDominoAutoExitExtension.sol";
import {IDominoFeeEvents, IDominoFeeSettlement} from "../../../src/v2/interfaces/IDominoFees.sol";
import {IDominoPriceAnchor} from "../../../src/v2/interfaces/IDominoPriceAnchor.sol";
import {DominoFeeLedger} from "../../../src/v2/fees/DominoFeeLedger.sol";
import {DominoActionLock} from "../../../src/v2/route/DominoActionLock.sol";
import {AutoExitFixture, VmAutoExit} from "./AutoExitFixture.sol";
import {GasBurner, MockPriceAnchor, MockVault, NativeBouncer, NativeRefuser} from "./AutoExitMocks.sol";

/// Execution: who may fire a mandate, when the anchor says it may fire, what
/// the vault must hand over, and where everything goes when someone cannot
/// receive (#283 S3; audit A1 for the fee recipient).
contract DominoAutoExitExecuteTest is AutoExitFixture {
    address private constant CLAIM_TO = address(0xC1A1);

    function _stop() private returns (IDominoAutoExit.Execution memory) {
        return _plan(_observation(pool, STOP));
    }

    function _refused(bytes32 mandateHash, IDominoAutoExit.Execution memory execution, bytes4 reason) private {
        vm.prank(OPERATOR);
        vm.expectRevert(reason);
        autoExit.execute(mandateHash, execution);
    }

    function _withNonce(uint256 nonce) private view returns (DominoV2Types.ExitMandate memory mandate) {
        mandate = _mandate();
        mandate.nonce = nonce;
    }

    function _refill(MockVault target, DominoV2Types.PoolRef memory ref, uint256 amount0, uint256 amount1) private {
        target.setPosition(TOKEN_ID, amount0, amount1);
        _fund(ref.currency0, address(target), amount0);
        _fund(ref.currency1, address(target), amount1);
    }

    function _nativePool() private view returns (DominoV2Types.PoolRef memory) {
        return _poolOf(DominoV2Types.DEX_V4, address(0), address(token1));
    }

    /// A vault on the native pool, the anchor at the stop, and the owner's mandate on it.
    function _nativeExit(uint256 amount0, uint256 amount1) private returns (MockVault nativeVault, bytes32 mandateHash) {
        DominoV2Types.PoolRef memory ref = _nativePool();
        nativeVault = _newVault(ref, amount0, amount1);
        anchor.setSpot(ref, STOP);
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.vault = address(nativeVault);
        mandateHash = _register(mandate);
    }

    // ------------------------------------------------------------ happy path
    function testOperatorExitsBothTokensAtTheStop() public {
        _fund(address(token1), address(vault), 5e17);
        vault.setReserve(address(token1), 5e17);
        bytes32 mandateHash = _register(_mandate());
        IDominoAutoExit.Execution memory execution = _stop();
        execution.amount0MinRemoved = uint128(HELD0);
        execution.amount1MinRemoved = uint128(HELD1);

        vm.recordLogs();
        (uint256 amount0, uint256 amount1) = _execute(mandateHash, execution);

        // token1 is the first charge currency: 20 bps of the whole position
        // valued at the anchor (1e18 * 4 + 4e18), all of it in token1.
        uint256 fee = 8e18 * 20 / 10_000;
        _eq(amount0, HELD0, "token0 whole");
        _eq(amount1, HELD1 - fee, "token1 net of the fee");
        _eq(token0.balanceOf(owner), HELD0, "owner token0");
        _eq(token1.balanceOf(owner), HELD1 - fee + 5e17, "owner token1 plus reserves, no fee on reserves");
        _eq(token1.balanceOf(FEE_RECIPIENT), fee, "fee paid");
        _eq(token0.balanceOf(FEE_RECIPIENT), 0, "no token0 fee");
        _eq(token0.balanceOf(address(autoExit)), 0, "nothing stays: token0");
        _eq(token1.balanceOf(address(autoExit)), 0, "nothing stays: token1");
        _eq(autoExit.mandateStatus(mandateHash), 3, "executed");

        (uint8 version, bytes32 instructed, address recipient, uint128 min0, uint128 min1) =
            abi.decode(vault.lastInstruction(), (uint8, bytes32, address, uint128, uint128));
        _eq(version, 1, "instruction version");
        _eq(instructed, mandateHash, "instruction mandate");
        _eq(recipient, address(autoExit), "withdrawal comes to the module");
        _eq(min0, HELD0, "minimum 0 forwarded");
        _eq(min1, HELD1, "minimum 1 forwarded");
        _eq(vault.lastTokenId(), TOKEN_ID, "the mandate's position");

        VmAutoExit.Log[] memory logs = vm.getRecordedLogs();
        _eq(_count(logs, address(autoExit), IDominoFeeEvents.FeeCharged.selector), 1, "one fee");
        _eq(_count(logs, address(autoExit), IDominoFeeEvents.FeeDeferred.selector), 0, "fee paid at once");
        _eq(_count(logs, address(autoExit), IDominoAutoExitExtension.DeliveryDeferred.selector), 0, "delivered");
        _eq(_count(logs, address(autoExit), IDominoAutoExit.MandateExecuted.selector), 1, "executed event");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(autoExit)) continue;
            if (logs[i].topics[0] == IDominoFeeEvents.FeeCharged.selector) {
                _eq(logs[i].topics[1], bytes32(uint256(DominoV2Types.FEE_KIND_AUTO_EXIT)), "fee kind");
                _eq(logs[i].topics[2], bytes32(uint256(uint160(address(token1)))), "fee token");
                _eq(logs[i].topics[3], bytes32(uint256(uint160(owner))), "fee payer");
                (uint256 charged, bytes32 ref) = abi.decode(logs[i].data, (uint256, bytes32));
                _eq(charged, fee, "fee amount");
                _eq(ref, mandateHash, "fee ref");
            }
            if (logs[i].topics[0] == IDominoAutoExit.MandateExecuted.selector) {
                _eq(logs[i].topics[1], mandateHash, "executed id");
                _eq(logs[i].topics[2], bytes32(uint256(uint160(owner))), "executed recipient");
                (uint160 price, uint256 out0, uint256 out1) = abi.decode(logs[i].data, (uint160, uint256, uint256));
                _eq(price, STOP, "anchor in the event");
                _eq(out0, amount0, "event amount0");
                _eq(out1, amount1, "event amount1");
            }
        }
    }

    // --------------------------------------------------------------- triggers
    function testTakeProfitFiresAtOrAboveItsTrigger() public {
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.triggerBelowSqrtPriceX96 = 0;
        mandate.triggerAboveSqrtPriceX96 = STOP;
        bytes32 mandateHash = _register(mandate);
        anchor.setSpot(pool, STOP - 1);
        _refused(mandateHash, _plan(_observation(pool, STOP - 1)), IDominoAutoExit.TriggerNotReached.selector);
        anchor.setSpot(pool, STOP);
        _execute(mandateHash, _stop());
        _eq(autoExit.mandateStatus(mandateHash), 3, "executed");
    }

    function testEitherTriggerOfABracketFires() public {
        uint160 high = 3 * Q96;
        DominoV2Types.ExitMandate memory bracket = _mandate();
        bracket.triggerAboveSqrtPriceX96 = high;
        bytes32 first = _register(bracket);
        anchor.setSpot(pool, high);
        _execute(first, _plan(_observation(pool, high)));

        bracket.nonce = 2;
        bytes32 second = _register(bracket);
        _refill(vault, pool, HELD0, HELD1);
        anchor.setSpot(pool, STOP);
        _execute(second, _stop());
        _eq(autoExit.mandateStatus(first), 3, "above fired");
        _eq(autoExit.mandateStatus(second), 3, "below fired");
    }

    function testInsideTheBracketNothingFires() public {
        DominoV2Types.ExitMandate memory bracket = _mandate();
        bracket.triggerAboveSqrtPriceX96 = 3 * Q96;
        bytes32 mandateHash = _register(bracket);
        anchor.setSpot(pool, STOP + 1);
        _refused(mandateHash, _plan(_observation(pool, STOP + 1)), IDominoAutoExit.TriggerNotReached.selector);
        anchor.setSpot(pool, 3 * Q96 - 1);
        _refused(mandateHash, _plan(_observation(pool, 3 * Q96 - 1)), IDominoAutoExit.TriggerNotReached.selector);
    }

    function testAnUnsetAboveTriggerNeverFires() public {
        bytes32 mandateHash = _register(_mandate());
        anchor.setSpot(pool, STOP + Q96);
        _refused(mandateHash, _plan(_observation(pool, STOP + Q96)), IDominoAutoExit.TriggerNotReached.selector);
    }

    /// The trigger reads the anchor. A spot pushed through the stop, with the
    /// anchor still above it (inside the band), fires nothing.
    function testAManipulatedSpotDoesNotFireTheExit() public {
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.maxSlippageBps = 300;
        bytes32 mandateHash = _register(mandate);
        uint160 fair = uint160(uint256(STOP) * 1005 / 1000);
        anchor.setSpot(pool, STOP - 1);
        _refused(mandateHash, _plan(_observation(pool, fair)), IDominoAutoExit.TriggerNotReached.selector);
    }

    // ------------------------------------------------------------- operator
    function testOnlyAnAdmittedOperatorExecutes() public {
        bytes32 mandateHash = _register(_mandate());
        IDominoAutoExit.Execution memory execution = _stop();
        address[3] memory others = [STRANGER, owner, address(vault)];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(IDominoAutoExit.Unauthorized.selector);
            autoExit.execute(mandateHash, execution);
        }
        vm.prank(GUARDIAN);
        registry.removeOperator(OPERATOR);
        _refused(mandateHash, execution, IDominoAutoExit.Unauthorized.selector);
    }

    /// The guardian's halt stops exits like every operator execution; the
    /// owner's own actions continue.
    function testHaltStopsExitsButNotTheOwner() public {
        bytes32 mandateHash = _register(_mandate());
        vm.prank(GUARDIAN);
        registry.haltAutomation();
        _refused(mandateHash, _stop(), IDominoAutoExitExtension.AutomationHalted.selector);
        registry.resumeAutomation();
        _execute(mandateHash, _stop());
    }

    // ---------------------------------------------------------------- status
    function testARevokedMandateNeverExecutes() public {
        bytes32 mandateHash = _register(_mandate());
        vm.prank(owner);
        autoExit.revokeMandate(mandateHash);
        _refused(mandateHash, _stop(), IDominoAutoExit.MandateNotActive.selector);
    }

    function testAnUnknownMandateNeverExecutes() public {
        _refused(keccak256("unknown"), _stop(), IDominoAutoExit.MandateNotActive.selector);
    }

    function testExpiryIsInclusive() public {
        DominoV2Types.ExitMandate memory mandate = _mandate();
        bytes32 lastSecond = _register(mandate);
        bytes32 late = _register(_withNonce(2));
        vm.warp(mandate.validUntil);
        _execute(lastSecond, _stop());
        _refill(vault, pool, HELD0, HELD1);
        vm.warp(uint256(mandate.validUntil) + 1);
        _refused(late, _stop(), IDominoAutoExit.MandateNotActive.selector);
    }

    function testFiresOnce() public {
        bytes32 mandateHash = _register(_mandate());
        _execute(mandateHash, _stop());
        _refill(vault, pool, HELD0, HELD1);
        _refused(mandateHash, _stop(), IDominoAutoExit.MandateNotActive.selector);
        _eq(vault.exits(), 1, "one exit");
    }

    function testOtherMandatesOnThePositionSurvive() public {
        bytes32 first = _register(_mandate());
        bytes32 second = _register(_withNonce(2));
        _execute(first, _stop());
        _eq(autoExit.mandateStatus(second), 1, "still active");
    }

    // ---------------------------------------------------------------- consent
    function testTheVaultMustStillEnableTheModule() public {
        bytes32 mandateHash = _register(_mandate());
        vm.prank(owner);
        vault.setExitModule(address(0));
        _refused(mandateHash, _stop(), IDominoAutoExitExtension.ExitModuleNotEnabled.selector);
        vm.prank(owner);
        vault.setExitModule(STRANGER);
        _refused(mandateHash, _stop(), IDominoAutoExitExtension.ExitModuleNotEnabled.selector);
    }

    function testANewVaultOwnerIsNotBoundByTheOldMandate() public {
        bytes32 mandateHash = _register(_mandate());
        vault.setOwner(STRANGER);
        _refused(mandateHash, _stop(), IDominoAutoExitExtension.VaultOwnerChanged.selector);
    }

    function testThePoolMustHaveTwoOrderedTokens() public {
        bytes32 mandateHash = _register(_mandate());
        vault.setPool(_poolOf(DominoV2Types.DEX_V4, address(token1), address(token1)));
        _refused(mandateHash, _stop(), IDominoAutoExit.InvalidMandate.selector);
        vault.setPool(_poolOf(DominoV2Types.DEX_V4, address(token1), address(token0)));
        _refused(mandateHash, _stop(), IDominoAutoExit.InvalidMandate.selector);
    }

    function testTheConversionTargetMustStillBeAPoolToken() public {
        bytes32 mandateHash = _register(_converted(address(token1)));
        // Ordered (the highest address is last), so only the target check refuses it.
        vault.setPool(_poolOf(DominoV2Types.DEX_V4, address(token0), address(type(uint160).max)));
        _refused(mandateHash, _stop(), IDominoAutoExit.InvalidMandate.selector);
    }

    // ----------------------------------------------------------------- anchor
    function testTheAnchorGetsTheModulesAgeAndTheMandatesBand() public {
        bytes32 mandateHash = _register(_mandate());
        bytes memory evidence = _observation(pool, STOP);
        vm.expectCall(address(anchor), abi.encodeCall(MockPriceAnchor.anchor, (pool, evidence, MAX_AGE, 100)));
        _execute(mandateHash, _plan(evidence));
    }

    function testAStaleObservationIsRefused() public {
        bytes32 mandateHash = _register(_mandate());
        bytes memory stale = _observationAt(pool, STOP, START - 200, START - 80);
        _refused(mandateHash, _plan(stale), IDominoPriceAnchor.ObservationExpired.selector);
    }

    function testAnObservationLongerThanTheModulesAgeIsRefused() public {
        bytes32 mandateHash = _register(_mandate());
        bytes memory longer = _observationAt(pool, STOP, START, START + MAX_AGE + 1);
        _refused(mandateHash, _plan(longer), IDominoPriceAnchor.ObservationExpired.selector);
        _execute(mandateHash, _plan(_observationAt(pool, STOP, START, START + MAX_AGE)));
    }

    function testAnObservationFromAnUnadmittedSignerIsRefused() public {
        bytes32 mandateHash = _register(_mandate());
        bytes memory forged = _observationBy(OTHER_KEY, pool, STOP, START, START + MAX_AGE);
        _refused(mandateHash, _plan(forged), IDominoPriceAnchor.InvalidObservation.selector);
    }

    function testARevokedOrVoidedObservationIsRefused() public {
        bytes32 mandateHash = _register(_mandate());
        DominoV2Types.PriceObservation memory point = DominoV2Types.PriceObservation({
            pool: pool,
            sqrtPriceX96: STOP,
            observedAt: START,
            validUntil: START + MAX_AGE,
            nonce: 1
        });
        bytes memory evidence = _observationAt(pool, STOP, START, START + MAX_AGE);
        bytes32 observationHash = anchor.hashObservation(point);
        vm.prank(publisher);
        anchor.revokeObservation(observationHash);
        _refused(mandateHash, _plan(evidence), IDominoPriceAnchor.ObservationRevoked.selector);

        bytes memory later = _observationAt(pool, STOP, START, START + MAX_AGE - 1);
        vm.warp(START + 10);
        vm.prank(GUARDIAN);
        registry.raiseObservationEpoch(START + 1);
        _refused(mandateHash, _plan(later), IDominoPriceAnchor.ObservationRevoked.selector);
    }

    function testAnUnreadablePoolBlocksTheExit() public {
        bytes32 mandateHash = _register(_mandate());
        anchor.setSpot(pool, 0);
        _refused(mandateHash, _stop(), MockPriceAnchor.PoolUnavailable.selector);
    }

    function testAnAnchorOutageBlocksTheExit() public {
        bytes32 mandateHash = _register(_mandate());
        anchor.setMode(anchor.DOWN());
        _refused(mandateHash, _stop(), MockPriceAnchor.AnchorDown.selector);
    }

    function testAZeroAnchorPriceIsRefused() public {
        bytes32 mandateHash = _register(_mandate());
        anchor.setMode(anchor.ZERO_PRICE());
        _refused(mandateHash, _stop(), IDominoAutoExitExtension.InvalidAnchor.selector);
    }

    /// The band between anchor and spot is the mandate's own slippage: a 1.4%
    /// gap stops a 1% mandate and passes a 2% one.
    function testTheSpotMustBeWithinTheMandatesSlippage() public {
        anchor.setSpot(pool, uint160(uint256(STOP) * 1007 / 1000));
        bytes32 tight = _register(_mandate());
        _refused(tight, _stop(), IDominoPriceAnchor.SpotOutsideBand.selector);
        DominoV2Types.ExitMandate memory loose = _withNonce(2);
        loose.maxSlippageBps = 200;
        _execute(_register(loose), _stop());
    }

    function testAV3TwapAnchorsAnExitOverTheMinimumWindow() public {
        DominoV2Types.PoolRef memory v3 = _poolOf(DominoV2Types.DEX_V3, address(token0), address(token1));
        MockVault v3Vault = _newVault(v3, HELD0, HELD1);
        anchor.setTwap(v3, STOP);
        anchor.setSpot(v3, STOP);
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.vault = address(v3Vault);
        bytes32 mandateHash = _register(mandate);
        _refused(mandateHash, _plan(abi.encode(uint32(MIN_TWAP - 1))), IDominoAutoExitExtension.TwapWindowTooShort.selector);
        bytes memory evidence = abi.encode(uint32(MIN_TWAP));
        vm.expectCall(address(anchor), abi.encodeCall(MockPriceAnchor.anchor, (v3, evidence, MIN_TWAP, 100)));
        _execute(mandateHash, _plan(evidence));
        _eq(autoExit.mandateStatus(mandateHash), 3, "executed");
    }

    /// The window's ceiling is an hour, inclusive (owner decision of 3 Oct 2026).
    function testAV3TwapWindowIsCappedAtAnHour() public {
        DominoV2Types.PoolRef memory v3 = _poolOf(DominoV2Types.DEX_V3, address(token0), address(token1));
        MockVault v3Vault = _newVault(v3, HELD0, HELD1);
        anchor.setTwap(v3, STOP);
        anchor.setSpot(v3, STOP);
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.vault = address(v3Vault);
        bytes32 mandateHash = _register(mandate);
        uint32 ceiling = autoExit.MAX_TWAP_SECONDS();
        _eq(ceiling, 3600, "an hour");
        _refused(mandateHash, _plan(abi.encode(ceiling + 1)), IDominoAutoExitExtension.TwapWindowTooLong.selector);
        _refused(mandateHash, _plan(abi.encode(type(uint32).max)), IDominoAutoExitExtension.TwapWindowTooLong.selector);
        bytes memory evidence = abi.encode(ceiling);
        vm.expectCall(address(anchor), abi.encodeCall(MockPriceAnchor.anchor, (v3, evidence, ceiling, 100)));
        _execute(mandateHash, _plan(evidence));
        _eq(autoExit.mandateStatus(mandateHash), 3, "executed");
    }

    // ------------------------------------------------------------------ vault
    function testTheVaultEnforcesTheOperatorsMinimums() public {
        bytes32 mandateHash = _register(_mandate());
        IDominoAutoExit.Execution memory execution = _stop();
        execution.amount0MinRemoved = uint128(HELD0 + 1);
        _refused(mandateHash, execution, MockVault.PriceSlippageCheck.selector);
    }

    /// A vault that reports the full removal but hands over less is caught by
    /// the module's own measurement against the minimums.
    function testAVaultThatWithholdsIsCaught() public {
        bytes32 mandateHash = _register(_mandate());
        vault.setWithhold(0, 1);
        IDominoAutoExit.Execution memory execution = _stop();
        execution.amount0MinRemoved = uint128(HELD0);
        execution.amount1MinRemoved = uint128(HELD1);
        _refused(mandateHash, execution, IDominoAutoExitExtension.BelowMinimum.selector);
        vault.setWithhold(1, 0);
        _refused(mandateHash, execution, IDominoAutoExitExtension.BelowMinimum.selector);
    }

    function testAnEmptyPositionEndsTheMandateWithoutCharge() public {
        vault.setPosition(TOKEN_ID, 0, 0);
        bytes32 mandateHash = _register(_mandate());
        vm.recordLogs();
        (uint256 amount0, uint256 amount1) = _execute(mandateHash, _stop());
        _eq(amount0 + amount1, 0, "nothing delivered");
        _eq(_count(vm.getRecordedLogs(), address(autoExit), IDominoFeeEvents.FeeCharged.selector), 0, "no fee");
        _eq(autoExit.mandateStatus(mandateHash), 3, "executed");
    }

    function testReceivingBothTakesNoLegs() public {
        bytes32 mandateHash = _register(_mandate());
        _refused(
            mandateHash,
            _plan(_observation(pool, STOP), _legs(_routerLeg(address(token0), address(token1), HELD0, 4e18))),
            IDominoAutoExitExtension.InvalidExecution.selector
        );
    }

    /// The vault calls back into each entry point during its exit; every one
    /// is refused and the exit itself completes.
    function testReentryIntoEveryEntryPointIsRefused() public {
        bytes32 target = _register(_withNonce(99));
        DominoV2Types.ExitMandate memory other = _withNonce(98);
        bytes[6] memory calls = [
            abi.encodeCall(IDominoAutoExit.execute, (target, _stop())),
            abi.encodeCall(IDominoAutoExit.registerMandate, (other, _sign(other, OWNER_KEY))),
            abi.encodeCall(IDominoAutoExit.revokeMandate, (target)),
            abi.encodeCall(IDominoAutoExitExtension.cancelNonce, (9)),
            abi.encodeCall(IDominoAutoExitExtension.claim, (address(token1), owner)),
            abi.encodeCall(IDominoFeeSettlement.flushOwedFees, (address(token1)))
        ];
        bytes32 refused = keccak256(abi.encodeWithSelector(DominoActionLock.ReentrantCall.selector));
        for (uint256 i; i < calls.length; ++i) {
            bytes32 mandateHash = _register(_withNonce(i + 1));
            vault.setReentry(address(autoExit), calls[i]);
            _execute(mandateHash, _stop());
            _true(vault.reentryAttempted() && !vault.reentryOk(), "reentry refused");
            _eq(keccak256(vault.reentryResult()), refused, "with ReentrantCall()");
            _refill(vault, pool, HELD0, HELD1);
        }
        _eq(autoExit.mandateStatus(target), 1, "the target was never touched");
    }

    function testNativeCurrencyArrivesOnlyDuringAnExecution() public {
        vm.deal(address(this), 1 ether);
        (bool ok, bytes memory reason) = address(autoExit).call{value: 1}("");
        _true(!ok, "refused");
        _eq(keccak256(reason), keccak256(abi.encodeWithSelector(IDominoAutoExit.Unauthorized.selector)), "reason");
    }

    // --------------------------------------------- owners who cannot receive
    /// An EIP-7702 owner whose delegate has no receive(): the exit completes,
    /// the native part waits, and the owner claims it to any address.
    function testNativeForAnOwnerWithoutReceiveWaitsForClaim() public {
        (, bytes32 mandateHash) = _nativeExit(HELD0, HELD1);
        vm.etch(owner, type(NativeRefuser).runtimeCode);
        vm.recordLogs();
        _execute(mandateHash, _plan(_observation(_nativePool(), STOP)));
        VmAutoExit.Log[] memory logs = vm.getRecordedLogs();
        _eq(_count(logs, address(autoExit), IDominoAutoExitExtension.DeliveryDeferred.selector), 1, "deferred");
        _eq(autoExit.unclaimed(owner, address(0)), HELD0, "native waits");
        _eq(address(autoExit).balance, HELD0, "held for the owner");
        _eq(token1.balanceOf(owner), HELD1 - 8e18 * 20 / 10_000, "token1 delivered");

        vm.prank(STRANGER);
        vm.expectRevert(IDominoAutoExitExtension.NothingToClaim.selector);
        autoExit.claim(address(0), STRANGER);
        vm.prank(owner);
        vm.expectRevert(IDominoAutoExitExtension.InvalidRecipient.selector);
        autoExit.claim(address(0), address(0));

        vm.recordLogs();
        vm.prank(owner);
        uint256 claimed = autoExit.claim(address(0), CLAIM_TO);
        _eq(claimed, HELD0, "claimed");
        _eq(CLAIM_TO.balance, HELD0, "paid where the owner chose");
        _eq(autoExit.unclaimed(owner, address(0)), 0, "cleared");
        _eq(_count(vm.getRecordedLogs(), address(autoExit), IDominoAutoExitExtension.Claimed.selector), 1, "claim event");
        vm.prank(owner);
        vm.expectRevert(IDominoAutoExitExtension.NothingToClaim.selector);
        autoExit.claim(address(0), CLAIM_TO);
    }

    /// Native currency is accepted only inside an execution: a claim
    /// recipient that sends it straight back is refused.
    function testAClaimRecipientCannotSendNativeBack() public {
        (, bytes32 mandateHash) = _nativeExit(HELD0, HELD1);
        vm.etch(owner, type(NativeRefuser).runtimeCode);
        _execute(mandateHash, _plan(_observation(_nativePool(), STOP)));
        NativeBouncer bouncer = new NativeBouncer();
        vm.prank(owner);
        autoExit.claim(address(0), address(bouncer));
        _true(bouncer.bounced() && !bouncer.bounceOk(), "bounce refused");
        _eq(address(bouncer).balance, HELD0, "claimed");
    }

    function testAFailedClaimKeepsTheCredit() public {
        (, bytes32 mandateHash) = _nativeExit(HELD0, HELD1);
        vm.etch(owner, type(NativeRefuser).runtimeCode);
        _execute(mandateHash, _plan(_observation(_nativePool(), STOP)));
        NativeRefuser refuser = new NativeRefuser();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IDominoAutoExitExtension.DeliveryMismatch.selector, address(0)));
        autoExit.claim(address(0), address(refuser));
        _eq(autoExit.unclaimed(owner, address(0)), HELD0, "credit kept");
    }

    function testAFrozenTokenDeliveryWaitsForClaim() public {
        token1.setTowards(owner, token1.REVERTS());
        bytes32 mandateHash = _register(_mandate());
        _execute(mandateHash, _stop());
        uint256 net = HELD1 - 8e18 * 20 / 10_000;
        _eq(autoExit.unclaimed(owner, address(token1)), net, "token1 waits");
        _eq(token0.balanceOf(owner), HELD0, "token0 delivered");
        vm.prank(owner);
        autoExit.claim(address(token1), CLAIM_TO);
        _eq(token1.balanceOf(CLAIM_TO), net, "claimed elsewhere");
    }

    function testATokenReportingFalseWaitsForClaim() public {
        token1.setTowards(owner, token1.RETURNS_FALSE());
        bytes32 mandateHash = _register(_mandate());
        _execute(mandateHash, _stop());
        _eq(autoExit.unclaimed(owner, address(token1)), HELD1 - 8e18 * 20 / 10_000, "token1 waits");
    }

    /// Delivery is measured on the module's balance, not on what the token
    /// says: a token that moves the amount and returns false has delivered.
    function testATokenThatMovesButReportsFailureHasDelivered() public {
        token1.setTowards(owner, token1.LIES());
        bytes32 mandateHash = _register(_mandate());
        _execute(mandateHash, _stop());
        _eq(token1.balanceOf(owner), HELD1 - 8e18 * 20 / 10_000, "delivered");
        _eq(autoExit.unclaimed(owner, address(token1)), 0, "no credit on top");
    }

    /// A token that takes more than the amount would spend what the module
    /// holds for others (owed fees, other credits): the exit is refused.
    function testATokenThatOverdebitsRefusesTheExit() public {
        token1.mint(address(autoExit), 1);
        token1.setTowards(owner, token1.OVERDEBITS());
        bytes32 mandateHash = _register(_mandate());
        IDominoAutoExit.Execution memory execution = _stop();
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(IDominoAutoExitExtension.DeliveryMismatch.selector, address(token1)));
        autoExit.execute(mandateHash, execution);
    }

    /// A native push to the owner gets a bounded share of gas: an owner whose
    /// receive() burns everything gets a credit, and the exit completes under
    /// a realistic transaction limit.
    function testAGasBurningOwnerCannotBlockAnExit() public {
        (, bytes32 mandateHash) = _nativeExit(HELD0, HELD1);
        vm.etch(owner, type(GasBurner).runtimeCode);
        IDominoAutoExit.Execution memory execution = _plan(_observation(_nativePool(), STOP));
        vm.prank(OPERATOR);
        autoExit.execute{gas: 1_000_000}(mandateHash, execution);
        _eq(autoExit.unclaimed(owner, address(0)), HELD0, "native credited");
        _eq(autoExit.mandateStatus(mandateHash), 3, "executed");
    }

    function testATokenWithoutReturnDataDelivers() public {
        token1.setNoReturnData(true);
        bytes32 mandateHash = _register(_mandate());
        _execute(mandateHash, _stop());
        _eq(token1.balanceOf(owner), HELD1 - 8e18 * 20 / 10_000, "delivered");
        _eq(token1.balanceOf(FEE_RECIPIENT), 8e18 * 20 / 10_000, "fee paid");
        _eq(autoExit.unclaimed(owner, address(token1)), 0, "nothing waits");
    }

    /// A zero amount is neither charged nor pushed: a single-sided position
    /// emits one fee and no deferred delivery for the empty side.
    function testZeroAmountsAreNeitherChargedNorDelivered() public {
        (, bytes32 mandateHash) = _nativeExit(0, HELD1);
        vm.etch(owner, type(NativeRefuser).runtimeCode);
        vm.recordLogs();
        _execute(mandateHash, _plan(_observation(_nativePool(), STOP)));
        VmAutoExit.Log[] memory logs = vm.getRecordedLogs();
        _eq(_count(logs, address(autoExit), IDominoFeeEvents.FeeCharged.selector), 1, "one fee");
        _eq(_count(logs, address(autoExit), IDominoAutoExitExtension.DeliveryDeferred.selector), 0, "no empty push");
    }

    // ------------------------------------------------------- fee recipient
    /// Native first in rank: the fee is native, the recipient refuses it, the
    /// exit completes and the fee stays owed until flushed.
    function testARecipientRefusingNativeLeavesTheFeeOwed() public {
        registry.setChargeCurrency(address(0), 1);
        registry.setChargeCurrency(address(token1), 2);
        registry.setFeeRecipient(address(new NativeRefuser()));
        (, bytes32 mandateHash) = _nativeExit(HELD0, HELD1);
        vm.recordLogs();
        _execute(mandateHash, _plan(_observation(_nativePool(), STOP)));
        uint256 fee = 2e18 * 20 / 10_000;
        _eq(autoExit.owedFees(address(0)), fee, "owed");
        _eq(_count(vm.getRecordedLogs(), address(autoExit), IDominoFeeEvents.FeeDeferred.selector), 1, "deferred");
        _eq(owner.balance, HELD0 - fee, "owner paid in full otherwise");

        vm.expectRevert(abi.encodeWithSelector(DominoFeeLedger.FeeTransferMismatch.selector, address(0)));
        autoExit.flushOwedFees(address(0));
        _eq(autoExit.owedFees(address(0)), fee, "still owed");

        registry.setFeeRecipient(FEE_RECIPIENT);
        vm.recordLogs();
        vm.prank(STRANGER);
        _eq(autoExit.flushOwedFees(address(0)), fee, "flushed");
        _eq(FEE_RECIPIENT.balance, fee, "recipient paid");
        _eq(autoExit.owedFees(address(0)), 0, "cleared");
        _eq(_count(vm.getRecordedLogs(), address(autoExit), IDominoFeeEvents.OwedFeesFlushed.selector), 1, "event");
    }

    /// The push gets a bounded share of gas: under a realistic transaction
    /// limit the exit still completes and the fee stays owed.
    function testAGasBurningRecipientCannotBlockAnExit() public {
        registry.setChargeCurrency(address(0), 1);
        registry.setFeeRecipient(address(new GasBurner()));
        (, bytes32 mandateHash) = _nativeExit(HELD0, HELD1);
        IDominoAutoExit.Execution memory execution = _plan(_observation(_nativePool(), STOP));
        vm.prank(OPERATOR);
        autoExit.execute{gas: 1_000_000}(mandateHash, execution);
        _eq(autoExit.owedFees(address(0)), 2e18 * 20 / 10_000, "owed");
        _eq(autoExit.mandateStatus(mandateHash), 3, "executed");
    }

    function testNoRecipientLeavesTheFeeOwed() public {
        registry.setChargeCurrency(address(0), 1);
        registry.setFeeRecipient(address(0));
        (, bytes32 mandateHash) = _nativeExit(HELD0, HELD1);
        _execute(mandateHash, _plan(_observation(_nativePool(), STOP)));
        uint256 fee = 2e18 * 20 / 10_000;
        _eq(autoExit.owedFees(address(0)), fee, "owed, not burned");
        _eq(address(autoExit).balance, fee, "held");
        vm.expectRevert(DominoFeeLedger.FeeRecipientUnavailable.selector);
        autoExit.flushOwedFees(address(0));
    }

    function testFlushingNothingIsANoOp() public {
        registry.setFeeRecipient(address(0));
        vm.recordLogs();
        _eq(autoExit.flushOwedFees(address(token1)), 0, "nothing owed");
        _eq(vm.getRecordedLogs().length, 0, "no event");
    }
}
