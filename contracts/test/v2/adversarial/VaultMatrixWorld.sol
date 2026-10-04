// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDominoFeeEvents} from "../../../src/v2/interfaces/IDominoFees.sol";
import {IDominoVault} from "../../../src/v2/interfaces/IDominoVault.sol";
import {DominoFeeLedger} from "../../../src/v2/fees/DominoFeeLedger.sol";
import {TickMath} from "../../../src/v2/positions/uniswap/TickMath.sol";
import {DominoTokenOps} from "../../../src/v2/route/DominoTokenOps.sol";
import {DominoV2VaultBase} from "../../../src/v2/vault/DominoV2VaultBase.sol";
import {DominoV2VaultStorage} from "../../../src/v2/vault/DominoV2VaultStorage.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {DominoV3Positions} from "../../../src/v2/positions/DominoV3Positions.sol";
import {HarnessV3, VaultVm} from "../vault/VaultHarness.sol";
import {MockAnchor, MockRegistry, MockToken, MockV3PositionManager} from "../vault/VaultMocks.sol";
import {CallbackProbe, MockSwapSteps, MockSwapVenue, StepConfig} from "../vault/VaultSteps.sol";
import {Behaviour, MatrixToken} from "./HostileTokens.sol";

/// @notice The v3 vault (HarnessV3: the deployed implementation, factory and
/// clone on the v3 unit model) with both pool tokens replaced by matrix
/// tokens, so either can turn hostile toward the vault while the position
/// manager and the test doubles keep working. setUp stages a Domino vault
/// with reserves and owed fees in both tokens and one successor, then the
/// owner's and anyone's flows run on it: withdrawReserves, recoverToken,
/// exitAll, returnReserves (after the owner closes the root), flushOwedFees
/// and the operator's compound. An oracle settles each completed flow.
abstract contract VaultMatrixWorld is HarnessV3 {
    // The flows.
    uint8 internal constant WITHDRAW = 0;
    uint8 internal constant RECOVER = 1;
    uint8 internal constant EXIT_ALL = 2;
    uint8 internal constant RETURN = 3;
    uint8 internal constant FLUSH = 4;
    uint8 internal constant COMPOUND = 5;
    uint8 internal constant FLOWS = 6;

    /// The gas each flow is sent with: a burner takes at most 63/64 of it.
    uint256 internal constant FLOW_GAS = 10_000_000;
    uint256 internal constant DONATION = 1e18;

    MatrixToken internal m0;
    MatrixToken internal m1;
    uint256 internal childId;

    /// Balances (real ones: heldBy) and the vault's books, per pool token.
    struct Ledger {
        uint256[2] owner;
        uint256[2] recipient;
        uint256[2] vault;
        uint256[2] owed;
        uint256[2] reserves;
        uint256[2] idle;
    }

    /// What a flow's events report, per pool token.
    struct Reported {
        uint256 paidOut;
        uint256 withdrawn;
        uint256 charged;
        uint256 deferred;
        uint256 flushed;
    }

    function setUp() public virtual override {
        MatrixToken a = new MatrixToken();
        MatrixToken b = new MatrixToken();
        (m0, m1) = address(a) < address(b) ? (a, b) : (b, a);
        token0 = MockToken(address(m0));
        token1 = MockToken(address(m1));
        registry = new MockRegistry();
        registry.setOperator(OPERATOR, true);
        registry.setFeeRecipient(RECIPIENT);
        anchor = new MockAnchor();
        config = new StepConfig();
        probe = new CallbackProbe();
        venue = new MockSwapVenue();
        swaps = new MockSwapSteps(config, venue, anchor, probe);
        m0.mint(address(venue), 1e30);
        m1.mint(address(venue), 1e30);
        _deployDex();
        _stageVault();
    }

    // ============================================================ staging

    /// Compounds `target` from its own fees, the add capped at `cap` per token.
    function _compound(uint256 target, uint128 cap) internal {
        vm.warp(block.timestamp + 600);
        Plan.PlanV1 memory p = _plan();
        p.target = target;
        p.collect = _one(target);
        p.budgets[0] = _budget(target);
        (p.amount0Max, p.amount1Max) = (cap, cap);
        _execute(p);
    }

    /// A Domino vault of two positions: the root compounds from uneven fees,
    /// then, while the recipient cannot receive either token, under a cap
    /// (so lots stay in both tokens and the tariff is owed in both), then a
    /// successor is minted near the root's ceiling (VaultLedgerInvariants'
    /// geometry), also under a cap. About 9.9 units of each token stay in the
    /// root's lots and 0.04 of each is owed.
    function _stageVault() internal {
        _domino(2);
        _accrue(rootId, 9e18, 1e18);
        _compound(rootId, 1e18);
        m0.setBlocked(RECIPIENT, true);
        m1.setBlocked(RECIPIENT, true);
        _accrue(rootId, 1e18, 9e18);
        _compound(rootId, 1e18);
        m0.setBlocked(RECIPIENT, false);
        m1.setBlocked(RECIPIENT, false);
        _accrue(rootId, 4e18, 4e18);
        uint160 price = TickMath.getSqrtPriceAtTick(UPPER - 200);
        anchor.set(price, price);
        vm.warp(block.timestamp + 600);
        Plan.PlanV1 memory p = _plan();
        p.action = Plan.ACTION_MINT;
        (p.tickLower, p.tickUpper) = (UPPER - 600, UPPER + 4080);
        (p.amount0Max, p.amount1Max) = (2e18, 2e18);
        childId = npm.nextId();
        _execute(p);
        require(vault.member(childId).active, "staging: the successor");
        require(vault.owedFees(address(m0)) != 0 && vault.owedFees(address(m1)) != 0, "staging: owed fees");
        require(vault.reserves(address(m0)) != 0 && vault.reserves(address(m1)) != 0, "staging: reserves");
    }

    // ============================================================== flows

    function _pair() internal view returns (MatrixToken[2] memory) {
        return [m0, m1];
    }

    /// What the vault would let the owner recover in `token`, by its own
    /// reading of balanceOf (a lying or unreadable balance included).
    function _recoverable(MatrixToken token) internal view returns (uint256 amount) {
        uint256 reported = token.heldBy(address(vault));
        try token.balanceOf(address(vault)) returns (uint256 answer) {
            reported = answer;
        } catch {}
        uint256 claimed = vault.owedFees(address(token)) + vault.reserves(address(token));
        amount = reported > claimed ? reported - claimed : 1;
    }

    /// What a flow needs before it runs: a donation to recover, a closed
    /// root (its successor withdrawn first) for returnReserves, fresh fees
    /// and the interval for a compound.
    function _prepare(uint8 flow, MatrixToken hostile) internal {
        if (flow == RECOVER) {
            hostile.mint(address(vault), DONATION);
        } else if (flow == RETURN) {
            vm.prank(OWNER);
            vault.withdrawChild(childId);
            uint128 liquidity = _liquidityOf(rootId);
            vm.prank(OWNER);
            npm.decreaseLiquidity(
                MockV3PositionManager.DecreaseLiquidityParams(rootId, liquidity, 0, 0, block.timestamp)
            );
        } else if (flow == COMPOUND) {
            _accrue(rootId, 2e18, 1e18);
            vm.warp(block.timestamp + 600);
        }
    }

    function _flowCall(uint8 flow, MatrixToken hostile) internal view returns (address caller, bytes memory data) {
        address token = address(hostile);
        if (flow == WITHDRAW) {
            return (OWNER, abi.encodeCall(DominoV2VaultBase.withdrawReserves, (token, vault.reserves(token) / 2, OWNER)));
        }
        if (flow == RECOVER) return (OWNER, abi.encodeCall(DominoV2VaultBase.recoverToken, (token, _recoverable(hostile))));
        if (flow == EXIT_ALL) return (OWNER, abi.encodeCall(DominoV2VaultBase.exitAll, ()));
        if (flow == RETURN) return (STRANGER, abi.encodeCall(DominoV2VaultBase.returnReserves, ()));
        if (flow == FLUSH) return (STRANGER, abi.encodeCall(DominoFeeLedger.flushOwedFees, (token)));
        return (OPERATOR, abi.encodeCall(DominoV2VaultBase.execute, (Plan.encode(_plan()))));
    }

    function _runFlow(uint8 flow, MatrixToken hostile, uint256 gasLimit)
        internal
        returns (bool ok, bytes memory out, VaultVm.Log[] memory logs)
    {
        (address caller, bytes memory data) = _flowCall(flow, hostile);
        vm.recordLogs();
        vm.prank(caller);
        (ok, out) = address(vault).call{gas: gasLimit}(data);
        logs = vm.getRecordedLogs();
    }

    // ============================================================= oracle

    function _ledger() internal view returns (Ledger memory l) {
        MatrixToken[2] memory pair = _pair();
        for (uint256 i; i < 2; ++i) {
            address token = address(pair[i]);
            l.owner[i] = pair[i].heldBy(OWNER);
            l.recipient[i] = pair[i].heldBy(RECIPIENT);
            l.vault[i] = pair[i].heldBy(address(vault));
            l.owed[i] = vault.owedFees(token);
            l.reserves[i] = vault.reserves(token);
            l.idle[i] = vault.idleReserves(token);
        }
    }

    function _word(address account) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }

    function _reported(VaultVm.Log[] memory logs, address token) internal view returns (Reported memory r) {
        for (uint256 i; i < logs.length; ++i) {
            VaultVm.Log memory log = logs[i];
            if (log.emitter != address(vault) || log.topics.length < 2) continue;
            bytes32 topic = log.topics[0];
            if (topic == IDominoVault.ReservesWithdrawn.selector && log.topics[1] == _word(token)) {
                (uint256 amount,) = abi.decode(log.data, (uint256, uint64));
                r.paidOut += amount;
                r.withdrawn += amount;
            } else if (topic == IDominoVault.TokenRecovered.selector && log.topics[1] == _word(token)) {
                r.paidOut += abi.decode(log.data, (uint256));
            } else if (topic == IDominoFeeEvents.FeeCharged.selector && log.topics[2] == _word(token)) {
                (uint256 amount,) = abi.decode(log.data, (uint256, bytes32));
                r.charged += amount;
            } else if (topic == IDominoFeeEvents.FeeDeferred.selector && log.topics[1] == _word(token)) {
                (uint256 amount,) = abi.decode(log.data, (uint256, uint256));
                r.deferred += amount;
            } else if (topic == IDominoFeeEvents.OwedFeesFlushed.selector && log.topics[1] == _word(token)) {
                r.flushed += abi.decode(log.data, (uint256));
            }
        }
    }

    function _gap(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    function _taxBps(MatrixToken token) internal view returns (uint256) {
        return token.behaviour() == Behaviour.TAXED && token.subject() == address(vault) ? token.param() : 0;
    }

    /// Settles a completed flow; returns the first rule broken, or "":
    /// - owed fees fall only by a flush, which pays exactly them, and grow
    ///   only by FeeDeferred;
    /// - the vault never loses backing: what it holds covers its owed fees
    ///   and every reserve (a shortfall it started with never grows);
    /// - the owner receives exactly what ReservesWithdrawn and TokenRecovered
    ///   report (less a tax on the token's side), and the reserves fall by
    ///   exactly what ReservesWithdrawn reports;
    /// - the fee recipient gets FeeCharged less FeeDeferred, or the flush;
    /// - no allowance from the vault to the position manager survives;
    /// - exitAll and returnReserves pay every reserve of a token that behaves.
    function _settle(uint8 flow, Ledger memory before, VaultVm.Log[] memory logs) internal view returns (string memory) {
        Ledger memory now_ = _ledger();
        MatrixToken[2] memory pair = _pair();
        for (uint256 i; i < 2; ++i) {
            Reported memory r = _reported(logs, address(pair[i]));
            uint256 taxBps = _taxBps(pair[i]);
            if (flow == FLUSH) {
                if (now_.owed[i] + r.flushed != before.owed[i]) return "a flush moved the debt other than it reports";
            } else if (now_.owed[i] != before.owed[i] + r.deferred) {
                return "owed fees moved other than FeeDeferred says";
            }
            uint256 claimed = now_.owed[i] + now_.reserves[i];
            if (_gap(claimed, now_.vault[i]) > _gap(before.owed[i] + before.reserves[i], before.vault[i])) {
                return "the vault lost backing for its owed fees and reserves";
            }
            if (now_.owner[i] - before.owner[i] != r.paidOut - r.paidOut * taxBps / 10_000) {
                return "the owner received other than the events report";
            }
            if (flow != COMPOUND && flow != RECOVER && before.reserves[i] - now_.reserves[i] != r.withdrawn) {
                return "the reserves fell other than ReservesWithdrawn reports";
            }
            uint256 fee = flow == FLUSH ? r.flushed : r.charged - r.deferred;
            if (now_.recipient[i] - before.recipient[i] != fee - fee * taxBps / 10_000) {
                return "the fee recipient got other than the events report";
            }
            if (MockToken(address(pair[i])).allowance(address(vault), address(npm)) != 0) {
                return "an allowance from the vault survived";
            }
            bool honest = pair[i].behaviour() == Behaviour.NORMAL || pair[i].subject() != address(vault);
            if ((flow == EXIT_ALL || flow == RETURN) && honest && now_.reserves[i] != 0) {
                return "a token that behaves kept reserves through an exit";
            }
        }
        if (flow == EXIT_ALL && (npm.ownerOf(childId) != OWNER || !vault.paused())) return "exitAll left a child or automation";
        return "";
    }

    function _untouched(Ledger memory before) internal view returns (bool) {
        return keccak256(abi.encode(_ledger())) == keccak256(abi.encode(before));
    }

    // ============================================================= labels

    function _flowName(uint8 flow) internal pure returns (string memory) {
        string[6] memory names = ["withdrawReserves", "recoverToken", "exitAll", "returnReserves", "flushOwedFees", "compound"];
        return names[flow];
    }

    function _why(bytes memory out) internal pure returns (string memory) {
        if (out.length < 4) return "no data (out of gas or a bare revert)";
        bytes4 selector = bytes4(out);
        if (selector == DominoTokenOps.TokenCallFailed.selector) return "TokenCallFailed";
        if (selector == DominoFeeLedger.FeeNotBacked.selector) return "FeeNotBacked";
        if (selector == DominoFeeLedger.FeeTransferMismatch.selector) return "FeeTransferMismatch";
        if (selector == DominoV2VaultStorage.InsufficientReserves.selector) return "InsufficientReserves";
        if (selector == DominoV2VaultStorage.InvalidAmount.selector) return "InvalidAmount";
        if (selector == DominoV3Positions.ApprovalFailed.selector) return "ApprovalFailed";
        if (selector == 0x4e487b71) return "Panic";
        if (selector == 0x08c379a0) {
            bytes memory body = new bytes(out.length - 4);
            for (uint256 i; i < body.length; ++i) {
                body[i] = out[i + 4];
            }
            return string.concat("Error(", abi.decode(body, (string)), ")");
        }
        return "another error";
    }
}
