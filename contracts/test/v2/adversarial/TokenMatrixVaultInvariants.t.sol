// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoFeeLedger} from "../../../src/v2/fees/DominoFeeLedger.sol";
import {TickMath} from "../../../src/v2/positions/uniswap/TickMath.sol";
import {DominoV2VaultBase} from "../../../src/v2/vault/DominoV2VaultBase.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {VaultVm} from "../vault/VaultHarness.sol";
import {MockToken} from "../vault/VaultMocks.sol";
import {Behaviour, MatrixToken} from "./HostileTokens.sol";
import {VaultMatrixWorld} from "./VaultMatrixWorld.sol";

/// Everyone who can touch one Domino vault while its pool tokens turn
/// hostile, driven by the fuzzer:
/// - the pool: fees accrue to any member;
/// - the operator: compounds of any member, successor mints;
/// - the owner: withdrawals, recoveries of donations, child withdrawals,
///   exitAll, and resuming and rearming after it;
/// - either pool token switching behaviour between calls (every behaviour of
///   the matrix but the five whose violations TokenMatrixVault.t.sol pins:
///   over-debits, true but still, moves but false, a lying balanceOf, an
///   additive approve);
/// - the fee recipient going dark per token and back, flushes, donations.
/// Every completed flow is settled against its own events by the world's
/// oracle inside the call, and an invariant fails on the count.
contract VaultMatrixHandler is VaultMatrixWorld {
    uint256 public breaches;
    string public lastBreach;
    uint256 public owedLosses;
    uint256 public nonceDrops;
    uint64 public highestNonce;

    // Successes per action, so a campaign that only ever reverted cannot pass quietly.
    uint256 public compounds;
    uint256 public mints;
    uint256 public withdrawals;
    uint256 public recoveries;
    uint256 public exits;
    uint256 public flushes;
    uint256 public childWithdrawals;
    uint256 public switches;

    constructor() {
        setUp();
        highestNonce = vault.stateNonce();
    }

    /// Owed fees fall only through a flush; the nonce never falls.
    modifier observed(bool flushing) {
        uint256 owed0 = vault.owedFees(address(m0));
        uint256 owed1 = vault.owedFees(address(m1));
        _;
        if (!flushing && (vault.owedFees(address(m0)) < owed0 || vault.owedFees(address(m1)) < owed1)) ++owedLosses;
        uint64 nonce = vault.stateNonce();
        if (nonce < highestNonce) ++nonceDrops;
        else highestNonce = nonce;
    }

    function _token(uint256 seed) internal view returns (MatrixToken) {
        return seed % 2 == 0 ? m0 : m1;
    }

    function _member(uint256 seed) internal view returns (uint256) {
        uint256[] memory members = vault.positions();
        return members[seed % members.length];
    }

    /// Runs one flow (its preparation done by the caller) and settles it.
    function _run(uint8 flow, address caller, bytes memory data) internal returns (bool ok) {
        Ledger memory before = _ledger();
        vm.recordLogs();
        vm.prank(caller);
        (ok,) = address(vault).call{gas: FLOW_GAS}(data);
        VaultVm.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) {
            if (!_untouched(before)) _breach("a refused flow moved something");
            return false;
        }
        string memory problem = _settle(flow, before, logs);
        if (bytes(problem).length != 0) _breach(problem);
    }

    function _breach(string memory problem) internal {
        ++breaches;
        lastBreach = problem;
    }

    // ================================================================ pool

    function poolActivity(uint256 seed, uint256 fee0, uint256 fee1) external observed(false) {
        _accrue(_member(seed), fee0 % 1e19, fee1 % 1e19);
    }

    // ============================================================ operator

    function compound(uint256 seed) external observed(false) {
        uint256 target = _member(seed);
        vm.warp(block.timestamp + 600);
        Plan.PlanV1 memory p = _plan();
        p.target = target;
        p.collect = _one(target);
        p.budgets[0] = _budget(target);
        if (_run(COMPOUND, OPERATOR, abi.encodeCall(DominoV2VaultBase.execute, (Plan.encode(p))))) ++compounds;
    }

    /// A successor of the root once its slot is free, near its ceiling.
    function mintSuccessor() external observed(false) {
        if (vault.positions().length != 1 || vault.member(rootId).successor != 0) return;
        uint160 price = TickMath.getSqrtPriceAtTick(UPPER - 200);
        anchor.set(price, price);
        vm.warp(block.timestamp + 600);
        Plan.PlanV1 memory p = _plan();
        p.action = Plan.ACTION_MINT;
        (p.tickLower, p.tickUpper) = (UPPER - 600, UPPER + 4080);
        (p.amount0Max, p.amount1Max) = (1e18, 1e18);
        uint256 next = npm.nextId();
        if (_run(COMPOUND, OPERATOR, abi.encodeCall(DominoV2VaultBase.execute, (Plan.encode(p)))) && vault.member(next).active) {
            childId = next;
            ++mints;
        }
    }

    // =============================================================== owner

    function withdrawReserves(uint256 seed, uint256 amount) external observed(false) {
        MatrixToken token = _token(seed);
        uint256 reserves = vault.reserves(address(token));
        if (reserves == 0) return;
        bytes memory data =
            abi.encodeCall(DominoV2VaultBase.withdrawReserves, (address(token), amount % reserves + 1, OWNER));
        if (_run(WITHDRAW, OWNER, data)) ++withdrawals;
    }

    function recover(uint256 seed, uint256 amount) external observed(false) {
        MatrixToken token = _token(seed);
        token.mint(address(vault), amount % 1e19);
        uint256 surplus =
            token.heldBy(address(vault)) - vault.owedFees(address(token)) - vault.reserves(address(token));
        if (surplus == 0) return;
        bytes memory data = abi.encodeCall(DominoV2VaultBase.recoverToken, (address(token), surplus));
        if (_run(RECOVER, OWNER, data)) ++recoveries;
    }

    function withdrawChild() external observed(false) {
        uint256[] memory members = vault.positions();
        if (members.length < 2) return;
        vm.prank(OWNER);
        try vault.withdrawChild(members[1]) {
            ++childWithdrawals;
        } catch {}
    }

    /// One call in four: an exit ends the sequence until the owner takes it
    /// back, so a frequent one would leave the campaign little to compound.
    function exitAll(uint256 seed) external observed(false) {
        if (seed % 4 != 0) return;
        if (_run(EXIT_ALL, OWNER, abi.encodeCall(DominoV2VaultBase.exitAll, ()))) ++exits;
    }

    /// After an exit (or a pause) the owner takes the sequence back.
    function resumeAndRearm() external observed(false) {
        vm.startPrank(OWNER);
        if (vault.paused()) vault.resume();
        try vault.rearm(true) {} catch {}
        vm.stopPrank();
    }

    // ============================================================ the tokens

    /// One pool token turns to another behaviour toward the vault (never one
    /// of the five pinned elsewhere), with a fuzzed parameter.
    function switchBehaviour(uint256 seed, uint256 paramSeed) external observed(false) {
        uint8[14] memory safe = [
            Behaviour.NORMAL,
            Behaviour.RETURNS_FALSE,
            Behaviour.RETURNS_NOTHING,
            Behaviour.REVERTS,
            Behaviour.TAXED,
            Behaviour.BURNS_GAS,
            Behaviour.RETURN_BOMB,
            Behaviour.BALANCE_REVERTS,
            Behaviour.ZERO_REVERTS,
            Behaviour.APPROVE_RACE,
            Behaviour.APPROVE_ZERO_REVERTS,
            Behaviour.INFLATES,
            Behaviour.HOOKED,
            Behaviour.APPROVE_BOMB
        ];
        MatrixToken token = _token(seed);
        uint8 behaviour = safe[(seed >> 1) % safe.length];
        uint256 param;
        if (behaviour == Behaviour.TAXED) param = 1 + paramSeed % 10_000;
        else if (behaviour == Behaviour.RETURN_BOMB || behaviour == Behaviour.APPROVE_BOMB) param = 32 + paramSeed % 300_000;
        else if (behaviour == Behaviour.INFLATES) param = 1 + paramSeed % 1e24;
        if (behaviour == Behaviour.HOOKED) {
            token.setHook(address(vault), abi.encodeCall(DominoFeeLedger.flushOwedFees, (address(token))));
        }
        token.aim(address(vault), behaviour, param, false);
        ++switches;
    }

    // ===================================================== recipient, others

    function recipientGoesDark(uint256 seed, bool dark) external observed(false) {
        _token(seed).setBlocked(RECIPIENT, dark);
    }

    function flush(uint256 seed) external observed(true) {
        MatrixToken token = _token(seed);
        uint256 owed = vault.owedFees(address(token));
        Ledger memory before = _ledger();
        vm.recordLogs();
        vm.prank(STRANGER);
        try vault.flushOwedFees(address(token)) returns (uint256 amount) {
            if (amount != 0) ++flushes;
            string memory problem = _settle(FLUSH, before, vm.getRecordedLogs());
            if (bytes(problem).length != 0 || amount != owed) _breach("a flush paid other than the debt");
        } catch {
            if (vault.owedFees(address(token)) != owed) ++owedLosses;
        }
    }

    function donate(uint256 seed, uint256 amount) external observed(false) {
        _token(seed).mint(address(vault), amount % 1e19);
    }

    // ================================================================ reads

    function vaultUnderTest() external view returns (address) {
        return address(vault);
    }

    function pair() external view returns (MatrixToken, MatrixToken) {
        return (m0, m1);
    }

    function positionManager() external view returns (address) {
        return address(npm);
    }
}

