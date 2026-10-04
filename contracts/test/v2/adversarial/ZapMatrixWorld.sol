// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IUniswapV3PositionManagerMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {DominoFeeLedger} from "../../../src/v2/fees/DominoFeeLedger.sol";
import {DominoV3Positions, IV3PoolInitializerMinimal} from "../../../src/v2/positions/DominoV3Positions.sol";
import {DominoSwapExecutor} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {DominoTokenOps} from "../../../src/v2/route/DominoTokenOps.sol";
import {UniswapBase8453} from "../positions/fixtures/UniswapBase8453.sol";
import {RobinhoodPermit2} from "../route/fixtures/RobinhoodPermit2.sol";
import {ScriptedRouter, scriptedCall} from "../route/RouteAdversaries.sol";
import {MockDominoRegistry, TestToken} from "../route/V2RouteTestKit.sol";
import {ZapBaseFixtures} from "../zap/ZapBaseFixtures.sol";
import {IPermit2Views, IPositionNft, IZap, ZapVm} from "../zap/ZapTestKit.sol";
import {Behaviour, MatrixToken, TwinEntry} from "./HostileTokens.sol";

/// @notice The v3 zap on the factory, NonfungiblePositionManager and WETH9
/// deployed on Base, with one hostile token `h` (MatrixToken, aimed at the
/// zap) in every role an action gives a token, and an oracle that settles
/// each completed action against its own events.
/// Pools, all at price one: usd/tkn 0.3% (`plain`, positions) and 0.05%
/// (legs); usd/h 0.3% (`hostile`, positions) and 0.05% (legs); tkn/h 0.05%
/// (legs). usd is the rank-1 charge currency; the fee roles make h one too.
/// Each user holds a seeded usd/h position with the zap approved on it.
abstract contract ZapMatrixWorld is ZapBaseFixtures {
    string internal constant ZAP_ARTIFACT = "DominoZapV3.sol:DominoZapV3";
    bytes32 internal constant POOL_INIT_CODE_HASH = 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
    int24 internal constant LOWER = -600;
    int24 internal constant UPPER = 600;
    address internal constant FEE_RECIPIENT = address(0xFEE);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant WETH = UniswapBase8453.WETH9;
    /// The gas each action is sent with: a burner takes at most 63/64 of it.
    uint256 internal constant ACTION_GAS = 20_000_000;
    uint256 internal constant SEED_AMOUNT = 10e18;

    // The roles a token plays in an action.
    /// An input no step uses: pulled, then refunded whole.
    uint8 internal constant EXTRA_INPUT = 0;
    /// A pool currency of a new position (the manager pulls it from the zap).
    uint8 internal constant POOL_CREATE = 1;
    /// A pool currency of an increase.
    uint8 internal constant POOL_INCREASE = 2;
    /// A pool currency of an exit to both tokens (the manager pays the owner).
    uint8 internal constant POOL_EXIT = 3;
    /// A pool currency an exit converts (h -> usd), the fee in usd.
    uint8 internal constant EXIT_CONVERTED = 4;
    /// A v3 leg's input (h -> usd), the fee in usd.
    uint8 internal constant LEG_INPUT = 5;
    /// A v3 leg's output (usd -> h), refunded.
    uint8 internal constant LEG_OUTPUT = 6;
    /// A router leg's input, pulled through Permit2 (h -> usd).
    uint8 internal constant ROUTER_INPUT = 7;
    /// The fee token, as the leg's input (h -> tkn): 65 bps on top.
    uint8 internal constant FEE_INPUT = 8;
    /// The fee token, as the leg's output (tkn -> h): 65 bps out of it.
    uint8 internal constant FEE_OUTPUT = 9;
    /// As FEE_OUTPUT, the fee recipient unable to receive h: the fee is owed.
    uint8 internal constant FEE_OWED = 10;
    uint8 internal constant ROLES = 11;

    MockDominoRegistry public registry;
    IZap public zap;
    IUniswapV3PositionManagerMinimal public npm = IUniswapV3PositionManagerMinimal(UniswapBase8453.V3_POSITION_MANAGER);
    ScriptedRouter public router;
    TestToken public usd;
    TestToken public tkn;
    MatrixToken public h;
    TwinEntry public hTwin;
    DominoV2Types.PoolRef internal plain;
    DominoV2Types.PoolRef internal hostile;
    mapping(address => uint256) public seeded;

    /// Everyone's balances and the zap's debts, in usd, tkn, h, WETH and ETH.
    struct Books {
        uint256[5] user;
        uint256[5] zap;
        uint256[5] recipient;
        uint256[5] owed;
    }

    /// What one token's events say an action did.
    struct Flows {
        int256 user;
        uint256 charged;
        uint256 deferred;
    }

    // ============================================================== world

    function _buildWorld() internal {
        vm.warp(NOW);
        vm.etch(PERMIT2, RobinhoodPermit2.RUNTIME);
        _installBaseV3();
        registry = new MockDominoRegistry();
        registry.setFeeRecipient(FEE_RECIPIENT);
        zap = IZap(
            _deploy(
                abi.encodePacked(
                    vm.getCode(ZAP_ARTIFACT),
                    abi.encode(
                        DominoSwapExecutor.RouteConfig(
                            IDominoRegistry(address(registry)),
                            PERMIT2,
                            UniswapBase8453.V3_FACTORY,
                            POOL_INIT_CODE_HASH,
                            address(0)
                        ),
                        npm
                    )
                )
            )
        );
        router = new ScriptedRouter(PERMIT2);
        registry.setRouter(address(router), 212);
        (usd, tkn, h) = (new TestToken(), new TestToken(), new MatrixToken());
        hTwin = new TwinEntry(h);
        h.setTwin(address(hTwin));
        registry.setRank(address(usd), 1);
        address[4] memory funded = [address(this), ALICE, BOB, address(router)];
        for (uint256 i; i < funded.length; ++i) {
            usd.mint(funded[i], 1e30);
            tkn.mint(funded[i], 1e30);
            h.mint(funded[i], 1e30);
        }
        (address c0, address c1) = _sorted(address(usd), address(tkn));
        plain = DominoV2Types.PoolRef(DominoV2Types.DEX_V3, c0, c1, 3000, 60, address(0));
        (c0, c1) = _sorted(address(usd), address(h));
        hostile = DominoV2Types.PoolRef(DominoV2Types.DEX_V3, c0, c1, 3000, 60, address(0));
        _openPool(address(usd), address(tkn), 3000, 887220, 1e22);
        _openPool(address(usd), address(tkn), 500, 887270, 1e25);
        _openPool(address(usd), address(h), 3000, 887220, 1e22);
        _openPool(address(usd), address(h), 500, 887270, 1e25);
        _openPool(address(tkn), address(h), 500, 887270, 1e25);
        address[2] memory users = [ALICE, BOB];
        for (uint256 i; i < users.length; ++i) {
            vm.startPrank(users[i]);
            usd.approve(address(zap), type(uint256).max);
            tkn.approve(address(zap), type(uint256).max);
            h.approve(address(zap), type(uint256).max);
            vm.stopPrank();
            seeded[users[i]] = _seed(users[i]);
        }
    }

    function _openPool(address a, address b, uint24 fee, int24 full, uint256 amount) internal returns (address at) {
        (address c0, address c1) = _sorted(a, b);
        at = IV3PoolInitializerMinimal(address(npm)).createAndInitializePoolIfNecessary(c0, c1, fee, PRICE_ONE);
        TestToken(c0).approve(address(npm), type(uint256).max);
        TestToken(c1).approve(address(npm), type(uint256).max);
        npm.mint(
            IUniswapV3PositionManagerMinimal.MintParams(
                c0, c1, fee, -full, full, amount, amount, 0, 0, address(this), block.timestamp
            )
        );
    }

    /// A usd/h position for `user`, made through the zap while h behaves, with
    /// the zap approved on it for exits.
    function _seed(address user) internal returns (uint256 id) {
        IDominoPositionActions.CreatePlan memory plan = _createPlan(
            hostile, _two(address(usd), SEED_AMOUNT, address(h), SEED_AMOUNT), _noLegs(), ETH, user
        );
        vm.prank(user);
        id = zap.create(plan).tokenId;
        vm.prank(user);
        IPositionNft(address(npm)).approve(address(zap), id);
    }

    // ============================================================== plans

    function _two(address a, uint256 amountA, address b, uint256 amountB)
        internal
        pure
        returns (DominoV2Types.TokenAmount[] memory list)
    {
        list = new DominoV2Types.TokenAmount[](2);
        list[0] = DominoV2Types.TokenAmount(a, uint128(amountA));
        list[1] = DominoV2Types.TokenAmount(b, uint128(amountB));
    }

    function _three(address a, uint256 amountA, address b, uint256 amountB, address c, uint256 amountC)
        internal
        pure
        returns (DominoV2Types.TokenAmount[] memory list)
    {
        list = new DominoV2Types.TokenAmount[](3);
        list[0] = DominoV2Types.TokenAmount(a, uint128(amountA));
        list[1] = DominoV2Types.TokenAmount(b, uint128(amountB));
        list[2] = DominoV2Types.TokenAmount(c, uint128(amountC));
    }

    /// An exact-input leg through the 0.05% pool of the pair (all at price one).
    function _v3Leg(address tokenIn, address tokenOut, uint256 amountIn)
        internal
        pure
        returns (DominoV2Types.SwapLeg memory)
    {
        return DominoV2Types.SwapLeg(
            DominoV2Types.LEG_V3_POOL,
            address(0),
            tokenIn,
            tokenOut,
            uint128(amountIn),
            uint128(amountIn * 98 / 100),
            abi.encodePacked(tokenIn, uint24(500), tokenOut)
        );
    }

    /// An honest router leg h -> usd at one for one, pulled through Permit2.
    function _routerLeg(uint256 amountIn) internal view returns (DominoV2Types.SwapLeg memory) {
        ScriptedRouter.Script memory script;
        (script.tokenIn, script.pull, script.tokenOut, script.pay) = (address(h), amountIn, address(usd), amountIn);
        return DominoV2Types.SwapLeg(
            DominoV2Types.LEG_UNIVERSAL_ROUTER,
            address(router),
            address(h),
            address(usd),
            uint128(amountIn),
            uint128(amountIn),
            scriptedCall(script)
        );
    }

    function _createPlan(
        DominoV2Types.PoolRef memory pool,
        DominoV2Types.TokenAmount[] memory inputs,
        DominoV2Types.SwapLeg[] memory legs,
        address feeToken,
        address user
    ) internal pure returns (IDominoPositionActions.CreatePlan memory plan) {
        plan.intent = _intent(DominoV2Types.ACTION_CREATE, pool, 0, LOWER, UPPER, 1, legs, feeToken, user, 0);
        (plan.inputs, plan.legs, plan.amount0Max, plan.amount1Max) =
            (inputs, legs, type(uint128).max, type(uint128).max);
    }

    function _create(
        DominoV2Types.PoolRef memory pool,
        DominoV2Types.TokenAmount[] memory inputs,
        DominoV2Types.SwapLeg[] memory legs,
        address feeToken,
        address user
    ) internal pure returns (bytes memory) {
        return abi.encodeCall(IDominoPositionActions.create, (_createPlan(pool, inputs, legs, feeToken, user)));
    }

    function _increase(uint256 id, DominoV2Types.TokenAmount[] memory inputs, address user)
        internal
        view
        returns (bytes memory)
    {
        IDominoPositionActions.IncreasePlan memory plan;
        plan.intent = _intent(DominoV2Types.ACTION_INCREASE, hostile, id, LOWER, UPPER, 1, _noLegs(), ETH, user, 0);
        (plan.inputs, plan.legs, plan.amount0Max, plan.amount1Max) =
            (inputs, _noLegs(), type(uint128).max, type(uint128).max);
        return abi.encodeCall(IDominoPositionActions.increase, (plan));
    }

    function _exit(
        uint256 id,
        uint128 liquidity,
        DominoV2Types.SwapLeg[] memory legs,
        address feeToken,
        bool burn,
        address user
    ) internal view returns (bytes memory) {
        IDominoPositionActions.ExitPlan memory plan;
        plan.intent = _intent(DominoV2Types.ACTION_EXIT, hostile, id, LOWER, UPPER, 0, legs, feeToken, user, 0);
        (plan.liquidityToRemove, plan.legs, plan.burn) = (liquidity, legs, burn);
        return abi.encodeCall(IDominoPositionActions.exit, (plan));
    }

    function _liquidity(uint256 id) internal view returns (uint128 liquidity) {
        (,,,,,,, liquidity,,,,) = npm.positions(id);
    }

    // ============================================================== roles

    /// The calldata of one action with h in `role`, for `user`, sized by `a`;
    /// `id` is the user's usd/h position for the roles that need one.
    function _roleCall(uint8 role, address user, uint256 a, uint256 id) internal view returns (bytes memory) {
        address u = address(usd);
        address t = address(tkn);
        address x = address(h);
        if (role == EXTRA_INPUT) return _create(plain, _three(u, a, t, a, x, a / 2), _noLegs(), ETH, user);
        if (role == POOL_CREATE) return _create(hostile, _two(u, a, x, a), _noLegs(), ETH, user);
        if (role == POOL_INCREASE) return _increase(id, _two(u, a, x, a), user);
        if (role == POOL_EXIT) return _exit(id, _liquidity(id) / 2, _noLegs(), ETH, false, user);
        if (role == EXIT_CONVERTED) {
            // At price one a [-600, 600] position holds about 3% of its liquidity in each token.
            return _exit(id, _liquidity(id), _oneLeg(_v3Leg(x, u, _liquidity(id) / 100)), u, true, user);
        }
        if (role == LEG_INPUT) return _create(plain, _three(u, a, t, a, x, a), _oneLeg(_v3Leg(x, u, a / 2)), u, user);
        if (role == LEG_OUTPUT) return _create(plain, _two(u, a, t, a), _oneLeg(_v3Leg(u, x, a / 2)), u, user);
        if (role == ROUTER_INPUT) return _create(plain, _three(u, a, t, a, x, a), _oneLeg(_routerLeg(a / 2)), u, user);
        if (role == FEE_INPUT) return _create(plain, _three(u, a, t, a, x, a), _oneLeg(_v3Leg(x, t, a / 2)), x, user);
        return _create(plain, _two(u, a, t, a), _oneLeg(_v3Leg(t, x, a / 2)), x, user);
    }

    /// What a role needs of the world: h ranked as a charge currency for the
    /// fee roles, and the recipient unable to receive h for FEE_OWED.
    function _stage(uint8 role) internal {
        if (role >= FEE_INPUT) registry.setRank(address(h), 1);
        if (role == FEE_OWED) h.setBlocked(FEE_RECIPIENT, true);
    }

    /// The matrix's parameter for a behaviour: a 1% tax, an over-debit of
    /// 0.001 h, a 100 KB payload, a lie of 1000 units (less than any fee the
    /// fee roles owe), an inflation of one h. The hook re-enters the zap (its
    /// flush), which the shared lock refuses.
    function _defaultParam(uint8 behaviour) internal pure returns (uint256) {
        if (behaviour == Behaviour.TAXED) return 100;
        if (behaviour == Behaviour.OVERDEBITS) return 1e15;
        if (behaviour == Behaviour.RETURN_BOMB || behaviour == Behaviour.APPROVE_BOMB) return 100_000;
        if (behaviour == Behaviour.BALANCE_LIES) return 1000;
        if (behaviour == Behaviour.INFLATES) return 1e18;
        return 0;
    }

    /// Aims h at the zap, its pulls included (the managers' transferFrom).
    function _aimAtZap(uint8 behaviour, uint256 param) internal {
        if (behaviour == Behaviour.HOOKED) {
            h.setHook(address(zap), abi.encodeCall(DominoFeeLedger.flushOwedFees, (address(usd))));
        }
        h.aim(address(zap), behaviour, param, true);
    }

    /// Runs the role as `user` and returns the call's outcome and its logs.
    function _runRole(uint8 role, address user, uint256 amount, uint256 id)
        internal
        returns (bool ok, bytes memory out, ZapVm.Log[] memory logs)
    {
        bytes memory data = _roleCall(role, user, amount, id);
        vm.recordLogs();
        vm.prank(user);
        (ok, out) = address(zap).call{gas: ACTION_GAS}(data);
        logs = vm.getRecordedLogs();
    }

    // ============================================================= oracle

    function _tokens() internal view returns (address[5] memory) {
        return [address(usd), address(tkn), address(h), WETH, ETH];
    }

    /// The real balance: h's balanceOf may lie, heldBy never does.
    function _held(address token, address account) internal view returns (uint256) {
        if (token == ETH) return account.balance;
        if (token == address(h)) return h.heldBy(account);
        return TestToken(token).balanceOf(account);
    }

    function _books(address user) internal view returns (Books memory b) {
        address[5] memory tokens = _tokens();
        for (uint256 i; i < 5; ++i) {
            b.user[i] = _held(tokens[i], user);
            b.zap[i] = _held(tokens[i], address(zap));
            b.recipient[i] = _held(tokens[i], FEE_RECIPIENT);
            b.owed[i] = zap.owedFees(tokens[i]);
        }
    }

    function _word(address account) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }

    /// What the zap's events say happened to `token`: the user's net flow
    /// (refunds credited less h's tax on the zap's own payments, inputs
    /// debited, an exit's direct payout when `direct`), the fees charged and
    /// the part deferred.
    function _flows(ZapVm.Log[] memory logs, address token, address user, bool direct, uint256 taxBps)
        internal
        view
        returns (Flows memory f)
    {
        for (uint256 i; i < logs.length; ++i) {
            ZapVm.Log memory log = logs[i];
            if (log.emitter != address(zap) || log.topics.length == 0) continue;
            bytes32 topic = log.topics[0];
            if (topic == INPUT_PULLED) {
                if (log.topics[3] == _word(token) && log.topics[2] == _word(user)) {
                    f.user -= int256(abi.decode(log.data, (uint256)));
                }
            } else if (topic == REFUNDED) {
                if (log.topics[2] == _word(token) && log.topics[1] == _word(user)) {
                    uint256 amount = abi.decode(log.data, (uint256));
                    f.user += int256(amount - amount * taxBps / 10_000);
                }
            } else if (topic == FEE_CHARGED) {
                if (log.topics[2] == _word(token)) {
                    (uint256 amount,) = abi.decode(log.data, (uint256, bytes32));
                    f.charged += amount;
                }
            } else if (topic == FEE_DEFERRED) {
                if (log.topics[1] == _word(token)) {
                    (uint256 amount,) = abi.decode(log.data, (uint256, uint256));
                    f.deferred += amount;
                }
            } else if (direct && topic == LIQUIDITY_CHANGED) {
                (DominoV2Types.PoolRef memory pool,, int256 amount0, int256 amount1) =
                    abi.decode(log.data, (DominoV2Types.PoolRef, int256, int256, int256));
                if (pool.currency0 == token) f.user += amount0;
                if (pool.currency1 == token) f.user += amount1;
            }
        }
    }

    /// How far `a` exceeds `b`, or zero.
    function _gap(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    /// Settles a completed action against its events; returns the first rule
    /// broken, or "" when every token settled exactly:
    /// - the zap keeps nothing new: what it holds beyond its owed fees never grows;
    /// - owed fees never fall, grow by exactly FeeDeferred, and never lose
    ///   backing (a shortfall the action found, after a rebase, never grows);
    /// - the user's balance moves by exactly the refunds (less h's tax),
    ///   the inputs and an exit's direct payout;
    /// - the fee recipient gets FeeCharged less FeeDeferred (less h's tax);
    /// - no ERC-20 or Permit2 allowance from the zap survives.
    function _audit(Books memory before, address user, ZapVm.Log[] memory logs, bool direct)
        internal
        view
        returns (string memory)
    {
        Books memory current = _books(user);
        address[5] memory tokens = _tokens();
        for (uint256 i; i < 5; ++i) {
            uint256 taxBps = tokens[i] == address(h) && h.behaviour() == Behaviour.TAXED ? h.param() : 0;
            Flows memory f = _flows(logs, tokens[i], user, direct, taxBps);
            if (current.owed[i] < before.owed[i]) return "owed fees fell";
            if (_gap(current.owed[i], current.zap[i]) > _gap(before.owed[i], before.zap[i])) {
                return "owed fees lost backing";
            }
            if (_gap(current.zap[i], current.owed[i]) > _gap(before.zap[i], before.owed[i])) {
                return "the zap kept part of an action";
            }
            if (int256(current.user[i]) - int256(before.user[i]) != f.user) {
                return "the user's balance moved other than the events say";
            }
            if (current.owed[i] - before.owed[i] != f.deferred) return "owed fees grew other than FeeDeferred says";
            uint256 paid = f.charged - f.deferred;
            if (current.recipient[i] - before.recipient[i] != paid - paid * taxBps / 10_000) {
                return "the recipient got other than FeeCharged less FeeDeferred";
            }
        }
        if (!_noAllowanceSurvives()) return "an allowance from the zap survived";
        return "";
    }

    function _magnitude(int256 value) internal pure returns (uint256) {
        return value < 0 ? uint256(-value) : uint256(value);
    }

    /// The action's return value against its events: the fee it charged, and
    /// the main step's liquidity and amounts as magnitudes (for a direct exit,
    /// what the owner received, which the oracle measures).
    function _resultMatches(bytes memory out, ZapVm.Log[] memory logs) internal view returns (bool) {
        IDominoPositionActions.ActionResult memory r = abi.decode(out, (IDominoPositionActions.ActionResult));
        uint256 fee;
        int256 liquidity;
        int256 amount0;
        int256 amount1;
        bool stepped;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(zap) || logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] == FEE_CHARGED) {
                (uint256 amount,) = abi.decode(logs[i].data, (uint256, bytes32));
                fee += amount;
            } else if (logs[i].topics[0] == LIQUIDITY_CHANGED) {
                (, liquidity, amount0, amount1) =
                    abi.decode(logs[i].data, (DominoV2Types.PoolRef, int256, int256, int256));
                stepped = true;
            }
        }
        return r.feeAmount == fee
            && (!stepped
                || (r.liquidity == _magnitude(liquidity) && r.amount0 == _magnitude(amount0)
                    && r.amount1 == _magnitude(amount1)));
    }

    /// A refused action changed nothing anyone holds or is owed.
    function _untouched(Books memory before, address user) internal view returns (bool) {
        Books memory current = _books(user);
        return keccak256(abi.encode(current)) == keccak256(abi.encode(before));
    }

    function _noAllowanceSurvives() internal view returns (bool) {
        address[3] memory tokens = [address(usd), address(tkn), address(h)];
        for (uint256 t; t < 3; ++t) {
            if (TestToken(tokens[t]).allowance(address(zap), address(npm)) != 0) return false;
            if (TestToken(tokens[t]).allowance(address(zap), PERMIT2) != 0) return false;
            (uint160 amount,,) = IPermit2Views(PERMIT2).allowance(address(zap), tokens[t], address(router));
            if (amount != 0) return false;
        }
        return true;
    }

    // ============================================================= labels

    function _roleName(uint8 role) internal pure returns (string memory) {
        string[11] memory names = [
            "extra input",
            "pool currency, create",
            "pool currency, increase",
            "pool currency, exit",
            "pool currency, converted exit",
            "v3 leg input",
            "v3 leg output",
            "router leg input",
            "fee token, leg input",
            "fee token, leg output",
            "fee token, owed"
        ];
        return names[role];
    }

    /// A readable revert reason.
    function _why(bytes memory out) internal pure returns (string memory) {
        if (out.length < 4) return "no data (out of gas or a bare revert)";
        bytes4 selector = bytes4(out);
        if (selector == DominoTokenOps.TokenCallFailed.selector) return "TokenCallFailed";
        if (selector == IDominoPositionActions.SwapEffectMismatch.selector) return "SwapEffectMismatch";
        if (selector == IDominoPositionActions.InvalidPlan.selector) return "InvalidPlan";
        if (selector == DominoFeeLedger.FeeNotBacked.selector) return "FeeNotBacked";
        if (selector == DominoFeeLedger.FeeTransferMismatch.selector) return "FeeTransferMismatch";
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
