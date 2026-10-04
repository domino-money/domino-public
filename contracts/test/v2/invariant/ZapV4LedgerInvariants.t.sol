// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IV4PoolManagerMinimal, IV4PositionManagerMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {DominoSwapExecutor} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {UniswapBase8453} from "../positions/fixtures/UniswapBase8453.sol";
import {V4SwapDriver} from "../positions/PositionTestKit.sol";
import {RobinhoodPermit2} from "../route/fixtures/RobinhoodPermit2.sol";
import {ScriptedRouter, scriptedCall} from "../route/RouteAdversaries.sol";
import {
    IV4PoolManagerTest,
    MockDominoRegistry,
    RejectingRecipient,
    TestToken,
    V4LiquidityHelper
} from "../route/V2RouteTestKit.sol";
import {ZapBaseFixtures} from "../zap/ZapBaseFixtures.sol";
import {IPermit2Views, IPositionNft, IZap} from "../zap/ZapTestKit.sol";

/// Everyone who can touch the v4 zap (where F-01 was found), on the
/// PoolManager and PositionManager bytecode deployed on Base, driven by the
/// fuzzer:
/// - two users creating (both tokens; usd alone with a leg; w with a leg
///   charged in w; native ETH with usd), increasing, changing range and
///   exiting their own positions, with v4 pool legs;
/// - a registered router running a random script;
/// - a leg whose input is w the zap owes (the F-01 shape);
/// - traders moving the positions' pool;
/// - the fee recipient going dark per token, or refusing native currency;
/// - flushes and donations, native included.
/// usd ranks first and ETH second; w is no charge currency, so a route with w
/// alone pays its fee in w (the fallback).
contract ZapV4LedgerHandler is ZapBaseFixtures {
    string internal constant ZAP_ARTIFACT = "DominoZapV4.sol:DominoZapV4";
    string internal constant STEPS_ARTIFACT = "DominoZapV4Steps.sol:DominoZapV4Steps";
    int24 internal constant LOWER = -600;
    int24 internal constant UPPER = 600;
    int24 internal constant FULL = 887220;
    address internal constant FEE_RECIPIENT = address(0xFEE);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    address public manager = UniswapBase8453.V4_POOL_MANAGER;
    address public positions = UniswapBase8453.V4_POSITION_MANAGER;
    MockDominoRegistry public registry;
    IZap public zap;
    ScriptedRouter public router;
    RejectingRecipient internal rejecting;
    V4SwapDriver internal trader;
    TestToken public usd;
    TestToken public tkn;
    TestToken public w;
    DominoV2Types.PoolRef internal pool; // positions: usd/tkn 0.3%
    DominoV2Types.PoolRef internal nativePool; // positions: ETH/usd 0.05%
    DominoV2Types.PoolRef internal swapPool; // legs: usd/tkn 0.05%
    DominoV2Types.PoolRef internal wTkn; // legs: w/tkn 0.05%
    DominoV2Types.PoolRef internal wUsd; // legs: w/usd 0.05%

    mapping(address => uint256[]) internal positionsOf;
    /// Each tracked position's upper tick; ranges are symmetric (600 or 1200).
    mapping(uint256 => int24) internal upperOf;
    mapping(address => uint256) public donated;

    uint256 public owedLosses;
    uint256 public strayFlushes;

    uint256 public creates;
    uint256 public swappedCreates;
    uint256 public nativeCreates;
    uint256 public increases;
    uint256 public ranges;
    uint256 public exits;
    uint256 public owedSpendAttempts;
    uint256 public flushes;

    constructor() {
        vm.warp(NOW);
        vm.etch(PERMIT2, RobinhoodPermit2.RUNTIME);
        _installBaseV4();
        registry = new MockDominoRegistry();
        registry.setFeeRecipient(FEE_RECIPIENT);
        address steps = _deploy(vm.getCode(STEPS_ARTIFACT));
        zap = IZap(
            _deploy(
                abi.encodePacked(
                    vm.getCode(ZAP_ARTIFACT),
                    abi.encode(
                        DominoSwapExecutor.RouteConfig(IDominoRegistry(address(registry)), PERMIT2, address(0), bytes32(0), manager),
                        positions,
                        steps
                    )
                )
            )
        );
        router = new ScriptedRouter(PERMIT2);
        registry.setRouter(address(router), 212);
        rejecting = new RejectingRecipient();
        (usd, tkn, w) = (new TestToken(), new TestToken(), new TestToken());
        registry.setRank(address(usd), 1);
        registry.setRank(ETH, 2);
        V4LiquidityHelper liquidity = new V4LiquidityHelper(manager);
        trader = new V4SwapDriver(IV4PoolManagerMinimal(manager));
        address[5] memory funded = [address(liquidity), address(trader), ALICE, BOB, address(router)];
        for (uint256 i; i < funded.length; ++i) {
            usd.mint(funded[i], 1e30);
            tkn.mint(funded[i], 1e30);
            w.mint(funded[i], 1e30);
            vm.deal(funded[i], 1e27);
        }
        (address c0, address c1) = _sorted(address(usd), address(tkn));
        pool = DominoV2Types.PoolRef(DominoV2Types.DEX_V4, c0, c1, 3000, 60, address(0));
        swapPool = DominoV2Types.PoolRef(DominoV2Types.DEX_V4, c0, c1, 500, 10, address(0));
        nativePool = DominoV2Types.PoolRef(DominoV2Types.DEX_V4, ETH, address(usd), 500, 10, address(0));
        (c0, c1) = _sorted(address(w), address(tkn));
        wTkn = DominoV2Types.PoolRef(DominoV2Types.DEX_V4, c0, c1, 500, 10, address(0));
        (c0, c1) = _sorted(address(w), address(usd));
        wUsd = DominoV2Types.PoolRef(DominoV2Types.DEX_V4, c0, c1, 500, 10, address(0));
        DominoV2Types.PoolRef[5] memory opened = [pool, swapPool, nativePool, wTkn, wUsd];
        for (uint256 i; i < opened.length; ++i) {
            IV4PoolManagerTest(manager).initialize(_key(opened[i]), PRICE_ONE);
            liquidity.add(_key(opened[i]), -FULL, FULL, i == 0 || i == 2 ? int256(1e22) : int256(1e25));
        }
        address[2] memory users = [ALICE, BOB];
        for (uint256 i; i < users.length; ++i) {
            vm.startPrank(users[i]);
            usd.approve(address(zap), type(uint256).max);
            tkn.approve(address(zap), type(uint256).max);
            w.approve(address(zap), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _key(DominoV2Types.PoolRef memory ref) internal pure returns (IV4PoolManagerMinimal.PoolKey memory) {
        return IV4PoolManagerMinimal.PoolKey(ref.currency0, ref.currency1, ref.fee, ref.tickSpacing, ref.hooks);
    }

    // ============================================================== ghosts

    function trackedTokens() public view returns (address[4] memory) {
        return [address(usd), address(tkn), address(w), ETH];
    }

    modifier observed(bool flushing) {
        address[4] memory tokens = trackedTokens();
        uint256[4] memory owed;
        for (uint256 i; i < 4; ++i) {
            owed[i] = zap.owedFees(tokens[i]);
        }
        _;
        for (uint256 i; i < 4; ++i) {
            if (!flushing && zap.owedFees(tokens[i]) < owed[i]) ++owedLosses;
        }
    }

    function _user(uint256 seed) internal pure returns (address) {
        return seed % 2 == 0 ? ALICE : BOB;
    }

    function _leg(DominoV2Types.PoolRef memory ref, address tokenIn, address tokenOut, uint128 amountIn)
        internal
        pure
        returns (DominoV2Types.SwapLeg memory)
    {
        DominoV2Types.PoolRef[] memory path = new DominoV2Types.PoolRef[](1);
        path[0] = ref;
        return DominoV2Types.SwapLeg(
            DominoV2Types.LEG_V4_POOL, address(0), tokenIn, tokenOut, amountIn, amountIn * 97 / 100, abi.encode(path)
        );
    }

    function _pair(address a, uint256 amountA, address b, uint256 amountB)
        internal
        pure
        returns (DominoV2Types.TokenAmount[] memory inputs)
    {
        inputs = new DominoV2Types.TokenAmount[](2);
        inputs[0] = DominoV2Types.TokenAmount(a, uint128(amountA));
        inputs[1] = DominoV2Types.TokenAmount(b, uint128(amountB));
    }

    /// The charge-currency rule for the routes this handler builds: usd if a
    /// leg touches it, else ETH if a leg touches it, else the first input (w).
    function _feeToken(DominoV2Types.SwapLeg[] memory legs) internal view returns (address) {
        if (legs.length == 0) return ETH;
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].tokenIn == address(usd) || legs[i].tokenOut == address(usd)) return address(usd);
        }
        return legs[0].tokenIn;
    }

    function _create(
        address user,
        DominoV2Types.PoolRef memory ref,
        DominoV2Types.TokenAmount[] memory inputs,
        DominoV2Types.SwapLeg[] memory legs,
        uint256 value
    ) internal returns (bool ok) {
        IDominoPositionActions.CreatePlan memory plan;
        plan.intent = _intent(DominoV2Types.ACTION_CREATE, ref, 0, LOWER, UPPER, 1, legs, _feeToken(legs), user, 0);
        (plan.inputs, plan.legs, plan.amount0Max, plan.amount1Max) = (inputs, legs, type(uint128).max, type(uint128).max);
        vm.prank(user);
        try zap.create{value: value}(plan) returns (IDominoPositionActions.ActionResult memory r) {
            if (ref.currency0 == pool.currency0 && ref.currency1 == pool.currency1 && ref.fee == pool.fee) {
                positionsOf[user].push(r.tokenId);
                upperOf[r.tokenId] = UPPER;
            }
            ok = true;
        } catch {}
    }

    // =============================================================== users

    function create(uint256 seed, uint256 amount, uint8 shape) external observed(false) {
        address user = _user(seed);
        amount = 1e15 + amount % 1e21;
        shape %= 4;
        bool ok;
        if (shape == 0) {
            ok = _create(user, pool, _pair(address(usd), amount, address(tkn), amount), _noLegs(), 0);
        } else if (shape == 1) {
            ok = _create(
                user, pool, _inputs(address(usd), uint128(amount)), _oneLeg(_leg(swapPool, address(usd), address(tkn), uint128(amount / 2))), 0
            );
            if (ok) ++swappedCreates;
        } else if (shape == 2) {
            ok = _create(
                user,
                pool,
                _pair(address(w), amount, address(usd), amount / 2),
                _oneLeg(_leg(wTkn, address(w), address(tkn), uint128(amount / 2))),
                0
            );
            if (ok) ++swappedCreates;
        } else {
            ok = _create(user, nativePool, _pair(ETH, amount, address(usd), amount), _noLegs(), amount);
            if (ok) ++nativeCreates;
        }
        if (ok) ++creates;
    }

    function _owned(uint256 seed)
        internal
        view
        returns (address user, uint256 index, uint256 id, uint128 liquidity, int24 upper)
    {
        user = _user(seed);
        uint256[] storage owned = positionsOf[user];
        if (owned.length == 0) return (user, 0, 0, 0, 0);
        index = seed % owned.length;
        id = owned[index];
        liquidity = IV4PositionManagerMinimal(positions).getPositionLiquidity(id);
        upper = upperOf[id];
    }

    function increase(uint256 seed, uint256 amount) external observed(false) {
        (address user,, uint256 id, uint128 liquidity, int24 upper) = _owned(seed);
        if (liquidity == 0) return;
        amount = 1e15 + amount % 1e21;
        vm.prank(user);
        IPositionNft(positions).approve(address(zap), id);
        DominoV2Types.SwapLeg[] memory legs = _oneLeg(_leg(swapPool, address(usd), address(tkn), uint128(amount / 2)));
        IDominoPositionActions.IncreasePlan memory plan;
        plan.intent = _intent(DominoV2Types.ACTION_INCREASE, pool, id, -upper, upper, 1, legs, address(usd), user, 0);
        (plan.inputs, plan.legs, plan.amount0Max, plan.amount1Max) =
            (_inputs(address(usd), uint128(amount)), legs, type(uint128).max, type(uint128).max);
        vm.prank(user);
        try zap.increase(plan) {
            ++increases;
        } catch {}
    }

    /// To the other width: 600 <-> 1200 ticks each side.
    function changeRange(uint256 seed) external observed(false) {
        (address user, uint256 index, uint256 id, uint128 liquidity, int24 upper) = _owned(seed);
        if (liquidity == 0) return;
        int24 next = upper == UPPER ? int24(1200) : UPPER;
        vm.prank(user);
        IPositionNft(positions).approve(address(zap), id);
        IDominoPositionActions.ChangeRangePlan memory plan;
        plan.intent = _intent(DominoV2Types.ACTION_CHANGE_RANGE, pool, id, -next, next, 1, _noLegs(), ETH, user, 0);
        (plan.liquidityToRemove, plan.burnOld, plan.amount0Max, plan.amount1Max) =
            (liquidity, true, type(uint128).max, type(uint128).max);
        vm.prank(user);
        try zap.changeRange(plan) returns (IDominoPositionActions.ActionResult memory r) {
            ++ranges;
            positionsOf[user][index] = r.tokenId;
            upperOf[r.tokenId] = next;
        } catch {}
    }

    function exit(uint256 seed, uint256 share, bool full) external observed(false) {
        (address user, uint256 index, uint256 id, uint128 liquidity, int24 upper) = _owned(seed);
        if (liquidity == 0) return;
        uint128 remove = full ? liquidity : uint128(1 + share % liquidity);
        vm.prank(user);
        IPositionNft(positions).approve(address(zap), id);
        IDominoPositionActions.ExitPlan memory plan;
        plan.intent = _intent(DominoV2Types.ACTION_EXIT, pool, id, -upper, upper, 0, _noLegs(), ETH, user, 0);
        (plan.liquidityToRemove, plan.legs, plan.burn) = (remove, _noLegs(), full);
        vm.prank(user);
        try zap.exit(plan) {
            ++exits;
            if (full) {
                uint256[] storage owned = positionsOf[user];
                owned[index] = owned[owned.length - 1];
                owned.pop();
            }
        } catch {}
    }

    // ========================================================== adversaries

    function scriptedLeg(uint256 seed, uint256 amount) external observed(false) {
        address user = _user(seed);
        amount = 1e15 + amount % 1e20;
        ScriptedRouter.Script memory script;
        (script.tokenIn, script.tokenOut) = (address(usd), address(tkn));
        uint256 r = uint256(keccak256(abi.encode(seed, "v4")));
        script.pull = r % 4 == 0 ? amount + 1 + (r >> 8) % amount : r % 4 == 1 ? amount - 1 - (r >> 8) % (amount - 1) : amount;
        if ((r >> 16) % 5 == 0) script.backdoorPull = 1 + (r >> 24) % amount;
        if ((r >> 32) % 5 == 0) script.refundIn = 1 + (r >> 40) % amount;
        script.pay = (r >> 48) % 3 == 0 ? amount / 2 : amount;
        if ((r >> 56) % 4 == 0) {
            address[3] memory extras = [address(w), address(usd), address(tkn)];
            (script.extraToken, script.extraAmount) = (extras[(r >> 64) % 3], 1 + (r >> 72) % amount);
        }
        if ((r >> 80) % 6 == 0) {
            (script.callTarget, script.callData) = (address(zap), abi.encodeCall(IZap.flushOwedFees, (address(w))));
        }
        DominoV2Types.SwapLeg[] memory legs = _oneLeg(
            DominoV2Types.SwapLeg(
                DominoV2Types.LEG_UNIVERSAL_ROUTER, address(router), address(usd), address(tkn), uint128(amount), uint128(amount / 2),
                scriptedCall(script)
            )
        );
        if (_create(user, pool, _inputs(address(usd), uint128(amount * 2)), legs, 0)) {
            if (script.extraToken == address(w)) donated[address(w)] += script.extraAmount;
        }
    }

    /// The F-01 shape: a leg whose input is w the zap may owe.
    function legSpendsOwedW(uint256 seed, uint256 amount) external observed(false) {
        uint256 owed = zap.owedFees(address(w));
        if (owed == 0) return;
        ++owedSpendAttempts;
        amount = 1 + amount % owed;
        _create(
            _user(seed),
            pool,
            _pair(address(usd), 1e18, address(tkn), 1e18),
            _oneLeg(_leg(wUsd, address(w), address(usd), uint128(amount))),
            0
        );
    }

    function traderSwaps(bool zeroForOne, uint256 amount) external observed(false) {
        trader.swap(_key(pool), zeroForOne, 1e15 + amount % 1e21);
    }

    // ===================================================== recipient, others

    /// Blocks the recipient in one token, or (seed 3) points the registry at a
    /// recipient that refuses native currency.
    function recipientGoesDark(uint256 seed, bool dark) external observed(false) {
        uint256 pick = seed % 4;
        if (pick == 3) {
            registry.setFeeRecipient(dark ? address(rejecting) : FEE_RECIPIENT);
            return;
        }
        TestToken[3] memory tokens = [usd, tkn, w];
        tokens[pick].setBlocked(FEE_RECIPIENT, dark);
    }

    function flush(uint256 seed) external observed(true) {
        address token = trackedTokens()[seed % 4];
        uint256 owed = zap.owedFees(token);
        try zap.flushOwedFees(token) returns (uint256 amount) {
            if (amount != 0) ++flushes;
            if (amount != owed || zap.owedFees(token) != 0) ++strayFlushes;
        } catch {
            if (zap.owedFees(token) != owed) ++owedLosses;
        }
    }

    function donate(uint256 seed, uint256 amount) external observed(false) {
        amount %= 1e21;
        address token = trackedTokens()[seed % 4];
        if (token == ETH) vm.deal(address(zap), address(zap).balance + amount);
        else TestToken(token).mint(address(zap), amount);
        donated[token] += amount;
    }
}