/// The vault's books while its pool tokens turn hostile, under every sequence
/// the handler can produce:
/// - every completed flow settled exactly against its events (the world's
///   oracle), and a refused one moved nothing;
/// - in each pool token the vault holds at least its owed fees plus every
///   reserve, and owed fees fall only through a flush, which pays exactly them;
/// - no allowance from the vault to the position manager survives;
/// - the state nonce only grows.
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 64
contract TokenMatrixVaultInvariantsTest {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    VaultMatrixHandler internal handler;
    IVaultView internal vault;

    function setUp() public {
        handler = new VaultMatrixHandler();
        vault = IVaultView(handler.vaultUnderTest());
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    /// The actions only: the handler also inherits the harness's setUp.
    function targetSelectors() public view returns (FuzzSelector[] memory targets) {
        bytes4[] memory selectors = new bytes4[](17);
        selectors[0] = VaultMatrixHandler.poolActivity.selector;
        selectors[1] = VaultMatrixHandler.poolActivity.selector;
        selectors[2] = VaultMatrixHandler.compound.selector;
        selectors[3] = VaultMatrixHandler.compound.selector;
        selectors[4] = VaultMatrixHandler.compound.selector;
        selectors[5] = VaultMatrixHandler.mintSuccessor.selector;
        selectors[6] = VaultMatrixHandler.withdrawReserves.selector;
        selectors[7] = VaultMatrixHandler.withdrawReserves.selector;
        selectors[8] = VaultMatrixHandler.recover.selector;
        selectors[9] = VaultMatrixHandler.withdrawChild.selector;
        selectors[10] = VaultMatrixHandler.exitAll.selector;
        selectors[11] = VaultMatrixHandler.resumeAndRearm.selector;
        selectors[12] = VaultMatrixHandler.switchBehaviour.selector;
        selectors[13] = VaultMatrixHandler.switchBehaviour.selector;
        selectors[14] = VaultMatrixHandler.recipientGoesDark.selector;
        selectors[15] = VaultMatrixHandler.flush.selector;
        selectors[16] = VaultMatrixHandler.donate.selector;
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    /// The handler is only evidence if its actions reach the vault: a scripted
    /// pass where each flow completes, a hostile token's tariff goes owed and
    /// is flushed, and exitAll pays the other token past a burner, with every
    /// invariant checked after it.
    function testTheHandlerReachesEveryAction() public {
        handler.poolActivity(0, 3e18, 2e18);
        handler.compound(0);
        handler.recipientGoesDark(0, true);
        handler.poolActivity(0, 3e18, 3e18);
        handler.compound(0);
        handler.recipientGoesDark(0, false);
        handler.flush(0);
        handler.withdrawReserves(1, 1e18);
        handler.recover(0, 1e18);
        handler.withdrawChild();
        handler.poolActivity(0, 3e18, 3e18); // the root's fees fund its next successor
        handler.mintSuccessor();
        handler.switchBehaviour(0 | 5 << 1, 0); // token0 burns gas
        handler.exitAll(0);
        handler.resumeAndRearm();
        handler.switchBehaviour(0, 0); // token0 normal again
        handler.poolActivity(0, 1e18, 1e18);
        handler.compound(0);
        require(handler.compounds() == 3 && handler.mints() == 1, "the operator's flows never reached the vault");
        require(
            handler.flushes() == 1 && handler.withdrawals() == 1 && handler.recoveries() == 1
                && handler.childWithdrawals() == 1 && handler.exits() == 1 && handler.switches() == 2,
            "an owner or settlement flow never reached the vault"
        );
        _all();
    }

    function _all() internal view {
        invariant_everyCompletedFlowSettledExactly();
        invariant_everyPoolTokenIsBackedAndOwedFeesFallOnlyByAFlush();
        invariant_noAllowanceSurvives();
        invariant_theStateNonceOnlyGrows();
    }

    function invariant_everyCompletedFlowSettledExactly() public view {
        require(handler.breaches() == 0, handler.lastBreach());
    }

    function invariant_everyPoolTokenIsBackedAndOwedFeesFallOnlyByAFlush() public view {
        (MatrixToken m0, MatrixToken m1) = handler.pair();
        MatrixToken[2] memory pair = [m0, m1];
        for (uint256 i; i < 2; ++i) {
            uint256 held = pair[i].heldBy(address(vault));
            require(held >= vault.owedFees(address(pair[i])) + vault.reserves(address(pair[i])), "a pool token is not backed");
        }
        require(handler.owedLosses() == 0, "owed fees fell without a flush");
    }

    function invariant_noAllowanceSurvives() public view {
        (MatrixToken m0, MatrixToken m1) = handler.pair();
        address manager = handler.positionManager();
        require(
            MockToken(address(m0)).allowance(address(vault), manager) == 0
                && MockToken(address(m1)).allowance(address(vault), manager) == 0,
            "an allowance from the vault survived"
        );
    }

    function invariant_theStateNonceOnlyGrows() public view {
        require(handler.nonceDrops() == 0 && vault.stateNonce() == handler.highestNonce(), "the nonce moved backwards");
    }
}

/// The vault surface the invariants read.
interface IVaultView {
    function owedFees(address token) external view returns (uint256);
    function reserves(address token) external view returns (uint256);
    function stateNonce() external view returns (uint64);
}
