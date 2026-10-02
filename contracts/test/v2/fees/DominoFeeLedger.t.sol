// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoFeeEvents, IDominoFeeSettlement} from "../../../src/v2/interfaces/IDominoFees.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {DominoFeeLedger} from "../../../src/v2/fees/DominoFeeLedger.sol";
import {DominoActionLock} from "../../../src/v2/route/DominoActionLock.sol";
import {
    AcceptingRecipient,
    GasBurningRecipient,
    MockDominoRegistry,
    ReenteringRecipient,
    RejectingRecipient,
    TestToken,
    V2TestBase,
    V2Vm
} from "../route/V2RouteTestKit.sol";

/// A fee-charging host with no swaps (the shape of the auto-exit module).
contract FeeLedgerHarness is DominoFeeLedger {
    constructor(IDominoRegistry registry) DominoFeeLedger(registry) {}

    receive() external payable {}

    function charge(uint8 kind, address token, address payer, uint256 amount, bytes32 ref)
        external
        nonReentrant
        returns (uint256 deferred)
    {
        return _chargeFee(kind, token, payer, amount, ref);
    }

    function unowedBalance(address token) external view returns (uint256) {
        return _unowedBalance(token);
    }
}

/// V1 audit A1 in V2: a fee is paid by push, but a recipient that cannot
/// receive never blocks an action. The shortfall is owed, backed, never
/// spendable, and anyone flushes it later to the recipient then in force.
contract DominoFeeLedgerTest is V2TestBase {
    address internal constant PAYER = address(0xB0B);
    address internal constant STRANGER = address(0x5A11);
    address internal constant ETH = address(0);
    bytes32 internal constant REF = keccak256("intent");
    uint8 internal constant KIND = DominoV2Types.FEE_KIND_ASSISTED_SWAP;

    bytes32 internal constant FEE_CHARGED = keccak256("FeeCharged(uint8,address,address,uint256,bytes32)");
    bytes32 internal constant FEE_DEFERRED = keccak256("FeeDeferred(address,uint256,uint256)");
    bytes32 internal constant OWED_FLUSHED = keccak256("OwedFeesFlushed(address,address,uint256)");

    MockDominoRegistry internal registry;
    FeeLedgerHarness internal host;
    TestToken internal token;
    address internal recipient = address(0xFEE);

    function setUp() public {
        registry = new MockDominoRegistry();
        registry.setFeeRecipient(recipient);
        host = new FeeLedgerHarness(IDominoRegistry(address(registry)));
        token = new TestToken();
        token.mint(address(host), 1_000_000);
        vm.deal(address(host), 1 ether);
    }

    function _charge(address currency, uint256 amount) internal returns (uint256 deferred) {
        return host.charge(KIND, currency, PAYER, amount, REF);
    }

    function _owedAfterFailedCharge(address currency, uint256 amount, string memory what) internal {
        uint256 before = currency == ETH ? address(host).balance : token.balanceOf(address(host));
        vm.recordLogs();
        _eq(_charge(currency, amount), amount, what);
        V2Vm.Log[] memory logs = vm.getRecordedLogs();
        _eq(host.owedFees(currency), amount, "owed");
        _eq(currency == ETH ? address(host).balance : token.balanceOf(address(host)), before, "nothing left");
        _eq(_count(logs, address(host), FEE_CHARGED), 1, "FeeCharged");
        V2Vm.Log memory deferred = _first(logs, address(host), FEE_DEFERRED);
        _check(deferred.topics[1] == bytes32(uint256(uint160(currency))), "FeeDeferred token");
        (uint256 deferredAmount, uint256 total) = abi.decode(deferred.data, (uint256, uint256));
        _check(deferredAmount == amount && total == amount, "FeeDeferred amounts");
    }

    // ------------------------------------------------------------ paying
    function testAFeeIsPaidInTheSameTransaction() public {
        vm.recordLogs();
        _eq(_charge(address(token), 650), 0, "nothing deferred");
        V2Vm.Log[] memory logs = vm.getRecordedLogs();
        _eq(token.balanceOf(recipient), 650, "recipient paid");
        _eq(token.balanceOf(address(host)), 1_000_000 - 650, "host debited");
        _eq(host.owedFees(address(token)), 0, "nothing owed");
        V2Vm.Log memory charged = _first(logs, address(host), FEE_CHARGED);
        _check(charged.topics[1] == bytes32(uint256(KIND)), "FeeCharged kind");
        _check(charged.topics[2] == bytes32(uint256(uint160(address(token)))), "FeeCharged token");
        _check(charged.topics[3] == bytes32(uint256(uint160(PAYER))), "FeeCharged payer");
        (uint256 amount, bytes32 ref) = abi.decode(charged.data, (uint256, bytes32));
        _check(amount == 650 && ref == REF, "FeeCharged amount and ref");
        _eq(_count(logs, address(host), FEE_DEFERRED), 0, "no FeeDeferred");
    }

    function testANativeFeeIsPaid() public {
        AcceptingRecipient wallet = new AcceptingRecipient();
        registry.setFeeRecipient(address(wallet));
        _eq(_charge(ETH, 0.01 ether), 0, "nothing deferred");
        _eq(wallet.received(), 0.01 ether, "native fee received");
        _eq(address(host).balance, 0.99 ether, "host debited");
    }

    function testATokenWithoutReturnValueIsPaid() public {
        token.setMode(2);
        _eq(_charge(address(token), 650), 0, "USDT-style transfer accepted");
        _eq(token.balanceOf(recipient), 650, "recipient paid");
    }

    /// A transfer tax on the recipient's side is the recipient's: this
    /// contract paid in full, so nothing is owed.
    function testARecipientSideTaxIsTheRecipients() public {
        token.setTax(100);
        _eq(_charge(address(token), 1000), 0, "paid in full from this side");
        _eq(token.balanceOf(recipient), 990, "the recipient bore the 1% tax");
        _eq(host.owedFees(address(token)), 0, "nothing owed");
    }

    // ---------------------------------------------------------- deferring
    function testARecipientThatRefusesNativeLeavesTheFeeOwed() public {
        registry.setFeeRecipient(address(new RejectingRecipient()));
        _owedAfterFailedCharge(ETH, 0.01 ether, "a 7702 account without receive");
    }

    function testABlockedRecipientLeavesTheFeeOwed() public {
        token.setBlocked(recipient, true);
        _owedAfterFailedCharge(address(token), 650, "an issuer froze the recipient");
    }

    function testAFalseReturningTokenLeavesTheFeeOwed() public {
        token.setMode(1);
        _owedAfterFailedCharge(address(token), 650, "transfer returned false");
    }

    function testNoRecipientLeavesTheFeeOwed() public {
        registry.setFeeRecipient(address(0));
        _owedAfterFailedCharge(address(token), 650, "no recipient configured");
    }

    function testABrokenRegistryLeavesTheFeeOwed() public {
        registry.setRecipientReverts(true);
        _owedAfterFailedCharge(address(token), 650, "the registry reverts");
    }

    /// A misconfigured recipient equal to the host moves nothing, so the fee stays owed.
    function testASelfPaymentIsNoPayment() public {
        registry.setFeeRecipient(address(host));
        _owedAfterFailedCharge(address(token), 650, "an ERC-20 self-transfer");
        _owedAfterFailedCharge(ETH, 1, "a native self-transfer");
    }

    /// The inline attempt is capped: a recipient that burns gas costs the
    /// action at most the cap, and the fee waits.
    function testAGasBurningRecipientCannotBlockTheAction() public {
        registry.setFeeRecipient(address(new GasBurningRecipient()));
        uint256 start = gasleft();
        _eq(_charge(ETH, 0.01 ether), 0.01 ether, "deferred");
        uint256 used = start - gasleft();
        _check(used < 250_000, "the burner was given no more than the cap");
        _check(used > 50_000, "the burner was given the cap");
        _eq(host.owedFees(ETH), 0.01 ether, "owed");
    }

    /// The cap holds for ERC-20s too: a token whose transfer burns gas.
    function testAGasBurningTokenCannotBlockTheAction() public {
        token.setHook(address(new GasBurningRecipient()), "");
        uint256 start = gasleft();
        _eq(_charge(address(token), 650), 650, "deferred");
        _check(start - gasleft() < 250_000, "the token was given no more than the cap");
    }

    function testAnEarlierShortfallStaysOwedWhileLaterFeesArePaid() public {
        token.setBlocked(recipient, true);
        _charge(address(token), 650);
        token.setBlocked(recipient, false);
        _eq(_charge(address(token), 650), 0, "the next fee is paid");
        _eq(host.owedFees(address(token)), 650, "the earlier one stays owed");
        _eq(host.unowedBalance(address(token)), 1_000_000 - 1300, "owed is not spendable");
    }

    /// A token that takes more than asked would spend balances owed to others.
    function testATokenThatTakesMoreThanAskedReverts() public {
        token.setMode(3);
        _expectRevertData(
            address(host),
            abi.encodeCall(FeeLedgerHarness.charge, (KIND, address(token), PAYER, 650, REF)),
            abi.encodeWithSelector(DominoFeeLedger.FeeTransferMismatch.selector, address(token)),
            "over-debit"
        );
    }

    /// A token that hands this contract more than it takes during the
    /// payment: nothing measured as paid, so the fee stays owed (and backed).
    function testABalanceThatGrowsDuringThePaymentLeavesTheFeeOwed() public {
        token.setHook(address(token), abi.encodeCall(TestToken.mint, (address(host), 1000)));
        _eq(_charge(address(token), 650), 650, "deferred, not a panic");
        _eq(host.owedFees(address(token)), 650, "owed");
    }

    function testOwedFeesAccumulateAndAreNeverSpendable() public {
        token.setBlocked(recipient, true);
        _charge(address(token), 400);
        vm.recordLogs();
        _charge(address(token), 250);
        V2Vm.Log memory deferred = _first(vm.getRecordedLogs(), address(host), FEE_DEFERRED);
        (uint256 amount, uint256 total) = abi.decode(deferred.data, (uint256, uint256));
        _check(amount == 250 && total == 650, "FeeDeferred carries the running total");
        _eq(host.owedFees(address(token)), 650, "owed accumulates");
        _eq(host.unowedBalance(address(token)), 1_000_000 - 650, "the owed part is excluded");
    }

    /// Owed amounts sit in ERC-7201 storage, so a minimal-proxy clone or any
    /// host layout keeps them apart from its own state.
    function testOwedFeesLiveInTheErc7201Namespace() public {
        token.setBlocked(recipient, true);
        _charge(address(token), 650);
        bytes32 root = keccak256(abi.encode(uint256(keccak256("domino.v2.fees")) - 1)) & ~bytes32(uint256(0xff));
        bytes32 slot = keccak256(abi.encode(address(token), root));
        _eq(uint256(vm.load(address(host), slot)), 650, "owed[token] at the namespaced slot");
    }

    // ------------------------------------------------------------ backing
    function testAFeeMustBeBackedByTheBalance() public {
        _expectRevertData(
            address(host),
            abi.encodeCall(FeeLedgerHarness.charge, (KIND, address(token), PAYER, 1_000_001, REF)),
            abi.encodeWithSelector(DominoFeeLedger.FeeNotBacked.selector, address(token)),
            "more than the balance"
        );
        // An owed amount already claims its share of the balance.
        token.setBlocked(recipient, true);
        _charge(address(token), 600_000);
        _expectRevertData(
            address(host),
            abi.encodeCall(FeeLedgerHarness.charge, (KIND, address(token), PAYER, 400_001, REF)),
            abi.encodeWithSelector(DominoFeeLedger.FeeNotBacked.selector, address(token)),
            "the balance minus what is owed"
        );
        _eq(_charge(address(token), 400_000), 400_000, "exactly backed");
    }

    function testAZeroFeeChargesNothing() public {
        vm.recordLogs();
        _eq(_charge(address(token), 0), 0, "nothing deferred");
        _eq(vm.getRecordedLogs().length, 0, "no event");
    }

    function testTheConstructorNeedsARegistry() public {
        (bool ok,) = address(this).call(abi.encodeCall(this.deploy, (address(0x1234))));
        _check(!ok, "a registry without code");
        (ok,) = address(this).call(abi.encodeCall(this.deploy, (address(registry))));
        _check(ok, "a registry with code");
    }

    function deploy(address registry_) external {
        new FeeLedgerHarness(IDominoRegistry(registry_));
    }

    // ------------------------------------------------------------- flushing
    function testAnyoneFlushesToTheRotatedRecipient() public {
        registry.setFeeRecipient(address(new RejectingRecipient()));
        _charge(ETH, 0.01 ether);
        AcceptingRecipient next = new AcceptingRecipient();
        registry.setFeeRecipient(address(next)); // governance rotated the recipient
        vm.recordLogs();
        vm.prank(STRANGER);
        _eq(host.flushOwedFees(ETH), 0.01 ether, "flushed amount");
        V2Vm.Log memory flushed = _first(vm.getRecordedLogs(), address(host), OWED_FLUSHED);
        _check(flushed.topics[1] == bytes32(0) && flushed.topics[2] == bytes32(uint256(uint160(address(next)))),
            "OwedFeesFlushed names the token and the current recipient");
        _eq(abi.decode(flushed.data, (uint256)), 0.01 ether, "OwedFeesFlushed amount");
        _eq(next.received(), 0.01 ether, "the current recipient was paid");
        _eq(host.owedFees(ETH), 0, "nothing owed");
        _eq(address(host).balance, 0.99 ether, "host debited once");
    }

    function testAFlushOfAnErc20PaysTheRecipientInForce() public {
        token.setBlocked(recipient, true);
        _charge(address(token), 650);
        address next = address(0xFEE2);
        registry.setFeeRecipient(next);
        _eq(host.flushOwedFees(address(token)), 650, "flushed");
        _eq(token.balanceOf(next), 650, "new recipient paid");
        _eq(token.balanceOf(recipient), 0, "old recipient not paid");
        _eq(host.owedFees(address(token)), 0, "settled");
    }

    function testAFlushRevertsWhileTheRecipientStillCannotReceive() public {
        token.setBlocked(recipient, true);
        _charge(address(token), 650);
        _expectRevertData(
            address(host),
            abi.encodeCall(IDominoFeeSettlement.flushOwedFees, (address(token))),
            abi.encodeWithSelector(DominoFeeLedger.FeeTransferMismatch.selector, address(token)),
            "still blocked"
        );
        _eq(host.owedFees(address(token)), 650, "still owed");
    }

    function testAFlushMeasuresWhatLeft() public {
        token.setBlocked(recipient, true);
        _charge(address(token), 650);
        token.setBlocked(recipient, false);
        token.setMode(3);
        _expectRevertData(
            address(host),
            abi.encodeCall(IDominoFeeSettlement.flushOwedFees, (address(token))),
            abi.encodeWithSelector(DominoFeeLedger.FeeTransferMismatch.selector, address(token)),
            "the token took more than owed"
        );
        token.setMode(1);
        _expectRevertData(
            address(host),
            abi.encodeCall(IDominoFeeSettlement.flushOwedFees, (address(token))),
            abi.encodeWithSelector(DominoFeeLedger.FeeTransferMismatch.selector, address(token)),
            "the token returned false"
        );
        token.setMode(0);
        token.setTax(100);
        _eq(host.flushOwedFees(address(token)), 650, "a recipient-side tax still settles");
    }

    function testAFlushWithNothingOwedDoesNothing() public {
        vm.recordLogs();
        _eq(host.flushOwedFees(address(token)), 0, "nothing to pay");
        _eq(vm.getRecordedLogs().length, 0, "no event");
    }

    function testAFlushNeedsARecipient() public {
        token.setBlocked(recipient, true);
        _charge(address(token), 650);
        registry.setFeeRecipient(address(0));
        _expectRevert(address(host), abi.encodeCall(IDominoFeeSettlement.flushOwedFees, (address(token))),
            DominoFeeLedger.FeeRecipientUnavailable.selector, "no recipient");
        registry.setRecipientReverts(true);
        _expectRevert(address(host), abi.encodeCall(IDominoFeeSettlement.flushOwedFees, (address(token))),
            DominoFeeLedger.FeeRecipientUnavailable.selector, "registry unavailable");
        _eq(host.owedFees(address(token)), 650, "still owed");
    }

    /// The recipient cannot flush (or start anything) in the middle of an
    /// action, nor flush again in the middle of a flush.
    function testAFlushNeverRunsInsideAnAction() public {
        ReenteringRecipient reentrant = new ReenteringRecipient();
        reentrant.arm(address(host), abi.encodeCall(IDominoFeeSettlement.flushOwedFees, (ETH)));
        registry.setFeeRecipient(address(reentrant));
        _eq(_charge(ETH, 0.01 ether), 0, "paid: the recipient's own call failed, not the payment");
        _check(reentrant.reverted(), "flush inside the charge was refused");
        _check(bytes4(reentrant.revertData()) == DominoActionLock.ReentrantCall.selector, "by the lock");
    }

    function testAFlushCannotReenterItself() public {
        registry.setFeeRecipient(address(new RejectingRecipient()));
        _charge(ETH, 0.01 ether);
        ReenteringRecipient reentrant = new ReenteringRecipient();
        reentrant.arm(address(host), abi.encodeCall(IDominoFeeSettlement.flushOwedFees, (ETH)));
        registry.setFeeRecipient(address(reentrant));
        _eq(host.flushOwedFees(ETH), 0.01 ether, "flushed once");
        _check(reentrant.reverted(), "the nested flush was refused");
        _check(bytes4(reentrant.revertData()) == DominoActionLock.ReentrantCall.selector, "by the lock");
        _eq(address(reentrant).balance, 0.01 ether, "paid exactly once");
    }

    function testTheEventsAreTheFrozenOnes() public pure {
        _check(IDominoFeeEvents.FeeCharged.selector == FEE_CHARGED, "FeeCharged signature");
        _check(IDominoFeeEvents.FeeDeferred.selector == FEE_DEFERRED, "FeeDeferred signature");
        _check(IDominoFeeEvents.OwedFeesFlushed.selector == OWED_FLUSHED, "OwedFeesFlushed signature");
    }
}
