// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2VaultBase} from "../../../src/v2/vault/DominoV2VaultBase.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {AdversarialVm, Behaviour, CHEATS, MatrixToken, consoleLog} from "./HostileTokens.sol";
import {VaultMatrixWorld} from "./VaultMatrixWorld.sol";
import {ZapMatrixWorld} from "./ZapMatrixWorld.sol";

// EIP-7825's per-transaction gas cap (Osaka): the tightest a target chain may
// adopt (Arbitrum Orbit chains cap a transaction at 32M).
uint256 constant TX_GAS_CAP = 16_777_216;
// A payload whose memory alone costs about 190M gas: no frame can return it.
uint256 constant MEGA_BOMB = 10_000_000;

/// The EVM's memory cost of `size` bytes in a fresh frame.
function memoryCost(uint256 size) pure returns (uint256) {
    uint256 words = (size + 31) / 32;
    return 3 * words + words * words / 512;
}

/// @notice Gas burners and return bombs against the vault's exits and
/// settlement. DominoTokenOps copies at most one word back and forwards all
/// remaining gas to an owner's payment, so a hostile token takes at most
/// 63/64 of what is left and the rest of the exit still runs: exitAll and
/// returnReserves pay the other token and return the successor on a few
/// million gas, far under any chain's cap; the tariff push is capped at 100k.
contract ReturnBombVaultTest is VaultMatrixWorld {
    AdversarialVm internal constant cheats = AdversarialVm(CHEATS);

    function _turn(MatrixToken token, uint8 kind) internal {
        if (kind == 0) token.aim(address(vault), Behaviour.BURNS_GAS, 0, false);
        else token.aim(address(vault), Behaviour.RETURN_BOMB, MEGA_BOMB, false);
    }

    /// The least gas (to 1/64) with which `caller`'s `data` completes and
    /// pays the owner every reserve of `honest`, searched up to `high`.
    function _leastGas(address caller, bytes memory data, MatrixToken honest, uint256 high)
        internal
        returns (uint256)
    {
        uint256 low;
        uint256 reserves = vault.reserves(address(honest));
        while (high - low > high / 64) {
            uint256 mid = (low + high) / 2;
            uint256 snapshot = cheats.snapshotState();
            uint256 before = honest.heldBy(OWNER);
            vm.prank(caller);
            (bool ok,) = address(vault).call{gas: mid}(data);
            bool paid = ok && honest.heldBy(OWNER) - before == reserves;
            cheats.revertToState(snapshot);
            if (paid) high = mid;
            else low = mid;
        }
        return high;
    }

    function _report(string memory what, uint256 gas) internal view {
        consoleLog(string.concat(what, ": ", cheats.toString(gas), " gas"));
    }

    function _label(string memory flow, uint256 side, uint8 kind) internal pure returns (string memory) {
        return string.concat(flow, side == 0 ? ", token0" : ", token1", kind == 0 ? " burns gas" : " returns 10 MB");
    }

    /// From a snapshot: one token turned hostile, the least gas with which
    /// the flow still pays the other one, reported and bounded.
    function _measure(string memory flow, address caller, bytes memory data, uint256 side, uint8 kind) internal {
        uint256 snapshot = cheats.snapshotState();
        _turn(side == 0 ? m0 : m1, kind);
        uint256 least = _leastGas(caller, data, side == 0 ? m1 : m0, TX_GAS_CAP);
        _report(_label(flow, side, kind), least);
        _true(least < TX_GAS_CAP / 2, "the flow completes on a modest budget");
        cheats.revertToState(snapshot);
    }

    /// One pool token burning all its gas, or answering with a 10 MB
    /// payload, on either side: exitAll still pays every reserve of the
    /// other token (and returns the successor) on a budget far under the
    /// 16.7M cap. The baseline, with both tokens honest, is printed too.
    function testExitAllCompletesOnAModestBudgetWhateverOneTokenBurns() public {
        bytes memory data = abi.encodeCall(DominoV2VaultBase.exitAll, ());
        _report("exitAll, both honest", _leastGas(OWNER, data, m1, TX_GAS_CAP));
        for (uint256 side; side < 2; ++side) {
            _measure("exitAll", OWNER, data, side, 0);
            _measure("exitAll", OWNER, data, side, 1);
        }
    }

    /// The same for anyone's returnReserves, once the owner closed the root.
    function testReturnReservesCompletesOnAModestBudgetWhateverOneTokenBurns() public {
        _prepare(RETURN, m0);
        bytes memory data = abi.encodeCall(DominoV2VaultBase.returnReserves, ());
        _report("returnReserves, both honest", _leastGas(STRANGER, data, m1, TX_GAS_CAP));
        for (uint256 side; side < 2; ++side) {
            _measure("returnReserves", STRANGER, data, side, 0);
            _measure("returnReserves", STRANGER, data, side, 1);
        }
    }

    /// ACCEPTED (informational): with BOTH pool tokens burning gas, each
    /// payment of exitAll takes 63/64 of what is left, so the call needs
    /// about 64 x 64 times its tail: more than the 16.7M cap (it is printed).
    /// Nothing is stranded by it: neither token can be received anyway (A8
    /// keeps them idle), and the owner's other exits need no token at all:
    /// withdrawChild returns the successor and pause stops automation, each
    /// on an ordinary budget.
    function testWithBothTokensBurningTheOwnerStillLeavesPositionByPosition() public {
        _turn(m0, 0);
        _turn(m1, 0);
        uint256 snapshot = cheats.snapshotState();
        vm.prank(OWNER);
        (bool ok,) = address(vault).call{gas: TX_GAS_CAP}(abi.encodeCall(DominoV2VaultBase.exitAll, ()));
        cheats.revertToState(snapshot);
        consoleLog(string.concat("exitAll with both tokens burning, at the 16.7M cap: ", ok ? "completes" : "runs out of gas"));
        // The coarse threshold, for the report.
        uint256 least = 64_000_000;
        for (uint256 g = 20_000_000; g <= 64_000_000; g += 4_000_000) {
            snapshot = cheats.snapshotState();
            vm.prank(OWNER);
            (bool done,) = address(vault).call{gas: g}(abi.encodeCall(DominoV2VaultBase.exitAll, ()));
            cheats.revertToState(snapshot);
            if (done) {
                least = g;
                break;
            }
        }
        _report("exitAll with both tokens burning needs at most", least);
        vm.prank(OWNER);
        vault.withdrawChild{gas: 500_000}(childId);
        _true(npm.ownerOf(childId) == OWNER, "the successor is back");
        vm.prank(OWNER);
        vault.pause{gas: 200_000}();
        _true(vault.paused(), "automation stopped");
    }

    /// The tariff push is capped: with both pool tokens burning gas, the
    /// operator's compound still completes on 1M gas and owes the tariff in
    /// both tokens; nothing else in it calls the tokens with more than that.
    function testACompoundWithBurningTokensOwesTheTariffOnABoundedBudget() public {
        _prepare(COMPOUND, m0);
        uint256 owed0 = vault.owedFees(address(m0));
        uint256 owed1 = vault.owedFees(address(m1));
        _turn(m0, 0);
        _turn(m1, 0);
        bytes memory data = abi.encodeCall(DominoV2VaultBase.execute, (Plan.encode(_plan())));
        uint256 start = gasleft();
        vm.prank(OPERATOR);
        (bool ok,) = address(vault).call{gas: 1_000_000}(data);
        uint256 used = start - gasleft();
        _report("compound with both tokens burning", used);
        _true(ok, "the compound completed");
        _true(vault.owedFees(address(m0)) > owed0 && vault.owedFees(address(m1)) > owed1, "the tariff is owed in both");
    }
}