/// The v4 zap's ledger under every sequence the handler can produce: owed
/// fees backed and falling only by a flush (I2), nothing of an action kept
/// beyond donations, native currency included, and no allowance (ERC20 or
/// Permit2) or position left with the zap.
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 64
contract DominoV2ZapV4LedgerInvariantsTest {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    ZapV4LedgerHandler internal handler;

    function setUp() public {
        handler = new ZapV4LedgerHandler();
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory targets) {
        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = ZapV4LedgerHandler.create.selector;
        selectors[1] = ZapV4LedgerHandler.increase.selector;
        selectors[2] = ZapV4LedgerHandler.changeRange.selector;
        selectors[3] = ZapV4LedgerHandler.exit.selector;
        selectors[4] = ZapV4LedgerHandler.scriptedLeg.selector;
        selectors[5] = ZapV4LedgerHandler.legSpendsOwedW.selector;
        selectors[6] = ZapV4LedgerHandler.traderSwaps.selector;
        selectors[7] = ZapV4LedgerHandler.recipientGoesDark.selector;
        selectors[8] = ZapV4LedgerHandler.flush.selector;
        selectors[9] = ZapV4LedgerHandler.donate.selector;
        selectors[10] = ZapV4LedgerHandler.create.selector;
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    function testTheHandlerReachesEveryAction() public {
        handler.create(0, 5e18, 0);
        handler.create(1, 5e18, 1);
        handler.create(0, 3e18, 3);
        handler.recipientGoesDark(2, true);
        handler.create(0, 4e18, 2);
        require(IZapView(address(handler.zap())).owedFees(address(handler.w())) > 0, "no w fee went owed");
        handler.legSpendsOwedW(0, 7);
        handler.traderSwaps(true, 3e19);
        handler.increase(0, 1e18);
        handler.changeRange(1);
        handler.exit(1, 0, false);
        handler.exit(0, 0, true);
        handler.recipientGoesDark(2, false);
        handler.flush(2);
        handler.scriptedLeg(3, 1e18);
        handler.donate(3, 1000);
        require(handler.creates() >= 4 && handler.swappedCreates() >= 2 && handler.nativeCreates() == 1, "creates");
        require(handler.increases() == 1 && handler.ranges() == 1 && handler.exits() == 2, "increase, range or exit");
        require(handler.owedSpendAttempts() == 1 && handler.flushes() == 1, "the owed-fee paths never ran");
        invariant_everyOwedFeeIsBackedAndFallsOnlyByAFlush();
        invariant_theZapKeepsNothingOfAnAction();
        invariant_noAllowanceOrPositionSurvives();
    }

    function invariant_everyOwedFeeIsBackedAndFallsOnlyByAFlush() public view {
        IZapView zap = IZapView(address(handler.zap()));
        address[4] memory tokens = handler.trackedTokens();
        for (uint256 i; i < 4; ++i) {
            require(_balance(tokens[i], address(zap)) >= zap.owedFees(tokens[i]), "an owed fee is not backed");
        }
        require(handler.owedLosses() == 0 && handler.strayFlushes() == 0, "owed fees fell without a flush");
    }

    function invariant_theZapKeepsNothingOfAnAction() public view {
        IZapView zap = IZapView(address(handler.zap()));
        address[4] memory tokens = handler.trackedTokens();
        for (uint256 i; i < 4; ++i) {
            uint256 held = _balance(tokens[i], address(zap));
            require(held - zap.owedFees(tokens[i]) <= handler.donated(tokens[i]), "the zap kept part of an action");
        }
    }

    function invariant_noAllowanceOrPositionSurvives() public view {
        address zap = address(handler.zap());
        address[4] memory spenders =
            [handler.positions(), handler.manager(), 0x000000000022D473030F116dDEE9F6B43aC78BA3, address(handler.router())];
        address[3] memory tokens = [address(handler.usd()), address(handler.tkn()), address(handler.w())];
        for (uint256 t; t < 3; ++t) {
            for (uint256 s; s < 4; ++s) {
                require(TestToken(tokens[t]).allowance(zap, spenders[s]) == 0, "an allowance survived");
            }
            for (uint256 s; s < 4; ++s) {
                (uint160 amount,,) = IPermit2Views(spenders[2]).allowance(zap, tokens[t], spenders[s]);
                require(amount == 0, "a Permit2 allowance survived");
            }
        }
        require(IBalanceOf(handler.positions()).balanceOf(zap) == 0, "the zap holds a position");
    }

    function _balance(address token, address account) internal view returns (uint256) {
        return token == address(0) ? account.balance : TestToken(token).balanceOf(account);
    }
}

interface IZapView {
    function owedFees(address token) external view returns (uint256);
}

interface IBalanceOf {
    function balanceOf(address owner) external view returns (uint256);
}
