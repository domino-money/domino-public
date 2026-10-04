// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoVaultLedger} from "../../../src/v2/interfaces/IDominoVaultLedger.sol";
import {DominoFeeLedger} from "../../../src/v2/fees/DominoFeeLedger.sol";
import {DominoV2VaultBase} from "../../../src/v2/vault/DominoV2VaultBase.sol";
import {DominoV2VaultStorage} from "../../../src/v2/vault/DominoV2VaultStorage.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {VaultVm} from "../vault/VaultHarness.sol";
import {AdversarialVm, Behaviour, CHEATS, MatrixToken, TwinEntry, consoleLog} from "./HostileTokens.sol";
import {VaultMatrixWorld} from "./VaultMatrixWorld.sol";

/// PlanV1 with every uint128 widened, to put an amount above 2^128 on the
/// wire: the same ABI head.
struct WideBudget {
    uint256 tokenId;
    uint256 max0;
    uint256 max1;
}

struct WideSwap {
    uint256 source;
    bool zeroForOne;
    uint256 amountIn;
    uint256 minAmountOut;
    DominoV2Types.SwapLeg[] legs;
}

struct WidePlanV1 {
    uint8 action;
    uint64 stateNonce;
    uint64 deadline;
    uint256 target;
    int24 tickLower;
    int24 tickUpper;
    uint256 amount0Max;
    uint256 amount1Max;
    uint256 minLiquidity;
    uint256[] collect;
    WideBudget[] budgets;
    WideSwap swap;
    bytes anchorEvidence;
}

