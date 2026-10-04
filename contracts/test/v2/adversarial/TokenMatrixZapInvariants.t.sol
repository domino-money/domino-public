// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IPositionNft, ZapVm} from "../zap/ZapTestKit.sol";
import {Behaviour} from "./HostileTokens.sol";
import {ZapMatrixWorld} from "./ZapMatrixWorld.sol";

/// Everyone who can touch the v3 zap while one of its tokens turns hostile,
/// driven by the fuzzer:
/// - two users running every role of ZapMatrixWorld (an unused input, a pool
///   currency created, increased, exited directly or converted, a v3 or
///   router leg's input or output, the fee token as input or output) on
///   their own positions;
/// - the token itself switching behaviour between actions (every behaviour
///   of the matrix but the three whose violations are pinned in
///   TokenMatrixZap.t.sol: true but still, a lying balanceOf and an additive
///   approve; over-debits are in, since the zap now refuses them);
/// - the fee recipient going dark in usd or h and back, flushes, donations.
/// Every completed action is settled against its own events by the world's
/// oracle inside the call, and an invariant fails on the count.
contract ZapMatrixHandler is ZapMatrixWorld {
    // Rules broken inside one call; every invariant run expects zero.
    uint256 public breaches;
    string public lastBreach;
    uint256 public owedLosses;
    uint256 public strayFlushes;

    /// Everything given to the zap outside an action, per token.
    mapping(address => uint256) public donated;
    mapping(address => uint256[]) internal positionsOf;

    // Successes per action, so a campaign that only ever reverted cannot pass quietly.
    mapping(uint8 => uint256) public completions;
    uint256 public refusals;
    uint256 public flushes;
    uint256 public switches;

    constructor() {
        _buildWorld();
        positionsOf[ALICE].push(seeded[ALICE]);
        positionsOf[BOB].push(seeded[BOB]);
    }

    /// Owed fees fall only through a flush.
    modifier observed(bool flushing) {
        address[5] memory list = _tokens();
        uint256[5] memory owed;
        for (uint256 i; i < 5; ++i) {
            owed[i] = zap.owedFees(list[i]);
        }
        _;
        for (uint256 i; i < 5; ++i) {
            if (!flushing && zap.owedFees(list[i]) < owed[i]) ++owedLosses;
        }
    }

    function _user(uint256 seed) internal pure returns (address) {
        return seed % 2 == 0 ? ALICE : BOB;
    }

    // =============================================================== users

    /// One action with h in a role chosen by the fuzzer. The fee roles rank h
    /// as a charge currency for that action only, so the other roles' plans
    /// keep their usd fee.
    function act(uint256 roleSeed, uint256 userSeed, uint256 amountSeed) external observed(false) {
        uint8 role = uint8(roleSeed % (ROLES - 1)); // FEE_OWED is FEE_OUTPUT with the recipient dark
        address user = _user(userSeed);
        uint256 id;
        if (role == POOL_INCREASE || role == POOL_EXIT || role == EXIT_CONVERTED) {
            uint256[] storage owned = positionsOf[user];
            if (owned.length == 0) return;
            id = owned[(userSeed >> 8) % owned.length];
        }
        registry.setRank(address(h), role >= FEE_INPUT ? 1 : 0);
        Books memory before = _books(user);
        (bool ok, bytes memory out, ZapVm.Log[] memory logs) = _runRole(role, user, 1e15 + amountSeed % 1e21, id);
        registry.setRank(address(h), 0);
        if (!ok) {
            ++refusals;
            if (!_untouched(before, user)) _breach("a refused action moved something");
            return;
        }
        string memory problem = _audit(before, user, logs, role == POOL_EXIT);
        if (bytes(problem).length != 0) _breach(problem);
        if (!_resultMatches(out, logs)) _breach("the return value differs from the events");
        ++completions[role];
        if (role == POOL_CREATE) {
            uint256 created = abi.decode(out, (IDominoPositionActions.ActionResult)).tokenId;
            vm.prank(user);
            IPositionNft(address(npm)).approve(address(zap), created);
            positionsOf[user].push(created);
        } else if (role == EXIT_CONVERTED) {
            _forget(user, id);
        }
    }

    function _breach(string memory problem) internal {
        ++breaches;
        lastBreach = problem;
    }

    function _forget(address user, uint256 id) internal {
        uint256[] storage owned = positionsOf[user];
        for (uint256 i; i < owned.length; ++i) {
            if (owned[i] == id) {
                owned[i] = owned[owned.length - 1];
                owned.pop();
                return;
            }
        }
    }

    // ============================================================ the token

    /// h turns to another behaviour (never one of the three pinned elsewhere),
    /// with a fuzzed parameter.
    function switchBehaviour(uint256 seed, uint256 paramSeed) external observed(false) {
        uint8[16] memory safe = [
            Behaviour.NORMAL,
            Behaviour.RETURNS_FALSE,
            Behaviour.RETURNS_NOTHING,
            Behaviour.REVERTS,
            Behaviour.TAXED,
            Behaviour.BURNS_GAS,
            Behaviour.RETURN_BOMB,
            Behaviour.BALANCE_REVERTS,
            Behaviour.MOVES_BUT_FALSE,
            Behaviour.ZERO_REVERTS,
            Behaviour.APPROVE_RACE,
            Behaviour.APPROVE_ZERO_REVERTS,
            Behaviour.INFLATES,
            Behaviour.HOOKED,
            Behaviour.APPROVE_BOMB,
            Behaviour.OVERDEBITS
        ];
        uint8 behaviour = safe[seed % safe.length];
        uint256 param;
        if (behaviour == Behaviour.TAXED) param = 1 + paramSeed % 10_000;
        else if (behaviour == Behaviour.RETURN_BOMB || behaviour == Behaviour.APPROVE_BOMB) {
            param = 32 + paramSeed % 300_000;
        }
        else if (behaviour == Behaviour.INFLATES) param = 1 + paramSeed % 1e24;
        else if (behaviour == Behaviour.OVERDEBITS) param = 1 + paramSeed % 1e18;
        _aimAtZap(behaviour, param);
        ++switches;
    }

    // ===================================================== recipient, others

    function recipientGoesDark(uint256 seed, bool dark) external observed(false) {
        if (seed % 2 == 0) h.setBlocked(FEE_RECIPIENT, dark);
        else usd.setBlocked(FEE_RECIPIENT, dark);
    }

    /// A flush pays exactly the debt to the recipient (less h's tax on its own
    /// side) and clears it, or fails and leaves it whole.
    function flush(uint256 seed) external observed(true) {
        address token = _tokens()[seed % 3];
        uint256 owed = zap.owedFees(token);
        uint256 holding = _held(token, address(zap));
        uint256 paid = _held(token, FEE_RECIPIENT);
        uint256 taxBps = token == address(h) && h.behaviour() == Behaviour.TAXED ? h.param() : 0;
        try zap.flushOwedFees(token) returns (uint256 amount) {
            if (amount != 0) ++flushes;
            if (
                amount != owed || zap.owedFees(token) != 0 || holding - _held(token, address(zap)) != owed
                    || _held(token, FEE_RECIPIENT) - paid != owed - owed * taxBps / 10_000
            ) ++strayFlushes;
        } catch {
            if (zap.owedFees(token) != owed) ++owedLosses;
        }
    }

    function donate(uint256 seed, uint256 amount) external observed(false) {
        address token = _tokens()[seed % 3];
        amount %= 1e21;
        TestTokenLike(token).mint(address(zap), amount);
        donated[token] += amount;
    }

    // ================================================================ reads

    function positionCount(address user) external view returns (uint256) {
        return positionsOf[user].length;
    }

    function tokens() external view returns (address[5] memory) {
        return _tokens();
    }

    function held(address token, address account) external view returns (uint256) {
        return _held(token, account);
    }

    function noAllowanceSurvives() external view returns (bool) {
        return _noAllowanceSurvives();
    }
}

