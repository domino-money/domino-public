// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultFactoryV4} from "../src/DominoVaultFactoryV4.sol";
import {DominoVaultV4} from "../src/DominoVaultV4.sol";
import {DominoVaultReadHelper} from "../src/DominoVaultReadHelper.sol";
import {DominoVaultTypes as T} from "../src/DominoVaultTypes.sol";
import {IDominoVaultDraft} from "../src/IDominoVaultDraft.sol";
import {VmE2, MockPoolManager, MockPositionManager, MockStateView, MockERC20} from "./E2Mocks.sol";
import {StubEngineV4} from "./DominoVaultV4Custody.t.sol";

/// A pool manager whose positions point somewhere else, for ManagerMismatch.
contract ForeignPoolManager {}

/// finalizeImplementation reads seven getters off the candidate. A real
/// DominoVaultV4 cannot be made to disagree on two of them - implementation()
/// and implementationVersion() - so covering all seven needs a candidate that
/// can disagree on any one.
contract FakeImplementation {
    address public factory;
    address public implementation;
    uint64 public implementationVersion;
    address public poolManager;
    address public positionManager;
    address public stateView;
    address public serviceFeeRecipient;
    constructor(address factory_, address pool_, address positions_, address state_, address recipient_) {
        factory = factory_; implementation = address(this); implementationVersion = 4;
        poolManager = pool_; positionManager = positions_; stateView = state_; serviceFeeRecipient = recipient_;
    }
    function set(uint256 which, address value, uint64 version) external {
        if (which == 0) factory = value;
        else if (which == 1) implementation = value;
        else if (which == 2) implementationVersion = version;
        else if (which == 3) poolManager = value;
        else if (which == 4) positionManager = value;
        else if (which == 5) stateView = value;
        else serviceFeeRecipient = value;
    }
}

/**
 * The V4 factory's refusals.
 *
 * Before this suite, DominoVaultFactoryV4 had a single happy-path call in
 * reference/OfficialDominoExecutionV4.t.sol and no rejection coverage, while
 * the V3 factory has thirty tests. finalizeImplementation is V4-only - V3
 * builds its implementation in the constructor - so its seven identity
 * disagreements were reachable by nothing at all.
 */
