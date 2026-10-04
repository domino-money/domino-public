// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoAutoExit} from "../../../src/v2/interfaces/IDominoAutoExit.sol";
import {IDominoAutoExitExtension} from "../../../src/v2/interfaces/IDominoAutoExitExtension.sol";
import {IDominoFeeEvents, IDominoFeeSettlement} from "../../../src/v2/interfaces/IDominoFees.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoPriceAnchor} from "../../../src/v2/interfaces/IDominoPriceAnchor.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {DominoActionLock} from "../../../src/v2/route/DominoActionLock.sol";
import {DominoSwapFloor} from "../../../src/v2/route/DominoSwapFloor.sol";
import {MockVault, NativeRefuser} from "../autoexit/AutoExitMocks.sol";
import {ScriptedRouter} from "../route/RouteAdversaries.sol";
import {AutoExitAdversarialWorld} from "./AutoExitAdversarialWorld.sol";

/// Targeted attacks on the auto-exit module (#283 S3) from the audit's attack
/// map, on Base's deployed Uniswap with the real registry, anchor and module
/// (AutoExitAdversarialWorld). Each test asserts the documented behaviour;
/// where that behaviour is a deliberate design choice, the comment cites the
/// line of docs/v2/F4_AUTO_EXIT.md ("F4") or docs/v2/F1_REGISTRY_ANCHOR.md
/// ("F1") that makes it one. The vault's own side (pause, exitAll, its halt
/// check) runs on the real vault in AutoExitVaultAttacks.t.sol.
contract DominoAutoExitAttacksTest is AutoExitAdversarialWorld {
    function setUp() public {
        _buildWorld();
    }

    function _stop(MockVault vault, address owner, uint256 key, uint160 below, uint16 slippage, uint256 nonce)
        private
        returns (bytes32)
    {
        return _register(
            _mandate(owner, address(vault), below, 0, DominoV2Types.RECEIVE_BOTH, address(0), slippage, nonce), key
        );
    }

    // ================================================= the TWAP window

    /// p3's oracle history: price one from the pool's opening at START, 0.85
    /// for two hours, then price one again for the last hour. Returns a stop
    /// at 0.95.
    function _dipAndRecovery() private returns (uint160 stop) {
        _advance(60);
        _moveTo(p3, _scaled(PRICE_ONE, 8500));
        _advance(2 hours);
        _moveTo(p3, PRICE_ONE);
        _advance(1 hours);
        stop = _scaled(PRICE_ONE, 9500);
    }

    /// The owner's decision of 3 Oct 2026: a v3 TWAP may span at most an hour
    /// (MAX_TWAP_SECONDS). Before it, the operator's window had no ceiling and
    /// the module passed it to the anchor as the age bound, so a stop signed an
    /// hour after the price came back above it fired at once on a 6,500 s
    /// window reaching into the earlier dip, though the price never crossed
    /// after the signature and the 600 s floor window saw no crossing. Now that
    /// window is refused (TwapWindowTooLong), and the longest one allowed, an
    /// hour, sees only the recovery: the stop waits for a real crossing.
    function testATwapWindowAboveAnHourIsRefusedSoAStaleDipNeverFiresAStop() public {
        uint160 stop = _dipAndRecovery();
        uint160 spot = _spot(p3);
        _eq(spot, PRICE_ONE, "the spot has stood above the stop for an hour");
        bytes32 id = _stop(vaultA, ownerA, OWNER_A_KEY, stop, 1000, 1);
        _check(anchor.twapSqrtPrice(p3, MIN_TWAP) > stop, "the floor window sees no crossing");
        _refused(id, _plan(_twap(MIN_TWAP)), IDominoAutoExit.TriggerNotReached.selector);
        // 2,900 s of the dip and 3,600 s of the recovery: the stale window is refused.
        uint160 stale = anchor.twapSqrtPrice(p3, 6500);
        _check(stale <= stop && _withinBand(stale, spot, 1000), "a stale anchor under the stop, inside the band");
        _refused(id, _plan(_twap(6500)), IDominoAutoExitExtension.TwapWindowTooLong.selector);
        _refused(id, _plan(_twap(3601)), IDominoAutoExitExtension.TwapWindowTooLong.selector);
        // The longest window allowed sees only the recovery.
        _check(anchor.twapSqrtPrice(p3, 3600) > stop, "an hour sees no crossing");
        _refused(id, _plan(_twap(3600)), IDominoAutoExit.TriggerNotReached.selector);
        _eq(autoExit.mandateStatus(id), 1, "the stop is still active, unspent");
    }

    /// The bounds on the operator's window: the module's 600 s floor
    /// (TwapWindowTooShort, F4 line 71), its one-hour ceiling
    /// (TwapWindowTooLong, the owner's decision of 3 Oct 2026) and the band
    /// of the mandate's own slippage around the anchor the window yields
    /// (SpotOutsideBand, F4 line 80). The pool's oracle history
    /// (TwapUnavailable, F1 line 124) is past the ceiling here: a window it
    /// would refuse is refused first by the module. None of the refusals
    /// spends a mandate.
    function testATwapWindowIsBoundedByTheFloorTheCeilingAndTheBand() public {
        uint160 stop = _dipAndRecovery();
        bytes32 wide = _stop(vaultA, ownerA, OWNER_A_KEY, stop, 1000, 1);
        bytes32 tight = _stop(vaultA, ownerA, OWNER_A_KEY, stop, 500, 2);
        _refused(wide, _plan(_twap(MIN_TWAP - 1)), IDominoAutoExitExtension.TwapWindowTooShort.selector);
        // Past an hour, whatever the window would yield, the module refuses it first.
        _refused(wide, _plan(_twap(3 hours)), IDominoAutoExitExtension.TwapWindowTooLong.selector);
        _refused(tight, _plan(_twap(6500)), IDominoAutoExitExtension.TwapWindowTooLong.selector);
        // Within the hour, an anchor farther from the spot than a mandate's
        // slippage is the anchor's refusal: ten minutes 2% under the spot
        // leave a 1% mandate's band, not a 5% one's (whose stop they miss).
        bytes32 narrow = _stop(vaultA, ownerA, OWNER_A_KEY, stop, 100, 3);
        _moveTo(p3, _scaled(PRICE_ONE, 9800));
        _advance(MIN_TWAP);
        _moveTo(p3, PRICE_ONE);
        uint160 recent = anchor.twapSqrtPrice(p3, MIN_TWAP);
        _check(!_withinBand(recent, _spot(p3), 100) && _withinBand(recent, _spot(p3), 500), "outside 1%, inside 5%");
        _refused(narrow, _plan(_twap(MIN_TWAP)), IDominoPriceAnchor.SpotOutsideBand.selector);
        _refused(tight, _plan(_twap(MIN_TWAP)), IDominoAutoExit.TriggerNotReached.selector);
        // The module decodes the window as a uint32, the anchor reads the whole
        // word: a word with high bits set is refused by the module's own ABI
        // decoder (no revert data; the anchor would have said TwapUnavailable)
        // before the two could read different windows.
        IDominoAutoExit.Execution memory dirty = _plan(abi.encodePacked(bytes32((uint256(1) << 255) | 3600)));
        vm.prank(OPERATOR);
        (bool ok, bytes memory reason) = address(autoExit).call(abi.encodeCall(IDominoAutoExit.execute, (wide, dirty)));
        _check(!ok && reason.length == 0, "refused by the module's decoder");
        _eq(
            autoExit.mandateStatus(wide) + autoExit.mandateStatus(tight) + autoExit.mandateStatus(narrow),
            3,
            "no mandate is spent"
        );
    }

    /// The same freedom also sets the conversion's floor, which F4 computes
    /// against the anchor (lines 137-144: "quote(source at the anchor) × (1 −
    /// poolFee) × (1 − maxSlippageBps)"; "81% of the anchor value"), while the
    /// band lets the anchor sit up to the mandate's slippage away from the spot
    /// (line 80). An operator that picks a window putting the anchor at the
    /// band's edge under the spot, and routes through a router paying exactly
    /// the floor, stacks the two: with a 1% mandate on a 0.3% pool the owner's
    /// token0 is sold at 97.8% of its spot value, against the 98.7% the floor
    /// would demand at an anchor equal to the spot. Accepted by the letter of
    /// F4 (the floor is "against the anchor"; line 198 bounds a compromised
    /// operator by "the slippage tolerance of the exit it executes"), pinned
    /// here so the compounding is explicit.
    function testAnAnchorAtTheBandsEdgeStacksTheBandOnTheFloor() public {
        // p3: price one, 0.98 for two hours, price one for the last half hour.
        _advance(60);
        _moveTo(p3, _scaled(PRICE_ONE, 9800));
        _advance(2 hours);
        _moveTo(p3, PRICE_ONE);
        _advance(30 minutes);
        uint160 spot = _spot(p3);
        uint160 stop = _scaled(PRICE_ONE, 9950);
        bytes32 id = _register(
            _mandate(ownerA, address(vaultA), stop, 0, DominoV2Types.RECEIVE_CONVERTED, address(token1), 100, 1),
            OWNER_A_KEY
        );
        // About 1,580 s of the dip in a 3,383 s window: the anchor just inside a 1% band.
        uint32 window = 3383;
        uint160 edge = anchor.twapSqrtPrice(p3, window);
        _check(edge < stop && _withinBand(edge, spot, 100), "an anchor at the band's edge, under the stop");
        uint256 floor = DominoSwapFloor.minimumOutput(HELD0, edge, true, 3000, 100);
        uint256 atSpot = DominoSwapFloor.minimumOutput(HELD0, spot, true, 3000, 100);
        (, uint256 amount1) =
            _execute(id, _plan(_twap(window), _legs(_routerLeg(address(token0), address(token1), HELD0, floor))));
        uint256 gross = HELD1 + floor;
        _eq(amount1, gross - gross * 20 / 10_000, "converted at the floor of the edge anchor");
        uint256 value = DominoSwapFloor.quote(HELD0, spot, true);
        // Sold at 97.77% of the spot value; the floor at the spot is 98.70%.
        _check(floor * 10_000 < value * 9_780 && floor * 10_000 > value * 9_770, "97.7-97.8% of the spot value");
        _check(atSpot * 10_000 > value * 9_869, "the floor at the spot is 98.7%");
    }

    /// A v4 pool has no oracle: TWAP evidence for a v4 vault fails closed (F4 line 82; F1 line 124).
    function testATwapForAV4VaultFailsClosed() public {
        bytes32 id = _stop(vaultB, ownerB, OWNER_B_KEY, PRICE_ONE, 1000, 1);
        _advance(1 hours);
        _refused(id, _plan(_twap(MIN_TWAP)), IDominoPriceAnchor.TwapUnavailable.selector);
        _eq(autoExit.mandateStatus(id), 1, "not spent");
    }

    // ============================================ stale observations

    /// The price falls through B's 5% stop on p4: the stop and the low spot.
    function _fallThrough() private returns (uint160 stop, uint160 low) {
        stop = _scaled(PRICE_ONE, 9500);
        _moveTo(p4, _scaled(PRICE_ONE, 9400));
        low = _spot(p4);
    }

    /// Every stale or misshapen observation is refused by the anchor and
    /// spends nothing: expired, a validity longer than the module's 300 s,
    /// dated in the future, signed for another pool or by a key the registry
    /// never admitted (F4 lines 72 and 81; F1 lines 94-107).
    function testStaleOrMisshapenObservationsAreRefusedAndSpendNothing() public {
        (uint160 stop, uint160 low) = _fallThrough();
        bytes32 id = _stop(vaultB, ownerB, OWNER_B_KEY, stop, 100, 1);
        bytes memory signedThen = _fresh(p4, low);
        _advance(MAX_AGE + 1);
        _refused(id, _plan(signedThen), IDominoPriceAnchor.ObservationExpired.selector);
        _refused(
            id,
            _plan(_signed(PUBLISHER_KEY, _point(p4, low, clock, clock + MAX_AGE + 1))),
            IDominoPriceAnchor.ObservationExpired.selector
        );
        _refused(
            id,
            _plan(_signed(PUBLISHER_KEY, _point(p4, low, clock + 1, clock + 1 + MAX_AGE))),
            IDominoPriceAnchor.InvalidObservation.selector
        );
        _refused(
            id, _plan(_signed(PUBLISHER_KEY, _point(pn, low, clock, clock + MAX_AGE))), IDominoPriceAnchor.InvalidObservation.selector
        );
        _refused(
            id, _plan(_signed(OUTSIDER_KEY, _point(p4, low, clock, clock + MAX_AGE))), IDominoPriceAnchor.InvalidObservation.selector
        );
        _eq(autoExit.mandateStatus(id), 1, "nothing spent");
        _execute(id, _plan(_fresh(p4, low)));
        _eq(autoExit.mandateStatus(id), 3, "a fresh observation fires it");
    }

    /// An observation anchors for its whole validity, at most the module's
    /// 300 s (F4 line 81; F1 line 107: the window rule bounds the age at use).
    /// Signed while the price was through the stop, it still fires a stop
    /// after the price came back above it, as long as the spot stands within
    /// the mandate's band of it (F4 line 80); outside the band, or once
    /// expired, it does not.
    function testAStillValidObservationFiresAfterARecoveryOnlyWithinTheBand() public {
        (uint160 stop, uint160 low) = _fallThrough();
        bytes32 first = _stop(vaultB, ownerB, OWNER_B_KEY, stop, 300, 1);
        bytes32 second = _stop(vaultW, address(wallet), WALLET_SIGNER_KEY, stop, 300, 1);
        bytes memory signedLow = _fresh(p4, low);
        _advance(200);
        _moveTo(p4, _scaled(PRICE_ONE, 9600));
        _check(_spot(p4) > stop && _withinBand(low, _spot(p4), 300), "recovered above the stop, inside a 3% band");
        vm.recordLogs();
        _execute(first, _plan(signedLow));
        (uint160 used,) = _executedAnchor(vm.getRecordedLogs());
        _eq(used, low, "fired on the observation signed before the recovery");
        _moveTo(p4, _scaled(PRICE_ONE, 9800));
        _refused(second, _plan(signedLow), IDominoPriceAnchor.SpotOutsideBand.selector);
        _moveTo(p4, _scaled(PRICE_ONE, 9600));
        _advance(MAX_AGE - 200 + 1);
        _refused(second, _plan(signedLow), IDominoPriceAnchor.ObservationExpired.selector);
        _eq(autoExit.mandateStatus(second), 1, "the second stop is not spent");
    }

    // ===================== a publisher rotation between signing and execution

    /// The guardian raises the observation epoch between the publisher's
    /// signature and the operator's execution: the observation is void
    /// (IDominoRegistry: "Observations with observedAt below this timestamp
    /// are void everywhere"), the refusal spends nothing, and an observation
    /// made after the epoch fires the mandate.
    function testAnEpochRaisedBetweenSigningAndExecutionVoidsTheObservation() public {
        (uint160 stop, uint160 low) = _fallThrough();
        bytes32 id = _stop(vaultB, ownerB, OWNER_B_KEY, stop, 100, 1);
        bytes memory signedBefore = _fresh(p4, low);
        _advance(1);
        vm.prank(GUARDIAN);
        registry.raiseObservationEpoch(uint64(clock));
        _refused(id, _plan(signedBefore), IDominoPriceAnchor.ObservationRevoked.selector);
        _eq(autoExit.mandateStatus(id), 1, "nothing spent");
        _execute(id, _plan(_fresh(p4, low)));
        _eq(autoExit.mandateStatus(id), 3, "an observation made after the epoch fires it");
    }

    /// A full rotation: the guardian removes the publisher at once and
    /// governance admits its successor through the timelock. The old key's
    /// observations, signed before or after its removal, are refused; the
    /// successor's fire the mandate, which the refusals did not spend.
    function testARotatedOutPublisherCannotFireAndItsSuccessorCan() public {
        (uint160 stop, uint160 low) = _fallThrough();
        bytes32 id = _stop(vaultB, ownerB, OWNER_B_KEY, stop, 100, 1);
        bytes memory signedBefore = _fresh(p4, low);
        vm.prank(GUARDIAN);
        registry.removePublisher(vm.addr(PUBLISHER_KEY));
        _refused(id, _plan(signedBefore), IDominoPriceAnchor.InvalidObservation.selector);
        _refused(id, _plan(_fresh(p4, low)), IDominoPriceAnchor.InvalidObservation.selector);
        _governed(DominoV2Types.REGISTRY_PUBLISHER, abi.encode(vm.addr(NEXT_PUBLISHER_KEY), true));
        _refused(id, _plan(_fresh(p4, low)), IDominoPriceAnchor.InvalidObservation.selector);
        _execute(id, _plan(_signed(NEXT_PUBLISHER_KEY, _point(p4, low, clock, clock + MAX_AGE))));
        _eq(autoExit.mandateStatus(id), 3, "the successor's observation fires it");
    }

    /// The epoch only voids the past. An observation a key in doubt dated
    /// after the epoch survives it (DominoRegistry.raiseObservationEpoch: it
    /// "can void the past but never block observations made from now on"),
    /// within its 300 s; only the key's removal voids it. F4 line 76: a
    /// guardian halts when a publisher key is in doubt.
    function testAnObservationDatedAfterTheEpochSurvivesItButNotTheKeysRemoval() public {
        (uint160 stop, uint160 low) = _fallThrough();
        bytes32 first = _stop(vaultB, ownerB, OWNER_B_KEY, stop, 100, 1);
        bytes32 second = _stop(vaultW, address(wallet), WALLET_SIGNER_KEY, stop, 100, 1);
        uint256 signedAt = clock;
        bytes memory preDated = _signed(PUBLISHER_KEY, _point(p4, low, signedAt + 100, signedAt + 100 + MAX_AGE));
        _advance(1);
        vm.prank(GUARDIAN);
        registry.raiseObservationEpoch(uint64(clock));
        _refused(first, _plan(preDated), IDominoPriceAnchor.InvalidObservation.selector);
        _advance(99);
        _execute(first, _plan(preDated));
        _eq(autoExit.mandateStatus(first), 3, "the pre-dated observation outlived the epoch");
        vm.prank(GUARDIAN);
        registry.removePublisher(vm.addr(PUBLISHER_KEY));
        _refused(second, _plan(preDated), IDominoPriceAnchor.InvalidObservation.selector);
    }

    /// One observation revoked by hash is void (F1 "Revocation").
    function testARevokedObservationIsRefused() public {
        (uint160 stop, uint160 low) = _fallThrough();
        bytes32 id = _stop(vaultB, ownerB, OWNER_B_KEY, stop, 100, 1);
        DominoV2Types.PriceObservation memory point = _point(p4, low, clock, clock + MAX_AGE);
        bytes memory evidence = _signed(PUBLISHER_KEY, point);
        vm.prank(GUARDIAN);
        anchor.revokeObservation(anchor.hashObservation(point));
        _refused(id, _plan(evidence), IDominoPriceAnchor.ObservationRevoked.selector);
    }

    // ================================================ the global halt

    /// The halt stops exits (F4 line 76, owner decision 4) without spending a
    /// mandate, while the owner still revokes and switches the module (F4
    /// line 53). Only a resume scheduled after the halt lifts it, one full
    /// timelock later (DominoRegistry: "Re-admitting a removed role or resuming
    /// a halt needs a change scheduled later than the removal or the halt").
    function testTheGlobalHaltStopsExitsButNeitherRevocationNorTheModuleSwitch() public {
        (uint160 stop, uint160 low) = _fallThrough();
        bytes32 kept = _stop(vaultB, ownerB, OWNER_B_KEY, stop, 100, 1);
        bytes32 revoked = _stop(vaultB, ownerB, OWNER_B_KEY, stop, 100, 2);
        vm.prank(GUARDIAN);
        registry.haltAutomation();
        _refused(kept, _plan(_fresh(p4, low)), IDominoAutoExitExtension.AutomationHalted.selector);
        vm.prank(ownerB);
        autoExit.revokeMandate(revoked);
        vm.prank(ownerB);
        vaultB.setExitModule(address(0));
        vm.prank(ownerB);
        vaultB.setExitModule(address(autoExit));
        _eq(autoExit.mandateStatus(kept), 1, "the halt spends nothing");
        _eq(autoExit.mandateStatus(revoked), 2, "revoked during the halt");
        _advance(1);
        _governed(DominoV2Types.REGISTRY_RESUME_AUTOMATION, "");
        _execute(kept, _plan(_fresh(p4, low)));
        _eq(autoExit.mandateStatus(kept), 3, "fires after the resume");
    }

    /// A resume queued before the halt cannot lift it ("a change queued
    /// earlier cannot quietly reverse an emergency action", DominoRegistry).
    function testAResumeQueuedBeforeTheHaltCannotLiftIt() public {
        (uint160 stop, uint160 low) = _fallThrough();
        bytes32 id = _stop(vaultB, ownerB, OWNER_B_KEY, stop, 100, 1);
        bytes32 resume = registry.scheduleChange(DominoV2Types.REGISTRY_RESUME_AUTOMATION, "");
        _advance(1);
        vm.prank(GUARDIAN);
        registry.haltAutomation();
        _advance(TIMELOCK);
        vm.expectRevert(IDominoRegistry.InvalidChange.selector);
        registry.executeChange(resume);
        _check(registry.automationHalted(), "still halted");
        _refused(id, _plan(_fresh(p4, low)), IDominoAutoExitExtension.AutomationHalted.selector);
    }

    /// The guardian removes a compromised operator at once (F4 line 199).
    function testARemovedOperatorCannotExecute() public {
        (uint160 stop, uint160 low) = _fallThrough();
        bytes32 id = _stop(vaultB, ownerB, OWNER_B_KEY, stop, 100, 1);
        vm.prank(GUARDIAN);
        registry.removeOperator(OPERATOR);
        _refused(id, _plan(_fresh(p4, low)), IDominoAutoExit.Unauthorized.selector);
        _eq(autoExit.mandateStatus(id), 1, "not spent");
    }

    // ===================================== a hostile router leg in the conversion

    /// B's stop at price one, converting into token1 (the first charge
    /// currency): the source is HELD0 of token0, the anchor price one.
    function _convertB(uint16 slippage) private returns (bytes32) {
        return _register(
            _mandate(ownerB, address(vaultB), PRICE_ONE, 0, DominoV2Types.RECEIVE_CONVERTED, address(token1), slippage, 1),
            OWNER_B_KEY
        );
    }

    /// p4's whole fee for a token0 sale, as the module reads it from the PoolManager.
    function _p4Fee() private view returns (uint24 fee) {
        (, fee) = DominoSwapFloor.v4SpotAndFee(chain.v4PoolManager, p4, true);
    }

    /// The honest script: pulls exactly HELD0 through Permit2 and pays `pay` of token1.
    function _honest(uint256 pay) private returns (ScriptedRouter.Script memory script) {
        script.tokenIn = address(token0);
        script.pull = HELD0;
        script.tokenOut = address(token1);
        script.pay = pay;
        token1.mint(address(router), pay);
    }

    function _convertWith(ScriptedRouter.Script memory script) private returns (IDominoAutoExit.Execution memory) {
        return _plan(_fresh(p4, PRICE_ONE), _legs(_routerLegWith(address(token0), address(token1), HELD0, script)));
    }

    /// Whatever a hostile router pays, the conversion is accepted only at or
    /// above quote × (1 − pool fee) × (1 − slippage) at the anchor (F4 "The
    /// floor"; slippage excludes the pool's fee, owner decision 3). So the
    /// owner's loss against the anchor value of what was sold is at most the
    /// pool's fee and the mandate's slippage, compounded; the 20 bps fee is
    /// charged once, on what arrived; the module keeps nothing.
    function testFuzzAHostileRouterLosesTheOwnerAtMostTheMandatesSlippage(uint256 paySeed, uint256 slipSeed) public {
        uint16 slippage = uint16(1 + slipSeed % 1000);
        bytes32 id = _convertB(slippage);
        uint256 floor = DominoSwapFloor.minimumOutput(HELD0, PRICE_ONE, true, _p4Fee(), slippage);
        uint256 pay = paySeed % 2 == 0 ? floor - 1 + (paySeed >> 1) % 3 : 1 + paySeed % (HELD0 * 11 / 10);
        IDominoAutoExit.Execution memory execution =
            _plan(_fresh(p4, PRICE_ONE), _legs(_routerLeg(address(token0), address(token1), HELD0, pay)));
        if (pay < floor) {
            _refused(id, execution, IDominoAutoExitExtension.BelowMinimum.selector);
            _eq(autoExit.mandateStatus(id), 1, "a refused conversion spends nothing");
            return;
        }
        (uint256 amount0, uint256 amount1) = _execute(id, execution);
        uint256 gross = HELD1 + pay;
        _eq(amount0, 0, "nothing left in token0");
        _eq(amount1, gross - gross * 20 / 10_000, "20 bps of the converted output, once");
        _eq(token1.balanceOf(ownerB), amount1, "the owner holds the delivery");
        _eq(token1.balanceOf(FEE_RECIPIENT), gross * 20 / 10_000, "the recipient holds the fee");
        // The loss bound, exactly as the floor states it at the anchor (price one).
        _check(pay * 1e10 >= HELD0 * (1e6 - uint256(_p4Fee())) * (1e4 - uint256(slippage)) - 1e10 + 1, "loss within fee and slippage");
        _eq(token0.balanceOf(address(autoExit)) + token1.balanceOf(address(autoExit)), 0, "the module keeps nothing");
    }

    /// Each way a router can misbehave is refused by the leg's effect, and a
    /// refusal spends nothing (F4 line 126: each leg is accepted by its effect,
    /// both pool tokens and native currency tracked; F1b's executor).
    function testHostileRouterScriptsAreRefusedByTheirEffect() public {
        bytes32 id = _convertB(100);
        ScriptedRouter.Script memory script = _honest(HELD0);
        script.pull = HELD0 - 1; // its Permit2 allowance survives
        _refusedWith(id, script, IDominoPositionActions.SwapEffectMismatch.selector);
        script = _honest(HELD0);
        script.refundIn = 1; // part of the input comes back
        _refusedWith(id, script, IDominoPositionActions.SwapEffectMismatch.selector);
        script = _honest(HELD0);
        (script.extraToken, script.extraAmount) = (address(0), 1); // native slipped in
        vm.deal(address(router), 1);
        _refusedWith(id, script, IDominoPositionActions.SwapEffectMismatch.selector);
        script = _honest(HELD0);
        script.tokenOut = address(token2); // pays in a token it was not asked for
        token2.mint(address(router), HELD0);
        _refusedWith(id, script, IDominoPositionActions.SwapEffectMismatch.selector);
        script = _honest(HELD0);
        (script.callTarget, script.callData) =
            (address(autoExit), abi.encodeCall(IDominoAutoExitExtension.cancelNonce, (9)));
        _refusedWith(id, script, DominoActionLock.ReentrantCall.selector);
        script = _honest(HELD0);
        script.pull = HELD0 + 1; // past its exact, same-block Permit2 allowance: Permit2 refuses
        IDominoAutoExit.Execution memory pullMore = _convertWith(script);
        vm.prank(OPERATOR);
        vm.expectRevert();
        autoExit.execute(id, pullMore);
        _eq(autoExit.mandateStatus(id), 1, "no refusal spent the mandate");
        _eq(token0.balanceOf(address(autoExit)) + token1.balanceOf(address(autoExit)), 0, "nothing stayed");
        _execute(id, _convertWith(_honest(HELD0)));
        _eq(autoExit.mandateStatus(id), 3, "the honest script converts");
    }

    function _refusedWith(bytes32 id, ScriptedRouter.Script memory script, bytes4 reason) private {
        _refused(id, _convertWith(script), reason);
    }

    /// The module's own leg rules on top (F4 lines 129-131): legs sell the
    /// source for the target, a router leg names its amount, and everything
    /// withdrawn is converted.
    function testLegsThatSellTheWrongTokenOrTheWrongAmountAreRefused() public {
        bytes32 id = _convertB(100);
        bytes memory evidence = _fresh(p4, PRICE_ONE);
        _refused(id, _plan(evidence, _legs(_routerLeg(address(token1), address(token1), HELD0, HELD0))), IDominoAutoExitExtension.InvalidExecution.selector);
        _refused(id, _plan(evidence, _legs(_routerLeg(address(token0), address(token0), HELD0, HELD0))), IDominoAutoExitExtension.InvalidExecution.selector);
        _refused(id, _plan(evidence, _legs(_routerLeg(address(token0), address(token1), HELD0 + 1, HELD0))), IDominoAutoExitExtension.InvalidExecution.selector);
        _refused(id, _plan(evidence, _legs(_routerLeg(address(token0), address(token1), HELD0 - 1, HELD0))), IDominoAutoExitExtension.InvalidExecution.selector);
        _refused(id, _plan(evidence, _legs(_routerLeg(address(token0), address(token1), 0, HELD0))), IDominoAutoExitExtension.InvalidExecution.selector);
        // A v3 pool leg taking the remainder converts it on Base's 0.05% pool.
        _execute(id, _plan(evidence, _legs(_v3Leg(address(token0), address(token1), 0, 500))));
        _eq(autoExit.mandateStatus(id), 3, "converted on the remainder leg");
    }

    /// The floor holds the conversion as a whole: one leg may overpay and the
    /// other underpay; only their sum is held to the floor (F4 line 137).
    function testASplitRouteIsHeldToTheFloorAsAWhole() public {
        bytes32 id = _convertB(100);
        uint256 floor = DominoSwapFloor.minimumOutput(HELD0, PRICE_ONE, true, _p4Fee(), 100);
        bytes memory evidence = _fresh(p4, PRICE_ONE);
        DominoV2Types.SwapLeg[] memory split = new DominoV2Types.SwapLeg[](2);
        split[0] = _routerLeg(address(token0), address(token1), 4e20, 4.1e20);
        split[1] = _routerLeg(address(token0), address(token1), 6e20, floor - 4.1e20 - 1);
        _refused(id, _plan(evidence, split), IDominoAutoExitExtension.BelowMinimum.selector);
        split[1] = _routerLeg(address(token0), address(token1), 6e20, floor - 4.1e20);
        (, uint256 amount1) = _execute(id, _plan(evidence, split));
        _eq(amount1, (HELD1 + floor) - (HELD1 + floor) * 20 / 10_000, "converted exactly at the floor");
    }

    /// A router's gift in a token outside the action (neither pool token nor
    /// native currency) is no one's delivery and is not refused: it stays in
    /// the module, which has no sweep (F4 line 212). The owner's delivery is
    /// exact and nothing owed to anyone is spent.
    function testARoutersGiftInAnUntrackedTokenStaysInTheModule() public {
        bytes32 id = _convertB(100);
        ScriptedRouter.Script memory script = _honest(HELD0);
        (script.extraToken, script.extraAmount) = (address(token2), 7);
        token2.mint(address(router), 7);
        (, uint256 amount1) = _execute(id, _convertWith(script));
        _eq(amount1, 2 * HELD1 - 2 * HELD1 * 20 / 10_000, "the owner's delivery is exact");
        _eq(token2.balanceOf(address(autoExit)), 7, "the gift stays in the module");
        _eq(token1.balanceOf(address(autoExit)), 0, "nothing of the owner's stays");
    }

    // ============================== a vault no factory made

    /// Balances other owners left in the module: B's token1 delivery waits (B
    /// frozen), the fee recipient is frozen in token1, and C (an EIP-7702
    /// owner without receive) has native currency waiting (F4 "Delivery").
    function _victims() private returns (uint256 credit1, uint256 creditNative) {
        token1.setTowards(ownerB, token1.REVERTS());
        token1.setTowards(FEE_RECIPIENT, token1.REVERTS());
        vm.etch(ownerC, type(NativeRefuser).runtimeCode);
        _execute(_stop(vaultB, ownerB, OWNER_B_KEY, PRICE_ONE, 100, 1), _plan(_fresh(p4, PRICE_ONE)));
        _execute(_stop(vaultC, ownerC, OWNER_C_KEY, PRICE_ONE, 100, 1), _plan(_fresh(pn, PRICE_ONE)));
        credit1 = autoExit.unclaimed(ownerB, address(token1));
        creditNative = autoExit.unclaimed(ownerC, address(0));
        _check(credit1 > 0 && creditNative > 0 && autoExit.owedFees(address(token1)) > 0, "the victims' balances");
    }

    /// F4 lines 205-208: a vault the owner signs for need not come from the
    /// factory; it can only exit its own tokens. The attacker's vault pays
    /// nothing while reporting everything, tries to pull the module's token1
    /// directly and through Permit2, and calls back into flushOwedFees; then
    /// it lies about its pool; then its conversion tries to sell what it did
    /// not deliver; then it gifts native currency and token2. Every other
    /// owner's credit and every owed fee stays whole, and is then claimed and
    /// flushed exactly; only the gifts remain.
    function testAVaultNoFactoryMadeCannotReachOtherOwnersCreditsOrOwedFees() public {
        (uint256 credit1, uint256 creditNative) = _victims();
        bytes32 empty = _register(
            _mandate(attacker, address(hostile), PRICE_ONE, 0, DominoV2Types.RECEIVE_BOTH, address(0), 100, 1), ATTACKER_KEY
        );
        hostile.setPayments(0, 0, type(uint128).max, type(uint128).max);
        hostile.setPull(address(token1), credit1);
        hostile.setCall(address(autoExit), abi.encodeCall(IDominoFeeSettlement.flushOwedFees, (address(token1))));
        uint256 owed1 = autoExit.owedFees(address(token1));
        vm.recordLogs();
        (uint256 amount0, uint256 amount1) = _execute(empty, _plan(_fresh(p4, PRICE_ONE)));
        _eq(amount0 + amount1, 0, "nothing arrived, nothing delivered");
        _eq(
            _count(vm.getRecordedLogs(), address(autoExit), IDominoFeeEvents.FeeCharged.selector), 0, "no fee on nothing"
        );
        _check(!hostile.pullSucceeded(), "no allowance to pull with");
        _check(hostile.callAttempted() && !hostile.callOk(), "the call back failed");
        _check(
            keccak256(hostile.callResult()) == keccak256(abi.encodeWithSelector(DominoActionLock.ReentrantCall.selector)),
            "on the shared lock"
        );
        _eq(autoExit.owedFees(address(token1)), owed1, "the owed fee is untouched");
        _eq(token1.balanceOf(address(autoExit)), _backed(address(token1)), "token1 backs exactly debt and credits");

        // Its pool: unordered, or one token twice.
        bytes32 lying = _register(
            _mandate(attacker, address(hostile), PRICE_ONE, 0, DominoV2Types.RECEIVE_BOTH, address(0), 100, 2), ATTACKER_KEY
        );
        hostile.setPool(DominoV2Types.PoolRef(DominoV2Types.DEX_V4, address(token1), address(token0), 3000, 60, address(0)));
        _refused(lying, _plan(_fresh(p4, PRICE_ONE)), IDominoAutoExit.InvalidMandate.selector);
        hostile.setPool(DominoV2Types.PoolRef(DominoV2Types.DEX_V4, address(token1), address(token1), 3000, 60, address(0)));
        _refused(lying, _plan(_fresh(p4, PRICE_ONE)), IDominoAutoExit.InvalidMandate.selector);
        hostile.setPool(p4);

        // A conversion sells exactly what its vault delivered, and nothing of anyone else's.
        bytes32 converting = _register(
            _mandate(attacker, address(hostile), PRICE_ONE, 0, DominoV2Types.RECEIVE_CONVERTED, address(token1), 1000, 3),
            ATTACKER_KEY
        );
        hostile.setPayments(1e18, 0, 0, 0);
        token0.mint(address(hostile), 1e18);
        bytes memory evidence = _fresh(p4, PRICE_ONE);
        _refused(
            converting,
            _plan(evidence, _legs(_routerLeg(address(token1), address(token1), credit1, credit1))),
            IDominoAutoExitExtension.InvalidExecution.selector
        );
        _refused(
            converting,
            _plan(evidence, _legs(_routerLeg(address(token0), address(token1), 1e18 + credit1, 1e18))),
            IDominoAutoExitExtension.InvalidExecution.selector
        );
        uint256 before = autoExit.owedFees(address(token1));
        (, uint256 out) = _execute(converting, _plan(evidence, _legs(_routerLeg(address(token0), address(token1), 1e18, 1e18))));
        uint256 fee = 1e18 * 20 / 10_000;
        _eq(out, 1e18 - fee, "the attacker gets its own vault's value, less the fee");
        _eq(token1.balanceOf(attacker), out, "delivered to the attacker");
        _eq(autoExit.owedFees(address(token1)), before + fee, "its fee is owed like any other");

        // Gifts during its exit stay in the module, as no one's.
        bytes32 gifting = _register(
            _mandate(attacker, address(hostile), PRICE_ONE, 0, DominoV2Types.RECEIVE_BOTH, address(0), 100, 4), ATTACKER_KEY
        );
        hostile.setPayments(1e18, 1e18, 0, 0);
        token0.mint(address(hostile), 1e18);
        token1.mint(address(hostile), 1e18);
        hostile.setGifts(5, address(token2), 7);
        vm.deal(address(hostile), 5);
        token2.mint(address(hostile), 7);
        _execute(gifting, _plan(_fresh(p4, PRICE_ONE)));

        // The victims recover exactly what was theirs.
        token1.setTowards(ownerB, token1.NORMAL());
        vm.prank(ownerB);
        _eq(autoExit.claim(address(token1), CLAIM_TO), credit1, "B's credit, exactly");
        vm.prank(ownerC);
        _eq(autoExit.claim(address(0), CLAIM_TO), creditNative, "C's native credit, exactly");
        token1.setTowards(FEE_RECIPIENT, token1.NORMAL());
        uint256 owedNow = autoExit.owedFees(address(token1));
        _eq(autoExit.flushOwedFees(address(token1)), owedNow, "every owed fee, exactly");
        _eq(token1.balanceOf(address(autoExit)), 0, "no token1 left");
        _eq(token0.balanceOf(address(autoExit)), 0, "no token0 left");
        _eq(address(autoExit).balance, 5, "only the native gift remains");
        _eq(token2.balanceOf(address(autoExit)), 7, "and the token2 gift");
    }

    // ===================================== consent, with everything else in place

    /// Expiry is not a status (F4 line 31): with the trigger crossed on fresh
    /// evidence, a mandate executes at its validUntil (F4 line 67) and never a
    /// second later, while it still reads active and its owner can still
    /// revoke it (F4 line 53).
    function testAnExpiredMandateNeverExecutesAndExpiryIsInclusive() public {
        (uint160 stop, uint160 low) = _fallThrough();
        DominoV2Types.ExitMandate memory last =
            _mandate(ownerB, address(vaultB), stop, 0, DominoV2Types.RECEIVE_BOTH, address(0), 100, 1);
        last.validUntil = uint64(clock + 1 hours);
        bytes32 atEnd = _register(last, OWNER_B_KEY);
        DominoV2Types.ExitMandate memory late =
            _mandate(address(wallet), address(vaultW), stop, 0, DominoV2Types.RECEIVE_BOTH, address(0), 100, 1);
        late.validUntil = uint64(clock + 1 hours);
        bytes32 past = _register(late, WALLET_SIGNER_KEY);
        _advance(1 hours);
        _execute(atEnd, _plan(_fresh(p4, low)));
        _eq(autoExit.mandateStatus(atEnd), 3, "executes at validUntil");
        _advance(1);
        _refused(past, _plan(_fresh(p4, low)), IDominoAutoExit.MandateNotActive.selector);
        _eq(autoExit.mandateStatus(past), 1, "expired, still reading active");
        wallet.run(address(autoExit), abi.encodeCall(IDominoAutoExit.revokeMandate, (past)));
        _eq(autoExit.mandateStatus(past), 2, "revoked after expiry");
    }

    /// A vault whose owner changed is not bound by the old owner's mandate
    /// (VaultOwnerChanged, F4 line 69): with the trigger crossed and fresh
    /// evidence, nothing moves; the change back brings the mandate back.
    function testANewVaultOwnerIsNotBoundByTheOldOwnersMandate() public {
        (uint160 stop, uint160 low) = _fallThrough();
        bytes32 id = _stop(vaultB, ownerB, OWNER_B_KEY, stop, 100, 1);
        vaultB.setOwner(STRANGER);
        _refused(id, _plan(_fresh(p4, low)), IDominoAutoExitExtension.VaultOwnerChanged.selector);
        _eq(token0.balanceOf(ownerB) + token0.balanceOf(STRANGER), 0, "nothing delivered to either");
        vaultB.setOwner(ownerB);
        _execute(id, _plan(_fresh(p4, low)));
        _eq(token0.balanceOf(ownerB), HELD0, "the mandate's owner is paid");
    }

    /// Switching the module off pauses the vault's mandates without revoking
    /// them, and switching it on brings them back (F4 line 56); the module
    /// refuses on its own (ExitModuleNotEnabled, F4 line 68) before the vault
    /// would.
    function testTheModuleSwitchPausesAMandateWithoutRevokingIt() public {
        (uint160 stop, uint160 low) = _fallThrough();
        bytes32 id = _stop(vaultB, ownerB, OWNER_B_KEY, stop, 100, 1);
        vm.prank(ownerB);
        vaultB.setExitModule(address(0));
        _refused(id, _plan(_fresh(p4, low)), IDominoAutoExitExtension.ExitModuleNotEnabled.selector);
        _eq(autoExit.mandateStatus(id), 1, "paused, not revoked");
        vm.prank(ownerB);
        vaultB.setExitModule(address(autoExit));
        _execute(id, _plan(_fresh(p4, low)));
        _eq(autoExit.mandateStatus(id), 3, "back, and executed");
    }

    // ============================================== front-running a revoke

    /// The owner sends revokeMandate; the operator's execution of the crossed
    /// mandate lands first. The mandate was the owner's consent in force at
    /// that moment (F4 line 53, revocation at any time; line 90, one shot): it
    /// executes, and the late revoke meets MandateNotActive.
    function testAnExecutionThatLandsBeforeTheRevokeWins() public {
        (uint160 stop, uint160 low) = _fallThrough();
        bytes32 id = _stop(vaultB, ownerB, OWNER_B_KEY, stop, 100, 1);
        _execute(id, _plan(_fresh(p4, low)));
        vm.prank(ownerB);
        vm.expectRevert(IDominoAutoExit.MandateNotActive.selector);
        autoExit.revokeMandate(id);
        _eq(autoExit.mandateStatus(id), 3, "executed, not revoked");
    }

    /// Racing the owner before the trigger is no help to the operator, and a
    /// revoke that lands first ends the mandate for good: its signature never
    /// registers again (F4 line 32: a revoked or executed id never comes back).
    function testARevokeThatLandsFirstEndsTheMandateForGood() public {
        uint160 stop = _scaled(PRICE_ONE, 9500);
        DominoV2Types.ExitMandate memory m =
            _mandate(ownerB, address(vaultB), stop, 0, DominoV2Types.RECEIVE_BOTH, address(0), 100, 1);
        bytes memory signature = _sign(m, OWNER_B_KEY);
        bytes32 id = autoExit.registerMandate(m, signature);
        _refused(id, _plan(_fresh(p4, _spot(p4))), IDominoAutoExit.TriggerNotReached.selector);
        vm.prank(ownerB);
        autoExit.revokeMandate(id);
        _moveTo(p4, _scaled(PRICE_ONE, 9400));
        _refused(id, _plan(_fresh(p4, _spot(p4))), IDominoAutoExit.MandateNotActive.selector);
        vm.expectRevert(IDominoAutoExitExtension.MandateAlreadyRegistered.selector);
        autoExit.registerMandate(m, signature);
    }

    /// cancelNonce voids only a signature that was never registered (F4 line
    /// 51). Whoever holds the signature can front-run the owner's cancelNonce
    /// with registerMandate: the cancel then fails with NonceAlreadyUsed and
    /// the mandate is active, so only revokeMandate ends it (until that lands,
    /// a crossed trigger can fire it, as the execution-first race above shows).
    /// Once revoked, neither the crossed trigger nor the signature brings it back.
    function testARegistrationFrontRunningCancelNonceLeavesOnlyRevoke() public {
        uint160 stop = _scaled(PRICE_ONE, 9500);
        DominoV2Types.ExitMandate memory m =
            _mandate(ownerB, address(vaultB), stop, 0, DominoV2Types.RECEIVE_BOTH, address(0), 100, 7);
        bytes memory signature = _sign(m, OWNER_B_KEY);
        vm.prank(STRANGER);
        bytes32 id = autoExit.registerMandate(m, signature);
        vm.prank(ownerB);
        vm.expectRevert(IDominoAutoExitExtension.NonceAlreadyUsed.selector);
        autoExit.cancelNonce(7);
        _eq(autoExit.mandateStatus(id), 1, "the signature the owner tried to void is an active mandate");
        vm.prank(ownerB);
        autoExit.revokeMandate(id);
        (, uint160 low) = _fallThrough();
        _refused(id, _plan(_fresh(p4, low)), IDominoAutoExit.MandateNotActive.selector);
        vm.expectRevert(IDominoAutoExitExtension.MandateAlreadyRegistered.selector);
        autoExit.registerMandate(m, signature);
        _eq(autoExit.mandateStatus(id), 2, "revoked for good");
    }
}