interface TestTokenLike {
    function mint(address to, uint256 amount) external;
}

/// The zap's settlement while a token turns hostile, under every sequence the
/// handler can produce:
/// - every completed action settled exactly against its events (the world's
///   oracle), and a refused one moved nothing;
/// - in every token the zap holds at least what it owes, and owed fees fall
///   only through a flush, which pays exactly them;
/// - the zap keeps nothing of an action: beyond its owed fees it holds only
///   what was given to it;
/// - no ERC-20 or Permit2 allowance from the zap survives.
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 64
contract TokenMatrixZapInvariantsTest {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    ZapMatrixHandler internal handler;

    function setUp() public {
        handler = new ZapMatrixHandler();
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    /// The actions only; `act` twice, so most calls are actions.
    function targetSelectors() public view returns (FuzzSelector[] memory targets) {
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = ZapMatrixHandler.act.selector;
        selectors[1] = ZapMatrixHandler.act.selector;
        selectors[2] = ZapMatrixHandler.switchBehaviour.selector;
        selectors[3] = ZapMatrixHandler.recipientGoesDark.selector;
        selectors[4] = ZapMatrixHandler.flush.selector;
        selectors[5] = ZapMatrixHandler.donate.selector;
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    /// The handler is only evidence if its actions reach the zap: a scripted
    /// pass where every role completes while h behaves, a fee in h goes owed
    /// and is flushed, and a hostile turn refuses an action and still lets
    /// the direct exit through, with every invariant checked after it.
    function testTheHandlerReachesEveryAction() public {
        for (uint256 role; role < 10; ++role) {
            handler.act(role, role, 5e18);
            require(handler.completions(uint8(role)) == 1, "a role never completed");
        }
        handler.recipientGoesDark(0, true);
        handler.act(9, 1, 5e18); // the fee in h, owed
        require(IZapView(address(handler.zap())).owedFees(address(handler.h())) != 0, "no fee in h went owed");
        handler.recipientGoesDark(0, false);
        handler.flush(2);
        require(handler.flushes() == 1, "the owed fee was never flushed");
        handler.switchBehaviour(5, 0); // burns gas
        handler.act(0, 0, 1e18);
        require(handler.refusals() == 1, "a burning token was not refused");
        handler.act(3, 1, 0); // the direct exit still completes
        require(handler.completions(3) == 2, "the direct exit was blocked");
        handler.donate(0, 1000);
        require(handler.switches() == 1, "the token never turned");
        _all();
    }

    function _all() internal view {
        invariant_everyCompletedActionSettledExactly();
        invariant_everyOwedFeeIsBackedAndFallsOnlyByAFlush();
        invariant_theZapKeepsNothingButGifts();
        invariant_noAllowanceSurvives();
    }

    function invariant_everyCompletedActionSettledExactly() public view {
        require(handler.breaches() == 0, handler.lastBreach());
    }

    function invariant_everyOwedFeeIsBackedAndFallsOnlyByAFlush() public view {
        IZapView zap = IZapView(address(handler.zap()));
        address[5] memory tokens = handler.tokens();
        for (uint256 i; i < 5; ++i) {
            require(handler.held(tokens[i], address(zap)) >= zap.owedFees(tokens[i]), "an owed fee is not backed");
        }
        require(handler.owedLosses() == 0 && handler.strayFlushes() == 0, "owed fees fell without an exact flush");
    }

    function invariant_theZapKeepsNothingButGifts() public view {
        IZapView zap = IZapView(address(handler.zap()));
        address[5] memory tokens = handler.tokens();
        for (uint256 i; i < 5; ++i) {
            uint256 kept = handler.held(tokens[i], address(zap)) - zap.owedFees(tokens[i]);
            require(kept <= handler.donated(tokens[i]), "the zap kept part of an action");
        }
    }

    function invariant_noAllowanceSurvives() public view {
        require(handler.noAllowanceSurvives(), "an allowance from the zap survived");
    }
}

interface IZapView {
    function owedFees(address token) external view returns (uint256);
}
