// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IUniswapV3PositionManagerMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {IV3PoolInitializerMinimal} from "../../../src/v2/positions/DominoV3Positions.sol";
import {DominoSwapExecutor} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {UniswapBase8453} from "../positions/fixtures/UniswapBase8453.sol";
import {V3SwapDriver} from "../positions/PositionTestKit.sol";
import {RobinhoodPermit2} from "../route/fixtures/RobinhoodPermit2.sol";
import {ScriptedRouter, scriptedCall} from "../route/RouteAdversaries.sol";
import {MockDominoRegistry, TestToken} from "../route/V2RouteTestKit.sol";
import {ZapBaseFixtures} from "../zap/ZapBaseFixtures.sol";
import {IPermit2Views, IPositionNft, IZap} from "../zap/ZapTestKit.sol";

/// Everyone who can touch the v3 zap, on the factory, NonfungiblePositionManager
/// and WETH9 deployed on Base, driven by the fuzzer:
/// - two users creating, increasing and exiting their own positions, with
///   direct v3 legs (usd -> tkn, w -> tkn, w -> usd) or none;
/// - a registered router running a random script (pulls more or less than the
///   leg, pulls by a backdoor, refunds, pays short or long, sends another
///   token, re-enters the zap);
/// - a leg whose input is a token the zap owes (the F-01 shape);
/// - traders moving the positions' pool;
/// - the fee recipient going dark per token and back, flushes, donations.
/// usd is the first charge currency, w the second; w legs that touch no usd
/// are charged in w, so w fees go owed while the recipient is dark in w.
contract ZapLedgerHandler is ZapBaseFixtures {
    string internal constant ZAP_ARTIFACT = "DominoZapV3.sol:DominoZapV3";
    bytes32 internal constant POOL_INIT_CODE_HASH = 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
    int24 internal constant LOWER = -600;
    int24 internal constant UPPER = 600;
    address internal constant FEE_RECIPIENT = address(0xFEE);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    MockDominoRegistry public registry;
    IZap public zap;
    IUniswapV3PositionManagerMinimal public npm = IUniswapV3PositionManagerMinimal(UniswapBase8453.V3_POSITION_MANAGER);
    ScriptedRouter public router;
    V3SwapDriver internal trader;
    TestToken public usd;
    TestToken public tkn;
    TestToken public w;
    DominoV2Types.PoolRef internal pool; // positions: usd/tkn 0.3%
    address public poolAddress;

    mapping(address => uint256[]) internal positionsOf;
    /// Everything sent to the zap outside an action, per token.
    mapping(address => uint256) public donated;

    // Rules broken inside one call; every invariant run expects zero.
    uint256 public owedLosses;
    uint256 public strayFlushes;

    // Successes per action.
    uint256 public creates;
    uint256 public swappedCreates;
    uint256 public increases;
    uint256 public exits;
    uint256 public scriptedSuccesses;
    uint256 public owedSpendAttempts;
    uint256 public flushes;

    constructor() {
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
        (usd, tkn, w) = (new TestToken(), new TestToken(), new TestToken());
        registry.setRank(address(usd), 1);
        registry.setRank(address(w), 2);
        trader = new V3SwapDriver();
        address[5] memory funded = [address(this), address(trader), ALICE, BOB, address(router)];
        for (uint256 i; i < funded.length; ++i) {
            usd.mint(funded[i], 1e30);
            tkn.mint(funded[i], 1e30);
            w.mint(funded[i], 1e30);
        }
        (address c0, address c1) = _sorted(address(usd), address(tkn));
        pool = DominoV2Types.PoolRef(DominoV2Types.DEX_V3, c0, c1, 3000, 60, address(0));
        poolAddress = _openPool(address(usd), address(tkn), 3000, 887220, 1e22);
        _openPool(address(usd), address(tkn), 500, 887270, 1e25);
        _openPool(address(w), address(tkn), 500, 887270, 1e25);
        _openPool(address(w), address(usd), 500, 887270, 1e25);
        address[2] memory users = [ALICE, BOB];
        for (uint256 i; i < users.length; ++i) {
            vm.startPrank(users[i]);
            usd.approve(address(zap), type(uint256).max);
            tkn.approve(address(zap), type(uint256).max);
            w.approve(address(zap), type(uint256).max);
            vm.stopPrank();
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

    // ============================================================== ghosts

    function trackedTokens() public view returns (address[4] memory) {
        return [address(usd), address(tkn), address(w), ETH];
    }

    /// Owed fees fall only through a flush.
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

    /// A direct v3 leg through the 0.05% pool of the pair (every pool starts
    /// at price one with deep liquidity; a leg needs a nonzero minimum).
    function _leg(address tokenIn, address tokenOut, uint128 amountIn) internal pure returns (DominoV2Types.SwapLeg memory) {
        return DominoV2Types.SwapLeg(
            DominoV2Types.LEG_V3_POOL,
            address(0),
            tokenIn,
            tokenOut,
            amountIn,
            amountIn * 98 / 100,
            abi.encodePacked(tokenIn, uint24(500), tokenOut)
        );
    }

    function _feeToken(DominoV2Types.SwapLeg[] memory legs) internal view returns (address) {
        if (legs.length == 0) return ETH;
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].tokenIn == address(usd) || legs[i].tokenOut == address(usd)) return address(usd);
        }
        return address(w);
    }

    function _create(address user, DominoV2Types.TokenAmount[] memory inputs, DominoV2Types.SwapLeg[] memory legs)
        internal
        returns (bool ok)
    {
        IDominoPositionActions.CreatePlan memory plan;
        plan.intent = _intent(DominoV2Types.ACTION_CREATE, pool, 0, LOWER, UPPER, 1, legs, _feeToken(legs), user, 0);
        (plan.inputs, plan.legs, plan.amount0Max, plan.amount1Max) = (inputs, legs, type(uint128).max, type(uint128).max);
        vm.prank(user);
        try zap.create(plan) returns (IDominoPositionActions.ActionResult memory r) {
            positionsOf[user].push(r.tokenId);
            ok = true;
        } catch {}
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

    // =============================================================== users

    /// A position from both tokens, or from usd or w alone with a leg to tkn.
    function create(uint256 seed, uint256 amount, uint8 shape) external observed(false) {
        address user = _user(seed);
        amount = 1e15 + amount % 1e21;
        DominoV2Types.TokenAmount[] memory inputs;
        DominoV2Types.SwapLeg[] memory legs;
        shape %= 3;
        if (shape == 0) {
            inputs = _pair(address(usd), amount, address(tkn), amount);
            legs = _noLegs();
        } else {
            address from = shape == 1 ? address(usd) : address(w);
            inputs = shape == 1 ? _inputs(address(usd), uint128(amount)) : _pair(address(w), amount, address(usd), amount / 2);
            legs = _oneLeg(_leg(from, address(tkn), uint128(amount / 2)));
        }
        if (_create(user, inputs, legs)) {
            ++creates;
            if (legs.length != 0) ++swappedCreates;
        }
    }

    function increase(uint256 seed, uint256 amount, bool swap) external observed(false) {
        address user = _user(seed);
        uint256[] storage owned = positionsOf[user];
        if (owned.length == 0) return;
        uint256 id = owned[seed % owned.length];
        amount = 1e15 + amount % 1e21;
        IDominoPositionActions.IncreasePlan memory plan;
        DominoV2Types.SwapLeg[] memory legs = swap ? _oneLeg(_leg(address(usd), address(tkn), uint128(amount / 2))) : _noLegs();
        plan.intent = _intent(DominoV2Types.ACTION_INCREASE, pool, id, LOWER, UPPER, 1, legs, _feeToken(legs), user, 0);
        (plan.inputs, plan.legs, plan.amount0Max, plan.amount1Max) = (
            swap ? _inputs(address(usd), uint128(amount)) : _pair(address(usd), amount, address(tkn), amount),
            legs,
            type(uint128).max,
            type(uint128).max
        );
        vm.prank(user);
        try zap.increase(plan) {
            ++increases;
        } catch {}
    }

    /// Some or all of a position, to both tokens; a full exit burns the NFT.
    function exit(uint256 seed, uint256 share, bool full) external observed(false) {
        address user = _user(seed);
        uint256[] storage owned = positionsOf[user];
        if (owned.length == 0) return;
        uint256 index = seed % owned.length;
        uint256 id = owned[index];
        (,,,,,,, uint128 liquidity,,,,) = npm.positions(id);
        if (liquidity == 0) return;
        uint128 remove = full ? liquidity : uint128(1 + share % liquidity);
        vm.prank(user);
        IPositionNft(address(npm)).approve(address(zap), id);
        IDominoPositionActions.ExitPlan memory plan;
        plan.intent = _intent(DominoV2Types.ACTION_EXIT, pool, id, LOWER, UPPER, 0, _noLegs(), ETH, user, 0);
        (plan.liquidityToRemove, plan.legs, plan.burn) = (remove, _noLegs(), full);
        vm.prank(user);
        try zap.exit(plan) {
            ++exits;
            if (full) {
                owned[index] = owned[owned.length - 1];
                owned.pop();
            }
        } catch {}
    }

    // ========================================================== adversaries

    /// A usd -> tkn leg through the registered router, which runs a script
    /// built from the seed: most scripts must be refused, and none may leave
    /// the zap holding anything but owed fees.
    function scriptedLeg(uint256 seed, uint256 amount) external observed(false) {
        address user = _user(seed);
        amount = 1e15 + amount % 1e20;
        ScriptedRouter.Script memory script;
        (script.tokenIn, script.tokenOut) = (address(usd), address(tkn));
        uint256 r = uint256(keccak256(abi.encode(seed)));
        // Honest pull and pay, then up to five deviations.
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
                DominoV2Types.LEG_UNIVERSAL_ROUTER,
                address(router),
                address(usd),
                address(tkn),
                uint128(amount),
                uint128(amount / 2),
                scriptedCall(script)
            )
        );
        if (_create(user, _inputs(address(usd), uint128(amount * 2)), legs)) {
            ++scriptedSuccesses;
            // The router's own tokens in a token outside the action stay in
            // the zap: a gift, no user's money, counted as a donation.
            if (script.extraToken == address(w)) donated[address(w)] += script.extraAmount;
        }
    }

    /// The F-01 shape: a create whose only input is usd but whose leg spends
    /// w, which the zap may be holding as owed fees.
    function legSpendsOwedW(uint256 seed, uint256 amount) external observed(false) {
        uint256 owed = zap.owedFees(address(w));
        if (owed == 0) return;
        ++owedSpendAttempts;
        amount = 1 + amount % owed;
        DominoV2Types.SwapLeg[] memory legs = new DominoV2Types.SwapLeg[](2);
        legs[0] = _leg(address(w), address(usd), uint128(amount));
        legs[1] = _leg(address(usd), address(tkn), uint128(1e15));
        _create(_user(seed), _inputs(address(usd), uint128(1e18)), legs);
    }

    function traderSwaps(bool zeroForOne, uint256 amount) external observed(false) {
        trader.swap(poolAddress, zeroForOne, 1e15 + amount % 1e21);
    }

    // ===================================================== recipient, others

    function recipientGoesDark(uint256 seed, bool dark) external observed(false) {
        TestToken[3] memory tokens = [usd, tkn, w];
        tokens[seed % 3].setBlocked(FEE_RECIPIENT, dark);
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
        TestToken[3] memory tokens = [usd, tkn, w];
        tokens[seed % 3].mint(address(zap), amount);
        donated[address(tokens[seed % 3])] += amount;
    }

    // ================================================================ reads

    function positionCount(address user) external view returns (uint256) {
        return positionsOf[user].length;
    }
}

