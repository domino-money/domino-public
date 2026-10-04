// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoPriceAnchor} from "../../../src/v2/interfaces/IDominoPriceAnchor.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {
    AdvChargeCurrency,
    AdvRegistryConfig,
    AdvStateView,
    AdvVm,
    IAnchorProbe,
    IRegistryProbe,
    RegistryWorld
} from "./RegistryWorld.sol";

/// @notice Attack map item 13, the registry and governance, one attack per
/// test, on the registry and anchor artifacts with the deployment's 24-hour
/// timelock: the governance hand-over, the guardian cancelling and
/// front-running governance, compromised keys on either side, routers below
/// 2.1.2, re-admitting a removed router or publisher, and the observation
/// epoch at the anchor. Where a behaviour is a design choice, the test cites
/// docs/v2/F1_REGISTRY_ANCHOR.md (the "F1 doc").
contract DominoRegistryAttacksTest is RegistryWorld {
    address internal constant GOVERNANCE = address(0x6070);
    address internal constant NEXT_GOVERNANCE = address(0x6071);
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant NEW_GUARDIAN = address(0x6A2E);
    address internal constant RECIPIENT = address(0xFEE0);
    address internal constant OPERATOR = address(0x0BE7);
    address internal constant NEWCOMER = address(0x2E70);
    address internal constant ATTACKER = address(0xA77AC);
    address internal constant ATTACKER_OPERATOR = address(0xA77AD);
    address internal constant STRANGER = address(0xBAD0);
    address internal constant ROUTER = address(0xA0000);
    address internal constant NEXT_ROUTER = address(0xA0001);
    address internal constant STABLE = address(0xC0001);
    address internal constant WRAPPED = address(0xC0002);
    uint256 internal constant PUBLISHER_KEY = 0xB0B0CAFE;
    uint256 internal constant SECOND_PUBLISHER_KEY = 0xB0B0D00D;
    uint32 internal constant TIMELOCK = DEPLOYED_TIMELOCK;

    IRegistryProbe internal registry;
    IAnchorProbe internal anchor;
    AdvStateView internal stateView;
    address internal publisher;
    address internal secondPublisher;
    /// The test's clock: via-IR may re-read TIMESTAMP after a warp, so a
    /// local copy of block.timestamp is never trusted across one.
    uint256 internal clock;

    function setUp() public {
        _warpTo(START);
        _giveCode(ROUTER);
        _giveCode(NEXT_ROUTER);
        _giveCode(STABLE);
        _giveCode(WRAPPED);
        publisher = vm.addr(PUBLISHER_KEY);
        secondPublisher = vm.addr(SECOND_PUBLISHER_KEY);
        registry = _deployRegistry(_config());
        stateView = new AdvStateView();
        anchor = _deployAnchor(address(registry), address(stateView));
    }

    /// The deployment's shape (F1 doc, "Deployment parameters"): 24 hours,
    /// one operator, two publishers, Universal Router 2.1.2, the stable at
    /// rank 1 and ETH and WETH at rank 2.
    function _config() internal view returns (AdvRegistryConfig memory config) {
        config.governance = GOVERNANCE;
        config.guardian = GUARDIAN;
        config.timelockSeconds = TIMELOCK;
        config.feeRecipient = RECIPIENT;
        config.operators = new address[](1);
        config.operators[0] = OPERATOR;
        config.publishers = new address[](2);
        (config.publishers[0], config.publishers[1]) = (publisher, secondPublisher);
        config.routers = new address[](1);
        config.routers[0] = ROUTER;
        config.chargeCurrencies = new AdvChargeCurrency[](3);
        config.chargeCurrencies[0] = AdvChargeCurrency(STABLE, 1);
        config.chargeCurrencies[1] = AdvChargeCurrency(address(0), 2);
        config.chargeCurrencies[2] = AdvChargeCurrency(WRAPPED, 2);
    }

    // ============================================================= helpers

    function _warpTo(uint256 timestamp) internal {
        clock = timestamp;
        vm.warp(timestamp);
    }

    function _advance(uint256 seconds_) internal {
        _warpTo(clock + seconds_);
    }

    function _scheduleAs(address caller, bytes32 kind, bytes memory data) internal returns (bytes32 id) {
        vm.prank(caller);
        id = registry.scheduleChange(kind, data);
    }

    function _schedule(bytes32 kind, bytes memory data) internal returns (bytes32) {
        return _scheduleAs(GOVERNANCE, kind, data);
    }

    function _executeAs(address caller, bytes32 id) internal {
        vm.prank(caller);
        registry.executeChange(id);
    }

    function _execute(bytes32 id) internal {
        _executeAs(GOVERNANCE, id);
    }

    function _wait() internal {
        _advance(registry.timelockSeconds());
    }

    function _executionRefused(address caller, bytes32 id, bytes4 selector, string memory what) internal {
        _refused(caller, address(registry), abi.encodeCall(IDominoRegistry.executeChange, (id)), selector, what);
    }

    function _handOver(address next) internal {
        vm.prank(registry.governance());
        registry.transferGovernance(next);
        vm.prank(next);
        registry.acceptGovernance();
    }

    /// An observation of the suite's pool by `key`, dated `observedAt` and
    /// valid for the consumers' 300 seconds from then.
    function _observation(uint256 key, uint64 observedAt)
        internal
        view
        returns (DominoV2Types.PriceObservation memory point, bytes memory signature)
    {
        point = _point(observedAt, observedAt + CONSUMER_MAX_AGE, 1);
        signature = _signed(key, _digest(anchor, point));
    }

    /// The anchor's verdict on an observation, through both entry points:
    /// verifyObservation, and anchor() with the spot at the same price.
    function _anchorAccepts(DominoV2Types.PriceObservation memory point, bytes memory signature, string memory what)
        internal
        view
    {
        _eq(anchor.verifyObservation(point, signature, CONSUMER_MAX_AGE), PRICE, what);
        (uint160 anchored, uint160 spot) = anchor.anchor(_pool(), abi.encode(point, signature), CONSUMER_MAX_AGE, 0);
        _check(anchored == PRICE && spot == PRICE, what);
    }

    function _anchorRefuses(
        DominoV2Types.PriceObservation memory point,
        bytes memory signature,
        bytes4 selector,
        string memory what
    ) internal {
        _refused(
            STRANGER,
            address(anchor),
            abi.encodeCall(IDominoPriceAnchor.verifyObservation, (point, signature, CONSUMER_MAX_AGE)),
            selector,
            what
        );
        _refused(
            STRANGER,
            address(anchor),
            abi.encodeCall(IDominoPriceAnchor.anchor, (_pool(), abi.encode(point, signature), CONSUMER_MAX_AGE, 0)),
            selector,
            what
        );
    }

    /// Every call that needs a role, as `caller` would make it.
    function _privilegedCalls(bytes32 id) internal view returns (bytes[10] memory calls) {
        calls = [
            abi.encodeCall(IDominoRegistry.scheduleChange, (RECIPIENT_KIND, abi.encode(ATTACKER))),
            abi.encodeCall(IDominoRegistry.executeChange, (id)),
            abi.encodeCall(IDominoRegistry.cancelChange, (id)),
            abi.encodeCall(IDominoRegistry.transferGovernance, (ATTACKER)),
            abi.encodeCall(IDominoRegistry.removeOperator, (OPERATOR)),
            abi.encodeCall(IDominoRegistry.removePublisher, (publisher)),
            abi.encodeCall(IDominoRegistry.removeRouter, (ROUTER)),
            abi.encodeCall(IDominoRegistry.raiseObservationEpoch, (uint64(clock))),
            abi.encodeCall(IDominoRegistry.haltAutomation, ()),
            abi.encodeCall(IDominoPriceAnchor.revokeObservation, (keccak256("an observation")))
        ];
    }

    function _target(uint256 i) internal view returns (address) {
        return i == 9 ? address(anchor) : address(registry);
    }

    // ================================================= governance hand-over

    /// F1 doc, "Who can do what": governance hands over "Immediately", with
    /// transferGovernance "(two-step, the new address accepts)", and
    /// "Governance procedures": "transferGovernance(next), then
    /// acceptGovernance() from next". The hand-over is not a timelocked
    /// change: no ChangeScheduled, nothing for the guardian to cancel, and
    /// none of the guardian's emergency actions touches the offer. It is
    /// accepted in the same second.
    function testAGovernanceHandOverIsImmediateAndOutsideTheGuardiansVeto() public {
        bytes32 pending = _schedule(OPERATOR_KIND, abi.encode(NEWCOMER, true));
        vm.recordLogs();
        vm.prank(GOVERNANCE);
        registry.transferGovernance(NEXT_GOVERNANCE);
        AdvVm.Log[] memory logs = vm.getRecordedLogs();
        _eq(logs.length, 1, "the offer is one event");
        _check(logs[0].topics[0] == IDominoRegistry.GovernanceTransferStarted.selector, "and not a scheduled change");
        _refused(
            GUARDIAN,
            address(registry),
            abi.encodeCall(IDominoRegistry.transferGovernance, (address(0))),
            UNAUTHORIZED,
            "the guardian cannot withdraw the offer"
        );
        vm.startPrank(GUARDIAN);
        registry.cancelChange(pending);
        registry.haltAutomation();
        registry.removeOperator(OPERATOR);
        registry.raiseObservationEpoch(uint64(clock));
        vm.stopPrank();
        _check(registry.pendingGovernance() == NEXT_GOVERNANCE, "no emergency action touches the offer");
        vm.prank(NEXT_GOVERNANCE);
        registry.acceptGovernance();
        _check(registry.governance() == NEXT_GOVERNANCE && registry.pendingGovernance() == address(0), "handed over");
        _eq(block.timestamp, START, "in the same second as the offer");
    }

    /// The former governance loses every power in the hand-over's own
    /// transaction, the immediate narrowing ones and the anchor's revocation
    /// included (the anchor reads registry.governance() live); the new one
    /// has them all at once.
    function testTheFormerGovernanceLosesEveryPowerAtOnce() public {
        bytes32 id = _schedule(RECIPIENT_KIND, abi.encode(NEWCOMER));
        _wait();
        _handOver(NEXT_GOVERNANCE);
        bytes[10] memory calls = _privilegedCalls(id);
        for (uint256 i; i < calls.length; ++i) {
            _refused(GOVERNANCE, _target(i), calls[i], UNAUTHORIZED, "the former governance keeps a power");
        }
        for (uint256 i; i < calls.length; ++i) {
            if (i == 2) continue; // executed just before: nothing left to cancel
            vm.prank(NEXT_GOVERNANCE);
            (bool ok,) = _target(i).call(calls[i]);
            _check(ok, "the new governance lacks a power");
        }
        _check(registry.feeRecipient() == NEWCOMER && registry.automationHalted(), "the new governance acted");
        _check(registry.pendingGovernance() == ATTACKER, "and may make its own offer");
    }

    /// F1 doc: "executeChange is governance-only, so a change queued by an
    /// earlier governance runs only if the current one chooses to." Pending
    /// changes survive a hand-over with their executableAt, stay under the
    /// guardian's veto, and the new governance may run or drop them.
    function testChangesQueuedByAFormerGovernanceRunOnlyIfTheCurrentOneChooses() public {
        bytes32 recipient = _schedule(RECIPIENT_KIND, abi.encode(NEWCOMER));
        bytes32 operator = _schedule(OPERATOR_KIND, abi.encode(NEWCOMER, true));
        bytes32 router = _schedule(ROUTER_KIND, abi.encode(NEXT_ROUTER, uint16(220)));
        (,,, uint64 executableAt) = registry.pendingChange(recipient);
        _handOver(NEXT_GOVERNANCE);
        (,,, uint64 stillAt) = registry.pendingChange(recipient);
        _eq(stillAt, executableAt, "the hand-over moves no executableAt");
        vm.prank(GUARDIAN);
        registry.cancelChange(router);
        _wait();
        _executionRefused(GOVERNANCE, recipient, UNAUTHORIZED, "the former governance cannot run its own change");
        vm.prank(NEXT_GOVERNANCE);
        registry.cancelChange(recipient);
        _executeAs(NEXT_GOVERNANCE, operator);
        _check(registry.feeRecipient() == RECIPIENT && registry.isOperator(NEWCOMER), "dropped one, ran the other");
        _executionRefused(NEXT_GOVERNANCE, router, INVALID, "the guardian's veto survives the hand-over");
    }

    /// An offer has no expiry: until withdrawn (transferGovernance(address(0)),
    /// F1 doc "Governance procedures") or replaced, the offered key can take
    /// governance at any time, a year later, with no timelock. Accepted
    /// design; operationally an outstanding offer is a second governance key,
    /// and monitoring should watch GovernanceTransferStarted.
    function testAnOfferStandsUntilWithdrawnOrReplaced() public {
        vm.prank(GOVERNANCE);
        registry.transferGovernance(NEXT_GOVERNANCE);
        vm.prank(GOVERNANCE);
        registry.transferGovernance(ATTACKER);
        _refused(
            NEXT_GOVERNANCE,
            address(registry),
            abi.encodeCall(IDominoRegistry.acceptGovernance, ()),
            UNAUTHORIZED,
            "a replaced offer is void"
        );
        vm.prank(GOVERNANCE);
        registry.transferGovernance(address(0));
        _refused(
            ATTACKER,
            address(registry),
            abi.encodeCall(IDominoRegistry.acceptGovernance, ()),
            UNAUTHORIZED,
            "a withdrawn offer is void"
        );
        vm.prank(GOVERNANCE);
        registry.transferGovernance(NEXT_GOVERNANCE);
        _advance(365 days);
        vm.prank(NEXT_GOVERNANCE);
        registry.acceptGovernance();
        _check(registry.governance() == NEXT_GOVERNANCE, "a year-old offer still hands governance over");
    }

    /// Nothing on chain keeps governance and the guardian apart; the
    /// deployment parameters ask for "a separate key or multisig, held apart
    /// from governance" (F1 doc). Handed governance, the guardian's address
    /// cancels guardian changes, so the rule "The guardian cannot cancel a
    /// guardian change" no longer separates anything. Governance's choice
    /// (it could equally name itself guardian); pinned here for the runbook.
    function testHandingGovernanceToTheGuardianMergesTheRoles() public {
        bytes32 replace = _schedule(GUARDIAN_KIND, abi.encode(NEW_GUARDIAN));
        _refused(
            GUARDIAN,
            address(registry),
            abi.encodeCall(IDominoRegistry.cancelChange, (replace)),
            UNAUTHORIZED,
            "a separate guardian cannot veto its replacement"
        );
        _handOver(GUARDIAN);
        vm.prank(GUARDIAN);
        registry.cancelChange(replace);
        (,,, uint64 executableAt) = registry.pendingChange(replace);
        _eq(executableAt, 0, "merged, the guardian vetoed its replacement");
    }

    // ============================== the guardian against governance's changes

    /// F1 doc, "Veto a pending change": the guardian cancels any pending
    /// change but a guardian change, so also in the second it becomes
    /// executable, ahead of governance's executeChange in the same block.
    /// Once executed a change cannot be cancelled; the guardian narrows it
    /// back with its immediate powers instead.
    function testTheGuardianFrontRunsAnExecutionInItsFirstSecond() public {
        bytes32 id = _schedule(OPERATOR_KIND, abi.encode(NEWCOMER, true));
        _wait();
        vm.prank(GUARDIAN);
        registry.cancelChange(id);
        _executionRefused(GOVERNANCE, id, INVALID, "a cancelled change executed");
        bytes32 next = _schedule(OPERATOR_KIND, abi.encode(NEWCOMER, true));
        _wait();
        _execute(next);
        _refused(
            GUARDIAN,
            address(registry),
            abi.encodeCall(IDominoRegistry.cancelChange, (next)),
            INVALID,
            "an executed change was cancelled"
        );
        vm.prank(GUARDIAN);
        registry.removeOperator(NEWCOMER);
        _check(!registry.isOperator(NEWCOMER), "the guardian narrows it back at once");
    }

    /// The same-second rule (F1 doc: "one scheduled in the same second or
    /// earlier reverts with InvalidChange"): a removal in the very block a
    /// re-admission was scheduled, even after it, voids it, without its id,
    /// and for good. It stays listed until cancelled; removedAt tells
    /// monitoring it is void.
    function testARemovalInTheSecondOfAReadmissionVoidsItForGood() public {
        vm.prank(GUARDIAN);
        registry.removeOperator(OPERATOR);
        _advance(1);
        bytes32 id = _schedule(OPERATOR_KIND, abi.encode(OPERATOR, true));
        vm.prank(GUARDIAN);
        registry.removeOperator(OPERATOR);
        _eq(registry.removedAt(OPERATOR_KIND, OPERATOR), clock, "monitoring sees the change is void");
        _wait();
        _executionRefused(GOVERNANCE, id, INVALID, "re-admitted by a change of the removal's second");
        _advance(365 days);
        _executionRefused(GOVERNANCE, id, INVALID, "a void re-admission came back to life");
        (,,, uint64 executableAt) = registry.pendingChange(id);
        _check(executableAt != 0, "listed until cancelled");
        vm.prank(GUARDIAN);
        registry.cancelChange(id);
        _check(!registry.isOperator(OPERATOR), "still removed");
    }

    /// F1 doc: "calling haltAutomation again while halted voids resumes
    /// queued since the previous halt", and a resume queued while nothing was
    /// halted is void once a halt follows it. Only a resume scheduled after
    /// the latest halt lifts it, a full timelock later.
    function testOnlyAResumeQueuedAfterTheLatestHaltLiftsIt() public {
        bytes32 early = _schedule(RESUME_KIND, "");
        _advance(1);
        vm.prank(GUARDIAN);
        registry.haltAutomation();
        _advance(1);
        bytes32 between = _schedule(RESUME_KIND, "");
        vm.prank(GUARDIAN);
        registry.haltAutomation();
        _wait();
        _executionRefused(GOVERNANCE, early, INVALID, "a resume queued before any halt lifted it");
        _executionRefused(GOVERNANCE, between, INVALID, "a resume of the latest halt's second lifted it");
        _advance(1);
        bytes32 fresh = _schedule(RESUME_KIND, "");
        _advance(TIMELOCK - 1);
        _executionRefused(GOVERNANCE, fresh, NOT_READY, "a resume skipped its timelock");
        _check(registry.automationHalted(), "halted throughout");
        _advance(1);
        _execute(fresh);
        _check(!registry.automationHalted(), "lifted by a resume queued after the latest halt");
    }

    /// F1 doc, "Why the guardian cannot cancel a guardian change": the
    /// guardian cannot cancel its replacement, but keeps every power until it
    /// executes, in its last second too; afterwards it has none, in the same
    /// second, and the new guardian has them all.
    function testTheGuardianCannotVetoItsReplacementButActsUntilItExecutes() public {
        bytes32 id = _schedule(GUARDIAN_KIND, abi.encode(NEW_GUARDIAN));
        _refused(
            GUARDIAN,
            address(registry),
            abi.encodeCall(IDominoRegistry.cancelChange, (id)),
            UNAUTHORIZED,
            "the guardian vetoed its replacement"
        );
        bytes32 other = _schedule(RECIPIENT_KIND, abi.encode(NEWCOMER));
        _wait();
        vm.startPrank(GUARDIAN);
        registry.haltAutomation();
        registry.removePublisher(secondPublisher);
        vm.stopPrank();
        _execute(id);
        bytes[10] memory calls = _privilegedCalls(other);
        for (uint256 i = 2; i < calls.length; ++i) {
            if (i == 3) continue; // transferGovernance was never the guardian's
            _refused(GUARDIAN, _target(i), calls[i], UNAUTHORIZED, "the replaced guardian keeps a power");
        }
        vm.startPrank(NEW_GUARDIAN);
        registry.cancelChange(other);
        registry.removeRouter(ROUTER);
        vm.stopPrank();
        _check(registry.guardian() == NEW_GUARDIAN && registry.routerVersion(ROUTER) == 0, "the new guardian acts");
    }

    /// F1 doc: "A compromised guardian costs at most two timelocks of
    /// automation. It can halt, remove and cancel, but not its own
    /// replacement. Governance replaces it after one timelock, then restores
    /// what it removed after a second." Exactly two timelocks and one second:
    /// the old guardian may still act in the second of its replacement, and
    /// the same-second rule voids what governance schedules in that second.
    function testACompromisedGuardianCostsTwoTimelocksAndOneSecond() public {
        uint256 t0 = clock;
        _strikeEverything(GUARDIAN);
        bytes32 replace = _schedule(GUARDIAN_KIND, abi.encode(NEW_GUARDIAN));
        // Restorations queued before the replacement are vetoed or voided.
        _advance(1);
        bytes32[4] memory early = _restorations();
        vm.startPrank(GUARDIAN);
        for (uint256 i; i < 4; ++i) {
            registry.cancelChange(early[i]);
        }
        vm.stopPrank();
        // In the second of its replacement it strikes again, first.
        _warpTo(t0 + TIMELOCK);
        _strikeEverything(GUARDIAN);
        _execute(replace);
        bytes32[4] memory sameSecond = _restorations();
        _strikeRefused(GUARDIAN);
        _advance(1);
        bytes32[4] memory restore = _restorations();
        _warpTo(t0 + 2 * uint256(TIMELOCK));
        for (uint256 i; i < 4; ++i) {
            _executionRefused(GOVERNANCE, restore[i], NOT_READY, "restored before two timelocks");
            _executionRefused(GOVERNANCE, sameSecond[i], INVALID, "restored by a change of the strike's second");
        }
        _advance(1);
        for (uint256 i; i < 4; ++i) {
            _execute(restore[i]);
        }
        _check(registry.isOperator(OPERATOR) && registry.isPublisher(publisher), "roles restored");
        _check(registry.routerVersion(ROUTER) == 212 && !registry.automationHalted(), "router and automation restored");
        _eq(clock, t0 + 2 * uint256(TIMELOCK) + 1, "two timelocks and one second");
    }

    function _strikeEverything(address guardian) internal {
        vm.startPrank(guardian);
        registry.haltAutomation();
        registry.removeOperator(OPERATOR);
        registry.removePublisher(publisher);
        registry.removeRouter(ROUTER);
        vm.stopPrank();
    }

    function _strikeRefused(address guardian) internal {
        bytes[10] memory calls = _privilegedCalls(bytes32(0));
        for (uint256 i = 4; i < 9; ++i) {
            _refused(guardian, address(registry), calls[i], UNAUTHORIZED, "a replaced guardian struck");
        }
    }

    function _restorations() internal returns (bytes32[4] memory ids) {
        ids[0] = _schedule(OPERATOR_KIND, abi.encode(OPERATOR, true));
        ids[1] = _schedule(PUBLISHER_KIND, abi.encode(publisher, true));
        ids[2] = _schedule(ROUTER_KIND, abi.encode(ROUTER, uint16(212)));
        ids[3] = _schedule(RESUME_KIND, "");
    }

    /// F1 doc: "A compromised governance needs two timelocks to defeat an
    /// honest guardian: one to replace it, one for the change it was
    /// vetoing. Throughout, the guardian can halt automation and remove every
    /// role." The attacker queues everything at once; the guardian vetoes all
    /// but its own replacement, halts and removes. The attacker's operator,
    /// recipient and shorter timelock all wait for a second timelock.
    function testACompromisedGovernanceNeedsTwoTimelocks() public {
        uint256 t0 = clock;
        _handOver(ATTACKER);
        bytes32 operator = _scheduleAs(ATTACKER, OPERATOR_KIND, abi.encode(ATTACKER_OPERATOR, true));
        bytes32 recipient = _scheduleAs(ATTACKER, RECIPIENT_KIND, abi.encode(ATTACKER));
        bytes32 shorter = _scheduleAs(ATTACKER, TIMELOCK_KIND, abi.encode(uint32(1 hours)));
        bytes32 guardian = _scheduleAs(ATTACKER, GUARDIAN_KIND, abi.encode(ATTACKER));
        vm.startPrank(GUARDIAN);
        registry.cancelChange(recipient);
        registry.cancelChange(shorter);
        // One removal voids every pending admission of the address, whatever its id.
        registry.removeOperator(ATTACKER_OPERATOR);
        registry.haltAutomation();
        registry.removeOperator(OPERATOR);
        registry.removePublisher(publisher);
        registry.removePublisher(secondPublisher);
        registry.removeRouter(ROUTER);
        vm.stopPrank();
        _refused(
            GUARDIAN,
            address(registry),
            abi.encodeCall(IDominoRegistry.cancelChange, (guardian)),
            UNAUTHORIZED,
            "the honest guardian vetoed its replacement"
        );
        _warpTo(t0 + TIMELOCK);
        _executionRefused(ATTACKER, operator, INVALID, "the voided admission executed");
        _executeAs(ATTACKER, guardian);
        bytes32[4] memory wanted = [
            _scheduleAs(ATTACKER, OPERATOR_KIND, abi.encode(ATTACKER_OPERATOR, true)),
            _scheduleAs(ATTACKER, RECIPIENT_KIND, abi.encode(ATTACKER)),
            _scheduleAs(ATTACKER, TIMELOCK_KIND, abi.encode(uint32(1 hours))),
            _scheduleAs(ATTACKER, RESUME_KIND, "")
        ];
        _warpTo(t0 + 2 * uint256(TIMELOCK) - 1);
        for (uint256 i; i < 4; ++i) {
            _executionRefused(ATTACKER, wanted[i], NOT_READY, "the attacker beat two timelocks");
        }
        _check(!registry.isOperator(ATTACKER_OPERATOR) && registry.feeRecipient() == RECIPIENT, "nothing won yet");
        _check(registry.automationHalted() && registry.timelockSeconds() == TIMELOCK, "halted, timelock intact");
        _advance(1);
        _executeAs(ATTACKER, wanted[0]);
        _check(registry.isOperator(ATTACKER_OPERATOR), "won after exactly two timelocks");
    }

    /// Removing a leaked key from one role does not void its pending
    /// admission to the other: removal times are kept per kind
    /// (removedAt(kind, subject), F1 doc "Monitoring"), and the disjointness
    /// check that blocked the admission while the key operated no longer
    /// does. The guardian must also call removePublisher (which voids every
    /// pending publisher admission of the address, F1 doc) or cancel the id.
    /// Accepted per the per-kind design; the key-leak procedure ("removeOperator
    /// or removePublisher, at once") should say "both".
    function testRemovingAnOperatorLeavesItsPendingPublisherAdmissionLive() public {
        bytes32 asPublisher = _schedule(PUBLISHER_KIND, abi.encode(OPERATOR, true));
        _wait();
        _executionRefused(GOVERNANCE, asPublisher, INVALID, "an operator was admitted as publisher");
        // The operator key leaks; the guardian removes it as an operator only.
        vm.prank(GUARDIAN);
        registry.removeOperator(OPERATOR);
        _eq(registry.removedAt(PUBLISHER_KIND, OPERATOR), 0, "no publisher removal recorded");
        _execute(asPublisher);
        _check(registry.isPublisher(OPERATOR), "the leaked key publishes, by a change queued before its removal");
        // Removing it from both roles voids such an admission without its id.
        vm.prank(GUARDIAN);
        registry.removePublisher(OPERATOR);
        bytes32 again = _schedule(PUBLISHER_KIND, abi.encode(OPERATOR, true));
        vm.prank(GUARDIAN);
        registry.removePublisher(OPERATOR);
        _wait();
        _executionRefused(GOVERNANCE, again, INVALID, "a removal from both roles voids it");
    }

    // ================================================ routers below 2.1.2

    /// F1 doc, "Changes": a router version "from 1 to 211 (Universal Router
    /// 2.0 and 2.1.1 are sunset on 21 Oct 2026)" is refused at scheduling,
    /// and no other path writes a version: the constructor admits at 212, a
    /// removal writes 0. Consumers only check routerVersion != 0 (F1 doc,
    /// "Registry reads"), so this refusal is the whole defence.
    function testFuzzARouterBelow212IsNeverAdmitted(uint16 version, uint256 dirty) public {
        version = uint16(1 + version % 211);
        vm.prank(GOVERNANCE);
        vm.expectRevert(INVALID);
        registry.scheduleChange(ROUTER_KIND, abi.encode(NEXT_ROUTER, version));
        // Nor a canonical 212 carried in a dirty word.
        uint256 word = uint256(212) | (uint256(1 + dirty % type(uint240).max) << 16);
        vm.prank(GOVERNANCE);
        vm.expectRevert(INVALID);
        registry.scheduleChange(ROUTER_KIND, abi.encode(NEXT_ROUTER, word));
        _eq(registry.routerVersion(NEXT_ROUTER), 0, "nothing admitted");
        _eq(registry.MIN_UNIVERSAL_ROUTER_VERSION(), 212, "the floor is 2.1.2");
        _eq(registry.routerVersion(ROUTER), 212, "the deployment admits at 2.1.2");
    }

    /// Admitted versions are 212 and above, set exactly as scheduled; an
    /// admitted router may be moved to another admitted version (a downgrade
    /// to 2.1.2 included) and only removal reaches 0.
    function testFuzzRouterVersionsFrom212AreSetAsScheduled(uint16 version) public {
        version = uint16(212 + version % (uint256(type(uint16).max) - 211));
        bytes32 id = _schedule(ROUTER_KIND, abi.encode(NEXT_ROUTER, version));
        _wait();
        _execute(id);
        _eq(registry.routerVersion(NEXT_ROUTER), version, "the scheduled version");
        id = _schedule(ROUTER_KIND, abi.encode(NEXT_ROUTER, uint16(212)));
        _wait();
        _execute(id);
        _eq(registry.routerVersion(NEXT_ROUTER), 212, "moved to 2.1.2");
        vm.prank(GUARDIAN);
        registry.removeRouter(NEXT_ROUTER);
        _eq(registry.routerVersion(NEXT_ROUTER), 0, "removed");
    }

    // =========================== re-admitting a removed router or publisher

    /// F1 doc, "The guardian's emergency actions cannot be undone quietly": a
    /// removed router comes back only through a change scheduled after the
    /// removal and its full timelock. A scheduled removal (version 0) counts
    /// from its execution, so a re-admission queued between the removal's
    /// scheduling and its execution is void too.
    function testARemovedRouterComesBackOnlyThroughAFreshTimelock() public {
        bytes32 before = _schedule(ROUTER_KIND, abi.encode(ROUTER, uint16(220)));
        _advance(1);
        vm.prank(GUARDIAN);
        registry.removeRouter(ROUTER);
        bytes32 sameSecond = _schedule(ROUTER_KIND, abi.encode(ROUTER, uint16(212)));
        _advance(1);
        bytes32 fresh = _schedule(ROUTER_KIND, abi.encode(ROUTER, uint16(220)));
        _wait();
        _executionRefused(GOVERNANCE, before, INVALID, "a router came back through an older change");
        _executionRefused(GOVERNANCE, sameSecond, INVALID, "a router came back through a change of its removal's second");
        _execute(fresh);
        _eq(registry.routerVersion(ROUTER), 220, "back at the scheduled version");
        // A removal through the timelock counts from its execution.
        bytes32 removal = _schedule(ROUTER_KIND, abi.encode(ROUTER, uint16(0)));
        _advance(1);
        bytes32 between = _schedule(ROUTER_KIND, abi.encode(ROUTER, uint16(212)));
        _wait();
        _execute(removal);
        _eq(registry.removedAt(ROUTER_KIND, ROUTER), clock, "removed at execution");
        _executionRefused(GOVERNANCE, between, INVALID, "a router came back through a change queued before its removal ran");
    }

    /// A removed publisher's observations are void at once (F1 doc: "the
    /// signer is an admitted publisher now"). Re-admitted through a fresh
    /// timelock, its honest observations from before the removal stay void:
    /// they expired, since no consumer accepts more than 300 seconds and the
    /// timelock is at least an hour (MIN_TIMELOCK_SECONDS).
    function testARemovedPublisherComesBackOnlyThroughAFreshTimelock() public {
        (DominoV2Types.PriceObservation memory point, bytes memory signature) = _observation(PUBLISHER_KEY, uint64(clock));
        _anchorAccepts(point, signature, "an admitted publisher's observation");
        bytes32 before = _schedule(PUBLISHER_KIND, abi.encode(publisher, true));
        _advance(10);
        vm.prank(GUARDIAN);
        registry.removePublisher(publisher);
        _anchorRefuses(point, signature, INVALID_OBSERVATION, "a removed publisher's observation");
        _advance(1);
        bytes32 fresh = _schedule(PUBLISHER_KIND, abi.encode(publisher, true));
        _advance(TIMELOCK - 1);
        _executionRefused(GOVERNANCE, before, INVALID, "a publisher came back through an older change");
        _executionRefused(GOVERNANCE, fresh, NOT_READY, "a publisher came back early");
        _advance(1);
        _execute(fresh);
        _check(registry.isPublisher(publisher), "back after a full timelock");
        _anchorRefuses(point, signature, bytes4(keccak256("ObservationExpired()")), "a pre-removal observation came back");
        _check(registry.MIN_TIMELOCK_SECONDS() > CONSUMER_MAX_AGE, "no timelock is shorter than an observation's life");
        (point, signature) = _observation(PUBLISHER_KEY, uint64(clock));
        _anchorAccepts(point, signature, "a fresh observation");
    }

    /// What the epoch cannot void: an observation dated in the future by
    /// whoever holds the key. The epoch never passes now (F1 doc: it "can
    /// never block observations made from now on"), so such observations
    /// escape it; removal (or revocation by hash) is the remedy, and they come
    /// back if the same key is re-admitted. Accepted: the F1 doc's key-leak
    /// procedure removes the key, and re-admitting a leaked key re-trusts it
    /// anyway. The procedure should say a leaked key is never re-admitted.
    function testAFutureDatedObservationEscapesTheEpochUntilItsKeyIsRemoved() public {
        uint64 later = uint64(clock + 3 days);
        (DominoV2Types.PriceObservation memory point, bytes memory signature) = _observation(PUBLISHER_KEY, later);
        vm.prank(GUARDIAN);
        registry.raiseObservationEpoch(uint64(clock));
        _advance(3 days);
        vm.prank(GUARDIAN);
        registry.raiseObservationEpoch(later);
        _anchorAccepts(point, signature, "an observation at the epoch is valid");
        vm.prank(GUARDIAN);
        registry.removePublisher(publisher);
        _anchorRefuses(point, signature, INVALID_OBSERVATION, "removal voids it");
        // Re-admitted by a change scheduled after the removal, the key's
        // observations pre-dated to land after the re-admission are valid.
        _advance(1);
        bytes32 id = _schedule(PUBLISHER_KIND, abi.encode(publisher, true));
        (point, signature) = _observation(PUBLISHER_KEY, uint64(clock + TIMELOCK));
        _advance(TIMELOCK);
        _execute(id);
        _anchorAccepts(point, signature, "a pre-signed observation of a re-admitted key");
        bytes32 digest = _digest(anchor, point);
        vm.prank(GUARDIAN);
        anchor.revokeObservation(digest);
        _anchorRefuses(point, signature, OBSERVATION_REVOKED, "revocation by hash voids it");
    }

    // ===================================================== epoch rotation

    /// Raising the epoch voids every observation dated before it, from every
    /// publisher, at once (the anchor reads the epoch live); an observation
    /// dated at the epoch stays valid (F1 doc, "Other rules"); fresh ones are
    /// accepted. The epoch never falls and never passes now, so no party
    /// revives a voided observation or blocks the next ones.
    function testEpochRotationVoidsEveryEarlierObservationAtTheAnchor() public {
        uint64 t0 = uint64(clock);
        (DominoV2Types.PriceObservation memory old1, bytes memory sig1) = _observation(PUBLISHER_KEY, t0);
        (DominoV2Types.PriceObservation memory old2, bytes memory sig2) = _observation(SECOND_PUBLISHER_KEY, t0);
        _advance(60);
        uint64 t1 = uint64(clock);
        (DominoV2Types.PriceObservation memory atEpoch, bytes memory sig3) = _observation(PUBLISHER_KEY, t1);
        _anchorAccepts(old1, sig1, "valid before the rotation");
        vm.prank(GUARDIAN);
        registry.raiseObservationEpoch(t1);
        _anchorRefuses(old1, sig1, OBSERVATION_REVOKED, "an old epoch's observation");
        _anchorRefuses(old2, sig2, OBSERVATION_REVOKED, "another publisher's old observation");
        _anchorAccepts(atEpoch, sig3, "an observation dated at the epoch");
        // Nobody lowers it or pushes it past now.
        vm.startPrank(GUARDIAN);
        vm.expectRevert(INVALID);
        registry.raiseObservationEpoch(t0);
        vm.expectRevert(INVALID);
        registry.raiseObservationEpoch(t1);
        vm.expectRevert(INVALID);
        registry.raiseObservationEpoch(t1 + 1);
        vm.stopPrank();
        _advance(30);
        vm.prank(GOVERNANCE);
        registry.raiseObservationEpoch(uint64(clock));
        _anchorRefuses(atEpoch, sig3, OBSERVATION_REVOKED, "the next rotation voids it too");
        (DominoV2Types.PriceObservation memory fresh, bytes memory sig4) =
            _observation(SECOND_PUBLISHER_KEY, uint64(clock));
        _anchorAccepts(fresh, sig4, "an observation made at the new epoch");
        // A publisher admitted later cannot bring an observation dated before
        // the epoch, whatever window its caller allows.
        uint64 epoch = registry.observationEpoch();
        uint256 lateKey = 0xB0B0FEED;
        bytes32 id = _schedule(PUBLISHER_KIND, abi.encode(vm.addr(lateKey), true));
        _wait();
        _execute(id);
        DominoV2Types.PriceObservation memory backdated = _point(epoch - 1, uint64(clock), 2);
        _refused(
            STRANGER,
            address(anchor),
            abi.encodeCall(
                IDominoPriceAnchor.verifyObservation,
                (backdated, _signed(lateKey, _digest(anchor, backdated)), type(uint32).max)
            ),
            OBSERVATION_REVOKED,
            "a late publisher's observation from before the epoch"
        );
    }

    /// The epoch boundary for any dates: an observation within its window is
    /// accepted exactly when observedAt is at or after the epoch.
    function testFuzzTheEpochBoundary(uint32 epochAgo, uint32 observedAgo) public {
        _advance(10 days);
        uint64 epoch = uint64(clock - epochAgo % 5 days);
        uint64 observedAt = uint64(clock - observedAgo % CONSUMER_MAX_AGE);
        if (epoch != 0 && epoch > registry.observationEpoch()) {
            vm.prank(GUARDIAN);
            registry.raiseObservationEpoch(epoch);
        }
        (DominoV2Types.PriceObservation memory point, bytes memory signature) = _observation(PUBLISHER_KEY, observedAt);
        if (observedAt >= registry.observationEpoch()) {
            _anchorAccepts(point, signature, "at or after the epoch");
        } else {
            _anchorRefuses(point, signature, OBSERVATION_REVOKED, "before the epoch");
        }
    }

    // ========================================================= monitoring

    /// Informational. The deployment's timelock is the one registry value no
    /// event carries: the constructor emits GovernanceTransferred,
    /// GuardianChanged, FeeRecipientSet and the role, router and rank events
    /// (F1 doc: "The constructor emits the same events as the changes would,
    /// so an indexer rebuilds the state from logs"), but a timelock change
    /// emits only ChangeExecuted, which the constructor has no id for. An
    /// indexer learns it from the first ChangeScheduled (executableAt minus
    /// the block time) or from the constructor's arguments.
    function testTheDeploymentTimelockIsInNoEvent() public {
        vm.recordLogs();
        IRegistryProbe fresh = _deployRegistry(_config());
        AdvVm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(fresh)) continue;
            for (uint256 j; j < logs[i].topics.length; ++j) {
                _check(uint256(logs[i].topics[j]) != TIMELOCK, "a topic carries the timelock");
            }
            _check(keccak256(logs[i].data) != keccak256(abi.encode(uint256(TIMELOCK))), "an event carries the timelock");
        }
        vm.recordLogs();
        vm.prank(GOVERNANCE);
        fresh.scheduleChange(RECIPIENT_KIND, abi.encode(NEWCOMER));
        logs = vm.getRecordedLogs();
        (, uint64 executableAt) = abi.decode(logs[0].data, (bytes, uint64));
        _eq(executableAt - clock, TIMELOCK, "the first ChangeScheduled reveals it");
    }
}
