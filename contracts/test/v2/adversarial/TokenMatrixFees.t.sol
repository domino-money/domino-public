// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {DominoFeeLedger} from "../../../src/v2/fees/DominoFeeLedger.sol";
import {DominoSwapExecutor} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {DominoTokenOps} from "../../../src/v2/route/DominoTokenOps.sol";
import {AssistedSwapHarness, MockDominoRegistry, V2TestBase, V2Vm} from "../route/V2RouteTestKit.sol";
import {AdversarialVm, Behaviour, CHEATS, MatrixToken, consoleLog} from "./HostileTokens.sol";

/// @notice Fee settlement (F1b's DominoFeeLedger) against every behaviour of
/// the token matrix, through AssistedSwapHarness, the host shape the zap and
/// the vault share: the inline push with its 100k gas cap, the owed fallback
/// and flushOwedFees. Each charge either reverts for a documented reason with
/// nothing moved, or settles exactly: what left the host plus what is now owed
/// is the fee, the recipient got what left (less a tax on its own side), owed
/// fees only grow and stay backed, and neither a gas burner nor a return bomb
/// gets more than the cap.
contract TokenMatrixFeesTest is V2TestBase {
    AdversarialVm internal constant cheats = AdversarialVm(CHEATS);
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant PAYER = address(0xB0B);
    address internal constant RECIPIENT = address(0xFEE);
    bytes32 internal constant REF = keccak256("token matrix");
    uint8 internal constant KIND = DominoV2Types.FEE_KIND_ASSISTED_SWAP;
    /// DominoFeeLedger.FEE_TRANSFER_GAS.
    uint256 internal constant FEE_TRANSFER_GAS = 100_000;
    /// What a charge spends besides the capped push: two balance reads, the
    /// registry read, the owed slot (a fresh one is 22k) and two events.
    uint256 internal constant CHARGE_OVERHEAD = 60_000;

    bytes32 internal constant FEE_CHARGED = keccak256("FeeCharged(uint8,address,address,uint256,bytes32)");
    bytes32 internal constant FEE_DEFERRED = keccak256("FeeDeferred(address,uint256,uint256)");
    bytes32 internal constant OWED_FLUSHED = keccak256("OwedFeesFlushed(address,address,uint256)");

    MockDominoRegistry internal registry;
    AssistedSwapHarness internal host;
    MatrixToken internal token;

    /// One charge's observable effects.
    struct Settlement {
        bool ok;
        bytes4 reason;
        uint256 deferred;
        uint256 debited;
        uint256 received;
        uint256 owedBefore;
        uint256 owedAfter;
        uint256 gasUsed;
    }

    function setUp() public {
        // The executor needs code at Permit2; no router leg runs here.
        vm.etch(PERMIT2, hex"00");
        registry = new MockDominoRegistry();
        registry.setFeeRecipient(RECIPIENT);
        host = new AssistedSwapHarness(
            DominoSwapExecutor.RouteConfig(IDominoRegistry(address(registry)), PERMIT2, address(0), bytes32(0), address(0))
        );
        token = new MatrixToken();
    }

    // ============================================================ helpers

    /// A fuzzed parameter for the behaviour: a tax in bps, an over-debit, a
    /// payload size, a lie or an inflation.
    function _param(uint8 behaviour, uint256 seed) internal pure returns (uint256) {
        if (behaviour == Behaviour.TAXED) return 1 + seed % 10_000;
        if (behaviour == Behaviour.OVERDEBITS) return 1 + seed % 1e18;
        if (behaviour == Behaviour.RETURN_BOMB || behaviour == Behaviour.APPROVE_BOMB) return 32 + seed % 2_000_000;
        if (behaviour == Behaviour.BALANCE_LIES || behaviour == Behaviour.INFLATES) return 1 + seed % 1e24;
        return 0;
    }

    /// Aims the behaviour at the host; the hook, when on, re-enters the host's flush.
    function _aim(uint8 behaviour, uint256 param) internal {
        if (behaviour == Behaviour.HOOKED) {
            token.setHook(address(host), abi.encodeCall(DominoFeeLedger.flushOwedFees, (address(token))));
        }
        token.aim(address(host), behaviour, param, false);
    }

    /// Leaves `owed` owed in the token: the recipient is dark for one charge.
    function _owe(uint256 owed) internal {
        if (owed == 0) return;
        token.setBlocked(RECIPIENT, true);
        host.chargeFee(KIND, address(token), PAYER, owed, REF);
        token.setBlocked(RECIPIENT, false);
        _eq(host.owedFees(address(token)), owed, "the earlier fee is owed");
    }

    function _charge(uint256 amount, uint256 gasLimit) internal returns (Settlement memory s) {
        s.owedBefore = host.owedFees(address(token));
        uint256 held = token.heldBy(address(host));
        uint256 paidBefore = token.heldBy(RECIPIENT);
        vm.recordLogs();
        uint256 start = gasleft();
        (bool ok, bytes memory out) = address(host).call{gas: gasLimit}(
            abi.encodeCall(AssistedSwapHarness.chargeFee, (KIND, address(token), PAYER, amount, REF))
        );
        s.gasUsed = start - gasleft();
        V2Vm.Log[] memory logs = vm.getRecordedLogs();
        s.ok = ok;
        s.owedAfter = host.owedFees(address(token));
        uint256 heldAfter = token.heldBy(address(host));
        s.debited = held > heldAfter ? held - heldAfter : 0;
        s.received = token.heldBy(RECIPIENT) - paidBefore;
        if (!ok) {
            s.reason = out.length >= 4 ? bytes4(out) : bytes4(0);
            _eq(s.owedAfter, s.owedBefore, "a refused charge leaves the owed fees");
            _eq(heldAfter, held, "a refused charge moves nothing");
            _eq(s.received, 0, "a refused charge pays nothing");
            return s;
        }
        s.deferred = abi.decode(out, (uint256));
        _checkEvents(logs, amount, s);
    }

    /// Exactly one FeeCharged for the whole fee, then one FeeDeferred for the
    /// shortfall carrying the new total, and none without a shortfall.
    function _checkEvents(V2Vm.Log[] memory logs, uint256 amount, Settlement memory s) internal view {
        if (amount == 0) {
            _eq(logs.length, 0, "a zero fee emits nothing");
            return;
        }
        _eq(_count(logs, address(host), FEE_CHARGED), 1, "one FeeCharged");
        V2Vm.Log memory charged = _first(logs, address(host), FEE_CHARGED);
        (uint256 reported, bytes32 ref) = abi.decode(charged.data, (uint256, bytes32));
        _check(reported == amount && ref == REF, "FeeCharged carries the fee and the reference");
        _check(charged.topics[2] == bytes32(uint256(uint160(address(token)))), "FeeCharged token");
        uint256 deferrals = _count(logs, address(host), FEE_DEFERRED);
        if (s.deferred == 0) {
            _eq(deferrals, 0, "nothing deferred, no FeeDeferred");
            return;
        }
        _eq(deferrals, 1, "one FeeDeferred");
        (uint256 deferred, uint256 total) = abi.decode(_first(logs, address(host), FEE_DEFERRED).data, (uint256, uint256));
        _check(deferred == s.deferred && total == s.owedAfter, "FeeDeferred carries the shortfall and the total");
    }

    /// The settlement of a charge that completed: the fee is what left the
    /// host plus what is owed, the recipient got what left (less a tax on its
    /// own side), owed fees only grew and stay backed by what the host holds.
    function _exact(Settlement memory s, uint256 amount, uint256 taxBps) internal view {
        _check(s.deferred <= amount, "never more than the fee is owed");
        _eq(s.debited + s.deferred, amount, "what left plus what is owed is the fee");
        _eq(s.owedAfter, s.owedBefore + s.deferred, "the shortfall, and only it, is owed");
        _eq(s.received, s.debited - s.debited * taxBps / 10_000, "the recipient got what left, less its own tax");
        _check(token.heldBy(address(host)) >= s.owedAfter, "owed fees are backed");
    }

    function _taxBps(uint8 behaviour) internal view returns (uint256) {
        return behaviour == Behaviour.TAXED ? token.param() : 0;
    }

    // ===================================================== the charge, fuzzed

    /// Every behaviour, any fee, any earlier debt, the recipient able to
    /// receive or not: the charge either reverts for a documented reason with
    /// nothing moved, or settles exactly. The only refusals of a fee the host
    /// can back are an over-debit (it would spend balances owed to others)
    /// and an unreadable balance.
    function testFuzz_AChargeSettlesExactlyOrRevertsCleanly(
        uint256 behaviourSeed,
        uint256 paramSeed,
        uint96 owed,
        uint96 amount,
        uint96 spare,
        bool recipientDark
    ) public {
        uint8 behaviour = uint8(behaviourSeed % Behaviour.COUNT);
        token.mint(address(host), uint256(owed) + amount + spare);
        _owe(owed);
        _aim(behaviour, _param(behaviour, paramSeed));
        token.setBlocked(RECIPIENT, recipientDark);
        Settlement memory s = _charge(amount, 5_000_000);
        if (!s.ok) {
            bool overDebit = behaviour == Behaviour.OVERDEBITS && !recipientDark
                && s.reason == DominoFeeLedger.FeeTransferMismatch.selector;
            bool unreadable =
                behaviour == Behaviour.BALANCE_REVERTS && s.reason == DominoTokenOps.TokenCallFailed.selector;
            _check(overDebit || unreadable, "a charge the host can back reverts only for a documented reason");
            return;
        }
        _exact(s, amount, _taxBps(behaviour));
        // A dark recipient, a refusing or lying payment, a burner, a
        // re-entering hook: all owed, never lost.
        if (recipientDark && amount != 0) _eq(s.deferred, amount, "a dark recipient leaves it all owed");
    }

    /// An unbacked fee is refused whatever the payment does. (A token that
    /// lies about the host's balance passes this check, since the ledger can
    /// only read balanceOf: testALyingBalanceCanOnlyOweItsOwnToken.)
    function testFuzz_AnUnbackedChargeIsRefused(uint256 behaviourSeed, uint96 held, uint96 shortfall) public {
        uint8 behaviour = uint8(behaviourSeed % Behaviour.COUNT);
        cheats.assume(behaviour != Behaviour.BALANCE_LIES);
        token.mint(address(host), held);
        _aim(behaviour, _param(behaviour, shortfall));
        Settlement memory s = _charge(uint256(held) + 1 + shortfall, 5_000_000);
        _check(!s.ok, "refused");
        _check(
            s.reason == DominoFeeLedger.FeeNotBacked.selector || s.reason == DominoTokenOps.TokenCallFailed.selector,
            "FeeNotBacked, or an unreadable balance"
        );
    }

    /// A token that reports more than the host holds gets an unbacked fee past
    /// FeeNotBacked: the push fails for want of tokens and the fee is owed,
    /// unbacked. The debt is in the lying token only; another token's owed
    /// fees and backing are untouched. Accepted: a host can only read
    /// balanceOf, and the fee token is a charge currency or the plan's own
    /// first input (F1b's charge-currency rule).
    function testALyingBalanceCanOnlyOweItsOwnToken() public {
        MatrixToken honest = new MatrixToken();
        honest.mint(address(host), 1000);
        honest.setBlocked(RECIPIENT, true);
        host.chargeFee(KIND, address(honest), PAYER, 400, REF);
        token.mint(address(host), 100);
        token.aim(address(host), Behaviour.BALANCE_LIES, 1e18, false);
        Settlement memory s = _charge(650, 5_000_000);
        _check(s.ok && s.deferred == 650, "owed: the lie passed the backing check, the push could not pay");
        _check(token.heldBy(address(host)) < host.owedFees(address(token)), "the lying token's own fee is unbacked");
        _eq(honest.heldBy(address(host)), 1000, "the other token is untouched");
        _eq(host.owedFees(address(honest)), 400, "and its owed fee stays backed");
    }

    // ====================================================== the flush, fuzzed

    /// Whatever the token does at flush time, a flush pays exactly the owed
    /// amount to the recipient in force and clears it, or reverts and leaves
    /// all of it owed.
    function testFuzz_AFlushPaysExactlyWhatIsOwedOrNothing(
        uint256 behaviourSeed,
        uint256 paramSeed,
        uint96 owed,
        uint96 spare,
        bool recipientDark
    ) public {
        cheats.assume(owed != 0);
        uint8 behaviour = uint8(behaviourSeed % Behaviour.COUNT);
        token.mint(address(host), uint256(owed) + spare);
        _owe(owed);
        _aim(behaviour, _param(behaviour, paramSeed));
        token.setBlocked(RECIPIENT, recipientDark);
        uint256 held = token.heldBy(address(host));
        uint256 paidBefore = token.heldBy(RECIPIENT);
        vm.recordLogs();
        // A bounded budget, so a burner's 63/64 stays small next to the test's own.
        (bool ok, bytes memory out) =
            address(host).call{gas: 10_000_000}(abi.encodeCall(DominoFeeLedger.flushOwedFees, (address(token))));
        V2Vm.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) {
            _eq(host.owedFees(address(token)), owed, "a failed flush leaves everything owed");
            _eq(token.heldBy(address(host)), held, "and moves nothing");
            return;
        }
        _eq(abi.decode(out, (uint256)), owed, "the flush returns what was owed");
        _eq(host.owedFees(address(token)), 0, "and clears it");
        _eq(held - token.heldBy(address(host)), owed, "exactly the owed amount left the host");
        _eq(token.heldBy(RECIPIENT) - paidBefore, owed - owed * _taxBps(behaviour) / 10_000,
            "the recipient got it, less its own tax");
        _eq(_count(logs, address(host), OWED_FLUSHED), 1, "one OwedFeesFlushed");
        _check(!recipientDark, "a dark recipient is never flushed to");
        _check(
            behaviour != Behaviour.RETURNS_FALSE && behaviour != Behaviour.REVERTS && behaviour != Behaviour.BURNS_GAS
                && behaviour != Behaviour.TRUE_BUT_STILL && behaviour != Behaviour.OVERDEBITS,
            "a payment that failed or took more never counts as a flush"
        );
    }

    // ========================================================= the gas cap

    /// A token that burns all it is given, and return bombs from a word to
    /// four megabytes: the inline push never gets more than the cap, the
    /// caller never pays to copy the payload, the action completes on a
    /// modest gas budget, and what could not be paid stays owed.
    function testNeitherABurnerNorABombGetsMoreThanTheCap() public {
        token.mint(address(host), 1e24);
        uint256[6] memory sizes = [uint256(32), 1_024, 32_768, 200_000, 1_000_000, 4_000_000];
        for (uint256 i; i < sizes.length + 1; ++i) {
            if (i < sizes.length) token.aim(address(host), Behaviour.RETURN_BOMB, sizes[i], false);
            else token.aim(address(host), Behaviour.BURNS_GAS, 0, false);
            uint256 snapshot = vm.snapshotState();
            // The push's 100k plus the charge's own work, with room under the 63/64 rule.
            Settlement memory s = _charge(650, 400_000);
            _check(s.ok, "the action completes on a modest budget");
            _check(s.gasUsed < FEE_TRANSFER_GAS + CHARGE_OVERHEAD, "the token got at most the cap");
            _exact(s, 650, 0);
            vm.revertToState(snapshot);
        }
    }

    /// The bounded forward is what keeps the action alive: a payload too
    /// large for the cap fails inside it and is owed, one that fits is paid;
    /// a flush, which forwards all its gas, pays the large one later.
    function testABombThatFitsTheCapIsPaidAndOneThatDoesNotIsOwed() public {
        token.mint(address(host), 1e24);
        token.aim(address(host), Behaviour.RETURN_BOMB, 1_024, false);
        Settlement memory small = _charge(650, 400_000);
        _check(small.ok && small.deferred == 0 && small.received == 650, "a 1 KB payload is paid");
        token.aim(address(host), Behaviour.RETURN_BOMB, 1_000_000, false);
        Settlement memory large = _charge(650, 400_000);
        _check(large.ok && large.deferred == 650 && large.received == 0, "a 1 MB payload outgrows the cap and is owed");
        _eq(host.flushOwedFees(address(token)), 650, "the flush pays it");
        _eq(token.heldBy(RECIPIENT), 1300, "both fees reached the recipient");
    }

    // ===================================================== balances in transit

    /// A rebase in the middle of the push: up, the fee is owed although the
    /// recipient was paid (F1b's documented "balance that grew"), and the
    /// rebase backs it; down, the host lost more than the fee and the charge
    /// is refused (FeeTransferMismatch).
    function testARebaseDuringThePushIsOwedOrRefused() public {
        token.mint(address(host), 1e6);
        token.aim(address(host), Behaviour.HOOKED, 0, false);
        token.setHook(address(token), abi.encodeCall(MatrixToken.mint, (address(host), 1000)));
        Settlement memory up = _charge(650, 1_000_000);
        _check(up.ok && up.deferred == 650 && up.received == 650, "paid, yet owed: the balance grew");
        _check(token.heldBy(address(host)) >= host.owedFees(address(token)), "backed by the rebase");
        token.setHook(address(token), abi.encodeCall(MatrixToken.burn, (address(host), 1000)));
        Settlement memory down = _charge(650, 1_000_000);
        _check(!down.ok && down.reason == DominoFeeLedger.FeeTransferMismatch.selector, "a fall is refused");
    }

    /// The lock: a token whose payment calls back into the host's flush, or
    /// into a new charge, meets ReentrantCall, so that payment fails and the
    /// fee stays owed; nothing is paid twice.
    function testATokenThatReentersTheHostMeetsTheLock() public {
        token.mint(address(host), 1e6);
        _owe(100);
        _aim(Behaviour.HOOKED, 0);
        Settlement memory s = _charge(650, 1_000_000);
        _check(s.ok && s.deferred == 650 && s.received == 0, "the re-entering payment failed and the fee is owed");
        _eq(s.owedAfter, 750, "both owed");
        token.setHook(
            address(host), abi.encodeCall(AssistedSwapHarness.chargeFee, (KIND, address(token), PAYER, 1, REF))
        );
        _expectRevertData(
            address(host),
            abi.encodeCall(DominoFeeLedger.flushOwedFees, (address(token))),
            abi.encodeWithSelector(DominoFeeLedger.FeeTransferMismatch.selector, address(token)),
            "a flush whose payment re-enters fails"
        );
        _eq(host.owedFees(address(token)), 750, "and leaves it owed");
        token.aim(address(host), Behaviour.NORMAL, 0, false);
        _eq(host.flushOwedFees(address(token)), 750, "then flushes exactly");
        _eq(token.heldBy(RECIPIENT), 750, "paid once");
    }

    // ============================================================ the table

    /// Every behaviour once (a 1% tax, a one-unit over-debit, a 1 MB payload):
    /// the charge's outcome with the recipient able to receive, then a flush
    /// of a debt left while it was dark. Printed for the report (-vv).
    function testEveryBehaviourOnTheFeePath() public {
        token.mint(address(host), 1e24);
        for (uint8 b; b < Behaviour.COUNT; ++b) {
            uint256 snapshot = vm.snapshotState();
            _owe(1000);
            uint256 param = b == Behaviour.TAXED ? 100 : b == Behaviour.OVERDEBITS ? 1 : b == Behaviour.RETURN_BOMB
                ? 1_000_000
                : b == Behaviour.BALANCE_LIES || b == Behaviour.INFLATES ? 1e18 : 0;
            _aim(b, param);
            Settlement memory s = _charge(650, 5_000_000);
            if (s.ok) _exact(s, 650, _taxBps(b));
            (bool flushed,) =
                address(host).call{gas: 10_000_000}(abi.encodeCall(DominoFeeLedger.flushOwedFees, (address(token))));
            consoleLog(
                string.concat(
                    "fee path | ",
                    Behaviour.name(b),
                    " | charge: ",
                    !s.ok ? _reason(s.reason) : s.deferred == 0 ? "paid" : s.deferred == 650 ? "owed" : "part owed",
                    " | flush: ",
                    flushed ? "paid" : "stays owed"
                )
            );
            vm.revertToState(snapshot);
        }
    }

    function _reason(bytes4 reason) internal pure returns (string memory) {
        if (reason == DominoFeeLedger.FeeTransferMismatch.selector) return "FeeTransferMismatch";
        if (reason == DominoFeeLedger.FeeNotBacked.selector) return "FeeNotBacked";
        if (reason == DominoTokenOps.TokenCallFailed.selector) return "TokenCallFailed";
        return "other revert";
    }
}