/// The zap's ledger under every sequence the handler can produce:
/// - I2: in every token, the zap holds at least what it owes the fee
///   recipient, and owed fees fall only through a flush, which pays them;
/// - the zap keeps nothing of an action's: whatever it holds beyond its owed
///   fees came from donations (or a router's gift in a token outside the
///   action, which no user paid);
/// - no allowance from the zap to the position manager, Permit2 or the router
///   (nor Permit2's own to the router) survives an action, and the zap holds
///   no position.
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 64
contract DominoV2ZapLedgerInvariantsTest {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    ZapLedgerHandler internal handler;

    function setUp() public {
        handler = new ZapLedgerHandler();
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory targets) {
        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = ZapLedgerHandler.create.selector;
        selectors[1] = ZapLedgerHandler.increase.selector;
        selectors[2] = ZapLedgerHandler.exit.selector;
        selectors[3] = ZapLedgerHandler.scriptedLeg.selector;
        selectors[4] = ZapLedgerHandler.legSpendsOwedW.selector;
        selectors[5] = ZapLedgerHandler.traderSwaps.selector;
        selectors[6] = ZapLedgerHandler.recipientGoesDark.selector;
        selectors[7] = ZapLedgerHandler.flush.selector;
        selectors[8] = ZapLedgerHandler.donate.selector;
        selectors[9] = ZapLedgerHandler.create.selector;
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    /// A scripted pass through every action, each succeeding at least once.
    function testTheHandlerReachesEveryAction() public {
        handler.create(0, 5e18, 0);
        handler.create(1, 5e18, 1);
        handler.recipientGoesDark(2, true);
        handler.create(0, 4e18, 2);
        require(IZapView(address(handler.zap())).owedFees(address(handler.w())) > 0, "no w fee went owed");
        handler.legSpendsOwedW(0, 7);
        handler.traderSwaps(true, 3e19);
        handler.increase(0, 1e18, true);
        handler.exit(1, 0, false);
        handler.exit(0, 0, true);
        handler.recipientGoesDark(2, false);
        handler.flush(2);
        handler.scriptedLeg(3, 1e18);
        handler.donate(1, 1000);
        require(handler.creates() >= 3 && handler.swappedCreates() >= 2, "creates never reached the zap");
        require(handler.increases() == 1 && handler.exits() == 2, "increase or exit never reached the zap");
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
            uint256 owed = zap.owedFees(tokens[i]);
            require(held - owed <= handler.donated(tokens[i]), "the zap kept part of an action");
        }
    }

    function invariant_noAllowanceOrPositionSurvives() public view {
        address zap = address(handler.zap());
        address[3] memory spenders = [address(handler.npm()), 0x000000000022D473030F116dDEE9F6B43aC78BA3, address(handler.router())];
        address[3] memory tokens = [address(handler.usd()), address(handler.tkn()), address(handler.w())];
        for (uint256 t; t < 3; ++t) {
            for (uint256 s; s < 3; ++s) {
                require(TestToken(tokens[t]).allowance(zap, spenders[s]) == 0, "an allowance survived");
            }
            (uint160 amount,,) = IPermit2Views(spenders[1]).allowance(zap, tokens[t], address(handler.router()));
            require(amount == 0, "a Permit2 allowance to the router survived");
        }
        require(IBalanceOf(address(handler.npm())).balanceOf(zap) == 0, "the zap holds a position");
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
