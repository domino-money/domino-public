// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {DominoRegistry} from "../../../src/v2/registry/DominoRegistry.sol";
import {CodeStub, RegistryFixtures, V2Vm} from "./RegistryFixtures.sol";

/// @notice DominoRegistry: who may change what, when, and what a change may
/// carry. Refusals come first; each names the guard it pins.
contract DominoRegistryTest is RegistryFixtures {
    bytes32 internal constant OPERATOR_KIND = DominoV2Types.REGISTRY_OPERATOR;
    bytes32 internal constant PUBLISHER_KIND = DominoV2Types.REGISTRY_PUBLISHER;
    bytes32 internal constant ROUTER_KIND = DominoV2Types.REGISTRY_ROUTER;
    bytes32 internal constant CURRENCY_KIND = DominoV2Types.REGISTRY_CHARGE_CURRENCY;
    bytes32 internal constant RECIPIENT_KIND = DominoV2Types.REGISTRY_FEE_RECIPIENT;
    bytes32 internal constant GUARDIAN_KIND = DominoV2Types.REGISTRY_GUARDIAN;
    bytes32 internal constant TIMELOCK_KIND = DominoV2Types.REGISTRY_TIMELOCK;
    bytes32 internal constant RESUME_KIND = DominoV2Types.REGISTRY_RESUME_AUTOMATION;

    DominoRegistry internal registry;
    address internal router;
    address internal secondRouter;
    address internal stable;
    address internal wrapped;
    address internal token;

    function setUp() public {
        _warpTo(START);
        router = address(new CodeStub());
        secondRouter = address(new CodeStub());
        stable = address(new CodeStub());
        wrapped = address(new CodeStub());
        token = address(new CodeStub());
        registry = new DominoRegistry(_config(router, stable, wrapped));
    }

    // ------------------------------------------------------------ helpers
    function _schedule(bytes32 kind, bytes memory data) internal returns (bytes32 id) {
        vm.prank(GOVERNANCE);
        id = registry.scheduleChange(kind, data);
    }

    function _execute(bytes32 id) internal {
        vm.prank(GOVERNANCE);
        registry.executeChange(id);
    }

    function _wait() internal {
        _advance(registry.timelockSeconds());
    }

    function _enact(bytes32 kind, bytes memory data) internal returns (bytes32 id) {
        id = _schedule(kind, data);
        _wait();
        _execute(id);
    }

    function _refuse(bytes32 kind, bytes memory data) internal {
        vm.prank(GOVERNANCE);
        vm.expectRevert(IDominoRegistry.InvalidChange.selector);
        registry.scheduleChange(kind, data);
    }

    function _refuseExecution(bytes32 id) internal {
        vm.prank(GOVERNANCE);
        vm.expectRevert(IDominoRegistry.InvalidChange.selector);
        registry.executeChange(id);
    }

    function _base() internal view returns (DominoRegistry.Config memory) {
        return _config(router, stable, wrapped);
    }

    function _refuseDeployment(DominoRegistry.Config memory config) internal {
        vm.expectRevert(IDominoRegistry.InvalidChange.selector);
        new DominoRegistry(config);
    }

    function _outsiders() internal pure returns (address[4] memory) {
        return [OPERATOR, PUBLISHER, RECIPIENT, STRANGER];
    }

    // ------------------------------------------------- deployment refusals
    function testDeploymentRefusesMissingRoles() public {
        DominoRegistry.Config memory config = _base();
        config.governance = address(0);
        _refuseDeployment(config);
        config = _base();
        config.guardian = address(0);
        _refuseDeployment(config);
        config = _base();
        config.feeRecipient = address(0);
        _refuseDeployment(config);
        config = _base();
        config.operators[0] = address(0);
        _refuseDeployment(config);
        config = _base();
        config.publishers[0] = address(0);
        _refuseDeployment(config);
    }

    function testDeploymentRefusesATimelockOutsideItsBounds() public {
        DominoRegistry.Config memory config = _base();
        config.timelockSeconds = registry.MIN_TIMELOCK_SECONDS() - 1;
        _refuseDeployment(config);
        config.timelockSeconds = registry.MAX_TIMELOCK_SECONDS() + 1;
        _refuseDeployment(config);
        config.timelockSeconds = registry.MIN_TIMELOCK_SECONDS();
        _eq(new DominoRegistry(config).timelockSeconds(), 1 hours, "minimum timelock");
        config.timelockSeconds = registry.MAX_TIMELOCK_SECONDS();
        _eq(new DominoRegistry(config).timelockSeconds(), 30 days, "maximum timelock");
    }

    function testDeploymentKeepsOperatorsAndPublishersApart() public {
        DominoRegistry.Config memory config = _base();
        config.publishers[0] = OPERATOR;
        _refuseDeployment(config);
    }

    function testDeploymentRefusesARouterOrCurrencyWithoutCode() public {
        DominoRegistry.Config memory config = _base();
        config.routers[0] = address(0xDEAD);
        _refuseDeployment(config);
        config = _base();
        config.chargeCurrencies[0].token = address(0xDEAD);
        _refuseDeployment(config);
        config = _base();
        config.chargeCurrencies[0].rank = 0;
        _refuseDeployment(config);
    }

    function testDeploymentAppliesTheConfiguration() public view {
        _check(registry.governance() == GOVERNANCE, "governance");
        _check(registry.pendingGovernance() == address(0), "no pending governance");
        _check(registry.guardian() == GUARDIAN, "guardian");
        _check(registry.feeRecipient() == RECIPIENT, "fee recipient");
        _eq(registry.timelockSeconds(), TIMELOCK, "timelock");
        _check(registry.isOperator(OPERATOR) && !registry.isOperator(PUBLISHER), "operators");
        _check(registry.isPublisher(PUBLISHER) && !registry.isPublisher(OPERATOR), "publishers");
        _eq(registry.routerVersion(router), 212, "router 2.1.2");
        _eq(registry.routerVersion(secondRouter), 0, "unknown router");
        _eq(registry.chargeCurrencyRank(stable), 1, "stable first");
        _eq(registry.chargeCurrencyRank(address(0)), 2, "native second");
        _eq(registry.chargeCurrencyRank(wrapped), 2, "wrapped second");
        _eq(registry.chargeCurrencyRank(token), 0, "other token");
        _eq(registry.observationEpoch(), 0, "epoch");
        _check(!registry.automationHalted(), "automation on");
    }

    function testDeploymentEmitsTheInitialState() public {
        vm.recordLogs();
        DominoRegistry fresh = new DominoRegistry(_base());
        V2Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32[9] memory expected = [
            IDominoRegistry.GovernanceTransferred.selector,
            IDominoRegistry.GuardianChanged.selector,
            IDominoRegistry.FeeRecipientSet.selector,
            IDominoRegistry.OperatorSet.selector,
            IDominoRegistry.PublisherSet.selector,
            IDominoRegistry.RouterSet.selector,
            IDominoRegistry.ChargeCurrencySet.selector,
            IDominoRegistry.ChargeCurrencySet.selector,
            IDominoRegistry.ChargeCurrencySet.selector
        ];
        _eq(logs.length, expected.length, "initial events");
        for (uint256 i; i < expected.length; ++i) {
            _check(logs[i].topics[0] == expected[i] && logs[i].emitter == address(fresh), "initial event order");
        }
    }

    // ----------------------------------------------------- unauthorized
    function testOnlyGovernanceSchedulesExecutesAndTransfers() public {
        bytes32 id = _schedule(RECIPIENT_KIND, abi.encode(NEWCOMER));
        _wait();
        address[5] memory callers = [GUARDIAN, OPERATOR, PUBLISHER, RECIPIENT, STRANGER];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(IDominoRegistry.Unauthorized.selector);
            registry.scheduleChange(RECIPIENT_KIND, abi.encode(callers[i]));
            vm.prank(callers[i]);
            vm.expectRevert(IDominoRegistry.Unauthorized.selector);
            registry.executeChange(id);
            vm.prank(callers[i]);
            vm.expectRevert(IDominoRegistry.Unauthorized.selector);
            registry.transferGovernance(callers[i]);
        }
        _execute(id);
        _check(registry.feeRecipient() == NEWCOMER, "governance executes");
    }

    function testOnlyGuardianOrGovernanceNarrow() public {
        bytes32 id = _schedule(RECIPIENT_KIND, abi.encode(NEWCOMER));
        address[4] memory callers = _outsiders();
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(IDominoRegistry.Unauthorized.selector);
            registry.removeOperator(OPERATOR);
            vm.expectRevert(IDominoRegistry.Unauthorized.selector);
            registry.removePublisher(PUBLISHER);
            vm.expectRevert(IDominoRegistry.Unauthorized.selector);
            registry.removeRouter(router);
            vm.expectRevert(IDominoRegistry.Unauthorized.selector);
            registry.raiseObservationEpoch(uint64(clock));
            vm.expectRevert(IDominoRegistry.Unauthorized.selector);
            registry.haltAutomation();
            vm.expectRevert(IDominoRegistry.Unauthorized.selector);
            registry.cancelChange(id);
            vm.stopPrank();
        }
        _check(registry.isOperator(OPERATOR) && registry.isPublisher(PUBLISHER), "roles intact");
        _check(registry.routerVersion(router) == 212 && !registry.automationHalted(), "router and automation intact");
    }

    function testAcceptGovernanceNeedsThePendingAddress() public {
        vm.prank(STRANGER);
        vm.expectRevert(IDominoRegistry.Unauthorized.selector);
        registry.acceptGovernance();
        vm.prank(GOVERNANCE);
        registry.transferGovernance(NEWCOMER);
        vm.prank(STRANGER);
        vm.expectRevert(IDominoRegistry.Unauthorized.selector);
        registry.acceptGovernance();
        vm.prank(GOVERNANCE);
        vm.expectRevert(IDominoRegistry.Unauthorized.selector);
        registry.acceptGovernance();
    }

    // ---------------------------------------------------------- timelock
    function testChangeExecutesOnlyAfterTheTimelock() public {
        uint256 scheduledAt = clock;
        bytes32 id = _schedule(RECIPIENT_KIND, abi.encode(NEWCOMER));
        (bytes32 kind, bytes memory data, uint64 recordedAt, uint64 executableAt) = registry.pendingChange(id);
        _check(kind == RECIPIENT_KIND && keccak256(data) == keccak256(abi.encode(NEWCOMER)), "pending change");
        _eq(recordedAt, scheduledAt, "scheduled at");
        _eq(executableAt, scheduledAt + TIMELOCK, "executable at");
        _warpTo(scheduledAt + TIMELOCK - 1);
        vm.prank(GOVERNANCE);
        vm.expectRevert(IDominoRegistry.ChangeNotReady.selector);
        registry.executeChange(id);
        _check(registry.feeRecipient() == RECIPIENT, "nothing before the delay");
        _warpTo(scheduledAt + TIMELOCK);
        _execute(id);
        _check(registry.feeRecipient() == NEWCOMER, "applied at the delay");
        (,,, executableAt) = registry.pendingChange(id);
        _eq(executableAt, 0, "spent");
        _refuseExecution(id);
    }

    function testUnknownChangeCannotBeExecutedOrCancelled() public {
        bytes32 id = keccak256("never scheduled");
        _refuseExecution(id);
        vm.prank(GOVERNANCE);
        vm.expectRevert(IDominoRegistry.InvalidChange.selector);
        registry.cancelChange(id);
        vm.prank(GUARDIAN);
        vm.expectRevert(IDominoRegistry.InvalidChange.selector);
        registry.cancelChange(id);
    }

    function testScheduleAndExecuteEmitTheChange() public {
        bytes memory data = abi.encode(NEWCOMER);
        vm.expectEmit(false, true, false, true, address(registry));
        emit IDominoRegistry.ChangeScheduled(bytes32(0), RECIPIENT_KIND, data, uint64(clock) + TIMELOCK);
        bytes32 id = _schedule(RECIPIENT_KIND, data);
        _wait();
        vm.expectEmit(true, false, false, false, address(registry));
        emit IDominoRegistry.FeeRecipientSet(NEWCOMER);
        vm.expectEmit(true, true, false, true, address(registry));
        emit IDominoRegistry.ChangeExecuted(id, RECIPIENT_KIND, data);
        _execute(id);
    }

    function testIdenticalChangesGetDistinctIds() public {
        bytes32 first = _schedule(RECIPIENT_KIND, abi.encode(NEWCOMER));
        bytes32 second = _schedule(RECIPIENT_KIND, abi.encode(NEWCOMER));
        _check(first != second, "distinct ids");
        vm.prank(GOVERNANCE);
        registry.cancelChange(first);
        _wait();
        _execute(second);
        _check(registry.feeRecipient() == NEWCOMER, "second applies");
    }

    function testNewTimelockAppliesToLaterChangesOnly() public {
        uint256 start = clock;
        bytes32 early = _schedule(RECIPIENT_KIND, abi.encode(NEWCOMER));
        bytes32 longer = _schedule(TIMELOCK_KIND, abi.encode(uint32(7 days)));
        _wait();
        _execute(longer);
        _eq(registry.timelockSeconds(), 7 days, "timelock raised");
        (,,, uint64 earlyAt) = registry.pendingChange(early);
        _eq(earlyAt, start + TIMELOCK, "earlier change keeps its delay");
        bytes32 late = _schedule(RECIPIENT_KIND, abi.encode(STRANGER));
        (,,, uint64 lateAt) = registry.pendingChange(late);
        _eq(lateAt, clock + 7 days, "later change waits longer");
        _execute(early);
        _warpTo(lateAt - 1);
        vm.prank(GOVERNANCE);
        vm.expectRevert(IDominoRegistry.ChangeNotReady.selector);
        registry.executeChange(late);
    }

    function testCancelledChangeNeverExecutes() public {
        bytes32 byGovernance = _schedule(RECIPIENT_KIND, abi.encode(NEWCOMER));
        bytes32 byGuardian = _schedule(OPERATOR_KIND, abi.encode(NEWCOMER, true));
        vm.expectEmit(true, false, false, false, address(registry));
        emit IDominoRegistry.ChangeCancelled(byGovernance);
        vm.prank(GOVERNANCE);
        registry.cancelChange(byGovernance);
        vm.prank(GUARDIAN);
        registry.cancelChange(byGuardian);
        _wait();
        _refuseExecution(byGovernance);
        _refuseExecution(byGuardian);
        _check(registry.feeRecipient() == RECIPIENT && !registry.isOperator(NEWCOMER), "nothing applied");
    }

    /// The guardian vetoes any widening, but not its own replacement: a lost
    /// or compromised guardian could otherwise block governance forever.
    function testGuardianCannotCancelAGuardianChange() public {
        bytes32 id = _schedule(GUARDIAN_KIND, abi.encode(NEWCOMER));
        vm.prank(GUARDIAN);
        vm.expectRevert(IDominoRegistry.Unauthorized.selector);
        registry.cancelChange(id);
        _wait();
        _execute(id);
        _check(registry.guardian() == NEWCOMER, "guardian replaced");
        bytes32 again = _schedule(GUARDIAN_KIND, abi.encode(GUARDIAN));
        vm.prank(GOVERNANCE);
        registry.cancelChange(again);
        _wait();
        _refuseExecution(again);
    }

    function testGuardianVetoesEveryOtherKind() public {
        bytes[8] memory data = [
            abi.encode(NEWCOMER, true),
            abi.encode(STRANGER, true),
            abi.encode(secondRouter, uint16(212)),
            abi.encode(token, uint8(1)),
            abi.encode(NEWCOMER),
            abi.encode(uint32(1 hours)),
            bytes(""),
            abi.encode(OPERATOR, false)
        ];
        bytes32[8] memory kinds =
            [OPERATOR_KIND, PUBLISHER_KIND, ROUTER_KIND, CURRENCY_KIND, RECIPIENT_KIND, TIMELOCK_KIND, RESUME_KIND, OPERATOR_KIND];
        for (uint256 i; i < kinds.length; ++i) {
            bytes32 id = _schedule(kinds[i], data[i]);
            vm.prank(GUARDIAN);
            registry.cancelChange(id);
            (,,, uint64 executableAt) = registry.pendingChange(id);
            _eq(executableAt, 0, "vetoed");
        }
    }

    // ------------------------------------------------ guardian narrows
    function testGuardianNarrowsAtOnce() public {
        vm.startPrank(GUARDIAN);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IDominoRegistry.OperatorSet(OPERATOR, false);
        registry.removeOperator(OPERATOR);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IDominoRegistry.PublisherSet(PUBLISHER, false);
        registry.removePublisher(PUBLISHER);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IDominoRegistry.RouterSet(router, 0);
        registry.removeRouter(router);
        vm.expectEmit(false, false, false, true, address(registry));
        emit IDominoRegistry.ObservationEpochRaised(uint64(clock));
        registry.raiseObservationEpoch(uint64(clock));
        vm.expectEmit(false, false, false, true, address(registry));
        emit IDominoRegistry.AutomationHaltSet(true);
        registry.haltAutomation();
        vm.stopPrank();
        _check(!registry.isOperator(OPERATOR) && !registry.isPublisher(PUBLISHER), "roles removed");
        _eq(registry.routerVersion(router), 0, "router removed");
        _eq(registry.observationEpoch(), clock, "epoch raised");
        _check(registry.automationHalted(), "halted");
        _eq(registry.haltedAt(), clock, "halt time");
        _eq(registry.removedAt(OPERATOR_KIND, OPERATOR), clock, "operator removal time");
        _eq(registry.removedAt(PUBLISHER_KIND, PUBLISHER), clock, "publisher removal time");
        _eq(registry.removedAt(ROUTER_KIND, router), clock, "router removal time");
    }

    function testGovernanceMayNarrowAtOnceToo() public {
        vm.startPrank(GOVERNANCE);
        registry.removeOperator(OPERATOR);
        registry.removePublisher(PUBLISHER);
        registry.removeRouter(router);
        registry.raiseObservationEpoch(uint64(clock));
        registry.haltAutomation();
        vm.stopPrank();
        _check(!registry.isOperator(OPERATOR) && !registry.isPublisher(PUBLISHER), "roles removed");
        _check(registry.routerVersion(router) == 0 && registry.automationHalted(), "router removed, halted");
    }

    function testEpochOnlyRisesAndNeverPassesNow() public {
        vm.startPrank(GUARDIAN);
        vm.expectRevert(IDominoRegistry.InvalidChange.selector);
        registry.raiseObservationEpoch(uint64(clock) + 1);
        registry.raiseObservationEpoch(uint64(clock) - 10);
        vm.expectRevert(IDominoRegistry.InvalidChange.selector);
        registry.raiseObservationEpoch(uint64(clock) - 10);
        vm.expectRevert(IDominoRegistry.InvalidChange.selector);
        registry.raiseObservationEpoch(uint64(clock) - 11);
        registry.raiseObservationEpoch(uint64(clock));
        vm.stopPrank();
        _eq(registry.observationEpoch(), clock, "epoch at now");
    }

    function testRemovalVoidsAReadmissionScheduledBeforeIt() public {
        bytes32 operatorBack = _schedule(OPERATOR_KIND, abi.encode(OPERATOR, true));
        bytes32 publisherBack = _schedule(PUBLISHER_KIND, abi.encode(PUBLISHER, true));
        bytes32 routerBack = _schedule(ROUTER_KIND, abi.encode(router, uint16(212)));
        _advance(1);
        vm.startPrank(GUARDIAN);
        registry.removeOperator(OPERATOR);
        registry.removePublisher(PUBLISHER);
        registry.removeRouter(router);
        vm.stopPrank();
        _wait();
        _refuseExecution(operatorBack);
        _refuseExecution(publisherBack);
        _refuseExecution(routerBack);
        _check(!registry.isOperator(OPERATOR) && !registry.isPublisher(PUBLISHER), "still removed");
        _eq(registry.routerVersion(router), 0, "router still removed");
    }

    function testRemovalInTheSameSecondVoidsTheReadmission() public {
        bytes32 back = _schedule(OPERATOR_KIND, abi.encode(OPERATOR, true));
        vm.prank(GUARDIAN);
        registry.removeOperator(OPERATOR);
        _wait();
        _refuseExecution(back);
    }

    function testReadmissionScheduledAfterTheRemovalExecutes() public {
        vm.startPrank(GUARDIAN);
        registry.removeOperator(OPERATOR);
        registry.removePublisher(PUBLISHER);
        registry.removeRouter(router);
        vm.stopPrank();
        _advance(1);
        bytes32 operatorBack = _schedule(OPERATOR_KIND, abi.encode(OPERATOR, true));
        bytes32 publisherBack = _schedule(PUBLISHER_KIND, abi.encode(PUBLISHER, true));
        bytes32 routerBack = _schedule(ROUTER_KIND, abi.encode(router, uint16(212)));
        _wait();
        _execute(operatorBack);
        _execute(publisherBack);
        _execute(routerBack);
        _check(registry.isOperator(OPERATOR) && registry.isPublisher(PUBLISHER), "readmitted");
        _eq(registry.routerVersion(router), 212, "router readmitted");
    }

    /// Removing an address that holds no role still records the removal, so
    /// the guardian can void pending admissions without knowing their ids.
    function testRemovingANonMemberVoidsItsPendingAdmission() public {
        bytes32 operatorAdd = _schedule(OPERATOR_KIND, abi.encode(NEWCOMER, true));
        bytes32 publisherAdd = _schedule(PUBLISHER_KIND, abi.encode(STRANGER, true));
        bytes32 routerAdd = _schedule(ROUTER_KIND, abi.encode(secondRouter, uint16(212)));
        _advance(1);
        vm.startPrank(GUARDIAN);
        registry.removeOperator(NEWCOMER);
        registry.removePublisher(STRANGER);
        registry.removeRouter(secondRouter);
        vm.stopPrank();
        _wait();
        _refuseExecution(operatorAdd);
        _refuseExecution(publisherAdd);
        _refuseExecution(routerAdd);
    }

    function testHaltLastsUntilAResumeScheduledAfterIt() public {
        vm.prank(GUARDIAN);
        registry.haltAutomation();
        _advance(1);
        bytes32 resume = _schedule(RESUME_KIND, "");
        _wait();
        _check(registry.automationHalted(), "halted during the delay");
        vm.expectEmit(false, false, false, true, address(registry));
        emit IDominoRegistry.AutomationHaltSet(false);
        _execute(resume);
        _check(!registry.automationHalted(), "resumed");
    }

    function testResumeScheduledBeforeTheLatestHaltIsVoid() public {
        bytes32 stale = _schedule(RESUME_KIND, "");
        _advance(1);
        vm.prank(GUARDIAN);
        registry.haltAutomation();
        _wait();
        _refuseExecution(stale);
        _check(registry.automationHalted(), "still halted");
    }

    function testHaltingAgainRestartsTheClock() public {
        vm.prank(GUARDIAN);
        registry.haltAutomation();
        _advance(1);
        bytes32 resume = _schedule(RESUME_KIND, "");
        _advance(1);
        vm.prank(GUARDIAN);
        registry.haltAutomation();
        _eq(registry.haltedAt(), clock, "halt time refreshed");
        _wait();
        _refuseExecution(resume);
        _check(registry.automationHalted(), "still halted");
    }

    // ------------------------------------------------------ change kinds
    function testUnknownKindIsRefused() public {
        _refuse(keccak256("domino.registry.unknown"), abi.encode(NEWCOMER));
        _refuse(bytes32(0), "");
    }

    function testOperatorAndPublisherChanges() public {
        _enact(OPERATOR_KIND, abi.encode(NEWCOMER, true));
        _check(registry.isOperator(NEWCOMER), "operator added");
        _enact(OPERATOR_KIND, abi.encode(OPERATOR, false));
        _check(!registry.isOperator(OPERATOR), "operator removed");
        _eq(registry.removedAt(OPERATOR_KIND, OPERATOR), clock, "scheduled removal is a removal");
        _enact(PUBLISHER_KIND, abi.encode(STRANGER, true));
        _check(registry.isPublisher(STRANGER), "publisher added");
        _enact(PUBLISHER_KIND, abi.encode(PUBLISHER, false));
        _check(!registry.isPublisher(PUBLISHER), "publisher removed");
        _eq(registry.removedAt(PUBLISHER_KIND, PUBLISHER), clock, "scheduled publisher removal");
    }

    function testRoleChangesRefuseNonCanonicalData() public {
        bytes32[2] memory kinds = [OPERATOR_KIND, PUBLISHER_KIND];
        for (uint256 i; i < kinds.length; ++i) {
            _refuse(kinds[i], abi.encode(NEWCOMER));
            _refuse(kinds[i], abi.encode(NEWCOMER, true, uint256(0)));
            _refuse(kinds[i], abi.encode(address(0), true));
            _refuse(kinds[i], abi.encode(uint256(uint160(NEWCOMER)) | (1 << 160), true));
            _refuse(kinds[i], abi.encode(NEWCOMER, uint256(2)));
        }
    }

    function testOperatorsAndPublishersStayDisjoint() public {
        bytes32 publisherAsOperator = _schedule(OPERATOR_KIND, abi.encode(PUBLISHER, true));
        bytes32 operatorAsPublisher = _schedule(PUBLISHER_KIND, abi.encode(OPERATOR, true));
        _wait();
        _refuseExecution(publisherAsOperator);
        _refuseExecution(operatorAsPublisher);
        vm.prank(GUARDIAN);
        registry.removePublisher(PUBLISHER);
        _advance(1);
        _enact(OPERATOR_KIND, abi.encode(PUBLISHER, true));
        _check(registry.isOperator(PUBLISHER), "a former publisher may operate");
    }

    /// Owner decision (2 Oct 2026): Universal Router 2.1.2 or later. The sunset
    /// 2.0 and 2.1.1 (and anything older) stay refused.
    function testRouterVersionsFrom212AreAdmitted() public {
        uint16[5] memory refused = [uint16(211), 210, 200, 199, 1];
        for (uint256 i; i < refused.length; ++i) {
            _refuse(ROUTER_KIND, abi.encode(secondRouter, refused[i]));
        }
        _refuse(ROUTER_KIND, abi.encode(secondRouter, uint256(212) | (1 << 16)));
        _refuse(ROUTER_KIND, abi.encode(address(0xDEAD), uint16(212)));
        _refuse(ROUTER_KIND, abi.encode(address(0xDEAD), uint16(213)));
        _refuse(ROUTER_KIND, abi.encode(address(0), uint16(0)));
        _refuse(ROUTER_KIND, abi.encode(secondRouter));
        uint16[4] memory admitted = [uint16(212), 213, 220, type(uint16).max];
        for (uint256 i; i < admitted.length; ++i) {
            address candidate = address(new CodeStub());
            bytes32 admit = _schedule(ROUTER_KIND, abi.encode(candidate, admitted[i]));
            _wait();
            vm.expectEmit(true, false, false, true, address(registry));
            emit IDominoRegistry.RouterSet(candidate, admitted[i]);
            _execute(admit);
            _eq(registry.routerVersion(candidate), admitted[i], "admitted version");
        }
        _enact(ROUTER_KIND, abi.encode(router, uint16(0)));
        _eq(registry.routerVersion(router), 0, "version 0 removes");
        _eq(registry.removedAt(ROUTER_KIND, router), clock, "scheduled router removal");
        _enact(ROUTER_KIND, abi.encode(address(0xDEAD), uint16(0)));
    }

    function testDeploymentAdmitsItsRoutersAt212() public view {
        _eq(registry.MIN_UNIVERSAL_ROUTER_VERSION(), 212, "minimum version");
        _eq(registry.routerVersion(router), 212, "deployment router");
    }

    function testChargeCurrencyRanksChange() public {
        _enact(CURRENCY_KIND, abi.encode(address(0), uint8(1)));
        _enact(CURRENCY_KIND, abi.encode(stable, uint8(2)));
        _enact(CURRENCY_KIND, abi.encode(token, uint8(3)));
        _eq(registry.chargeCurrencyRank(address(0)), 1, "native first");
        _eq(registry.chargeCurrencyRank(stable), 2, "stable second");
        _eq(registry.chargeCurrencyRank(token), 3, "token third");
        bytes32 drop = _schedule(CURRENCY_KIND, abi.encode(wrapped, uint8(0)));
        _wait();
        vm.expectEmit(true, false, false, true, address(registry));
        emit IDominoRegistry.ChargeCurrencySet(wrapped, 0);
        _execute(drop);
        _eq(registry.chargeCurrencyRank(wrapped), 0, "rank 0 removes");
        _enact(CURRENCY_KIND, abi.encode(address(0xDEAD), uint8(0)));
    }

    function testChargeCurrencyRefusesNonCanonicalData() public {
        _refuse(CURRENCY_KIND, abi.encode(address(0xDEAD), uint8(1)));
        _refuse(CURRENCY_KIND, abi.encode(token, uint256(256)));
        _refuse(CURRENCY_KIND, abi.encode(uint256(uint160(token)) | (1 << 200), uint8(1)));
        _refuse(CURRENCY_KIND, abi.encode(token));
        _refuse(CURRENCY_KIND, abi.encode(token, uint8(1), uint8(1)));
    }

    function testFeeRecipientChange() public {
        _refuse(RECIPIENT_KIND, abi.encode(address(0)));
        _refuse(RECIPIENT_KIND, abi.encode(NEWCOMER, uint256(0)));
        _refuse(RECIPIENT_KIND, abi.encode(uint256(uint160(NEWCOMER)) | (1 << 255)));
        _enact(RECIPIENT_KIND, abi.encode(NEWCOMER));
        _check(registry.feeRecipient() == NEWCOMER, "recipient changed");
    }

    function testGuardianChangeMovesTheNarrowingPowers() public {
        _refuse(GUARDIAN_KIND, abi.encode(address(0)));
        _refuse(GUARDIAN_KIND, "");
        bytes32 change = _schedule(GUARDIAN_KIND, abi.encode(NEWCOMER));
        _wait();
        vm.expectEmit(true, true, false, false, address(registry));
        emit IDominoRegistry.GuardianChanged(GUARDIAN, NEWCOMER);
        _execute(change);
        _check(registry.guardian() == NEWCOMER, "guardian changed");
        vm.prank(GUARDIAN);
        vm.expectRevert(IDominoRegistry.Unauthorized.selector);
        registry.haltAutomation();
        vm.prank(NEWCOMER);
        registry.haltAutomation();
        _check(registry.automationHalted(), "new guardian halts");
    }

    function testTimelockChangeStaysWithinItsBounds() public {
        _refuse(TIMELOCK_KIND, abi.encode(uint32(1 hours - 1)));
        _refuse(TIMELOCK_KIND, abi.encode(uint32(30 days + 1)));
        _refuse(TIMELOCK_KIND, abi.encode(uint256(1 hours) | (1 << 32)));
        _refuse(TIMELOCK_KIND, abi.encode(uint32(1 hours), uint32(0)));
        _enact(TIMELOCK_KIND, abi.encode(uint32(1 hours)));
        _eq(registry.timelockSeconds(), 1 hours, "minimum");
        _enact(TIMELOCK_KIND, abi.encode(uint32(30 days)));
        _eq(registry.timelockSeconds(), 30 days, "maximum");
    }

    function testResumeTakesNoData() public {
        _refuse(RESUME_KIND, abi.encode(uint256(0)));
        _refuse(RESUME_KIND, hex"00");
    }

    function testRemovedAtNamesOnlyRoleKinds() public {
        vm.expectRevert(IDominoRegistry.InvalidChange.selector);
        registry.removedAt(RECIPIENT_KIND, OPERATOR);
    }

    // -------------------------------------------------------- governance
    function testGovernanceTransferIsTwoStep() public {
        vm.expectEmit(true, true, false, false, address(registry));
        emit IDominoRegistry.GovernanceTransferStarted(GOVERNANCE, NEWCOMER);
        vm.prank(GOVERNANCE);
        registry.transferGovernance(NEWCOMER);
        _check(registry.governance() == GOVERNANCE && registry.pendingGovernance() == NEWCOMER, "pending");
        vm.expectEmit(true, true, false, false, address(registry));
        emit IDominoRegistry.GovernanceTransferred(GOVERNANCE, NEWCOMER);
        vm.prank(NEWCOMER);
        registry.acceptGovernance();
        _check(registry.governance() == NEWCOMER && registry.pendingGovernance() == address(0), "transferred");
        vm.prank(GOVERNANCE);
        vm.expectRevert(IDominoRegistry.Unauthorized.selector);
        registry.scheduleChange(RECIPIENT_KIND, abi.encode(GOVERNANCE));
        vm.prank(NEWCOMER);
        registry.scheduleChange(RECIPIENT_KIND, abi.encode(NEWCOMER));
    }

    function testGovernanceTransferCanBeWithdrawn() public {
        vm.startPrank(GOVERNANCE);
        registry.transferGovernance(NEWCOMER);
        registry.transferGovernance(address(0));
        vm.stopPrank();
        vm.prank(NEWCOMER);
        vm.expectRevert(IDominoRegistry.Unauthorized.selector);
        registry.acceptGovernance();
        _check(registry.governance() == GOVERNANCE, "unchanged");
    }

    // ------------------------------------------------------------- fuzz
    function testFuzzUnknownKindsAreRefused(bytes32 kind, bytes calldata data) public {
        if (
            kind == OPERATOR_KIND || kind == PUBLISHER_KIND || kind == ROUTER_KIND || kind == CURRENCY_KIND
                || kind == RECIPIENT_KIND || kind == GUARDIAN_KIND || kind == TIMELOCK_KIND || kind == RESUME_KIND
        ) return;
        _refuse(kind, data);
    }

    function testFuzzDirtyAddressWordsAreRefused(uint256 word) public {
        if (word >> 160 == 0) word |= 1 << 160;
        _refuse(OPERATOR_KIND, abi.encode(word, true));
        _refuse(RECIPIENT_KIND, abi.encode(word));
        _refuse(CURRENCY_KIND, abi.encode(word, uint8(0)));
    }

    function testRuntimeFitsTheContractSizeLimit() public view {
        _check(address(registry).code.length <= 24_576, "runtime size");
    }
}