contract DominoVaultFactoryV4Test {
    VmE2 private constant vm = VmE2(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant RECIPIENT = address(0xFEE);
    address private constant STRANGER = address(0xBAD);
    MockPoolManager private poolManager;
    MockPositionManager private positions;
    MockStateView private stateView;
    MockERC20 private token;
    DominoVaultReadHelper private readHelper;
    StubEngineV4 private engine;
    DominoVaultFactoryV4 private factory;

    function setUp() public {
        vm.chainId(4663);
        poolManager = new MockPoolManager();
        positions = new MockPositionManager(address(poolManager));
        stateView = new MockStateView(address(poolManager), positions);
        token = new MockERC20();
        readHelper = new DominoVaultReadHelper(address(positions), address(stateView));
        factory = new DominoVaultFactoryV4(address(poolManager), address(positions),
            address(stateView), RECIPIENT);
        engine = new StubEngineV4(address(factory));
    }

    function _implementation(address factory_) private returns (DominoVaultV4) {
        return new DominoVaultV4(factory_, address(poolManager), address(positions),
            address(stateView), RECIPIENT, address(readHelper), address(engine));
    }

    function _refused(bool ok, bytes memory out, bytes4 expected, string memory what) private pure {
        require(!ok, what);
        require(out.length >= 4 && bytes4(out) == expected, what);
    }

    function testConstructorRefusesAZeroOrCodelessManagerAndAForeignPool() external {
        address[4] memory good =
            [address(poolManager), address(positions), address(stateView), RECIPIENT];
        for (uint256 i; i < 4; ++i) {
            address[4] memory a = good;
            a[i] = address(0);
            (bool ok, bytes memory out) = address(this).call(
                abi.encodeCall(this.deployFactory, (a[0], a[1], a[2], a[3])));
            _refused(ok, out, DominoVaultFactoryV4.InvalidManagerConfiguration.selector, "zero address");
        }
        // An address with no code is not a manager either, for the three that
        // must be contracts. The fee recipient may be an ordinary account.
        for (uint256 i; i < 3; ++i) {
            address[4] memory a = good;
            a[i] = STRANGER;
            (bool ok, bytes memory out) = address(this).call(
                abi.encodeCall(this.deployFactory, (a[0], a[1], a[2], a[3])));
            _refused(ok, out, DominoVaultFactoryV4.InvalidManagerConfiguration.selector, "no code");
        }
        // Real contracts that disagree about which pool they serve. The guard
        // has two halves and the V3 factory suite covers both; only the
        // position-manager half was covered here, so deleting the state-view
        // half left every suite green.
        ForeignPoolManager foreign = new ForeignPoolManager();
        MockPositionManager otherPositions = new MockPositionManager(address(foreign));
        (bool ok2, bytes memory out2) = address(this).call(abi.encodeCall(this.deployFactory,
            (address(poolManager), address(otherPositions), address(stateView), RECIPIENT)));
        _refused(ok2, out2, DominoVaultFactoryV4.ManagerMismatch.selector, "positions serve another pool");

        MockStateView otherState = new MockStateView(address(foreign), otherPositions);
        (ok2, out2) = address(this).call(abi.encodeCall(this.deployFactory,
            (address(poolManager), address(positions), address(otherState), RECIPIENT)));
        _refused(ok2, out2, DominoVaultFactoryV4.ManagerMismatch.selector, "the state view serves another pool");
    }

    /// External so the constructor's reverts can be caught.
    function deployFactory(address pool, address pos, address state, address recipient) external {
        new DominoVaultFactoryV4(pool, pos, state, recipient);
    }

    function testFinalizeImplementationIsDeployerOnlyOneShotAndIdentityChecked() external {
        DominoVaultV4 good = _implementation(address(factory));

        vm.prank(STRANGER);
        (bool ok, bytes memory out) = address(factory).call(
            abi.encodeCall(DominoVaultFactoryV4.finalizeImplementation, (address(good))));
        _refused(ok, out, DominoVaultFactoryV4.InvalidManagerConfiguration.selector, "deployer only");

        (ok, out) = address(factory).call(
            abi.encodeCall(DominoVaultFactoryV4.finalizeImplementation, (STRANGER)));
        _refused(ok, out, DominoVaultFactoryV4.InvalidManagerConfiguration.selector, "candidate has no code");

        // All seven identity getters, one at a time. Only the first was
        // covered before: deleting the other six left every suite green.
        string[7] memory names = [string('factory'), 'implementation', 'implementationVersion',
            'poolManager', 'positionManager', 'stateView', 'serviceFeeRecipient'];
        for (uint256 i; i < 7; ++i) {
            FakeImplementation fake = new FakeImplementation(address(factory), address(poolManager),
                address(positions), address(stateView), RECIPIENT);
            fake.set(i, STRANGER, i == 2 ? 3 : 0);
            (ok, out) = address(factory).call(
                abi.encodeCall(DominoVaultFactoryV4.finalizeImplementation, (address(fake))));
            _refused(ok, out, DominoVaultFactoryV4.ManagerMismatch.selector, names[i]);
        }
        // A candidate agreeing on all seven is accepted, so the loop above
        // failed on the getter named and not on being a stand-in.
        DominoVaultFactoryV4 spare = new DominoVaultFactoryV4(address(poolManager), address(positions),
            address(stateView), RECIPIENT);
        FakeImplementation honest = new FakeImplementation(address(spare), address(poolManager),
            address(positions), address(stateView), RECIPIENT);
        spare.finalizeImplementation(address(honest));
        require(spare.implementation() == address(honest), "seven agreements are enough");

        factory.finalizeImplementation(address(good));
        require(factory.implementation() == address(good), "bound");

        (ok, out) = address(factory).call(
            abi.encodeCall(DominoVaultFactoryV4.finalizeImplementation, (address(good))));
        _refused(ok, out, DominoVaultFactoryV4.InvalidManagerConfiguration.selector, "one shot");
    }

    function testNothingIsCreatableBeforeTheImplementationIsBound() external {
        (bool ok, bytes memory out) = address(factory).call(
            abi.encodeCall(DominoVaultFactoryV4.predictVault, (address(this), 0)));
        _refused(ok, out, DominoVaultFactoryV4.InvalidManagerConfiguration.selector, "nothing to predict");

        T.InitParams memory params;
        (ok, out) = address(factory).call(
            abi.encodeCall(DominoVaultFactoryV4.createVault, (params, 0)));
        _refused(ok, out, DominoVaultFactoryV4.InvalidManagerConfiguration.selector, "nothing to clone");
    }

    function testSequenceIdRefusesTheZeroOwner() external {
        (bool ok, bytes memory out) = address(factory).call(
            abi.encodeCall(DominoVaultFactoryV4.sequenceIdFor, (address(0), 0)));
        _refused(ok, out, DominoVaultFactoryV4.InvalidOwner.selector, "no sequence for nobody");
    }

    function testCreateVaultBindsTheOwnerNonceAndTheAddressItPredicted() external {
        DominoVaultV4 good = _implementation(address(factory));
        factory.finalizeImplementation(address(good));
        positions.mint(address(this), 11, _key(), -600, 600, 1000);

        require(factory.nextOwnerNonce(address(this)) == 0, "first vault is nonce zero");
        (bool ok, bytes memory out) = address(factory).call(
            abi.encodeCall(DominoVaultFactoryV4.createVault, (_params(), 1)));
        _refused(ok, out, DominoVaultFactoryV4.UnexpectedOwnerNonce.selector, "the caller must know its nonce");

        address predicted = factory.predictVault(address(this), 0);
        positions.approve(predicted, 11);
        address created = factory.createVault(_params(), 0);
        require(created == predicted, "created where it was predicted");
        require(factory.isVault(created) && factory.vaultForSequence(
            factory.sequenceIdFor(address(this), 0)) == created, "registered under its sequence");
        require(factory.nextOwnerNonce(address(this)) == 1, "the nonce advanced exactly once");
    }

    function _key() private view returns (T.PoolKey memory) {
        return T.PoolKey(address(0), address(token), 3000, 60, address(0));
    }

    function _params() private view returns (T.InitParams memory) {
        return T.InitParams({
            rootTokenId: 11, expectedPoolId: keccak256(abi.encode(_key())),
            baseCurrency: _key().currency0, quoteCurrency: _key().currency1,
            operator: address(0xB0B), consentToUncollectedFees: true,
            policy: IDominoVaultDraft.Policy(200, 500, 1000, 60, 4, 1, false),
            limits: T.ExecutionLimits(1, 5000, 100, 100, 1 ether, 60, 3600)
        });
    }
}
