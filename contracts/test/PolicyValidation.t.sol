// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FeeAccounting} from "../src/FeeAccounting.sol";
import {IDominoVaultDraft} from "../src/IDominoVaultDraft.sol";
import {PolicyValidation} from "../src/PolicyValidation.sol";
import {PolicyWriteHarness} from "./helpers/PolicyWriteHarness.sol";

// Minimal Foundry log inspection only; no forge-std dependency or external calls.
interface VmPolicyLogs {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract PolicyCaller {
    function invoke(address target, bytes memory data) external returns (bool, bytes memory) {
        return target.call(data);
    }
}

contract PolicyValidationTest {
    VmPolicyLogs private constant vm = VmPolicyLogs(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Synthetic values for tests, not product defaults or real position IDs.
    function fixture() private pure returns (IDominoVaultDraft.Policy memory) {
        return IDominoVaultDraft.Policy(400, 500, 1000, 60, 3, 1, false);
    }

    function harness(address operator, uint256 childCount) private returns (PolicyWriteHarness) {
        uint256[] memory children = new uint256[](childCount);
        for (uint256 i; i < childCount; i++) {
            children[i] = 12 + i;
        }
        return new PolicyWriteHarness(address(this), operator, fixture(), 11, children);
    }

    function exposedInitial(IDominoVaultDraft.Policy calldata initial, uint256 count) external pure {
        PolicyValidation.validateInitial(initial, count);
    }

    function exposedUpdate(
        IDominoVaultDraft.Policy calldata current,
        IDominoVaultDraft.Policy calldata next,
        uint256 count
    ) external pure {
        PolicyValidation.validateUpdate(current, next, count);
    }

    function exposedDeploy(IDominoVaultDraft.Policy calldata initial, uint256 childCount) external returns (address) {
        uint256[] memory children = new uint256[](childCount);
        for (uint256 i; i < childCount; i++) {
            children[i] = 12 + i;
        }
        return address(new PolicyWriteHarness(address(this), address(0), initial, 11, children));
    }

    function assertError(bool ok, bytes memory data, bytes4 selector) private pure {
        require(!ok && keccak256(data) == keccak256(abi.encodeWithSelector(selector)), "wrong error selector");
    }

    function assertStored(PolicyWriteHarness vault, IDominoVaultDraft.Policy memory expected, uint64 nonce)
        private
        view
    {
        require(keccak256(abi.encode(vault.policy())) == keccak256(abi.encode(expected)), "unexpected policy mutation");
        require(vault.stateNonce() == nonce, "unexpected nonce mutation");
    }

    function assertReserves(PolicyWriteHarness vault, uint256 tokenId, uint128 amount0, uint128 amount1)
        private
        view
    {
        uint128[2] memory balance = vault.reservesForTest(tokenId);
        require(balance[0] == amount0 && balance[1] == amount1, "unexpected reserve mutation");
    }

    function testInclusiveBoundsAndIndependentGeometry() public pure {
        IDominoVaultDraft.Policy memory value = IDominoVaultDraft.Policy(200, 0, 2000, 1, 1, 1, true);
        PolicyValidation.validateInitial(value, 1);
        value.serviceFeeBps = 400;
        value.triggerDistanceBps = 2000;
        value.maxOverlapBps = 0;
        value.minimumIntervalSeconds = type(uint32).max;
        value.maxPositions = type(uint8).max;
        PolicyValidation.validateInitial(value, type(uint8).max);
    }

    function testInitializationRejectsInvalidStoredPolicy() public {
        IDominoVaultDraft.Policy memory value = fixture();
        value.serviceFeeBps = 201;
        (bool ok, bytes memory data) = address(this).call(abi.encodeCall(this.exposedDeploy, (value, 0)));
        assertError(ok, data, FeeAccounting.ExcessiveFee.selector);
        for (uint64 version; version < 3; version += 2) {
            value = fixture();
            value.version = version;
            (ok, data) = address(this).call(abi.encodeCall(this.exposedDeploy, (value, 0)));
            assertError(ok, data, PolicyValidation.InvalidPolicyVersion.selector);
        }
    }

    function testInitialMembershipAcceptsExactCapAndRejectsZeroOrAbove() public {
        IDominoVaultDraft.Policy memory value = fixture();
        PolicyValidation.validateInitial(value, 1);
        PolicyValidation.validateInitial(value, value.maxPositions);
        uint256[2] memory rejected = [uint256(0), uint256(value.maxPositions) + 1];
        for (uint256 i; i < rejected.length; i++) {
            (bool ok, bytes memory data) = address(this).call(abi.encodeCall(this.exposedInitial, (value, rejected[i])));
            assertError(ok, data, PolicyValidation.PositionLimitBelowMembership.selector);
        }
    }

    function testConstructorMembershipRejectsRootPlusChildrenAboveCap() public {
        IDominoVaultDraft.Policy memory value = fixture();
        PolicyWriteHarness vault = PolicyWriteHarness(this.exposedDeploy(value, 2));
        require(vault.registeredPositions() == value.maxPositions);
        assertStored(vault, value, 0);
        (bool ok, bytes memory data) = address(this).call(abi.encodeCall(this.exposedDeploy, (value, 3)));
        assertError(ok, data, PolicyValidation.PositionLimitBelowMembership.selector);
        assertStored(vault, value, 0);
        require(vault.registeredPositions() == 3);
    }

    function testEveryPolicyGuardRejectsAtWriteWithoutMutation() public {
        PolicyWriteHarness vault = harness(address(0), 0);
        for (uint8 field; field < 9; field++) {
            IDominoVaultDraft.Policy memory next = fixture();
            next.version = 2;
            bytes4 selector;
            if (field == 0) {
                next.serviceFeeBps = 201;
                selector = FeeAccounting.ExcessiveFee.selector;
            } else if (field == 1) {
                next.triggerDistanceBps = 2001;
                selector = PolicyValidation.ExcessiveTriggerDistance.selector;
            } else if (field == 2) {
                next.maxOverlapBps = 2001;
                selector = PolicyValidation.ExcessiveOverlap.selector;
            } else if (field == 3) {
                next.minimumIntervalSeconds = 0;
                selector = PolicyValidation.InvalidMinimumInterval.selector;
            } else if (field == 4) {
                next.maxPositions = 0;
                selector = PolicyValidation.InvalidMaxPositions.selector;
            } else if (field == 5) {
                next.version = 0;
                selector = PolicyValidation.InvalidPolicyVersion.selector;
            } else if (field == 6) {
                next.version = 1;
                selector = PolicyValidation.InvalidPolicyVersion.selector;
            } else if (field == 7) {
                next.version = 3;
                selector = PolicyValidation.InvalidPolicyVersion.selector;
            } else {
                next.paused = true;
                selector = PolicyValidation.PauseChangeRequiresTransition.selector;
            }
            (bool ok, bytes memory data) = address(vault).call(abi.encodeCall(vault.setPolicy, (next)));
            assertError(ok, data, selector);
            assertStored(vault, fixture(), 0);
        }
    }

    function testPositionLimitCountsRootAndHeldChildren() public {
        PolicyWriteHarness vault = harness(address(0), 2);
        IDominoVaultDraft.Policy memory next = fixture();
        next.version = 2;
        next.maxPositions = 2;
        (bool ok, bytes memory data) = address(vault).call(abi.encodeCall(vault.setPolicy, (next)));
        assertError(ok, data, PolicyValidation.PositionLimitBelowMembership.selector);
        assertStored(vault, fixture(), 0);
        vault.withdrawChildPosition(12);
        vault.setPolicy(next);
        assertStored(vault, next, 2);
        require(vault.registeredPositions() == 2);
        (ok, data) = address(this).call(abi.encodeCall(this.exposedUpdate, (next, next, 0)));
        assertError(ok, data, PolicyValidation.InvalidPolicyVersion.selector);
        IDominoVaultDraft.Policy memory later = fixture();
        later.version = 3;
        later.maxPositions = 2;
        (ok, data) = address(this).call(abi.encodeCall(this.exposedUpdate, (next, later, 0)));
        assertError(ok, data, PolicyValidation.PositionLimitBelowMembership.selector);
    }

    function testOwnerOnlyWritesAndExitsRejectOperatorAndStranger() public {
        PolicyCaller operator = new PolicyCaller();
        PolicyCaller stranger = new PolicyCaller();
        PolicyWriteHarness vault = harness(address(operator), 1);
        vault.seedReservesForTest(11, 100, 200);
        IDominoVaultDraft.Policy memory next = fixture();
        next.version = 2;
        bytes[] memory actions = new bytes[](4);
        actions[0] = abi.encodeCall(vault.setPolicy, (next));
        actions[1] = abi.encodeCall(vault.resume, ());
        actions[2] = abi.encodeCall(vault.withdrawFeeReserves, (11, 100, 200));
        actions[3] = abi.encodeCall(vault.withdrawChildPosition, (12));
        bool ok;
        bytes memory data;
        for (uint256 i; i < actions.length; i++) {
            (ok, data) = operator.invoke(address(vault), actions[i]);
            assertError(ok, data, PolicyWriteHarness.OwnerOnly.selector);
            (ok, data) = stranger.invoke(address(vault), actions[i]);
            assertError(ok, data, PolicyWriteHarness.OwnerOnly.selector);
        }
        (ok, data) = stranger.invoke(address(vault), abi.encodeCall(vault.pause, ()));
        assertError(ok, data, PolicyWriteHarness.OwnerOrOperatorOnly.selector);
        (ok, data) = stranger.invoke(address(vault), abi.encodeCall(vault.assertPlanFresh, (1, 0)));
        assertError(ok, data, PolicyWriteHarness.OwnerOrOperatorOnly.selector);
        assertStored(vault, fixture(), 0);
        require(
            vault.isOperator(address(operator)) && !vault.isOperator(address(stranger)) && !vault.isOperator(address(0))
        );
    }

    function testPauseAndOwnerOnlyResumeEmitExactTransitions() public {
        PolicyCaller operator = new PolicyCaller();
        PolicyWriteHarness vault = harness(address(operator), 0);
        vm.recordLogs();
        (bool ok,) = operator.invoke(address(vault), abi.encodeCall(vault.pause, ()));
        require(ok);
        VmPolicyLogs.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].emitter == address(vault));
        require(logs[0].topics.length == 3 && logs[0].topics[0] == keccak256("AutomationPaused(address,uint64,uint64)"));
        require(
            logs[0].topics[1] == bytes32(uint256(uint160(address(operator))))
                && logs[0].topics[2] == bytes32(uint256(1))
        );
        require(keccak256(logs[0].data) == keccak256(abi.encode(uint64(1))));
        bytes memory data;
        (ok, data) = operator.invoke(address(vault), abi.encodeCall(vault.resume, ()));
        assertError(ok, data, PolicyWriteHarness.OwnerOnly.selector);
        (ok, data) = address(vault).call(abi.encodeCall(vault.pause, ()));
        assertError(ok, data, PolicyWriteHarness.AlreadyPaused.selector);
        vm.recordLogs();
        vault.resume();
        logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].emitter == address(vault));
        require(logs[0].topics[0] == keccak256("AutomationResumed(address,uint64,uint64)"));
        require(
            logs[0].topics[1] == bytes32(uint256(uint160(address(this)))) && logs[0].topics[2] == bytes32(uint256(1))
        );
        require(keccak256(logs[0].data) == keccak256(abi.encode(uint64(2))));
        (ok, data) = address(vault).call(abi.encodeCall(vault.resume, ()));
        assertError(ok, data, PolicyWriteHarness.AlreadyActive.selector);
        require(vault.stateNonce() == 2 && !vault.policy().paused);
    }

    function testPausedOwnerExitsEmitAmountsRecipientAndChildMembership() public {
        PolicyWriteHarness vault = harness(address(0), 1);
        vault.seedReservesForTest(11, 123, 456);
        vault.seedReservesForTest(12, 7, 8);
        vault.pause();
        vm.recordLogs();
        vault.withdrawFeeReserves(11, 100, 200);
        VmPolicyLogs.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].emitter == address(vault));
        require(logs[0].topics[0] == keccak256("FeeReservesWithdrawn(uint256,address,uint128,uint128,uint64)"));
        require(
            logs[0].topics[1] == bytes32(uint256(11)) && logs[0].topics[2] == bytes32(uint256(uint160(address(this))))
        );
        require(keccak256(logs[0].data) == keccak256(abi.encode(uint128(100), uint128(200), uint64(2))));
        uint128[2] memory left = vault.reservesForTest(11);
        require(left[0] == 23 && left[1] == 256);
        vm.recordLogs();
        vault.withdrawChildPosition(12);
        logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].emitter == address(vault));
        require(logs[0].topics[0] == keccak256("ChildPositionWithdrawn(uint256,address,uint64)"));
        require(
            logs[0].topics[1] == bytes32(uint256(12)) && logs[0].topics[2] == bytes32(uint256(uint160(address(this))))
        );
        require(keccak256(logs[0].data) == keccak256(abi.encode(uint64(3))));
        require(vault.registeredPositions() == 1 && vault.policy().paused);
        vault.withdrawFeeReserves(12, 7, 8); // Historical source reserves remain recoverable.
        left = vault.reservesForTest(12);
        require(left[0] == 0 && left[1] == 0);
        (bool ok, bytes memory data) = address(vault).call(abi.encodeCall(vault.withdrawChildPosition, (12)));
        assertError(ok, data, PolicyWriteHarness.UnknownChild.selector);
        (ok, data) = address(vault).call(abi.encodeCall(vault.withdrawChildPosition, (11)));
        assertError(ok, data, PolicyWriteHarness.UnknownChild.selector);
        require(vault.stateNonce() == 4);
    }

    function testReserveWithdrawalAcceptsExactBalances() public {
        PolicyWriteHarness vault = harness(address(0), 1);
        vault.seedReservesForTest(11, 123, 456);
        vault.seedReservesForTest(12, 7, 8);
        vm.recordLogs();
        vault.withdrawFeeReserves(11, 123, 456);
        VmPolicyLogs.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].emitter == address(vault));
        require(logs[0].topics.length == 3);
        require(logs[0].topics[0] == keccak256("FeeReservesWithdrawn(uint256,address,uint128,uint128,uint64)"));
        require(logs[0].topics[1] == bytes32(uint256(11)));
        require(logs[0].topics[2] == bytes32(uint256(uint160(address(this)))));
        require(keccak256(logs[0].data) == keccak256(abi.encode(uint128(123), uint128(456), uint64(1))));
        assertReserves(vault, 11, 0, 0);
        assertReserves(vault, 12, 7, 8);
        assertStored(vault, fixture(), 1);
        require(vault.registeredPositions() == 2);
    }

    function testReserveOverdrawRejectsEachCurrencyWithExactErrorAndNoMutation() public {
        PolicyWriteHarness vault = harness(address(0), 1);
        vault.seedReservesForTest(11, 123, 456);
        vault.seedReservesForTest(12, 7, 8);
        uint128[2][3] memory requests = [
            [uint128(124), uint128(456)],
            [uint128(123), uint128(457)],
            [uint128(124), uint128(457)]
        ];
        for (uint256 i; i < requests.length; i++) {
            (bool ok, bytes memory data) = address(vault).call(
                abi.encodeCall(vault.withdrawFeeReserves, (11, requests[i][0], requests[i][1]))
            );
            assertError(ok, data, PolicyWriteHarness.InsufficientTrackedReserve.selector);
            assertReserves(vault, 11, 123, 456);
            assertReserves(vault, 12, 7, 8);
            assertStored(vault, fixture(), 0);
            require(vault.registeredPositions() == 2);
        }
    }

    function testUnknownReservePositionRejectsZeroAndNonzeroAmountsWithoutMutation() public {
        PolicyWriteHarness vault = harness(address(0), 1);
        vault.seedReservesForTest(11, 123, 456);
        vault.seedReservesForTest(12, 7, 8);
        for (uint128 amount; amount < 2; amount++) {
            (bool ok, bytes memory data) = address(vault).call(
                abi.encodeCall(vault.withdrawFeeReserves, (999, amount, amount))
            );
            assertError(ok, data, PolicyWriteHarness.UnknownPosition.selector);
            assertReserves(vault, 999, 0, 0);
            assertReserves(vault, 11, 123, 456);
            assertReserves(vault, 12, 7, 8);
            assertStored(vault, fixture(), 0);
            require(vault.registeredPositions() == 2);
        }
    }

    function testPolicyChangeEmitsVersionAndInvalidatesOldPlans() public {
        PolicyWriteHarness vault = harness(address(0), 0);
        IDominoVaultDraft.Policy memory next = fixture();
        next.version = 2;
        next.triggerDistanceBps = 0;
        vm.recordLogs();
        vault.setPolicy(next);
        VmPolicyLogs.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].emitter == address(vault));
        require(logs[0].topics[0] == keccak256("PolicyChanged(uint64)") && logs[0].topics[1] == bytes32(uint256(2)));
        require(logs[0].data.length == 0 && vault.stateNonce() == 1);
        (bool ok, bytes memory data) = address(vault).call(abi.encodeCall(vault.assertPlanFresh, (1, 1)));
        assertError(ok, data, PolicyWriteHarness.StalePolicy.selector);
        vault.assertPlanFresh(2, 1);
    }

    function testPauseResumeAndEachWithdrawalCannotReviveStalePlans() public {
        PolicyCaller operator = new PolicyCaller();
        PolicyWriteHarness vault = harness(address(operator), 1);
        vault.seedReservesForTest(11, 1, 0);
        vault.assertPlanFresh(1, 0);
        vault.pause();
        (bool ok, bytes memory data) = operator.invoke(address(vault), abi.encodeCall(vault.assertPlanFresh, (1, 1)));
        assertError(ok, data, PolicyWriteHarness.AutomationIsPaused.selector);
        vault.resume();
        (ok, data) = operator.invoke(address(vault), abi.encodeCall(vault.assertPlanFresh, (1, 0)));
        assertError(ok, data, PolicyWriteHarness.StaleState.selector);
        (ok,) = operator.invoke(address(vault), abi.encodeCall(vault.assertPlanFresh, (1, 2)));
        require(ok);
        vault.withdrawFeeReserves(11, 1, 0);
        (ok, data) = address(vault).call(abi.encodeCall(vault.assertPlanFresh, (1, 2)));
        assertError(ok, data, PolicyWriteHarness.StaleState.selector);
        vault.withdrawChildPosition(12);
        (ok, data) = address(vault).call(abi.encodeCall(vault.assertPlanFresh, (1, 3)));
        assertError(ok, data, PolicyWriteHarness.StaleState.selector);
        vault.assertPlanFresh(1, 4);
    }

    function testSetPolicyCannotResumeOrPauseThroughBoolean() public {
        PolicyWriteHarness vault = harness(address(0), 0);
        vault.pause();
        IDominoVaultDraft.Policy memory next = fixture();
        next.version = 2;
        (bool ok, bytes memory data) = address(vault).call(abi.encodeCall(vault.setPolicy, (next)));
        assertError(ok, data, PolicyValidation.PauseChangeRequiresTransition.selector);
        next.paused = true;
        vault.setPolicy(next);
        require(vault.policy().paused && vault.stateNonce() == 2);
        vault.resume();
        require(!vault.policy().paused && vault.policy().version == 2 && vault.stateNonce() == 3);
    }

    function testNonceExhaustionFailsWithExactErrorAndNoMutation() public {
        PolicyWriteHarness vault = harness(address(0), 1);
        vault.seedNonceForTest(type(uint64).max);
        IDominoVaultDraft.Policy memory next = fixture();
        next.version = 2;
        bytes[] memory actions = new bytes[](4);
        actions[0] = abi.encodeCall(vault.setPolicy, (next));
        actions[1] = abi.encodeCall(vault.pause, ());
        actions[2] = abi.encodeCall(vault.withdrawFeeReserves, (11, 0, 0));
        actions[3] = abi.encodeCall(vault.withdrawChildPosition, (12));
        for (uint256 i; i < actions.length; i++) {
            (bool ok, bytes memory data) = address(vault).call(actions[i]);
            assertError(ok, data, PolicyWriteHarness.StateNonceExhausted.selector);
            assertStored(vault, fixture(), type(uint64).max);
        }
    }

    function testFuzzPolicyWriteRejectsEveryExcessiveFee(uint16 seed) public {
        PolicyWriteHarness vault = harness(address(0), 0);
        IDominoVaultDraft.Policy memory next = fixture();
        next.version = 2;
        next.serviceFeeBps = 401 + seed % 65135;
        (bool ok, bytes memory data) = address(vault).call(abi.encodeCall(vault.setPolicy, (next)));
        assertError(ok, data, FeeAccounting.ExcessiveFee.selector);
        assertStored(vault, fixture(), 0);
    }

    function testFuzzInvalidGeometryUsesExactErrors(uint16 triggerSeed, uint16 overlapSeed) public {
        IDominoVaultDraft.Policy memory value = fixture();
        value.triggerDistanceBps = 2001 + triggerSeed % 63535;
        (bool ok, bytes memory data) = address(this).call(abi.encodeCall(this.exposedInitial, (value, 1)));
        assertError(ok, data, PolicyValidation.ExcessiveTriggerDistance.selector);
        value = fixture();
        value.maxOverlapBps = 2001 + overlapSeed % 63535;
        (ok, data) = address(this).call(abi.encodeCall(this.exposedInitial, (value, 1)));
        assertError(ok, data, PolicyValidation.ExcessiveOverlap.selector);
    }

    function testExhaustedPolicyVersionRejectsRatherThanWrappingOrPanicking() public {
        IDominoVaultDraft.Policy memory current = fixture();
        current.version = type(uint64).max;
        IDominoVaultDraft.Policy memory next = fixture();
        (bool ok, bytes memory data) = address(this).call(abi.encodeCall(this.exposedUpdate, (current, next, 1)));
        assertError(ok, data, PolicyValidation.InvalidPolicyVersion.selector);
    }

    function testFuzzConsecutiveVersionsNeverWrap(uint64 currentVersion) public {
        IDominoVaultDraft.Policy memory current = fixture();
        current.version = currentVersion;
        IDominoVaultDraft.Policy memory next = fixture();
        next.version = currentVersion == type(uint64).max ? 0 : currentVersion + 1;
        (bool ok, bytes memory data) = address(this).call(abi.encodeCall(this.exposedUpdate, (current, next, 1)));
        if (currentVersion == 0 || currentVersion == type(uint64).max) {
            assertError(ok, data, PolicyValidation.InvalidPolicyVersion.selector);
        } else {
            require(ok);
        }
    }
    function testTariffIsStrictModeAndSimpleCapacityIsOne() public {
        IDominoVaultDraft.Policy memory value = fixture();
        uint16[5] memory invalid = [uint16(0), 199, 201, 399, 401];
        for (uint256 i; i < invalid.length; ++i) {
            value.serviceFeeBps = invalid[i];
            (bool ok, bytes memory data) = address(this).call(abi.encodeCall(this.exposedInitial, (value, 1)));
            assertError(ok, data, FeeAccounting.ExcessiveFee.selector);
        }
        value.serviceFeeBps = 200;
        (bool success, bytes memory reason) = address(this).call(abi.encodeCall(this.exposedInitial, (value, 1)));
        assertError(success, reason, PolicyValidation.InvalidMaxPositions.selector);
        value.maxPositions = 1;
        PolicyValidation.validateInitial(value, 1);
        value.serviceFeeBps = 400;
        PolicyValidation.validateInitial(value, 1); // Domino can also choose capacity one.
    }

    function testDowngradeRequiresWithdrawingChildrenAndInvalidatesOldPolicy() public {
        PolicyWriteHarness vault = harness(address(0), 1);
        IDominoVaultDraft.Policy memory next = fixture();
        next.version = 2; next.serviceFeeBps = 200; next.maxPositions = 1;
        (bool ok, bytes memory reason) = address(vault).call(abi.encodeCall(vault.setPolicy, (next)));
        assertError(ok, reason, PolicyValidation.PositionLimitBelowMembership.selector);
        require(vault.policy().serviceFeeBps == 400 && vault.stateNonce() == 0, "failed mode write mutated");
        vault.withdrawChildPosition(12);
        vault.setPolicy(next);
        require(vault.policy().serviceFeeBps == 200 && vault.stateNonce() == 2, "mode/nonce not advanced");
        next.version = 3; next.serviceFeeBps = 400; next.maxPositions = 3;
        vault.setPolicy(next);
        require(vault.policy().serviceFeeBps == 400 && vault.stateNonce() == 3, "upgrade failed");
    }

}
