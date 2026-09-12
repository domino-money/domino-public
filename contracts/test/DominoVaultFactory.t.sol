// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultFactory} from "../src/DominoVaultFactory.sol";
import {DominoVault} from "../src/DominoVault.sol";
import {DominoVaultTypes as T} from "../src/DominoVaultTypes.sol";
import {IDominoVaultDraft} from "../src/IDominoVaultDraft.sol";
import {PolicyValidation} from "../src/PolicyValidation.sol";
import {FeeAccounting} from "../src/FeeAccounting.sol";
import {VmE2, MockPoolManager, MockPositionManager, MockStateView, MockERC20, E2ForeignSubscriber} from "./E2Mocks.sol";

interface VmFactoryCode {
    function etch(address account, bytes calldata code) external;
    function mockCall(address target, bytes calldata data, bytes calldata returnData) external;
    function clearMockedCalls() external;
}

contract DominoVaultFactoryTest {
    VmE2 private constant vm = VmE2(address(uint160(uint256(keccak256("hevm cheat code")))));
    VmFactoryCode private constant vmCode = VmFactoryCode(address(vm));
    address private constant OWNER_A = address(0x101);
    address private constant OWNER_B = address(0x102);
    address private constant OPERATOR = address(0x103);
    address private constant FEE_RECIPIENT = address(0x104);

    MockPoolManager private manager;
    MockPositionManager private positions;
    MockStateView private state;
    MockERC20 private token;
    DominoVaultFactory private factory;
    T.PoolKey private key;

    function setUp() public {
        vm.chainId(4663);
        vm.roll(1234);
        vm.warp(1_700_000_000);
        manager = new MockPoolManager();
        positions = new MockPositionManager(address(manager));
        state = new MockStateView(address(manager), positions);
        token = new MockERC20();
        key = T.PoolKey(address(0), address(token), 3000, 60, address(0));
        factory = new DominoVaultFactory(address(manager), address(positions), address(state), FEE_RECIPIENT);
    }

    function params(uint256 root) private view returns (T.InitParams memory value) {
        value.rootTokenId = root;
        value.expectedPoolId = keccak256(abi.encode(key));
        value.baseCurrency = address(0);
        value.quoteCurrency = address(token);
        value.operator = OPERATOR;
        value.consentToUncollectedFees = true;
        value.policy = IDominoVaultDraft.Policy(200, 500, 1000, 600, 4, 1, false);
        value.limits = T.ExecutionLimits(1, 5000, 100, 100, 1_000_000_000_000, 120, 3600);
    }

    function prepare(address owner, uint256 root, uint256 nonce) private returns (address predicted) {
        positions.mint(owner, root, key, -120, 180, 1000);
        predicted = factory.predictVault(owner, nonce);
        vm.prank(owner);
        positions.approve(predicted, root);
    }

    function create(address owner, uint256 root, uint256 nonce) private returns (address vault) {
        T.InitParams memory value = params(root);
        vm.prank(owner);
        vault = factory.createVault(value, nonce);
    }

    function addressGetter(address target, string memory signature) private view returns (address value) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSignature(signature));
        require(ok && data.length == 32, "missing address getter");
        value = abi.decode(data, (address));
    }

    function assertNotCreated(address owner, uint256 nonce, address predicted) private view {
        require(factory.nextOwnerNonce(owner) == nonce, "failed action consumed nonce");
        require(!factory.isVault(predicted), "failed action registered vault");
        require(factory.vaultForSequence(factory.sequenceIdFor(owner, nonce)) == address(0), "failed sequence registry");
    }

    function expectRejectedCreation(T.InitParams memory value, bytes4 selector, uint256 observedRoot) private {
        uint256 nonce = factory.nextOwnerNonce(OWNER_A);
        address predicted = factory.predictVault(OWNER_A, nonce);
        require(predicted.code.length == 0, "rejection precondition: occupied prediction");
        address holder = positions.ownerOf(observedRoot);
        address approval = positions.getApproved(observedRoot);
        address subscriber = positions.subscriber(observedRoot);
        vm.prank(OWNER_A);
        vm.expectRevert(selector);
        factory.createVault(value, nonce);
        assertNotCreated(OWNER_A, nonce, predicted);
        require(predicted.code.length == 0, "reverted initialization left clone code");
        require(positions.ownerOf(observedRoot) == holder, "reverted initialization changed root holder");
        require(positions.getApproved(observedRoot) == approval, "reverted initialization changed approval");
        require(positions.subscriber(observedRoot) == subscriber, "reverted initialization changed subscriber");
    }

    function expectRejectedKey(T.PoolKey memory candidate, int24 lower, int24 upper, uint256 root, bytes4 selector)
        private
    {
        positions.mint(OWNER_A, root, candidate, lower, upper, 1000);
        address predicted = factory.predictVault(OWNER_A, 0);
        vm.prank(OWNER_A);
        positions.approve(predicted, root);
        T.InitParams memory value = params(root);
        value.expectedPoolId = keccak256(abi.encode(candidate));
        value.baseCurrency = candidate.currency0;
        value.quoteCurrency = candidate.currency1;
        expectRejectedCreation(value, selector, root);
    }

    function testCreateRequiresExplicitUncollectedFeeConsent() public {
        address predicted = prepare(OWNER_A, 101, 0);
        T.InitParams memory value = params(101);
        value.consentToUncollectedFees = false;
        expectRejectedCreation(value, DominoVault.MissingConsent.selector, 101);
        require(create(OWNER_A, 101, 0) == predicted, "consented retry rejected");
    }

    function testCreateRejectsZeroRootOrWrongPoolIdentity() public {
        prepare(OWNER_A, 101, 0);
        T.InitParams memory value = params(101);
        value.rootTokenId = 0;
        expectRejectedCreation(value, DominoVault.InvalidPosition.selector, 101);
        value = params(101);
        value.expectedPoolId = bytes32(0);
        expectRejectedCreation(value, DominoVault.InvalidPosition.selector, 101);
        value.expectedPoolId = bytes32(uint256(1));
        expectRejectedCreation(value, DominoVault.InvalidPosition.selector, 101);
        value = params(101);
        (, uint256 info) = positions.getPoolAndPositionInfo(101);
        vmCode.mockCall(
            address(positions),
            abi.encodeCall(positions.getPoolAndPositionInfo, (101)),
            abi.encode(key, info ^ (uint256(1) << 56))
        );
        expectRejectedCreation(value, DominoVault.InvalidPosition.selector, 101);
        vmCode.clearMockedCalls();
        create(OWNER_A, 101, 0);
    }

    function testCreateRejectsUnsortedHookedOrUnsupportedFeePoolKey() public {
        MockERC20 other = new MockERC20();
        T.PoolKey memory candidate = key;
        // Both currencies have code and remain distinct: the order check is
        // the sole failing guard, not a later code/orientation rejection.
        candidate.currency0 = address(token) > address(other) ? address(token) : address(other);
        candidate.currency1 = address(token) > address(other) ? address(other) : address(token);
        expectRejectedKey(candidate, -120, 180, 101, DominoVault.InvalidIdentity.selector);
        candidate = key;
        candidate.hooks = address(0xbeef);
        expectRejectedKey(candidate, -120, 180, 102, DominoVault.InvalidIdentity.selector);
        candidate = key;
        candidate.fee = 1_000_001;
        expectRejectedKey(candidate, -120, 180, 103, DominoVault.InvalidIdentity.selector);
    }

    function testCreateRejectsInvalidTickSpacingAndRangesWithExactSelectors() public {
        T.PoolKey memory candidate = key;
        candidate.tickSpacing = 0;
        expectRejectedKey(candidate, -120, 180, 101, DominoVault.InvalidPosition.selector);
        candidate.tickSpacing = -60;
        expectRejectedKey(candidate, -120, 180, 102, DominoVault.InvalidPosition.selector);
        candidate.tickSpacing = 32768;
        // Aligned, valid int24 ticks reach initialize's spacing upper bound.
        expectRejectedKey(candidate, 0, 32768, 103, DominoVault.InvalidIdentity.selector);
        candidate = key;
        expectRejectedKey(candidate, -119, 180, 104, DominoVault.InvalidPosition.selector);
        expectRejectedKey(candidate, -120, 181, 105, DominoVault.InvalidPosition.selector);
        expectRejectedKey(candidate, 180, 180, 106, DominoVault.InvalidPosition.selector);
        expectRejectedKey(candidate, 180, -120, 107, DominoVault.InvalidPosition.selector);
        expectRejectedKey(candidate, -887280, 180, 108, DominoVault.InvalidPosition.selector);
        expectRejectedKey(candidate, -120, 887280, 109, DominoVault.InvalidPosition.selector);
    }

    function testCreateRejectsCurrencyWithoutCodeOnEitherSide() public {
        T.PoolKey memory candidate = key;
        candidate.currency0 = address(1);
        expectRejectedKey(candidate, -120, 180, 101, DominoVault.InvalidIdentity.selector);
        candidate = key;
        candidate.currency1 = address(1);
        expectRejectedKey(candidate, -120, 180, 102, DominoVault.InvalidIdentity.selector);
    }

    function testCreateRejectsOrientationOutsideThePoolPair() public {
        prepare(OWNER_A, 101, 0);
        T.InitParams memory value = params(101);
        value.baseCurrency = address(token);
        expectRejectedCreation(value, DominoVault.InvalidIdentity.selector, 101);
        value = params(101);
        value.baseCurrency = address(1);
        expectRejectedCreation(value, DominoVault.InvalidIdentity.selector, 101);
        value = params(101);
        value.quoteCurrency = address(1);
        expectRejectedCreation(value, DominoVault.InvalidIdentity.selector, 101);
    }

    function testCreateEnforcesEveryExecutionLimitDomain() public {
        prepare(OWNER_A, 101, 0);
        for (uint256 i; i < 9; ++i) {
            T.InitParams memory value = params(101);
            if (i == 0) value.limits.version = 0;
            else if (i == 1) value.limits.version = 2;
            else if (i == 2) value.limits.upsideBps = 0;
            else if (i == 3) value.limits.upsideBps = 1_000_001;
            else if (i == 4) value.limits.maxSlippageBps = 10000;
            else if (i == 5) value.limits.maxPriceImpactBps = 10000;
            else if (i == 6) value.limits.maxGasCostWei = 0;
            else if (i == 7) value.limits.maxObservationAgeSeconds = 0;
            else value.limits.forecastHorizonSeconds = 0;
            expectRejectedCreation(value, DominoVault.InvalidLimits.selector, 101);
        }
    }

    function testCreateEnforcesInitialPolicyVersionCountFeesAndGeometry() public {
        prepare(OWNER_A, 101, 0);
        for (uint256 i; i < 7; ++i) {
            T.InitParams memory value = params(101);
            bytes4 selector;
            if (i < 2) {
                value.policy.version = i == 0 ? 0 : 2;
                selector = PolicyValidation.InvalidPolicyVersion.selector;
            } else if (i == 2) {
                value.policy.maxPositions = 0;
                selector = PolicyValidation.InvalidMaxPositions.selector;
            } else if (i == 3) {
                value.policy.serviceFeeBps = 201;
                selector = FeeAccounting.ExcessiveFee.selector;
            } else if (i == 4) {
                value.policy.triggerDistanceBps = 2001;
                selector = PolicyValidation.ExcessiveTriggerDistance.selector;
            } else if (i == 5) {
                value.policy.maxOverlapBps = 2001;
                selector = PolicyValidation.ExcessiveOverlap.selector;
            } else {
                value.policy.minimumIntervalSeconds = 0;
                selector = PolicyValidation.InvalidMinimumInterval.selector;
            }
            expectRejectedCreation(value, selector, 101);
        }
    }

    function testCreateAcceptsInclusivePoolPolicyAndLimitBoundaries() public {
        T.PoolKey memory candidate = key;
        candidate.fee = 1_000_000;
        candidate.tickSpacing = 32767;
        positions.mint(OWNER_A, 101, candidate, -32767, 32767, 1000);
        address predicted = factory.predictVault(OWNER_A, 0);
        vm.prank(OWNER_A);
        positions.approve(predicted, 101);
        T.InitParams memory value = params(101);
        value.expectedPoolId = keccak256(abi.encode(candidate));
        value.policy = IDominoVaultDraft.Policy(200, 2000, 2000, type(uint32).max, 1, 1, false);
        value.limits =
            T.ExecutionLimits(1, 1_000_000, 9999, 9999, type(uint128).max, type(uint32).max, type(uint32).max);
        vm.prank(OWNER_A);
        DominoVault vault = DominoVault(payable(factory.createVault(value, 0)));
        require(vault.activePositions() == 1 && vault.policy().maxPositions == 1, "initial root count");
        vm.prank(OWNER_A);
        vault.validateAuthority(1, 1, 1);
    }

    function testCreateRejectsAndPreservesForeignRootSubscription() public {
        address predicted = prepare(OWNER_A, 101, 0);
        E2ForeignSubscriber foreignSubscriber = new E2ForeignSubscriber();
        vm.prank(OWNER_A);
        positions.subscribe(101, address(foreignSubscriber), "");
        expectRejectedCreation(params(101), DominoVault.ForeignSubscription.selector, 101);
        require(positions.subscriber(101) == address(foreignSubscriber), "foreign subscriber evicted");
        vm.prank(OWNER_A);
        positions.unsubscribe(101);
        require(create(OWNER_A, 101, 0) == predicted, "explicit unsubscribe did not allow retry");
    }

    function operatorEventCount(address vault, address configured) private returns (uint256 count) {
        VmE2.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("OperatorChanged(address,address,uint64,uint64)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != vault || logs[i].topics[0] != topic) continue;
            require(logs[i].topics.length == 3, "operator event topics");
            (uint64 generation, uint64 nonce) = abi.decode(logs[i].data, (uint64, uint64));
            require(
                logs[i].topics[1] == bytes32(0) && logs[i].topics[2] == bytes32(uint256(uint160(configured)))
                    && generation == 1 && nonce == 1,
                "operator event payload"
            );
            ++count;
        }
    }

    function testZeroInitialOperatorIsDisabledWithoutSpuriousChangeEvent() public {
        prepare(OWNER_A, 101, 0);
        T.InitParams memory value = params(101);
        value.operator = address(0);
        vm.recordLogs();
        vm.prank(OWNER_A);
        DominoVault vault = DominoVault(payable(factory.createVault(value, 0)));
        require(
            vault.operator() == address(0) && !vault.isOperator(address(0)) && !vault.isOperator(OPERATOR),
            "zero operator enabled"
        );
        require(operatorEventCount(address(vault), address(0)) == 0, "zero to zero OperatorChanged");
        vm.prank(OWNER_A);
        vault.validateAuthority(1, 1, 1);
        vm.prank(OPERATOR);
        vm.expectRevert(DominoVault.Unauthorized.selector);
        vault.validateAuthority(1, 1, 1);
    }

    function testNonzeroInitialOperatorRemainsConfiguredAndAuthorized() public {
        prepare(OWNER_A, 101, 0);
        vm.recordLogs();
        DominoVault vault = DominoVault(payable(create(OWNER_A, 101, 0)));
        require(vault.operator() == OPERATOR && vault.isOperator(OPERATOR), "configured operator missing");
        require(operatorEventCount(address(vault), OPERATOR) == 1, "operator registration event missing");
        vm.prank(OPERATOR);
        vault.validateAuthority(1, 1, 1);
        vm.prank(OWNER_A);
        vault.validateAuthority(1, 1, 1);
    }

    function testOwnerOrVaultAsInitialOperatorDoesNotNarrowAcceptedConfiguration() public {
        for (uint256 i; i < 2; ++i) {
            uint256 root = 101 + i;
            address predicted = prepare(OWNER_A, root, i);
            T.InitParams memory value = params(root);
            value.operator = i == 0 ? OWNER_A : predicted;
            vm.prank(OWNER_A);
            DominoVault vault = DominoVault(payable(factory.createVault(value, i)));
            require(vault.operator() == value.operator && vault.isOperator(value.operator), "operator alias rejected");
            vm.prank(OWNER_A);
            vault.validateAuthority(1, 1, 1);
        }
    }

    // These ABI field orders are pinned by ExecutionEncoding.t.sol / the E1
    // fixture, not fetched from the vault's identity helpers. The flat static
    // heads below deliberately avoid reproducing its SequenceWords layout.
    struct ExpectedHashes {
        bytes32 sequence;
        bytes32 baseline;
        bytes32 position;
        bytes32 source0;
        bytes32 source1;
    }

    function independentPoolId() private view returns (bytes32) {
        return keccak256(abi.encode(address(0), address(token), uint24(3000), int24(60), address(0)));
    }

    function independentSequenceHash(address vault, uint256 ownerNonce, bool reversed) private view returns (bytes32) {
        bytes32 sequenceId = keccak256(
            abi.encode(
                keccak256("DominoSequence(uint256 chainId,address factory,address owner,uint256 nonce)"),
                uint256(4663),
                address(factory),
                OWNER_A,
                ownerNonce
            )
        );
        bytes32 keyHash = keccak256(
            abi.encode(
                keccak256(
                    "PoolKey(address currency0,address currency1,uint24 fee_pips,int24 tick_spacing,address hooks)"
                ),
                address(0),
                address(token),
                uint24(3000),
                int24(60),
                address(0)
            )
        );
        bytes memory head = abi.encode(
            keccak256(
                "SequenceIdentity(uint256 chainId,address owner,bytes32 sequenceId,address vault,address factory,address implementation,uint64 implementationVersion,address poolManager,address positionManager,bytes32 poolKey,bytes32 poolId,address baseCurrency,address quoteCurrency,address serviceFeeRecipient)"
            ),
            uint256(4663),
            OWNER_A,
            sequenceId,
            vault,
            address(factory),
            factory.implementation(),
            uint64(2)
        );
        bytes memory tail = abi.encode(
            address(manager),
            address(positions),
            keyHash,
            independentPoolId(),
            reversed ? address(token) : address(0),
            reversed ? address(0) : address(token),
            FEE_RECIPIENT
        );
        return keccak256(bytes.concat(head, tail));
    }

    function independentCheckpointHash(bytes32 sequence, uint256 root, T.Checkpoint memory point)
        private
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                keccak256("DominoRegistrationCheckpointV1"),
                sequence,
                root,
                point.liquidity,
                point.feeGrowthInside0LastX128,
                point.feeGrowthInside1LastX128,
                point.feeGrowthInside0X128,
                point.feeGrowthInside1X128,
                point.observedAtBlock
            )
        );
    }

    function independentHashes(
        address vault,
        uint256 root,
        uint256 ownerNonce,
        bool reversed,
        T.Checkpoint memory point
    ) private view returns (ExpectedHashes memory expected) {
        expected.sequence = independentSequenceHash(vault, ownerNonce, reversed);
        expected.baseline = independentCheckpointHash(expected.sequence, root, point);
        // Core Position ID uses 20 + 3 + 3 + 32 bytes. Literal ffff88 is
        // signed int24(-120), and 0000b4 is int24(180), not padded ABI words.
        bytes32 core = keccak256(abi.encodePacked(address(positions), hex"ffff880000b4", bytes32(root)));
        expected.position = keccak256(
            abi.encode(
                keccak256(
                    "PositionIdentity(bytes32 sequence,uint256 tokenId,uint64 generation,bool isRoot,uint256 parentTokenId,int24 tickLower,int24 tickUpper,bytes32 corePositionId,bytes32 registrationBaselineId)"
                ),
                expected.sequence,
                root,
                uint64(1),
                true,
                uint256(0),
                int256(-120),
                int256(180),
                core,
                expected.baseline
            )
        );
        bytes32 sourceType = keccak256("FeeSourceIdentity(bytes32 sequence,bytes32 position,address currency)");
        expected.source0 = keccak256(abi.encode(sourceType, expected.sequence, expected.position, address(0)));
        expected.source1 = keccak256(abi.encode(sourceType, expected.sequence, expected.position, address(token)));
    }

    function originalCheckpoint() private pure returns (T.Checkpoint memory point) {
        // Distinct nonzero values reveal swapped fee-growth fields; liquidity
        // above 2**64 also exercises the declared uint128 width.
        point.liquidity = uint128(type(uint64).max) + 101;
        point.feeGrowthInside0LastX128 = (uint256(1) << 200) + 11;
        point.feeGrowthInside1LastX128 = (uint256(1) << 129) + 22;
        point.feeGrowthInside0X128 = (uint256(1) << 201) + 33;
        point.feeGrowthInside1X128 = (uint256(1) << 130) + 44;
        point.observedAtBlock = 1234;
    }

    function setCheckpointInputs(uint256 root, T.Checkpoint memory point) private {
        positions.setLiquidity(root, point.liquidity);
        state.setPositionState(root, point.liquidity, point.feeGrowthInside0LastX128, point.feeGrowthInside1LastX128);
        state.setFeeGrowthInside(independentPoolId(), -120, 180, point.feeGrowthInside0X128, point.feeGrowthInside1X128);
    }

    function assertIdentityAndSources(DominoVault vault, uint256 root, ExpectedHashes memory expected) private view {
        require(vault.sequenceIdentityHash() == expected.sequence, "independent E1 sequence hash");
        T.Position memory registered = vault.position(root);
        require(
            registered.known && registered.active && registered.isRoot && registered.generation == 1
                && registered.parentTokenId == 0,
            "registered root identity fields"
        );
        require(registered.tickLower == -120 && registered.tickUpper == 180, "registered signed ticks");
        require(registered.registrationBaselineId == expected.baseline, "registration baseline commitment");
        require(registered.identity == expected.position, "independent E1 position/core hash");
        require(
            registered.source0 == expected.source0 && registered.source1 == expected.source1,
            "independent E1 source hashes"
        );
        T.Source memory source = vault.source(expected.source0);
        require(
            source.known && source.tokenId == root && source.originalCurrency == address(0)
                && source.positionIdentity == expected.position,
            "native source binding"
        );
        source = vault.source(expected.source1);
        require(
            source.known && source.tokenId == root && source.originalCurrency == address(token)
                && source.positionIdentity == expected.position,
            "ERC20 source binding"
        );
    }

    function assertRegistrationEvent(address vault, uint256 root, ExpectedHashes memory expected) private {
        VmE2.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("PositionRegistered(uint256,bytes32,bytes32,bytes32,uint64)");
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != vault || logs[i].topics[0] != topic) continue;
            require(
                logs[i].topics.length == 3 && logs[i].topics[1] == bytes32(root)
                    && logs[i].topics[2] == expected.position,
                "registration identity topics"
            );
            (bytes32 source0, bytes32 source1, uint64 nonce) = abi.decode(logs[i].data, (bytes32, bytes32, uint64));
            require(
                source0 == expected.source0 && source1 == expected.source1 && nonce == 1, "registration source payload"
            );
            ++found;
        }
        require(found == 1, "missing registration commitment event");
    }

    function testNativeAndReversedOrientationMatchIndependentE1Commitments() public {
        for (uint256 i; i < 2; ++i) {
            uint256 root = 101 + i;
            prepare(OWNER_A, root, i);
            T.Checkpoint memory point = originalCheckpoint();
            setCheckpointInputs(root, point);
            T.InitParams memory value = params(root);
            if (i == 1) {
                value.baseCurrency = address(token);
                value.quoteCurrency = address(0);
            }
            vm.recordLogs();
            vm.prank(OWNER_A);
            DominoVault vault = DominoVault(payable(factory.createVault(value, i)));
            ExpectedHashes memory expected = independentHashes(address(vault), root, i, i == 1, point);
            point.commitment = expected.baseline;
            assertIdentityAndSources(vault, root, expected);
            require(
                keccak256(abi.encode(vault.registrationCheckpoint(root))) == keccak256(abi.encode(point)),
                "registration raw checkpoint fields"
            );
            require(
                keccak256(abi.encode(vault.checkpoint(root))) == keccak256(abi.encode(point)),
                "initial live checkpoint fields"
            );
            assertRegistrationEvent(address(vault), root, expected);
        }
    }

    function testRegistrationCheckpointPreservesOriginalPreimageAcrossRearm() public {
        prepare(OWNER_A, 101, 0);
        T.Checkpoint memory original = originalCheckpoint();
        setCheckpointInputs(101, original);
        DominoVault vault = DominoVault(payable(create(OWNER_A, 101, 0)));
        ExpectedHashes memory expected = independentHashes(address(vault), 101, 0, false, original);
        original.commitment = expected.baseline;
        T.Checkpoint memory latest = T.Checkpoint((uint128(1) << 100) + 17, 1001, 2002, 3003, 4004, 1300, bytes32(0));
        vm.roll(1300);
        setCheckpointInputs(101, latest);
        vm.prank(OWNER_A);
        vault.rearmRoot(true);
        latest.commitment = independentCheckpointHash(expected.sequence, 101, latest);
        require(latest.commitment != original.commitment, "rearm test needs a changed checkpoint");
        require(
            keccak256(abi.encode(vault.checkpoint(101))) == keccak256(abi.encode(latest)),
            "live checkpoint not refreshed on rearm"
        );
        T.Checkpoint memory registered = vault.registrationCheckpoint(101);
        require(
            keccak256(abi.encode(registered)) == keccak256(abi.encode(original)),
            "rearm overwrote original raw checkpoint"
        );
        // A caller can reconstruct the original baseline from current getters,
        // even after checkpoint() changes, with no historic storage query.
        require(
            independentCheckpointHash(expected.sequence, 101, registered) == expected.baseline,
            "registration baseline preimage lost"
        );
        assertIdentityAndSources(vault, 101, expected);
        require(vault.authorityGeneration() == 2 && vault.stateNonce() == 2, "rearm did not change authority");
    }

    function testConstructorPinsValidatedManagersAndImplementation() public view {
        require(factory.poolManager() == address(manager), "pool manager pin");
        require(factory.positionManager() == address(positions), "position manager pin");
        require(factory.stateView() == address(state), "state view pin");
        require(factory.serviceFeeRecipient() == FEE_RECIPIENT, "recipient pin");
        address implementation = factory.implementation();
        require(implementation.code.length != 0 && !factory.isVault(implementation), "implementation registry");
        require(addressGetter(implementation, "factory()") == address(factory), "implementation factory");
        require(addressGetter(implementation, "poolManager()") == address(manager), "implementation manager");
    }

    function testConstructorRejectsZeroOrCodeLessPins() public {
        address[4] memory pins = [address(manager), address(positions), address(state), FEE_RECIPIENT];
        for (uint256 i; i < pins.length; ++i) {
            address saved = pins[i];
            pins[i] = address(0);
            vm.expectRevert(DominoVaultFactory.InvalidManagerConfiguration.selector);
            new DominoVaultFactory(pins[0], pins[1], pins[2], pins[3]);
            pins[i] = saved;
        }
        for (uint256 i; i < 3; ++i) {
            address saved = pins[i];
            pins[i] = address(0xdead);
            vm.expectRevert(DominoVaultFactory.InvalidManagerConfiguration.selector);
            new DominoVaultFactory(pins[0], pins[1], pins[2], pins[3]);
            pins[i] = saved;
        }
    }

    function testConstructorRejectsManagerDisagreement() public {
        MockPoolManager other = new MockPoolManager();
        MockPositionManager foreignPositions = new MockPositionManager(address(other));
        MockStateView foreignState = new MockStateView(address(other), positions);
        vm.expectRevert(DominoVaultFactory.ManagerMismatch.selector);
        new DominoVaultFactory(address(manager), address(foreignPositions), address(state), FEE_RECIPIENT);
        vm.expectRevert(DominoVaultFactory.ManagerMismatch.selector);
        new DominoVaultFactory(address(manager), address(positions), address(foreignState), FEE_RECIPIENT);
    }

    function testChainAdmissionAlsoAppliesAfterDeployment() public {
        T.InitParams memory value = params(101);
        vm.chainId(1);
        vm.expectRevert(DominoVaultFactory.UnsupportedChain.selector);
        new DominoVaultFactory(address(manager), address(positions), address(state), FEE_RECIPIENT);
        vm.expectRevert(DominoVaultFactory.UnsupportedChain.selector);
        factory.createVault(value, 0);
    }

    function testPredictionUsesOwnerNonceDomainAndExactCloneCode() public {
        address predicted = prepare(OWNER_A, 101, 0);
        bytes32 sequence = keccak256(
            abi.encode(
                keccak256("DominoSequence(uint256 chainId,address factory,address owner,uint256 nonce)"),
                uint256(4663),
                address(factory),
                OWNER_A,
                uint256(0)
            )
        );
        require(factory.sequenceIdFor(OWNER_A, 0) == sequence, "sequence preimage");
        bytes memory initCode = abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", factory.implementation(), hex"5af43d82803e903d91602b57fd5bf3"
        );
        address independentPrediction = address(
            uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(factory), sequence, keccak256(initCode)))))
        );
        require(predicted == independentPrediction && predicted.code.length == 0, "CREATE2 prediction");
        address vault = create(OWNER_A, 101, 0);
        require(vault == predicted, "deployed address differs");
        require(
            keccak256(vault.code)
                == keccak256(
                    abi.encodePacked(
                        hex"363d3d373d3d3d363d73", factory.implementation(), hex"5af43d82803e903d91602b57fd5bf3"
                    )
                ),
            "unexpected delegate target/runtime"
        );
        require(factory.isVault(vault) && factory.vaultForSequence(sequence) == vault, "registration");
        require(factory.nextOwnerNonce(OWNER_A) == 1, "owner nonce");
        require(addressGetter(vault, "owner()") == OWNER_A, "immutable caller owner");
        require(addressGetter(vault, "factory()") == address(factory), "factory binding");
        require(addressGetter(vault, "positionManager()") == address(positions), "manager binding");
        require(addressGetter(vault, "stateView()") == address(state), "state binding");
        require(addressGetter(vault, "serviceFeeRecipient()") == FEE_RECIPIENT, "fee recipient binding");
        DominoVault deployed = DominoVault(payable(vault));
        require(
            deployed.implementation() == factory.implementation() && deployed.implementationVersion() == 2,
            "implementation version binding"
        );
        require(deployed.sequenceId() == sequence && deployed.rootTokenId() == 101, "sequence/root binding");
        require(deployed.policy().version == 1 && deployed.executionLimits().version == 1, "initial policy versions");
        require(deployed.stateNonce() == 1 && deployed.authorityGeneration() == 1, "initial authority versions");
        require(positions.ownerOf(101) == OWNER_A && positions.getApproved(101) == vault, "root custody");
        require(positions.subscriber(101) == vault, "root subscription");
        require(!positions.isApprovedForAll(OWNER_A, vault), "unrequested global approval");
    }

    function testAnotherCallerCannotFrontRunAnOwnersPrediction() public {
        address predicted = prepare(OWNER_A, 101, 0);
        require(factory.predictVault(OWNER_B, 0) != predicted, "owners share CREATE2 salt");
        T.InitParams memory value = params(101);
        vm.prank(OWNER_B);
        vm.expectRevert(DominoVault.PermissionUnavailable.selector);
        factory.createVault(value, 0);
        assertNotCreated(OWNER_A, 0, predicted);
        assertNotCreated(OWNER_B, 0, factory.predictVault(OWNER_B, 0));
        require(predicted.code.length == 0, "attacker deployed victim vault");
        require(create(OWNER_A, 101, 0) == predicted, "victim cannot initialize after failed front-run");
    }

    function testStaleAndSkippedOwnerNoncesCannotDeploy() public {
        address predicted = prepare(OWNER_A, 101, 0);
        T.InitParams memory value = params(101);
        vm.prank(OWNER_A);
        vm.expectRevert(abi.encodeWithSelector(DominoVaultFactory.UnexpectedOwnerNonce.selector, 0, 1));
        factory.createVault(value, 1);
        assertNotCreated(OWNER_A, 0, predicted);
        create(OWNER_A, 101, 0);
        vm.prank(OWNER_A);
        vm.expectRevert(abi.encodeWithSelector(DominoVaultFactory.UnexpectedOwnerNonce.selector, 1, 0));
        factory.createVault(value, 0);
        require(factory.nextOwnerNonce(OWNER_A) == 1 && factory.isVault(predicted), "replay mutated registry");
    }

    function testTwoOwnersAndTwoSequencesRemainIsolated() public {
        address a0 = prepare(OWNER_A, 101, 0);
        address a1 = prepare(OWNER_A, 102, 1);
        address b0 = prepare(OWNER_B, 201, 0);
        require(a0 != a1 && a0 != b0 && a1 != b0, "prediction collision");
        require(create(OWNER_A, 101, 0) == a0 && create(OWNER_B, 201, 0) == b0, "independent owner nonces");
        require(create(OWNER_A, 102, 1) == a1, "second sequence");
        require(factory.nextOwnerNonce(OWNER_A) == 2 && factory.nextOwnerNonce(OWNER_B) == 1, "shared owner nonce");
        require(addressGetter(a0, "owner()") == OWNER_A && addressGetter(a1, "owner()") == OWNER_A, "owner A");
        require(addressGetter(b0, "owner()") == OWNER_B, "owner B");
        require(
            positions.subscriber(101) == a0 && positions.subscriber(102) == a1 && positions.subscriber(201) == b0,
            "cross-sequence subscription"
        );
    }

    function testGlobalApprovalAloneDoesNotBootstrapRoot() public {
        positions.mint(OWNER_A, 101, key, -120, 180, 1000);
        address predicted = factory.predictVault(OWNER_A, 0);
        vm.prank(OWNER_A);
        positions.setApprovalForAll(predicted, true);
        T.InitParams memory value = params(101);
        vm.prank(OWNER_A);
        vm.expectRevert(DominoVault.PermissionUnavailable.selector);
        factory.createVault(value, 0);
        assertNotCreated(OWNER_A, 0, predicted);
        vm.prank(OWNER_A);
        positions.approve(predicted, 101);
        require(create(OWNER_A, 101, 0) == predicted, "individual approval did not bootstrap");
    }

    function testImplementationAndCloneCannotBeInitializedAgain() public {
        T.InitParams memory value = params(101);
        address implementation = factory.implementation();
        bytes32 sequence = factory.sequenceIdFor(OWNER_A, 0);
        // Even the designated factory cannot initialize the implementation.
        vm.prank(address(factory));
        vm.expectRevert(DominoVault.AlreadyInitialized.selector);
        DominoVault(payable(implementation)).initialize(OWNER_A, sequence, value);
        require(addressGetter(implementation, "owner()") == address(0), "implementation acquired owner");
        address predicted = prepare(OWNER_A, 101, 0);
        create(OWNER_A, 101, 0);
        vm.prank(OWNER_B);
        vm.expectRevert(DominoVault.Unauthorized.selector);
        DominoVault(payable(predicted)).initialize(OWNER_B, sequence, value);
        vm.prank(address(factory));
        vm.expectRevert(DominoVault.AlreadyInitialized.selector);
        DominoVault(payable(predicted)).initialize(OWNER_B, sequence, value);
        require(addressGetter(predicted, "owner()") == OWNER_A, "reinitialization replaced owner");
    }

    function testCreate2CollisionLeavesNonceAndRegistryUnchanged() public {
        address predicted = prepare(OWNER_A, 101, 0);
        vmCode.etch(predicted, hex"00"); // Fault injection; outsiders cannot deploy from this factory's CREATE2 origin.
        T.InitParams memory value = params(101);
        vm.prank(OWNER_A);
        vm.expectRevert(DominoVaultFactory.VaultDeploymentFailed.selector);
        factory.createVault{gas: 500_000}(value, 0);
        assertNotCreated(OWNER_A, 0, predicted);
    }

    function testOwnerNonceExhaustionDoesNotWrap() public {
        // Storage fault injection reaches the uint256 boundary without 2**256 calls.
        bytes32 slot = keccak256(abi.encode(OWNER_A, uint256(0)));
        vm.store(address(factory), slot, bytes32(type(uint256).max));
        require(factory.nextOwnerNonce(OWNER_A) == type(uint256).max, "nonce injection layout changed");
        T.InitParams memory value = params(101);
        vm.prank(OWNER_A);
        vm.expectRevert(DominoVaultFactory.OwnerNonceExhausted.selector);
        factory.createVault(value, type(uint256).max);
        require(factory.nextOwnerNonce(OWNER_A) == type(uint256).max, "nonce wrapped");
    }

    function testInitializationCallbackCannotReenterFactory() public {
        address predicted = prepare(OWNER_A, 101, 0);
        T.InitParams memory value = params(101);
        positions.configureSubscribeReentry(address(factory), abi.encodeCall(factory.createVault, (value, 0)), false);
        create(OWNER_A, 101, 0);
        require(positions.subscribeReentryAttempted() && !positions.subscribeReentrySucceeded(), "reentry outcome");
        require(
            keccak256(positions.subscribeReentryResult())
                == keccak256(abi.encodeWithSelector(DominoVaultFactory.ReentrantCreate.selector)),
            "reentry guard error"
        );
        require(factory.isVault(predicted) && factory.nextOwnerNonce(OWNER_A) == 1, "outer create failed");
        require(factory.nextOwnerNonce(address(positions)) == 0, "callback consumed owner nonce");
    }

    function testSubscriptionFailureRollsBackCloneRegistryAndAllowsIdenticalRetry() public {
        address predicted = prepare(OWNER_A, 101, 0);
        T.InitParams memory value = params(101);
        positions.configureSubscribeReentry(address(factory), abi.encodeCall(factory.createVault, (value, 0)), true);
        vm.prank(OWNER_A);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "mock subscribe reentry failed"));
        factory.createVault(value, 0);
        assertNotCreated(OWNER_A, 0, predicted);
        require(predicted.code.length == 0 && positions.subscriber(101) == address(0), "incomplete rollback");
        require(positions.getApproved(101) == predicted, "existing individual approval lost");
        positions.configureSubscribeReentry(address(0), "", false);
        require(create(OWNER_A, 101, 0) == predicted, "same CREATE2 retry failed");
    }

    function testSuccessfulCreationEventMatchesRegistry() public {
        address predicted = prepare(OWNER_A, 101, 0);
        bytes32 sequence = factory.sequenceIdFor(OWNER_A, 0);
        vm.recordLogs();
        create(OWNER_A, 101, 0);
        VmE2.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(factory)) continue;
            require(logs[i].topics.length == 4, "event topic count");
            require(
                logs[i].topics[0] == keccak256("VaultCreated(address,bytes32,address,uint256,address)"), "event type"
            );
            require(logs[i].topics[1] == bytes32(uint256(uint160(OWNER_A))), "event owner");
            require(
                logs[i].topics[2] == sequence && logs[i].topics[3] == bytes32(uint256(uint160(predicted))),
                "event identity"
            );
            (uint256 nonce, address implementation) = abi.decode(logs[i].data, (uint256, address));
            require(nonce == 0 && implementation == factory.implementation(), "event payload");
            ++found;
        }
        require(found == 1 && factory.vaultForSequence(sequence) == predicted, "missing committed creation event");
    }
}