/// @notice Return bombs against the zap. The owner's direct exit never calls
/// the hostile token at all, so it costs the same whatever the token does.
/// Every DominoTokenOps call copies one word, so a bomb on a refund, a leg
/// payment, the fee push or the router leg's approve costs only the token's
/// own memory. F1c's DominoV3Positions._approve, however, copies the whole
/// answer (a high-level call), so a token whose approve returns a payload
/// makes the zap pay to copy it twice per add: measured and printed here, it
/// only ever burdens adding liquidity to that token's own pools.
contract ReturnBombZapTest is ZapMatrixWorld {
    AdversarialVm internal constant cheats = AdversarialVm(CHEATS);

    function setUp() public {
        _buildWorld();
    }

    /// The gas `role` takes for ALICE with h aimed as `behaviour`, from a
    /// snapshot; zero when it reverts.
    function _gasOf(uint8 role, uint8 behaviour, uint256 param) internal returns (uint256 used) {
        uint256 snapshot = cheats.snapshotState();
        _stage(role);
        _aimAtZap(behaviour, param);
        uint256 start = gasleft();
        (bool ok,,) = _runRole(role, ALICE, 4e18, seeded[ALICE]);
        used = ok ? start - gasleft() : 0;
        cheats.revertToState(snapshot);
    }

    /// The owner's exit to both tokens, paid by the position manager, costs
    /// the same, within a few thousand gas of bookkeeping noise, whatever h
    /// does to the zap: burners, 10 MB bombs on transfer or approve, re-entry.
    function testTheDirectExitNeverPaysForAHostileToken() public {
        _gasOf(POOL_EXIT, Behaviour.NORMAL, 0); // warms every account it touches
        uint256 honest = _gasOf(POOL_EXIT, Behaviour.NORMAL, 0);
        uint8[5] memory hostile =
            [Behaviour.BURNS_GAS, Behaviour.RETURN_BOMB, Behaviour.APPROVE_BOMB, Behaviour.HOOKED, Behaviour.REVERTS];
        for (uint256 i; i < hostile.length; ++i) {
            uint256 used = _gasOf(POOL_EXIT, hostile[i], MEGA_BOMB);
            _check(used != 0, "the direct exit completes");
            _check(used < honest + 10_000 && used + 10_000 > honest, "and costs what it costs with an honest token");
        }
    }

    /// A payload the token answers with: on a refund or a leg payment
    /// (DominoTokenOps.transfer) and on the router leg's approve
    /// (DominoTokenOps.approve), the zap pays nothing to copy it; on F1c's
    /// approve the zap pays the copy. Printed per size: the extra gas of a
    /// create in h's own pool (approve bomb), of a router leg (approve bomb
    /// on DominoTokenOps.approve) and of an extra input's refund (transfer
    /// bomb), next to what the token itself pays for its memory. A 10 MB
    /// approve payload makes that create run out of gas (reported), and the
    /// same token in a create that does not add it costs nothing extra.
    function testWhoPaysForAReturnBomb() public {
        for (uint8 role; role < ROLES; ++role) {
            _gasOf(role, Behaviour.NORMAL, 0); // warms every account the roles touch
        }
        uint256 baseCreate = _gasOf(POOL_CREATE, Behaviour.NORMAL, 0);
        uint256 baseRouter = _gasOf(ROUTER_INPUT, Behaviour.NORMAL, 0);
        uint256 baseRefund = _gasOf(EXTRA_INPUT, Behaviour.NORMAL, 0);
        uint256[4] memory sizes = [uint256(65_536), 262_144, 1_048_576, MEGA_BOMB];
        for (uint256 i; i < sizes.length; ++i) {
            uint256 create = _gasOf(POOL_CREATE, Behaviour.APPROVE_BOMB, sizes[i]);
            uint256 router = _gasOf(ROUTER_INPUT, Behaviour.APPROVE_BOMB, sizes[i]);
            uint256 refund = _gasOf(EXTRA_INPUT, Behaviour.RETURN_BOMB, sizes[i]);
            consoleLog(
                string.concat(
                    "payload ",
                    cheats.toString(sizes[i]),
                    " B (token's own memory ",
                    cheats.toString(memoryCost(sizes[i])),
                    "): create in its pool +",
                    create == 0 ? "out of gas" : cheats.toString(create - baseCreate),
                    ", router leg approve +",
                    router == 0 ? "out of gas" : cheats.toString(router - baseRouter),
                    ", refund +",
                    refund == 0 ? "out of gas" : cheats.toString(refund - baseRefund)
                )
            );
            if (sizes[i] <= 1_048_576) {
                _check(create != 0 && router != 0 && refund != 0, "a payload up to 1 MB never stops an action");
                // One-word copies: the token's memory and little else.
                _check(router - baseRouter < memoryCost(sizes[i]) + 50_000, "the router leg's approve copies one word");
                _check(refund - baseRefund < memoryCost(sizes[i]) + 50_000, "the refund copies one word");
            }
        }
        // h bombing in a create that never adds it (an unused input): no copy.
        uint256 snapshot = cheats.snapshotState();
        _aimAtZap(Behaviour.APPROVE_BOMB, MEGA_BOMB);
        uint256 start = gasleft();
        (bool ok,,) = _runRole(LEG_OUTPUT, ALICE, 4e18, 0);
        uint256 used = start - gasleft();
        cheats.revertToState(snapshot);
        _check(ok && used < _gasOf(LEG_OUTPUT, Behaviour.NORMAL, 0) + 10_000, "the approve bomb costs nothing elsewhere");
    }
}
