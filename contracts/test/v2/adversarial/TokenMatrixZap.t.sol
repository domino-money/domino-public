// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {DominoFeeLedger} from "../../../src/v2/fees/DominoFeeLedger.sol";
import {IPositionNft, ZapVm} from "../zap/ZapTestKit.sol";
import {AdversarialVm, Behaviour, CHEATS, consoleLog} from "./HostileTokens.sol";
import {ZapMatrixWorld} from "./ZapMatrixWorld.sol";

/// The CreatePlan of IDominoPositionActions with every uint128 widened, to
/// put an amount above 2^128 on the wire: same ABI head and selector.
struct WideTokenAmount {
    address token;
    uint256 amount;
}

struct WideCreatePlan {
    DominoV2Types.PositionIntent intent;
    WideTokenAmount[] inputs;
    DominoV2Types.SwapLeg[] legs;
    uint256 amount0Max;
    uint256 amount1Max;
    uint160 initSqrtPriceX96;
}

/// @notice The v3 zap's create, increase and exit (with and without a
/// conversion) against every behaviour of the token matrix, with the hostile
/// token in every role an action gives a token: an unused input, a pool
/// currency, a v3 leg's input or output, a router leg's input pulled through
/// Permit2, and the fee token, paid or owed. Every action either reverts with
/// nothing moved, or settles exactly against its own events (ZapMatrixWorld's
/// oracle): the zap keeps nothing, owed fees never fall and stay backed, the
/// user and the fee recipient get what the events say, and no allowance from
/// the zap survives. What the matrix found is pinned below: an over-debiting
/// refund (fixed, now refused), a double-entry token (a known limit) and the
/// accepted behaviours of tokens that misreport their own transfers or
/// approvals.
contract TokenMatrixZapTest is ZapMatrixWorld {
    AdversarialVm internal constant cheats = AdversarialVm(CHEATS);

    function setUp() public {
        _buildWorld();
    }

    // ============================================================= matrix

    /// The (role, behaviour) pairs where an action completes without settling
    /// exactly, each pinned by a test below:
    /// - balanceOf lies by less than the fee owed:
    ///   testABalanceThatLiesCanOnlySpendFeesOwedInItself;
    /// - true but still (a refund that reports success and moves nothing):
    ///   testATokenThatReportsSuccessWithoutMovingStrandsOnlyItsOwnRefund;
    /// - approve adds (the reset to zero leaves what the manager did not
    ///   pull, so only when it pulls less than asked, as with uneven amounts):
    ///   testAnAdditiveApproveLeavesAnAllowanceOnlyTheManagerCanUse.
    function _known(uint8 role, uint8 behaviour) internal pure returns (bool) {
        if (behaviour == Behaviour.BALANCE_LIES) return role == FEE_OWED;
        if (behaviour == Behaviour.TRUE_BUT_STILL) {
            return role == EXTRA_INPUT || role == LEG_OUTPUT || role == FEE_OUTPUT || role == FEE_OWED;
        }
        if (behaviour == Behaviour.APPROVE_ADDS) return role == POOL_CREATE || role == POOL_INCREASE;
        return false;
    }

    /// One action with h in `role` behaving as `behaviour`: its outcome as a
    /// line of the table, "VIOLATION: ..." when it completed inexactly.
    function _trial(uint8 role, uint8 behaviour, uint256 param, address user, uint256 amount)
        internal
        returns (bool completed, string memory outcome)
    {
        _stage(role);
        _aimAtZap(behaviour, param);
        Books memory before = _books(user);
        (bool ok, bytes memory out, ZapVm.Log[] memory logs) = _runRole(role, user, amount, seeded[user]);
        if (!ok) {
            if (!_untouched(before, user)) return (false, "VIOLATION: a refused action moved something");
            return (false, string.concat("reverts: ", _why(out)));
        }
        string memory problem = _audit(before, user, logs, role == POOL_EXIT);
        if (bytes(problem).length != 0) return (true, string.concat("VIOLATION: ", problem));
        if (!_resultMatches(out, logs)) return (true, "VIOLATION: the return value differs from the events");
        return (true, "settles exactly");
    }

    function _isViolation(string memory outcome) internal pure returns (bool) {
        bytes memory text = bytes(outcome);
        return text.length > 9 && text[0] == "V" && text[1] == "I" && text[2] == "O";
    }

    /// Every role under every behaviour, once (ZapMatrixWorld._defaultParam:
    /// a 1% tax, an over-debit of 0.001 h, a 100 KB payload on transfer or
    /// approve, a lie of 1000 units, an inflation of one h, a hook that
    /// re-enters the zap). Printed for the report (-vv). Only the known pairs
    /// complete inexactly; every behaviour leaves the owner's direct exit
    /// working; every role completes for an honest token.
    function testEveryRoleUnderEveryBehaviour() public {
        uint256 violations;
        for (uint8 role; role < ROLES; ++role) {
            for (uint8 b; b < Behaviour.COUNT; ++b) {
                uint256 snapshot = vm.snapshotState();
                (bool completed, string memory outcome) = _trial(role, b, _defaultParam(b), ALICE, 5e18);
                consoleLog(string.concat("zap | ", _roleName(role), " | ", Behaviour.name(b), " | ", outcome));
                if (_isViolation(outcome)) {
                    ++violations;
                    _check(
                        _known(role, b),
                        string.concat("an unknown violation: ", _roleName(role), " / ", Behaviour.name(b), ": ", outcome)
                    );
                }
                if (b == Behaviour.NORMAL || role == POOL_EXIT) {
                    _check(completed, string.concat("an action that must complete: ", _roleName(role)));
                }
                vm.revertToState(snapshot);
            }
        }
        // An over-debit and a lying balance with a fee owed, and four refunds
        // that report success without moving; the table's even amounts leave
        // the manager no allowance.
        _eq(violations, 5, "every known violation reproduces");
    }

    function _fuzzParam(uint8 behaviour, uint256 seed) internal pure returns (uint256) {
        if (behaviour == Behaviour.TAXED) return 1 + seed % 10_000;
        if (behaviour == Behaviour.OVERDEBITS) return 1 + seed % 1e18;
        if (behaviour == Behaviour.RETURN_BOMB || behaviour == Behaviour.APPROVE_BOMB) return 32 + seed % 300_000;
        if (behaviour == Behaviour.BALANCE_LIES || behaviour == Behaviour.INFLATES) return 1 + seed % 1e24;
        return 0;
    }

    /// The matrix fuzzed: any role, any behaviour outside the pinned pairs,
    /// any parameter, any size from 0.001 to 1000 units, either user. The
    /// action settles exactly or reverts with nothing moved; an honest token
    /// always completes.
    function testFuzz_EveryRoleSettlesExactlyOrRevertsCleanly(
        uint256 roleSeed,
        uint256 behaviourSeed,
        uint256 paramSeed,
        uint256 amountSeed,
        bool bob
    ) public {
        uint8 role = uint8(roleSeed % ROLES);
        uint8 behaviour = uint8(behaviourSeed % Behaviour.COUNT);
        cheats.assume(!_known(role, behaviour));
        (bool completed, string memory outcome) =
            _trial(role, behaviour, _fuzzParam(behaviour, paramSeed), bob ? BOB : ALICE, 1e15 + amountSeed % 1e21);
        _check(!_isViolation(outcome), outcome);
        if (behaviour == Behaviour.NORMAL) _check(completed, "an honest token completes every role");
    }

    // ============================================== fixed, and the known limit

    /// FIXED (A, found by this suite): a refund used to read nothing back, so
    /// a token that debits its sender more than the amount (a sender-side
    /// fee) spent, on anyone's refund, the fees the zap owes in that token.
    /// _refund now measures each payment's debit and refuses one that took
    /// more than it moved (TokenCallFailed), as F1b's ledger refuses an
    /// over-debiting fee payment (FeeTransferMismatch). Here ALICE's fee in
    /// h went owed (the recipient could not receive h), then h takes 1/2 of
    /// that debt on top of each payment and BOB's ordinary create brings some
    /// h it does not use: the create is refused and the fee stays backed.
    function testAnOverDebitingRefundIsRefusedAndTheOwedFeeStaysBacked() public {
        _stage(FEE_OWED);
        (bool ok,,) = _runRole(FEE_OWED, ALICE, 5e18, 0);
        _check(ok, "ALICE's create completed with its fee in h owed");
        uint256 owed = zap.owedFees(address(h));
        _check(owed != 0 && h.heldBy(address(zap)) == owed, "the zap holds exactly the owed fee");
        h.aim(address(zap), Behaviour.OVERDEBITS, owed / 2, false);
        IDominoPositionActions.CreatePlan memory plan =
            _createPlan(plain, _three(address(usd), 1e18, address(tkn), 1e18, address(h), 1e18), _noLegs(), ETH, BOB);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("TokenCallFailed(address)")), address(h)));
        zap.create(plan);
        _eq(zap.owedFees(address(h)), owed, "the ledger still owes the whole fee");
        _eq(h.heldBy(address(zap)), owed, "and the zap still holds it");
    }

    /// KNOWN LIMIT (B, accepted): owed fees are kept per token address, so a
    /// double-entry token (two addresses moving one balance, the legacy TUSD
    /// shape) has the fees owed under one address refunded through the other:
    /// _unowedBalance(twin) is the shared balance minus owedFees(twin), which
    /// is zero, and no balance check can tell the two addresses apart. BOB
    /// adds 1 wei of the twin to an ordinary create and is refunded every unit
    /// the zap owes in h; the debt stays on the books, unbacked. Only fees
    /// owed in that token itself are exposed, and only when they are owed:
    /// the fee token is a charge currency the registry lists, or, on a route
    /// without one, the first leg's input (docs/v2/F1_FEES_ROUTE.md). Such
    /// tokens are not supported; this test pins the exposure so a change
    /// surfaces here.
    function testKnownLimit_ADoubleEntryTokensOwedFeesLeakThroughItsTwin() public {
        _stage(FEE_OWED);
        (bool ok,,) = _runRole(FEE_OWED, ALICE, 5e18, 0);
        _check(ok, "ALICE's create completed with its fee in h owed");
        uint256 owed = zap.owedFees(address(h));
        uint256 owedUsd = zap.owedFees(address(usd));
        uint256 bobBefore = h.heldBy(BOB);
        vm.prank(BOB);
        zap.create(
            _createPlan(plain, _three(address(usd), 1e18, address(tkn), 1e18, address(hTwin), 1), _noLegs(), ETH, BOB)
        );
        _eq(zap.owedFees(address(h)), owed, "the ledger still owes the whole fee");
        _eq(h.heldBy(BOB) - bobBefore, owed, "BOB was refunded exactly the fee owed in h, nothing more");
        _eq(h.heldBy(address(zap)), 0, "the debt in h is unbacked");
        _eq(zap.owedFees(address(usd)), owedUsd, "no other token's debt moved");
        _check(usd.balanceOf(address(zap)) >= owedUsd, "and every other debt stays backed");
    }

    // ================================================== accepted behaviours

    /// ACCEPTED: a token whose transfer returns true and moves nothing. The
    /// zap trusts a true return, as SafeERC20 does (DominoTokenOps: true, or
    /// nothing from a contract), and measures only legs and fees (F1b), so
    /// such a refund leaves the user's h in the zap, unowed, and the next
    /// refund in h pays it to that action's recipient. The token can strand
    /// only itself: owed fees stay backed and every other token settles
    /// exactly, even when this token's fee is owed in the same action.
    function testATokenThatReportsSuccessWithoutMovingStrandsOnlyItsOwnRefund() public {
        _stage(FEE_OWED);
        h.aim(address(zap), Behaviour.TRUE_BUT_STILL, 0, true);
        Books memory before = _books(ALICE);
        (bool ok,, ZapVm.Log[] memory logs) = _runRole(FEE_OWED, ALICE, 5e18, 0);
        _check(ok, "completed");
        Books memory current = _books(ALICE);
        uint256 owed = zap.owedFees(address(h));
        _check(owed != 0 && h.heldBy(address(zap)) > owed, "the refund stayed in the zap, beyond the owed fee");
        address[5] memory tokens = _tokens();
        for (uint256 i; i < 5; ++i) {
            _check(current.zap[i] >= current.owed[i], "every owed fee is backed");
            if (tokens[i] == address(h)) continue;
            _eq(current.zap[i], current.owed[i], "the zap keeps nothing else");
            int256 expected = _flows(logs, tokens[i], ALICE, false, 0).user;
            _check(int256(current.user[i]) - int256(before.user[i]) == expected, "every other token settles exactly");
        }
        _check(_noAllowanceSurvives(), "no allowance survives");
    }

    /// ACCEPTED: a token whose balanceOf reports more than the zap holds.
    /// Every host can only read balanceOf, so _unowedBalance overstates by the
    /// lie and a refund pays the lie out of what the zap owes in that token
    /// (a lie larger than the debt makes the refund fail instead). A balance
    /// check after the refund cannot see it either: the same lie answers it.
    /// The damage stays in the lying token: every other token settles
    /// exactly and the lying token's shortfall is exactly the lie.
    function testABalanceThatLiesCanOnlySpendFeesOwedInItself() public {
        _stage(FEE_OWED);
        h.aim(address(zap), Behaviour.BALANCE_LIES, 1000, true);
        Books memory before = _books(ALICE);
        (bool ok,, ZapVm.Log[] memory logs) = _runRole(FEE_OWED, ALICE, 5e18, 0);
        _check(ok, "completed");
        Books memory current = _books(ALICE);
        _eq(zap.owedFees(address(h)) - h.heldBy(address(zap)), 1000, "the shortfall in h is exactly the lie");
        address[5] memory tokens = _tokens();
        for (uint256 i; i < 5; ++i) {
            if (tokens[i] == address(h)) continue;
            _eq(current.zap[i], current.owed[i], "the zap keeps nothing else");
            int256 expected = _flows(logs, tokens[i], ALICE, false, 0).user;
            _check(int256(current.user[i]) - int256(before.user[i]) == expected, "every other token settles exactly");
        }
    }

    /// ACCEPTED (informational): F1c resets the manager's allowance with
    /// approve(manager, 0) and does not read it back, so a token whose approve
    /// adds keeps what the manager did not pull. Only the
    /// NonfungiblePositionManager holds it, and the manager pulls only from
    /// its caller, for what that call's own mint or increase needs (never
    /// more than the zap asks): later actions with the allowance in place
    /// still settle exactly, but for the allowance itself.
    function testAnAdditiveApproveLeavesAnAllowanceOnlyTheManagerCanUse() public {
        h.aim(address(zap), Behaviour.APPROVE_ADDS, 0, true);
        vm.prank(ALICE);
        zap.create(_createPlan(hostile, _two(address(usd), 1e18, address(h), 3e18), _noLegs(), ETH, ALICE));
        _check(h.allowance(address(zap), address(npm)) != 0, "the manager kept an allowance from the zap");
        _eq(h.allowance(address(zap), PERMIT2), 0, "nothing toward Permit2");
        _eq(h.heldBy(address(zap)), zap.owedFees(address(h)), "and the zap holds nothing it could spend");
        for (uint256 i; i < 3; ++i) {
            Books memory before = _books(BOB);
            (bool ok,, ZapVm.Log[] memory logs) = _runRole(i == 1 ? POOL_INCREASE : POOL_CREATE, BOB, 2e18, seeded[BOB]);
            _check(ok, "completed");
            string memory problem = _audit(before, BOB, logs, false);
            _check(bytes(problem).length == 0 || _isAllowanceOnly(problem), problem);
        }
    }

    function _isAllowanceOnly(string memory problem) internal pure returns (bool) {
        return keccak256(bytes(problem)) == keccak256("an allowance from the zap survived");
    }

    /// A fee-on-transfer input (every transfer of h taxed 1%, the user's own
    /// pull included): InputPulled reports what the user sent, the zap gets 1%
    /// less and refunds all that arrived, taxed again on the way out. The
    /// oracle's books close: the user bears exactly the token's two taxes, the
    /// zap keeps nothing. As a pool currency it is refused (the v3 pool's own
    /// balance check), as F1c documents.
    function testAFeeOnTransferInputIsRefundedAsItArrived() public {
        h.aim(h.ANYONE(), Behaviour.TAXED, 100, true);
        Books memory before = _books(ALICE);
        (bool ok,, ZapVm.Log[] memory logs) = _runRole(EXTRA_INPUT, ALICE, 4e18, 0);
        _check(ok, "completed");
        _check(bytes(_audit(before, ALICE, logs, false)).length == 0, "settled exactly");
        uint256 arrived = 2e18 - 2e18 / 100;
        _eq(before.user[2] - _books(ALICE).user[2], 2e18 - (arrived - arrived / 100), "the user bore two taxes");
        (ok,,) = _runRole(POOL_CREATE, ALICE, 4e18, 0);
        _check(!ok, "a taxed pool currency cannot be added");
    }

    /// ACCEPTED (informational): a rebase that takes the zap's h below what
    /// it owes (a slashing, a negative AMPL rebase). The ledger owes a fixed
    /// amount, so the zap holds h's fees whole: an action that brings less h
    /// than the shortfall fails closed (an arithmetic panic in _unowedBalance,
    /// nothing moved), a flush fails and leaves the debt, while actions in
    /// other tokens and the owner's direct exit settle exactly. The next
    /// action that brings more h covers the shortfall out of its own refund
    /// (a refund is what the zap holds beyond its debt; Refunded reports it),
    /// as a positive rebase or a donation would go to it; then the debt is
    /// backed and flushes whole. Fixed-amount ledgers cannot follow a rebase.
    function testANegativeRebaseIsCoveredByTheNextRefundInThatTokenOnly() public {
        _stage(FEE_OWED);
        (bool ok,,) = _runRole(FEE_OWED, ALICE, 5e18, 0);
        _check(ok, "the fee in h went owed");
        uint256 owed = zap.owedFees(address(h));
        uint256 shortfall = owed / 3;
        h.burn(address(zap), shortfall);
        (ok,,) = _runRole(EXTRA_INPUT, BOB, shortfall, 0);
        _check(!ok, "an action bringing less h than the shortfall fails closed");
        h.setBlocked(FEE_RECIPIENT, false);
        (ok,) = address(zap).call(abi.encodeCall(DominoFeeLedger.flushOwedFees, (address(h))));
        _check(!ok && zap.owedFees(address(h)) == owed, "the flush fails and the debt stays");
        Books memory before = _books(BOB);
        ZapVm.Log[] memory logs;
        (ok,, logs) = _runRole(POOL_EXIT, BOB, 0, seeded[BOB]);
        _check(ok && bytes(_audit(before, BOB, logs, true)).length == 0, "the owner's direct exit settles exactly");
        before = _books(BOB);
        vm.recordLogs();
        vm.prank(BOB);
        zap.create(_createPlan(plain, _two(address(usd), 1e18, address(tkn), 1e18), _noLegs(), ETH, BOB));
        _check(bytes(_audit(before, BOB, vm.getRecordedLogs(), false)).length == 0, "other tokens settle exactly");
        before = _books(BOB);
        (ok,, logs) = _runRole(EXTRA_INPUT, BOB, 4e18, 0);
        _check(ok && bytes(_audit(before, BOB, logs, false)).length == 0, "a larger action completes, as its events say");
        _eq(before.user[2] - _books(BOB).user[2], shortfall, "its refund covered the shortfall");
        _eq(zap.flushOwedFees(address(h)), owed, "the debt is backed again and flushes whole");
    }

    /// Isolation: whatever h does, actions that do not touch it (a usd/tkn
    /// create, then that position's exit converted to usd) settle exactly,
    /// and the owner's direct exit of a usd/h position, which the manager
    /// pays, always completes.
    function testAHostileTokenNeverBlocksWhatDoesNotTouchIt() public {
        for (uint8 b; b < Behaviour.COUNT; ++b) {
            uint256 snapshot = vm.snapshotState();
            _aimAtZap(b, _defaultParam(b));
            Books memory before = _books(BOB);
            vm.recordLogs();
            vm.prank(BOB);
            IDominoPositionActions.ActionResult memory r = zap.create(
                _createPlan(plain, _two(address(usd), 3e18, address(tkn), 3e18), _noLegs(), ETH, BOB)
            );
            _check(bytes(_audit(before, BOB, vm.getRecordedLogs(), false)).length == 0, "a usd/tkn create");
            vm.prank(BOB);
            IPositionNft(address(npm)).approve(address(zap), r.tokenId);
            IDominoPositionActions.ExitPlan memory plan;
            DominoV2Types.SwapLeg[] memory legs = _oneLeg(_v3Leg(address(tkn), address(usd), 1e18));
            plan.intent =
                _intent(DominoV2Types.ACTION_EXIT, plain, r.tokenId, LOWER, UPPER, 0, legs, address(usd), BOB, 0);
            (plan.liquidityToRemove, plan.legs, plan.burn) = (r.liquidity, legs, true);
            before = _books(BOB);
            vm.recordLogs();
            vm.prank(BOB);
            zap.exit(plan);
            _check(bytes(_audit(before, BOB, vm.getRecordedLogs(), false)).length == 0, "its converted exit");
            (bool completed, string memory outcome) = _trial(POOL_EXIT, b, _defaultParam(b), BOB, 0);
            _check(completed && !_isViolation(outcome), "the direct exit of a usd/h position");
            vm.revertToState(snapshot);
        }
    }

    // ===================================================== 128-bit amounts

    /// An amount above 2^128 never reaches the zap's arithmetic: the ABI
    /// decoder refuses a TokenAmount (or a cap) wider than uint128, before
    /// anything moves.
    function testFuzz_AnAmountAbove128BitsIsRefusedOnTheWire(uint256 amount, uint8 field) public {
        cheats.assume(amount > type(uint128).max);
        IDominoPositionActions.CreatePlan memory plan =
            _createPlan(plain, _two(address(usd), 1e18, address(tkn), 1e18), _noLegs(), ETH, ALICE);
        WideCreatePlan memory wide;
        wide.intent = plan.intent;
        wide.legs = plan.legs;
        wide.inputs = new WideTokenAmount[](2);
        wide.inputs[0] = WideTokenAmount(address(usd), 1e18);
        wide.inputs[1] = WideTokenAmount(address(tkn), 1e18);
        (wide.amount0Max, wide.amount1Max) = (type(uint128).max, type(uint128).max);
        field %= 3;
        if (field == 0) wide.inputs[1].amount = amount;
        else if (field == 1) wide.amount0Max = amount;
        else wide.amount1Max = amount;
        Books memory before = _books(ALICE);
        vm.prank(ALICE);
        (bool ok, bytes memory out) =
            address(zap).call(abi.encodeWithSelector(IDominoPositionActions.create.selector, wide));
        _check(!ok && out.length == 0, "the decoder refused it");
        _check(_untouched(before, ALICE), "nothing moved");
        // The same plan within 128 bits goes through.
        vm.prank(ALICE);
        zap.create(plan);
    }
}