/// @notice The v3 vault's owner and settlement flows (withdrawReserves,
/// recoverToken, exitAll, returnReserves, flushOwedFees) and the operator's
/// compound against every behaviour of the token matrix, with either pool
/// token hostile toward the vault. Every flow either reverts with nothing
/// moved or settles exactly against its events (VaultMatrixWorld's oracle);
/// a hostile token never stops exitAll or returnReserves from paying the
/// other token and returning the successor; and no amount above 2^128 is
/// ever truncated. What the matrix found is pinned below: an over-debiting
/// exact payout (fixed, now refused), a double-entry token (a known limit)
/// and the accepted behaviours of tokens that misreport their own
/// transfers, balances or approvals.
contract TokenMatrixVaultTest is VaultMatrixWorld {
    AdversarialVm internal constant cheats = AdversarialVm(CHEATS);

    // ============================================================= matrix

    /// The (flow, behaviour) pairs where a flow completes without settling
    /// exactly, each pinned below:
    /// - over-debits on exitAll's and returnReserves' best-effort payments
    ///   (A8: they never revert over one token; the exact payouts refuse it):
    ///   testAnOverDebitingWithdrawalIsRefusedAndTheSweepsKeepA8;
    /// - true but still (a payout that reports success and moves nothing):
    ///   testAPayoutThatMovesNothingStaysRecoverable;
    /// - moves but false (exitAll's and returnReserves' tryTransfer keep it idle):
    ///   testAPayoutThatMovesButReportsFailureErodesOnlyItsOwnToken;
    /// - balanceOf lies (recoverToken reads it):
    ///   testABalanceThatLiesErodesOnlyItsOwnToken;
    /// - approve adds (the compound's reset leaves what the manager did not pull):
    ///   testAnAdditiveApproveLeavesTheVaultsAllowanceToTheManagerOnly.
    function _known(uint8 flow, uint8 behaviour) internal pure returns (bool) {
        if (behaviour == Behaviour.OVERDEBITS) return flow == EXIT_ALL || flow == RETURN;
        if (behaviour == Behaviour.TRUE_BUT_STILL) return flow <= RETURN;
        if (behaviour == Behaviour.MOVES_BUT_FALSE) return flow == EXIT_ALL || flow == RETURN;
        if (behaviour == Behaviour.BALANCE_LIES) return flow == RECOVER;
        if (behaviour == Behaviour.APPROVE_ADDS) return flow == COMPOUND;
        return false;
    }

    function _defaultParam(uint8 behaviour) internal pure returns (uint256) {
        if (behaviour == Behaviour.TAXED) return 100;
        if (behaviour == Behaviour.OVERDEBITS) return 1e15;
        if (behaviour == Behaviour.RETURN_BOMB || behaviour == Behaviour.APPROVE_BOMB) return 100_000;
        if (behaviour == Behaviour.BALANCE_LIES) return 1000;
        if (behaviour == Behaviour.INFLATES) return 1e18;
        return 0;
    }

    /// Aims `behaviour` at the vault in one pool token; the hook re-enters
    /// the vault (its flush), which the shared lock refuses.
    function _aim(MatrixToken hostile, uint8 behaviour, uint256 param) internal {
        if (behaviour == Behaviour.HOOKED) {
            hostile.setHook(address(vault), abi.encodeCall(DominoFeeLedger.flushOwedFees, (address(hostile))));
        }
        hostile.aim(address(vault), behaviour, param, false);
    }

    function _trial(uint8 flow, uint8 behaviour, uint256 param, bool first)
        internal
        returns (bool completed, string memory outcome)
    {
        MatrixToken hostile = first ? m0 : m1;
        _prepare(flow, hostile);
        _aim(hostile, behaviour, param);
        Ledger memory before = _ledger();
        (bool ok, bytes memory out, VaultVm.Log[] memory logs) = _runFlow(flow, hostile, FLOW_GAS);
        if (!ok) {
            if (!_untouched(before)) return (false, "VIOLATION: a refused flow moved something");
            return (false, string.concat("reverts: ", _why(out)));
        }
        string memory problem = _settle(flow, before, logs);
        if (bytes(problem).length != 0) return (true, string.concat("VIOLATION: ", problem));
        if (flow == RETURN) {
            // returnReserves reports what it paid, token by token.
            (uint256 amount0, uint256 amount1) = abi.decode(out, (uint256, uint256));
            if (amount0 != _reported(logs, address(m0)).withdrawn || amount1 != _reported(logs, address(m1)).withdrawn) {
                return (true, "VIOLATION: returnReserves returned other than it paid");
            }
        } else if (flow == FLUSH && abi.decode(out, (uint256)) != _reported(logs, address(hostile)).flushed) {
            return (true, "VIOLATION: the flush returned other than it paid");
        }
        return (true, "settles exactly");
    }

    function _isViolation(string memory outcome) internal pure returns (bool) {
        bytes memory text = bytes(outcome);
        return text.length > 9 && text[0] == "V" && text[1] == "I" && text[2] == "O";
    }

    /// Every flow under every behaviour, token0 then token1 hostile (a 1%
    /// tax, an over-debit of 0.001, a 100 KB payload, a lie of 1000 units, an
    /// inflation of one unit, a hook that re-enters the vault). Printed for
    /// the report (-vv). Only the known pairs complete inexactly; exitAll
    /// and returnReserves always complete; everything completes for an
    /// honest token.
    function testEveryFlowUnderEveryBehaviour() public {
        uint256 violations;
        for (uint256 side; side < 2; ++side) {
            for (uint8 flow; flow < FLOWS; ++flow) {
                for (uint8 b; b < Behaviour.COUNT; ++b) {
                    uint256 snapshot = cheats.snapshotState();
                    (bool completed, string memory outcome) = _trial(flow, b, _defaultParam(b), side == 0);
                    consoleLog(
                        string.concat(
                            "vault | token", side == 0 ? "0" : "1", " | ", _flowName(flow), " | ", Behaviour.name(b), " | ", outcome
                        )
                    );
                    if (_isViolation(outcome)) {
                        ++violations;
                        _true(_known(flow, b), string.concat("an unknown violation: ", _flowName(flow), " / ", Behaviour.name(b)));
                    }
                    if (b == Behaviour.NORMAL || flow == EXIT_ALL || flow == RETURN) {
                        _true(completed, string.concat("a flow that must complete: ", _flowName(flow), " / ", Behaviour.name(b)));
                    }
                    cheats.revertToState(snapshot);
                }
            }
        }
        // Per side: true-but-still on the four payouts, over-debits and
        // moves-but-false on exitAll and returnReserves, a lie on recovery;
        // the additive approve leaves an allowance only in the token the
        // compound offers more of than it adds (token0 here).
        _eq(violations, 2 * 9 + 1, "every known violation reproduces, on both sides");
    }

    function _fuzzParam(uint8 behaviour, uint256 seed) internal pure returns (uint256) {
        if (behaviour == Behaviour.TAXED) return 1 + seed % 10_000;
        if (behaviour == Behaviour.OVERDEBITS) return 1 + seed % 1e18;
        if (behaviour == Behaviour.RETURN_BOMB || behaviour == Behaviour.APPROVE_BOMB) return 32 + seed % 300_000;
        if (behaviour == Behaviour.BALANCE_LIES || behaviour == Behaviour.INFLATES) return 1 + seed % 1e24;
        return 0;
    }

    /// The matrix fuzzed: any flow, any behaviour outside the pinned pairs,
    /// any parameter, either token hostile.
    function testFuzz_EveryFlowSettlesExactlyOrRevertsCleanly(
        uint256 flowSeed,
        uint256 behaviourSeed,
        uint256 paramSeed,
        bool first
    ) public {
        uint8 flow = uint8(flowSeed % FLOWS);
        uint8 behaviour = uint8(behaviourSeed % Behaviour.COUNT);
        cheats.assume(!_known(flow, behaviour));
        (bool completed, string memory outcome) = _trial(flow, behaviour, _fuzzParam(behaviour, paramSeed), first);
        _true(!_isViolation(outcome), outcome);
        if (behaviour == Behaviour.NORMAL || flow == EXIT_ALL || flow == RETURN) _true(completed, "completes");
    }

    // ===================================================== exits stay open

    /// The property behind A8, under every behaviour on either side: exitAll
    /// returns the successor, pays every reserve of the token that behaves,
    /// pauses automation and disarms the root, on a 10M gas budget, whatever
    /// the other token does (reverts, refuses, burns gas, bombs, lies,
    /// re-enters). The hostile token's own reserves stay idle or are paid.
    function testExitAllPaysTheOtherTokenWhateverOneTokenDoes() public {
        for (uint256 side; side < 2; ++side) {
            for (uint8 b; b < Behaviour.COUNT; ++b) {
                uint256 snapshot = cheats.snapshotState();
                (MatrixToken hostile, MatrixToken honest) = side == 0 ? (m0, m1) : (m1, m0);
                _aim(hostile, b, b == Behaviour.RETURN_BOMB ? 10_000_000 : _defaultParam(b));
                uint256 owed = vault.owedFees(address(honest));
                uint256 reserves = vault.reserves(address(honest));
                uint256 before = honest.heldBy(OWNER);
                vm.prank(OWNER);
                vault.exitAll{gas: FLOW_GAS}();
                _eq(honest.heldBy(OWNER) - before, reserves, "every reserve of the other token reached the owner");
                _eq(vault.reserves(address(honest)), 0, "none left");
                _eq(vault.owedFees(address(honest)), owed, "its owed fee untouched");
                _true(npm.ownerOf(childId) == OWNER, "the successor is the owner's");
                _true(vault.paused() && !vault.rootArmed(), "automation stopped");
                cheats.revertToState(snapshot);
            }
        }
    }

    /// The same for anyone's returnReserves once the owner closed the root.
    function testReturnReservesPaysTheOtherTokenWhateverOneTokenDoes() public {
        _prepare(RETURN, m0);
        for (uint256 side; side < 2; ++side) {
            for (uint8 b; b < Behaviour.COUNT; ++b) {
                uint256 snapshot = cheats.snapshotState();
                (MatrixToken hostile, MatrixToken honest) = side == 0 ? (m0, m1) : (m1, m0);
                _aim(hostile, b, b == Behaviour.RETURN_BOMB ? 10_000_000 : _defaultParam(b));
                uint256 reserves = vault.reserves(address(honest));
                uint256 before = honest.heldBy(OWNER);
                vm.prank(STRANGER);
                (uint256 amount0, uint256 amount1) = vault.returnReserves{gas: FLOW_GAS}();
                _eq(honest.heldBy(OWNER) - before, reserves, "every reserve of the other token reached the owner");
                _eq(side == 0 ? amount1 : amount0, reserves, "and returnReserves reports it");
                _eq(vault.reserves(address(honest)), 0, "none left");
                cheats.revertToState(snapshot);
            }
        }
    }

    // ============================================== fixed, and the known limit

    /// FIXED (A, found by this suite): the vault's exact payouts (_pay:
    /// withdrawReserves, recoverToken, the exit module's delivery) used to
    /// read nothing back, so a pool token that debits its sender more than
    /// the amount (a sender-side fee) spent, on the owner's withdrawal, the
    /// tariff the vault owes in that token. _pay now measures each payment's
    /// debit and refuses one that took more than it moved (TokenCallFailed),
    /// as F1b refuses it in its own payments. exitAll's and returnReserves'
    /// best-effort payments keep A8's rule (never revert over one token), so
    /// there an over-debiting token can still spend fees owed in itself:
    /// accepted, and pinned by the matrix above.
    function testAnOverDebitingWithdrawalIsRefusedAndTheSweepsKeepA8() public {
        uint256 owed = vault.owedFees(address(m0));
        uint256 reserves = vault.reserves(address(m0));
        _eq(m0.heldBy(address(vault)), owed + reserves, "staged: exactly backed");
        m0.aim(address(vault), Behaviour.OVERDEBITS, owed / 2, false);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("TokenCallFailed(address)")), address(m0)));
        vault.withdrawReserves(address(m0), reserves, OWNER);
        _eq(vault.owedFees(address(m0)), owed, "the ledger still owes the whole fee");
        _eq(m0.heldBy(address(vault)), owed + reserves, "and the vault still holds the fee and the reserves");
    }

    /// KNOWN LIMIT (B, accepted): owed fees and reserves are kept per token
    /// address, so a double-entry pool token (two addresses moving one
    /// balance, the legacy TUSD shape) lets its owner recover, through the
    /// second address, everything the vault holds in it: _unowedBalance(twin)
    /// owes nothing and reserves(twin) is zero, and no balance check can tell
    /// the two addresses apart. The owner takes its own reserves and the
    /// tariff the vault owes in that token, which stays on the books
    /// unbacked. Only that token's fees are exposed; such tokens are not
    /// supported. Pinned so a change surfaces here.
    function testKnownLimit_ADoubleEntryPoolTokenLetsTheOwnerRecoverItsOwnOwedFees() public {
        TwinEntry twin = new TwinEntry(m0);
        m0.setTwin(address(twin));
        uint256 owed = vault.owedFees(address(m0));
        uint256 held = m0.heldBy(address(vault));
        uint256 ownerBefore = m0.heldBy(OWNER);
        vm.prank(OWNER);
        vault.recoverToken(address(twin), held);
        _eq(m0.heldBy(OWNER) - ownerBefore, held, "the owner took the reserves and the fee owed in token0");
        _eq(vault.owedFees(address(m0)), owed, "the debt stays on the books, unbacked");
        _eq(m0.heldBy(address(vault)), 0, "nothing of token0 is left");
    }

    // ================================================== accepted behaviours

    /// ACCEPTED: a pool token whose transfer reports success and moves
    /// nothing. The vault trusts a true return, as SafeERC20 does
    /// (DominoTokenOps), so withdrawReserves and exitAll record a payment the
    /// owner never got (ReservesWithdrawn included). Nothing is lost: the
    /// amount left the books but not the vault, so it is surplus, and the
    /// owner recovers it with recoverToken once the token pays; owed fees and
    /// the other token are untouched.
    function testAPayoutThatMovesNothingStaysRecoverable() public {
        uint256 reserves = vault.reserves(address(m0));
        uint256 owed = vault.owedFees(address(m0));
        m0.aim(address(vault), Behaviour.TRUE_BUT_STILL, 0, false);
        vm.prank(OWNER);
        vault.exitAll();
        _eq(m0.heldBy(OWNER), 0, "the owner got nothing");
        _eq(vault.reserves(address(m0)), 0, "though the books paid it");
        _eq(m0.heldBy(address(vault)), owed + reserves, "it is all still in the vault");
        m0.aim(address(vault), Behaviour.NORMAL, 0, false);
        vm.prank(OWNER);
        vault.recoverToken(address(m0), reserves);
        _eq(m0.heldBy(OWNER), reserves, "recovered whole");
        _eq(m0.heldBy(address(vault)), owed, "the owed fee stays, backed");
    }

    /// ACCEPTED: a pool token whose transfer moves and still returns false.
    /// exitAll and returnReserves pay with tryTransfer and keep a failed
    /// payment idle (A8), so the owner is paid and the vault still claims
    /// the amount: its books over-claim that token by the payment, and a
    /// later withdrawal would reach the fee it owes in it. The over-claim
    /// stays in the lying token: the other token is paid whole and exactly.
    function testAPayoutThatMovesButReportsFailureErodesOnlyItsOwnToken() public {
        uint256 reserves0 = vault.reserves(address(m0));
        uint256 reserves1 = vault.reserves(address(m1));
        m0.aim(address(vault), Behaviour.MOVES_BUT_FALSE, 0, false);
        vm.prank(OWNER);
        vault.exitAll();
        _eq(m0.heldBy(OWNER), reserves0, "the owner was paid token0");
        _eq(vault.idleReserves(address(m0)), reserves0, "and the vault still claims it");
        _eq(m0.heldBy(address(vault)), vault.owedFees(address(m0)), "only the owed fee is left behind the claim");
        _eq(m1.heldBy(OWNER), reserves1, "token1 paid whole");
        _eq(vault.reserves(address(m1)), 0, "and settled");
        _eq(m1.heldBy(address(vault)), vault.owedFees(address(m1)), "token1 exactly backed");
    }

    /// ACCEPTED: a pool token whose balanceOf reports more than the vault
    /// holds. recoverToken can only read balanceOf, so it releases the lie as
    /// surplus and the payment comes out of the reserves and the owed fee of
    /// that token; the other token's books are untouched.
    function testABalanceThatLiesErodesOnlyItsOwnToken() public {
        uint256 owed = vault.owedFees(address(m0));
        m0.aim(address(vault), Behaviour.BALANCE_LIES, owed, false);
        vm.prank(OWNER);
        vault.recoverToken(address(m0), owed);
        _eq(m0.heldBy(OWNER), owed, "the owner recovered the lie");
        _eq(m0.heldBy(address(vault)) + owed, owed + vault.reserves(address(m0)), "out of token0's own books");
        _eq(m1.heldBy(address(vault)), vault.owedFees(address(m1)) + vault.reserves(address(m1)), "token1 exactly backed");
    }

    /// ACCEPTED (informational): F1c resets the manager's allowance with
    /// approve(manager, 0) and does not read it back, so a pool token whose
    /// approve adds keeps what the manager did not pull after a compound.
    /// Only the NonfungiblePositionManager holds it, and it pulls only from
    /// its caller for that call's own increase or mint, never more than the
    /// vault asks: the next compound still settles exactly but for it.
    function testAnAdditiveApproveLeavesTheVaultsAllowanceToTheManagerOnly() public {
        m0.aim(address(vault), Behaviour.APPROVE_ADDS, 0, false);
        for (uint256 i; i < 2; ++i) {
            _prepare(COMPOUND, m0);
            Ledger memory before = _ledger();
            (bool ok,, VaultVm.Log[] memory logs) = _runFlow(COMPOUND, m0, FLOW_GAS);
            _true(ok, "compounded");
            string memory problem = _settle(COMPOUND, before, logs);
            _true(
                keccak256(bytes(problem)) == keccak256("an allowance from the vault survived"),
                "settled exactly but for the allowance"
            );
        }
        _true(m0.allowance(address(vault), address(npm)) != 0, "the manager kept an allowance");
    }

    // ===================================================== 128-bit amounts

    function _compoundCall() internal view returns (bytes memory) {
        return abi.encodeCall(DominoV2VaultBase.execute, (Plan.encode(_plan())));
    }

    /// A collect that would credit more than 2^128 - 1 to a lot is refused
    /// (InvalidAmount from _u128), never truncated: the token credits the
    /// vault 2^128 more than the manager sends during the root's collect.
    function testACollectAbove128BitsIsRefusedNotTruncated() public {
        m0.aim(address(vault), Behaviour.INFLATES, 1 << 128, false);
        _prepare(COMPOUND, m0);
        Ledger memory before = _ledger();
        uint64 nonce = vault.stateNonce();
        bytes memory data = _compoundCall();
        vm.prank(OPERATOR);
        (bool ok, bytes memory out) = address(vault).call(data);
        _true(!ok && bytes4(out) == DominoV2VaultStorage.InvalidAmount.selector, "InvalidAmount");
        _true(_untouched(before) && vault.stateNonce() == nonce, "nothing moved");
    }

    /// A collect that fits 128 bits but would carry the lot past 2^128 - 1
    /// stops on the checked addition (Panic 0x11): refused, never wrapped.
    function testALotThatWouldPass128BitsIsRefusedNotWrapped() public {
        IDominoVaultLedger.Lot memory lot = vault.lot(rootId, address(m0));
        _prepare(COMPOUND, m0); // the root earns 2e18 of token0
        uint256 room = type(uint128).max - lot.uncharged;
        m0.aim(address(vault), Behaviour.INFLATES, room + 1 - 2e18, false);
        Ledger memory before = _ledger();
        bytes memory data = _compoundCall();
        vm.prank(OPERATOR);
        (bool ok, bytes memory out) = address(vault).call(data);
        _true(!ok && keccak256(out) == keccak256(abi.encodeWithSignature("Panic(uint256)", 0x11)), "Panic 0x11");
        _true(_untouched(before), "nothing moved");
        // One unit less fits exactly.
        m0.aim(address(vault), Behaviour.INFLATES, room - 2e18, false);
        vm.prank(OPERATOR);
        (ok,) = address(vault).call(data);
        _true(ok, "a collect up to the ceiling is credited");
    }

    /// Reserves are summed in 256 bits: two lots near the 128-bit ceiling,
    /// released together by exitAll, are paid whole (2^129 minus change),
    /// exactly as reported.
    function testReservesAbove128BitsArePaidWhole() public {
        uint256 near = (uint256(1) << 128) - 1e20;
        // The root's collect, then the successor's, each credited near the ceiling.
        m0.aim(address(vault), Behaviour.INFLATES, near - vault.lot(rootId, address(m0)).uncharged, false);
        _prepare(COMPOUND, m0);
        _execute(_plan());
        m0.aim(address(vault), Behaviour.INFLATES, near, false);
        _accrue(childId, 1e18, 1e18);
        _compound(childId, 1e18);
        m0.aim(address(vault), Behaviour.NORMAL, 0, false);
        uint256 reserves = vault.reserves(address(m0));
        _true(reserves > uint256(1) << 128, "reserves above 2^128");
        vm.recordLogs();
        vm.prank(OWNER);
        vault.exitAll();
        _eq(m0.heldBy(OWNER), reserves, "paid whole");
        Reported memory r = _reported(vm.getRecordedLogs(), address(m0));
        _eq(r.withdrawn, reserves, "as ReservesWithdrawn reports");
    }

    /// An owner's withdrawal or recovery of more than the vault can release
    /// is refused (InsufficientReserves) at any width, with nothing moved:
    /// never cut down to what fits.
    function testFuzz_AnOwnerAmountBeyondTheBooksIsRefusedAtAnyWidth(uint256 amount, bool first, bool recover)
        public
    {
        MatrixToken token = first ? m0 : m1;
        uint256 surplus = token.heldBy(address(vault)) - vault.owedFees(address(token)) - vault.reserves(address(token));
        cheats.assume(amount > (recover ? surplus : vault.reserves(address(token))));
        Ledger memory before = _ledger();
        vm.prank(OWNER);
        (bool ok, bytes memory out) = address(vault).call(
            recover
                ? abi.encodeCall(DominoV2VaultBase.recoverToken, (address(token), amount))
                : abi.encodeCall(DominoV2VaultBase.withdrawReserves, (address(token), amount, OWNER))
        );
        _true(!ok && bytes4(out) == DominoV2VaultStorage.InsufficientReserves.selector, "InsufficientReserves");
        _true(_untouched(before), "nothing moved");
    }

    /// A plan whose 128-bit fields carry more than 2^128 never decodes: the
    /// operator's execution reverts before any step, with nothing moved.
    function testFuzz_APlanAmountAbove128BitsIsRefusedOnTheWire(uint256 amount, uint8 field) public {
        cheats.assume(amount > type(uint128).max);
        Plan.PlanV1 memory p = _plan();
        WidePlanV1 memory wide;
        (wide.action, wide.stateNonce, wide.deadline, wide.target) = (p.action, p.stateNonce, p.deadline, p.target);
        (wide.amount0Max, wide.amount1Max, wide.minLiquidity) = (p.amount0Max, p.amount1Max, p.minLiquidity);
        (wide.collect, wide.anchorEvidence) = (p.collect, p.anchorEvidence);
        wide.budgets = new WideBudget[](1);
        wide.budgets[0] = WideBudget(rootId, type(uint128).max, type(uint128).max);
        field %= 4;
        if (field == 0) wide.amount0Max = amount;
        else if (field == 1) wide.minLiquidity = amount;
        else if (field == 2) wide.budgets[0].max1 = amount;
        else wide.swap.amountIn = amount;
        _prepare(COMPOUND, m0);
        Ledger memory before = _ledger();
        bytes memory data = abi.encodeCall(DominoV2VaultBase.execute, (bytes.concat(bytes1(0x01), abi.encode(wide))));
        vm.prank(OPERATOR);
        (bool ok, bytes memory out) = address(vault).call(data);
        _true(!ok && out.length == 0, "the decoder refused it");
        _true(_untouched(before), "nothing moved");
    }
}
