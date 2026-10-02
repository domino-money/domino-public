// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IPermit2Signature} from "../../../src/v2/external/IPermit2Signature.sol";
import {IV4PoolManagerMinimal, IV4PositionManagerMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {IDominoZap} from "../../../src/v2/interfaces/IDominoZap.sol";
import {DominoPositionMath} from "../../../src/v2/positions/DominoPositionMath.sol";
import {DominoV4Positions} from "../../../src/v2/positions/DominoV4Positions.sol";
import {DominoActionLock} from "../../../src/v2/route/DominoActionLock.sol";
import {DominoSwapExecutor} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {DominoZapV4} from "../../../src/v2/zap/DominoZapV4.sol";
import {DominoZapV4Steps} from "../../../src/v2/zap/DominoZapV4Steps.sol";
import {V4SwapDriver} from "../positions/PositionTestKit.sol";
import {RobinhoodPermit2} from "../route/fixtures/RobinhoodPermit2.sol";
import {
    IV4PoolManagerTest,
    MockDominoRegistry,
    ReenteringRecipient,
    RejectingRecipient,
    TestToken,
    V4LiquidityHelper
} from "../route/V2RouteTestKit.sol";
import {IPermit2Views, IPositionNft, IZap, ZapTestBase, ZapVm} from "./ZapTestKit.sol";

/// A v4 hook (afterSwap only) that calls the zap back in the middle of a swap
/// leg and records whether the zap refused it.
contract ReentrantSwapHook {
    address internal immutable ZAP;
    bool public refused;
    uint256 public calls;

    constructor(address zap) {
        ZAP = zap;
    }

    function afterSwap(
        address,
        IV4PoolManagerMinimal.PoolKey calldata,
        IV4PoolManagerMinimal.SwapParams calldata,
        int256,
        bytes calldata
    ) external returns (bytes4, int128) {
        (bool ok, bytes memory out) = ZAP.call(abi.encodeWithSignature("invalidateNonces(uint256,uint256)", 0, 1));
        refused = !ok && out.length >= 4 && bytes4(out) == DominoActionLock.ReentrantCall.selector;
        ++calls;
        return (this.afterSwap.selector, 0);
    }
}

/// @notice The v4 zap's four flows and their guards against a real
/// PoolManager and PositionManager. ZapV4Deployed.t.sol runs it on the Base
/// bytecode (the build Robinhood and Arbitrum run), ZapV4Vendored.t.sol on the
/// vendored v4 sources. Swap legs are direct v4 pool legs (F1b).
abstract contract ZapV4Behaviour is ZapTestBase {
    string internal constant ZAP_ARTIFACT = "DominoZapV4.sol:DominoZapV4";
    string internal constant STEPS_ARTIFACT = "DominoZapV4Steps.sol:DominoZapV4Steps";
    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant BOB_KEY = 0xB0B;
    int24 internal constant LOWER = -600;
    int24 internal constant UPPER = 600;
    int24 internal constant FULL = 887220;
    bytes4 internal constant NOT_APPROVED = bytes4(keccak256("NotApproved(address)"));
    bytes4 internal constant INVALID_SIGNER = bytes4(keccak256("InvalidSigner()"));
    bytes4 internal constant INVALID_NONCE = bytes4(keccak256("InvalidNonce()"));
    bytes4 internal constant SIGNATURE_EXPIRED = bytes4(keccak256("SignatureExpired(uint256)"));

    address internal manager;
    address internal positions;
    MockDominoRegistry internal registry;
    IZap internal zap;
    address internal steps;
    TestToken internal usd; // the chain's rank-1 charge currency (USDG / USDC)
    TestToken internal tkn; // not a charge currency
    V4SwapDriver internal trader;
    address internal owner;
    address internal bob;
    address internal feeRecipient = address(0xFEE);
    DominoV2Types.PoolRef internal pool; // positions: usd/tkn 0.3%
    DominoV2Types.PoolRef internal nativePool; // positions: ETH/usd 0.05%
    DominoV2Types.PoolRef internal swapPool; // legs: usd/tkn 0.05%, deep
    DominoV2Types.PoolRef internal nativeSwapPool; // legs: ETH/usd 0.3%, deep

    /// The PoolManager (owned by this test) and the PositionManager under test.
    function _deployStack() internal virtual returns (address manager_, address positions_);

    function setUp() public {
        vm.warp(NOW);
        vm.etch(PERMIT2, RobinhoodPermit2.RUNTIME);
        (manager, positions) = _deployStack();
        registry = new MockDominoRegistry();
        registry.setFeeRecipient(feeRecipient);
        steps = _deploy(vm.getCode(STEPS_ARTIFACT));
        zap = IZap(_deployZap(manager, positions, steps));
        (usd, tkn) = (new TestToken(), new TestToken());
        registry.setRank(address(usd), 1);
        registry.setRank(ETH, 2);
        (owner, bob) = (vm.addr(OWNER_KEY), vm.addr(BOB_KEY));

        V4LiquidityHelper liquidity = new V4LiquidityHelper(manager);
        trader = new V4SwapDriver(IV4PoolManagerMinimal(manager));
        address[4] memory funded = [address(liquidity), address(trader), owner, bob];
        for (uint256 i; i < funded.length; ++i) {
            usd.mint(funded[i], 1e30);
            tkn.mint(funded[i], 1e30);
            vm.deal(funded[i], 1e27);
        }
        (address c0, address c1) = _sorted(address(usd), address(tkn));
        pool = DominoV2Types.PoolRef(DominoV2Types.DEX_V4, c0, c1, 3000, 60, address(0));
        swapPool = DominoV2Types.PoolRef(DominoV2Types.DEX_V4, c0, c1, 500, 10, address(0));
        nativePool = DominoV2Types.PoolRef(DominoV2Types.DEX_V4, ETH, address(usd), 500, 10, address(0));
        nativeSwapPool = DominoV2Types.PoolRef(DominoV2Types.DEX_V4, ETH, address(usd), 3000, 60, address(0));
        _openPool(liquidity, pool, 1e22);
        _openPool(liquidity, swapPool, 1e25);
        _openPool(liquidity, nativePool, 1e22);
        _openPool(liquidity, nativeSwapPool, 1e25);
        _allowZap(owner);
        _allowZap(bob);
    }

    function _deployZap(address manager_, address positions_, address steps_) internal returns (address) {
        return _deploy(
            abi.encodePacked(
                vm.getCode(ZAP_ARTIFACT),
                abi.encode(
                    DominoSwapExecutor.RouteConfig(
                        IDominoRegistry(address(registry)), PERMIT2, address(0), bytes32(0), manager_
                    ),
                    positions_,
                    steps_
                )
            )
        );
    }

    function _key(DominoV2Types.PoolRef memory ref) internal pure returns (IV4PoolManagerMinimal.PoolKey memory) {
        return IV4PoolManagerMinimal.PoolKey(ref.currency0, ref.currency1, ref.fee, ref.tickSpacing, ref.hooks);
    }

    function _openPool(V4LiquidityHelper liquidity, DominoV2Types.PoolRef memory ref, int256 amount) internal {
        IV4PoolManagerTest(manager).initialize(_key(ref), PRICE_ONE);
        liquidity.add(_key(ref), -FULL, FULL, amount);
    }

    function _allowZap(address account) internal {
        vm.startPrank(account);
        usd.approve(address(zap), type(uint256).max);
        tkn.approve(address(zap), type(uint256).max);
        usd.approve(PERMIT2, type(uint256).max);
        tkn.approve(PERMIT2, type(uint256).max);
        vm.stopPrank();
    }

    /// An exact-input v4 leg through the deep swap pool of the pair.
    function _leg(address tokenIn, address tokenOut, uint128 amountIn, uint128 minOut)
        internal
        view
        returns (DominoV2Types.SwapLeg memory)
    {
        DominoV2Types.PoolRef[] memory path = new DominoV2Types.PoolRef[](1);
        path[0] = tokenIn == ETH || tokenOut == ETH ? nativeSwapPool : swapPool;
        return DominoV2Types.SwapLeg(
            DominoV2Types.LEG_V4_POOL, address(0), tokenIn, tokenOut, amountIn, minOut, abi.encode(path)
        );
    }

    function _price(DominoV2Types.PoolRef memory ref) internal view returns (uint160 price) {
        (price,,,) = DominoV4Positions.slot0(IV4PoolManagerMinimal(manager), ref);
    }

    function _liquidityFor(DominoV2Types.PoolRef memory ref, int24 lower, int24 upper, uint256 a0, uint256 a1)
        internal
        view
        returns (uint128)
    {
        return DominoPositionMath.liquidityForAmounts(_price(ref), lower, upper, a0, a1);
    }

    function _positionLiquidity(uint256 id) internal view returns (uint128) {
        return IV4PositionManagerMinimal(positions).getPositionLiquidity(id);
    }

    function _managers() internal view returns (DominoV4Positions.Managers memory) {
        return DominoV4Positions.Managers(IV4PoolManagerMinimal(manager), IV4PositionManagerMinimal(positions));
    }

    /// Nothing stays in the zap but owed fees, and the zap leaves no allowance.
    function _assertZapEmpty() internal view {
        address[3] memory tokens = [address(usd), address(tkn), ETH];
        for (uint256 i; i < tokens.length; ++i) {
            _eq(_balance(tokens[i], address(zap)), zap.owedFees(tokens[i]), "zap holds only owed fees");
        }
        address[3] memory spenders = [PERMIT2, positions, manager];
        for (uint256 i; i < spenders.length; ++i) {
            _eq(_allowance(address(usd), address(zap), spenders[i]), 0, "no usd allowance survives");
            _eq(_allowance(address(tkn), address(zap), spenders[i]), 0, "no tkn allowance survives");
        }
    }

    // ---------------------------------------------------------- plans

    function _createPlan(
        DominoV2Types.PoolRef memory ref,
        DominoV2Types.TokenAmount[] memory inputs,
        DominoV2Types.SwapLeg[] memory legs,
        address feeToken,
        uint128 minLiquidity,
        address recipient,
        uint256 nonce
    ) internal pure returns (IDominoPositionActions.CreatePlan memory plan) {
        plan.intent = _intent(
            DominoV2Types.ACTION_CREATE, ref, 0, LOWER, UPPER, minLiquidity, legs, feeToken, recipient, nonce
        );
        (plan.inputs, plan.legs, plan.amount0Max, plan.amount1Max) =
            (inputs, legs, type(uint128).max, type(uint128).max);
    }

    /// USDG only, half swapped to the other token: the TSLA/MANY-style create.
    function _createFromUsd(uint128 amount, address recipient, uint256 nonce)
        internal
        view
        returns (IDominoPositionActions.CreatePlan memory)
    {
        uint128 half = amount / 2;
        return _createPlan(
            pool,
            _inputs(address(usd), amount),
            _oneLeg(_leg(address(usd), address(tkn), half, half * 99 / 100)),
            address(usd),
            _liquidityFor(pool, LOWER, UPPER, uint256(half) * 98 / 100, uint256(half) * 98 / 100),
            recipient,
            nonce
        );
    }

    /// Both tokens, no swap: a plain mint for `who`.
    function _mintFor(address who, uint128 amount) internal returns (uint256 id) {
        DominoV2Types.TokenAmount[] memory inputs = new DominoV2Types.TokenAmount[](2);
        inputs[0] = DominoV2Types.TokenAmount(address(usd), amount);
        inputs[1] = DominoV2Types.TokenAmount(address(tkn), amount);
        vm.prank(who);
        id = zap.create(_createPlan(pool, inputs, _noLegs(), ETH, 1, who, 0)).tokenId;
    }

    function _approveZapOn(address who, uint256 id) internal {
        vm.prank(who);
        IPositionNft(positions).approve(address(zap), id);
    }

    function _increasePlan(uint256 id, uint128 amount, address recipient, uint256 nonce)
        internal
        view
        returns (IDominoPositionActions.IncreasePlan memory plan)
    {
        uint128 half = amount / 2;
        DominoV2Types.SwapLeg[] memory legs = _oneLeg(_leg(address(usd), address(tkn), half, half * 99 / 100));
        plan.intent = _intent(
            DominoV2Types.ACTION_INCREASE,
            pool,
            id,
            LOWER,
            UPPER,
            _liquidityFor(pool, LOWER, UPPER, uint256(half) * 98 / 100, uint256(half) * 98 / 100),
            legs,
            address(usd),
            recipient,
            nonce
        );
        (plan.inputs, plan.legs, plan.amount0Max, plan.amount1Max) =
            (_inputs(address(usd), amount), legs, type(uint128).max, type(uint128).max);
    }

    /// An exit of a position in `pool` (range LOWER..UPPER) to the owner.
    function _exitPlan(uint256 id, uint128 liquidity, DominoV2Types.SwapLeg[] memory legs, address feeToken, bool burn)
        internal
        view
        returns (IDominoPositionActions.ExitPlan memory plan)
    {
        plan.intent = _intent(DominoV2Types.ACTION_EXIT, pool, id, LOWER, UPPER, 0, legs, feeToken, owner, 0);
        (plan.liquidityToRemove, plan.legs, plan.burn) = (liquidity, legs, burn);
    }

    function _changePlan(uint256 id, uint128 liquidity, int24 lower, int24 upper, address recipient)
        internal
        view
        returns (IDominoPositionActions.ChangeRangePlan memory plan)
    {
        plan.intent = _intent(
            DominoV2Types.ACTION_CHANGE_RANGE, pool, id, lower, upper, 1, _noLegs(), ETH, recipient, 0
        );
        (plan.liquidityToRemove, plan.burnOld, plan.amount0Max, plan.amount1Max) =
            (liquidity, true, type(uint128).max, type(uint128).max);
    }

    function _withPermit(IDominoPositionActions.CreatePlan memory plan, uint256 key)
        internal
        view
        returns (IPermit2Signature.PermitBatchTransferFrom memory permit, bytes memory signature)
    {
        permit = _permit(plan.inputs, plan.intent.nonce, DEADLINE);
        signature = _signature(key, _permitDigest(permit, address(zap), plan.intent));
    }

    // ================================================================ create

    function testCreateFromOneTokenSwapsChargesAndRefundsEverything() public {
        IDominoPositionActions.CreatePlan memory plan = _createFromUsd(100e18, owner, 0);
        (uint256 usd0, uint256 tkn0) = (usd.balanceOf(owner), tkn.balanceOf(owner));
        vm.recordLogs();
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.create(plan);
        ZapVm.Log[] memory logs = vm.getRecordedLogs();

        _check(IPositionNft(positions).ownerOf(r.tokenId) == owner, "the NFT is the owner's");
        _check(r.liquidity >= plan.intent.minLiquidity && r.liquidity == _positionLiquidity(r.tokenId), "liquidity");
        _eq(r.feeAmount, 50e18 * 65 / 10_000, "65 bps of the swapped amount");
        _check(r.feeToken == address(usd), "fee in the charge currency");
        _eq(usd.balanceOf(feeRecipient), r.feeAmount, "fee paid at once");
        _assertZapEmpty();

        // Debits and credits close: what left the owner is the swap input, the
        // fee and what the position took; everything else came back.
        uint256 refundUsd = usd.balanceOf(owner) + 100e18 - usd0;
        uint256 refundTkn = tkn.balanceOf(owner) - tkn0;
        (uint256 paidUsd, uint256 paidTkn) = pool.currency0 == address(usd) ? (r.amount0, r.amount1) : (r.amount1, r.amount0);
        _eq(100e18 - 50e18 - r.feeAmount - paidUsd, refundUsd, "usd refunded");
        ZapVm.Log memory leg = _first(logs, address(zap), LEG_EXECUTED);
        (,, uint256 legOut) = abi.decode(leg.data, (address, uint256, uint256));
        _eq(legOut - paidTkn, refundTkn, "tkn refunded");

        // The receipt: input, leg, fee, position step, refunds, action.
        bytes32 ref = _intentHash(address(zap), plan.intent);
        _eq(_count(logs, address(zap), INPUT_PULLED), 1, "InputPulled");
        _eq(_count(logs, address(zap), FEE_CHARGED), 1, "FeeCharged");
        _eq(_count(logs, address(zap), LIQUIDITY_CHANGED), 1, "PositionLiquidityChanged");
        _eq(_count(logs, address(zap), REFUNDED), (refundUsd == 0 ? 0 : 1) + (refundTkn == 0 ? 0 : 1), "Refunded");
        ZapVm.Log memory charged = _first(logs, address(zap), FEE_CHARGED);
        (, bytes32 chargedRef) = abi.decode(charged.data, (uint256, bytes32));
        _check(chargedRef == ref && charged.topics[3] == bytes32(uint256(uint160(owner))), "fee ref and payer");
        ZapVm.Log memory executed = _first(logs, address(zap), ACTION_EXECUTED);
        _check(
            executed.topics[1] == bytes32(uint256(DominoV2Types.ACTION_CREATE))
                && executed.topics[2] == bytes32(uint256(uint160(owner)))
                && executed.topics[3] == bytes32(r.tokenId),
            "PositionActionExecuted topics"
        );
        (uint256 previous, uint128 liquidity, bytes32 executedRef) = abi.decode(executed.data, (uint256, uint128, bytes32));
        _check(previous == 0 && liquidity == r.liquidity && executedRef == ref, "PositionActionExecuted data");
        ZapVm.Log memory step = _first(logs, address(zap), LIQUIDITY_CHANGED);
        (DominoV2Types.PoolRef memory stepPool, int256 delta, int256 amount0, int256 amount1) =
            abi.decode(step.data, (DominoV2Types.PoolRef, int256, int256, int256));
        _check(
            step.topics[1] == ref && step.topics[2] == bytes32(uint256(uint160(owner)))
                && step.topics[3] == bytes32(r.tokenId) && DominoV2Types.hashPoolRef(stepPool) == DominoV2Types.hashPoolRef(pool)
                && delta == int256(uint256(r.liquidity)) && amount0 == -int256(r.amount0) && amount1 == -int256(r.amount1),
            "PositionLiquidityChanged"
        );
    }

    function testCreateWithPermitNeedsOneSignatureAndNoAllowanceToTheZap() public {
        address signer = vm.addr(0xC0FFEE);
        usd.mint(signer, 100e18);
        vm.prank(signer);
        usd.approve(PERMIT2, type(uint256).max); // the one-time Permit2 approval wallets already have
        IDominoPositionActions.CreatePlan memory plan = _createFromUsd(100e18, signer, 1234);
        (IPermit2Signature.PermitBatchTransferFrom memory permit, bytes memory signature) = _withPermit(plan, 0xC0FFEE);

        vm.prank(bob); // anyone may submit it; everything goes to the signer
        IDominoPositionActions.ActionResult memory r = zap.createWithPermit(plan, permit, signature);
        _check(IPositionNft(positions).ownerOf(r.tokenId) == signer, "the NFT is the signer's");
        _check(usd.balanceOf(bob) == 1e30 && tkn.balanceOf(bob) == 1e30, "the submitter gets nothing");
        _check(IPermit2Views(PERMIT2).nonceBitmap(signer, 1234 >> 8) & (1 << (1234 & 0xff)) != 0, "Permit2 nonce used");
        _eq(_allowance(address(usd), signer, address(zap)), 0, "no allowance to the zap was needed");
        _assertZapEmpty();
    }

    function testCreateWithNativeEthOnANativePool() public {
        DominoV2Types.TokenAmount[] memory inputs = _inputs(ETH, 10e18);
        DominoV2Types.SwapLeg[] memory legs = _oneLeg(_leg(ETH, address(usd), 5e18, 4.9e18));
        // ETH (rank 2) in, USDG (rank 1) out: the better rank wins, so USDG pays.
        IDominoPositionActions.CreatePlan memory plan = _createPlan(
            nativePool, inputs, legs, address(usd), _liquidityFor(nativePool, LOWER, UPPER, 4.9e18, 4.9e18), owner, 0
        );
        uint256 eth0 = owner.balance;
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.create{value: 10e18}(plan);
        _check(IPositionNft(positions).ownerOf(r.tokenId) == owner, "owner");
        _check(r.feeToken == address(usd) && usd.balanceOf(feeRecipient) == r.feeAmount && r.feeAmount > 0, "fee in USDG");
        _eq(eth0 - owner.balance, 5e18 + r.amount0, "ETH: the leg and what the position took; the rest refunded");
        _assertZapEmpty();
    }

    function testCreateRefusesNativeValueThatIsNotTheNativeInput() public {
        IDominoPositionActions.CreatePlan memory plan = _createFromUsd(100e18, owner, 0);
        vm.prank(owner);
        vm.expectRevert(IDominoPositionActions.InvalidPlan.selector);
        zap.create{value: 1}(plan);

        DominoV2Types.TokenAmount[] memory inputs = _inputs(ETH, 2e18);
        plan = _createPlan(nativePool, inputs, _noLegs(), ETH, 1, owner, 0);
        vm.prank(owner);
        vm.expectRevert(IDominoPositionActions.InvalidPlan.selector);
        zap.create{value: 1e18}(plan);
    }

    function testCreateInitializesAPoolOnlyIfItHasNoPrice() public {
        (address c0, address c1) = _sorted(address(usd), address(tkn));
        DominoV2Types.PoolRef memory fresh = DominoV2Types.PoolRef(DominoV2Types.DEX_V4, c0, c1, 10_000, 200, address(0));
        DominoV2Types.TokenAmount[] memory inputs = new DominoV2Types.TokenAmount[](2);
        inputs[0] = DominoV2Types.TokenAmount(address(usd), 10e18);
        inputs[1] = DominoV2Types.TokenAmount(address(tkn), 10e18);
        IDominoPositionActions.CreatePlan memory plan = _createPlan(fresh, inputs, _noLegs(), ETH, 0, owner, 0);
        (plan.intent.tickLower, plan.intent.tickUpper) = (-2000, 2000);
        plan.intent.minLiquidity = DominoPositionMath.liquidityForAmounts(PRICE_ONE, -2000, 2000, 9.9e18, 9.9e18);
        plan.initSqrtPriceX96 = PRICE_ONE;

        // Someone initializes first at a far price (#282 A11): the plan's
        // minimum liquidity refuses the mint instead of minting one-sided.
        uint256 snapshot = vm.snapshotState();
        IV4PoolManagerTest(manager).initialize(_key(fresh), PRICE_ONE * 4);
        vm.prank(owner);
        vm.expectPartialRevert(DominoV4Positions.InsufficientLiquidity.selector);
        zap.create(plan);
        vm.revertToState(snapshot);

        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.create(plan);
        _eq(_price(fresh), PRICE_ONE, "initialized at the plan's price");
        _check(r.liquidity >= plan.intent.minLiquidity, "minted");
        _assertZapEmpty();
    }

    function testCreateAtTheSlippageLimitAndJustBeyond() public {
        IDominoPositionActions.CreatePlan memory plan = _createFromUsd(100e18, owner, 0);
        uint256 snapshot = vm.snapshotState();
        vm.prank(owner);
        uint128 achieved = zap.create(plan).liquidity;
        vm.revertToState(snapshot);

        plan.intent.minLiquidity = achieved; // exactly what the pool gives
        vm.prank(owner);
        _eq(zap.create(plan).liquidity, achieved, "the exact minimum passes");
        vm.revertToState(snapshot);

        plan.intent.minLiquidity = achieved + 1;
        vm.prank(owner);
        vm.expectPartialRevert(DominoV4Positions.InsufficientLiquidity.selector);
        zap.create(plan);
    }

    function testCreateCapsAddAtMostThePlansAmounts() public {
        DominoV2Types.TokenAmount[] memory inputs = new DominoV2Types.TokenAmount[](2);
        inputs[0] = DominoV2Types.TokenAmount(address(usd), 10e18);
        inputs[1] = DominoV2Types.TokenAmount(address(tkn), 10e18);
        IDominoPositionActions.CreatePlan memory plan = _createPlan(pool, inputs, _noLegs(), ETH, 1, owner, 0);
        (plan.amount0Max, plan.amount1Max) = (4e18, 4e18);
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.create(plan);
        _check(r.amount0 <= 4e18 && r.amount1 <= 4e18, "within the caps");
        _check(r.amount0 > 3.9e18 || r.amount1 > 3.9e18, "a cap binds");
        _assertZapEmpty();
    }

    // ============================================================== increase

    function testIncreaseWithSwapForwardsTheOwnersAccruedFees() public {
        uint256 id = _mintFor(owner, 50e18);
        trader.swap(_key(pool), true, 5e20);
        trader.swap(_key(pool), false, 5e20);
        (uint256 fees0, uint256 fees1) = DominoV4Positions.collectable(_managers(), id);
        _check(fees0 > 0 && fees1 > 0, "fees accrued");
        _approveZapOn(owner, id);

        IDominoPositionActions.IncreasePlan memory plan = _increasePlan(id, 20e18, owner, 0);
        uint160 price = _price(pool);
        (uint256 usd0, uint256 tkn0) = (usd.balanceOf(owner), tkn.balanceOf(owner));
        uint128 before = _positionLiquidity(id);
        vm.recordLogs();
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.increase(plan);
        ZapVm.Log[] memory logs = vm.getRecordedLogs();

        _eq(_positionLiquidity(id), before + r.liquidity, "liquidity added");
        (uint256 after0, uint256 after1) = DominoV4Positions.collectable(_managers(), id);
        _check(after0 == 0 && after1 == 0, "the fees left the position");
        (uint256 principal0, uint256 principal1) =
            DominoPositionMath.amountsForLiquidity(price, LOWER, UPPER, r.liquidity, true);
        (,, uint256 legOut) = abi.decode(_first(logs, address(zap), LEG_EXECUTED).data, (address, uint256, uint256));
        // Every unit the zap held came back to the owner, the fees included.
        (uint256 feesUsd, uint256 feesTkn, uint256 principalUsd, uint256 principalTkn) = pool.currency0 == address(usd)
            ? (fees0, fees1, principal0, principal1)
            : (fees1, fees0, principal1, principal0);
        _eq(usd.balanceOf(owner) + 10e18 + r.feeAmount + principalUsd, usd0 + feesUsd, "usd: fees forwarded");
        _eq(tkn.balanceOf(owner), tkn0 + legOut - principalTkn + feesTkn, "tkn: fees forwarded");
        _assertZapEmpty();
    }

    function testIncreaseWithPermit() public {
        uint256 id = _mintFor(owner, 50e18);
        _approveZapOn(owner, id);
        IDominoPositionActions.IncreasePlan memory plan = _increasePlan(id, 20e18, owner, 77);
        IPermit2Signature.PermitBatchTransferFrom memory permit = _permit(plan.inputs, 77, DEADLINE);
        bytes memory signature = _signature(OWNER_KEY, _permitDigest(permit, address(zap), plan.intent));
        vm.prank(owner);
        usd.approve(address(zap), 0);
        uint128 before = _positionLiquidity(id);
        vm.prank(bob);
        IDominoPositionActions.ActionResult memory r = zap.increaseWithPermit(plan, permit, signature);
        _eq(_positionLiquidity(id), before + r.liquidity, "added");
        _assertZapEmpty();
    }

    function testIncreaseNeedsTheZapApprovedOnTheNft() public {
        uint256 id = _mintFor(owner, 50e18);
        IDominoPositionActions.IncreasePlan memory plan = _increasePlan(id, 20e18, owner, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(NOT_APPROVED, address(zap)));
        zap.increase(plan);
    }

    // ===================================================== lingering approval

    /// The owner's approval of the zap outlives every action and the zap
    /// cannot clear it: nobody but the owner can act through it.
    function testNobodyButTheOwnerCanUseTheLingeringApproval() public {
        uint256 id = _mintFor(owner, 50e18);
        _approveZapOn(owner, id);
        IDominoPositionActions.IncreasePlan memory own = _increasePlan(id, 2e18, owner, 0);
        vm.prank(owner);
        zap.increase(own);
        _check(IPositionNft(positions).getApproved(id) == address(zap), "the approval lingers");
        uint128 liquidity = _positionLiquidity(id);

        // Plain calls from Bob, with Bob as recipient.
        IDominoPositionActions.ExitPlan memory exitPlan = _exitPlan(id, liquidity, _noLegs(), ETH, true);
        exitPlan.intent.recipient = bob;
        vm.prank(bob);
        vm.expectRevert(IDominoPositionActions.Unauthorized.selector);
        zap.exit(exitPlan);
        IDominoPositionActions.ChangeRangePlan memory change = _changePlan(id, liquidity, -1200, 1200, bob);
        vm.prank(bob);
        vm.expectRevert(IDominoPositionActions.Unauthorized.selector);
        zap.changeRange(change);
        own = _increasePlan(id, 2e18, bob, 0);
        vm.prank(bob);
        vm.expectRevert(IDominoPositionActions.Unauthorized.selector);
        zap.increase(own);

        // Bob's own Permit2 signature names Bob, not the owner.
        IDominoPositionActions.IncreasePlan memory increasePlan = _increasePlan(id, 2e18, bob, 5);
        IPermit2Signature.PermitBatchTransferFrom memory permit = _permit(increasePlan.inputs, 5, DEADLINE);
        bytes memory signature = _signature(BOB_KEY, _permitDigest(permit, address(zap), increasePlan.intent));
        vm.expectRevert(IDominoPositionActions.Unauthorized.selector);
        zap.increaseWithPermit(increasePlan, permit, signature);

        // Bob's relayed signature is not the owner's.
        exitPlan.intent.nonce = 9;
        vm.expectRevert(IDominoZap.InvalidSignature.selector);
        zap.exitWithSignature(exitPlan, _signature(BOB_KEY, _relayedDigest(address(zap), _relayedExit(exitPlan))));
        vm.expectRevert(IDominoZap.InvalidSignature.selector);
        zap.changeRangeWithSignature(change, _signature(BOB_KEY, _relayedDigest(address(zap), _relayedChange(change))));
        _eq(_positionLiquidity(id), liquidity, "untouched");
    }

    // ========================================================== change range

    function testChangeRangeWithdrawsSwapsAndMintsTheNewRangeToTheOwner() public {
        uint256 id = _mintFor(owner, 50e18);
        trader.swap(_key(pool), true, 5e19);
        trader.swap(_key(pool), false, 5e19);
        _approveZapOn(owner, id);
        uint128 liquidity = _positionLiquidity(id);
        IDominoPositionActions.ChangeRangePlan memory plan = _changePlan(id, liquidity, -1200, 1200, owner);
        // Rebalance on the way: part of the withdrawn USDG becomes the other token.
        DominoV2Types.SwapLeg[] memory legs = _oneLeg(_leg(address(usd), address(tkn), 1e18, 0.98e18));
        (plan.legs, plan.intent.routesHash, plan.intent.feeBps, plan.intent.feeToken) =
            (legs, _routesHash(legs), DominoV2Types.FEE_ASSISTED_SWAP_BPS, address(usd));
        vm.recordLogs();
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.changeRange(plan);
        ZapVm.Log[] memory logs = vm.getRecordedLogs();

        _check(r.tokenId != id && IPositionNft(positions).ownerOf(r.tokenId) == owner, "new NFT to the owner");
        (bool exists,) = positions.staticcall(abi.encodeCall(IPositionNft.ownerOf, (id)));
        _check(!exists, "the old NFT is burned");
        _eq(_count(logs, address(zap), LIQUIDITY_CHANGED), 2, "two position steps");
        ZapVm.Log memory executed = _first(logs, address(zap), ACTION_EXECUTED);
        (uint256 previous,,) = abi.decode(executed.data, (uint256, uint128, bytes32));
        _eq(previous, id, "previousTokenId");
        _check(r.feeAmount > 0 && r.feeToken == address(usd), "the conversion pays 65 bps");
        _assertZapEmpty();
    }

    function testChangeRangeRelayedWithTheOwnersSignature() public {
        uint256 id = _mintFor(owner, 50e18);
        _approveZapOn(owner, id);
        IDominoPositionActions.ChangeRangePlan memory plan =
            _changePlan(id, _positionLiquidity(id), -1200, 1200, owner);
        (plan.intent.nonce, plan.burnOld) = (42, false); // the emptied NFT stays, so a replay reaches the nonce
        bytes memory signature = _signature(OWNER_KEY, _relayedDigest(address(zap), _relayedChange(plan)));

        // A relayer must not loosen what the owner signed.
        plan.amount0MinRemoved = 1;
        vm.prank(bob);
        vm.expectRevert(IDominoZap.InvalidSignature.selector);
        zap.changeRangeWithSignature(plan, signature);
        plan.amount0MinRemoved = 0;

        vm.prank(bob);
        IDominoPositionActions.ActionResult memory r = zap.changeRangeWithSignature(plan, signature);
        _check(IPositionNft(positions).ownerOf(r.tokenId) == owner, "new NFT to the owner");
        _check(zap.nonceBitmap(owner, 0) & (1 << 42) != 0, "nonce used");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IDominoZap.NonceUsed.selector, owner, uint256(42)));
        zap.changeRangeWithSignature(plan, signature);
        _assertZapEmpty();
    }

    // ================================================================= exit

    function testExitToBothTokensPaysTheOwnerDirectly() public {
        uint256 id = _mintFor(owner, 50e18);
        _approveZapOn(owner, id);
        IDominoPositionActions.ExitPlan memory plan = _exitPlan(id, _positionLiquidity(id), _noLegs(), ETH, true);
        (plan.amount0MinRemoved, plan.amount1MinRemoved) = (49e18, 49e18);
        (uint256 usd0, uint256 tkn0) = (usd.balanceOf(owner), tkn.balanceOf(owner));
        vm.recordLogs();
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.exit(plan);
        (uint256 gotUsd, uint256 gotTkn) = pool.currency0 == address(usd) ? (r.amount0, r.amount1) : (r.amount1, r.amount0);
        _eq(usd.balanceOf(owner) - usd0, gotUsd, "usd delivered");
        _eq(tkn.balanceOf(owner) - tkn0, gotTkn, "tkn delivered");
        _check(r.feeAmount == 0 && r.feeToken == ETH, "no swap, no fee");
        ZapVm.Log[] memory logs = vm.getRecordedLogs();
        (, int256 delta, int256 amount0, int256 amount1) = abi.decode(
            _first(logs, address(zap), LIQUIDITY_CHANGED).data, (DominoV2Types.PoolRef, int256, int256, int256)
        );
        _check(
            delta == -int256(uint256(plan.liquidityToRemove)) && amount0 == int256(r.amount0)
                && amount1 == int256(r.amount1),
            "the removal's receipt"
        );
        _eq(_count(logs, address(zap), REFUNDED), 0, "nothing passed through the zap");
        _assertZapEmpty();
    }

    function testExitMinimaAreTheOwners() public {
        uint256 id = _mintFor(owner, 50e18);
        _approveZapOn(owner, id);
        IDominoPositionActions.ExitPlan memory plan = _exitPlan(id, _positionLiquidity(id), _noLegs(), ETH, true);
        (plan.amount0MinRemoved, plan.amount1MinRemoved) = (51e18, 0);
        vm.prank(owner);
        vm.expectRevert();
        zap.exit(plan);
    }

    function testExitWithConversionDeliversOneTokenAndChargesTheOutput() public {
        uint256 id = _mintFor(owner, 50e18);
        _approveZapOn(owner, id);
        DominoV2Types.SwapLeg[] memory legs = _oneLeg(_leg(address(tkn), address(usd), 49e18, 48e18));
        IDominoPositionActions.ExitPlan memory plan = _exitPlan(id, _positionLiquidity(id), legs, address(usd), true);
        uint256 usd0 = usd.balanceOf(owner);
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.exit(plan);
        _check(r.feeToken == address(usd) && r.feeAmount > 48e18 * 65 / 10_000, "65 bps of the converted output");
        _check(usd.balanceOf(owner) - usd0 > 97e18, "the owner holds USDG");
        _assertZapEmpty();
    }

    function testExitRelayedAndCollectOnly() public {
        uint256 id = _mintFor(owner, 50e18);
        trader.swap(_key(pool), true, 5e19);
        trader.swap(_key(pool), false, 5e19);
        _approveZapOn(owner, id);
        // Collect only: no liquidity removed, the fees go to the owner.
        IDominoPositionActions.ExitPlan memory plan = _exitPlan(id, 0, _noLegs(), ETH, false);
        plan.intent.nonce = 3;
        bytes memory signature = _signature(OWNER_KEY, _relayedDigest(address(zap), _relayedExit(plan)));
        (uint256 fees0, uint256 fees1) = DominoV4Positions.collectable(_managers(), id);
        uint128 liquidity = _positionLiquidity(id);
        vm.prank(bob);
        IDominoPositionActions.ActionResult memory r = zap.exitWithSignature(plan, signature);
        _check(r.amount0 == fees0 && r.amount1 == fees1 && fees0 + fees1 > 0, "fees collected");
        _eq(_positionLiquidity(id), liquidity, "liquidity kept");
        _assertZapEmpty();
    }

    function testExitBurnNeedsTheWholeLiquidity() public {
        uint256 id = _mintFor(owner, 50e18);
        _approveZapOn(owner, id);
        IDominoPositionActions.ExitPlan memory plan = _exitPlan(id, _positionLiquidity(id) - 1, _noLegs(), ETH, true);
        vm.prank(owner);
        vm.expectPartialRevert(DominoV4Positions.PartialBurn.selector);
        zap.exit(plan);
    }

    function testExitRemovesAtLeastTheIntentsMinimumLiquidity() public {
        uint256 id = _mintFor(owner, 50e18);
        _approveZapOn(owner, id);
        IDominoPositionActions.ExitPlan memory plan = _exitPlan(id, 10, _noLegs(), ETH, false);
        plan.intent.minLiquidity = 11;
        vm.prank(owner);
        vm.expectRevert(IDominoPositionActions.InsufficientLiquidity.selector);
        zap.exit(plan);
    }

    // ============================================================ the intent

    function testTheIntentBindsThePlan() public {
        IDominoPositionActions.CreatePlan memory plan = _createFromUsd(100e18, owner, 0);
        bytes4 invalid = IDominoPositionActions.InvalidPlan.selector;

        plan.intent.action = DominoV2Types.ACTION_INCREASE;
        _expectCreateRevert(plan, invalid, "wrong action");
        plan.intent.action = DominoV2Types.ACTION_CREATE;

        plan.intent.deadline = uint64(block.timestamp - 1);
        _expectCreateRevert(plan, IDominoPositionActions.PlanExpired.selector, "expired");
        plan.intent.deadline = uint64(block.timestamp); // the last valid second
        uint256 snapshot = vm.snapshotState();
        vm.prank(owner);
        zap.create(plan);
        vm.revertToState(snapshot);
        plan.intent.deadline = DEADLINE;

        plan.intent.routesHash = bytes32(uint256(plan.intent.routesHash) ^ 1);
        _expectCreateRevert(plan, invalid, "routes hash");
        plan.intent.routesHash = _routesHash(plan.legs);

        plan.legs[0].minAmountOut -= 1; // a leg changed after the owner saw it
        _expectCreateRevert(plan, invalid, "leg changed");
        plan.legs[0].minAmountOut += 1;

        plan.intent.recipient = address(0);
        _expectCreateRevert(plan, invalid, "no recipient");
        plan.intent.recipient = address(zap);
        _expectCreateRevert(plan, invalid, "the zap as recipient");
        plan.intent.recipient = owner;

        plan.intent.tokenId = 7;
        _expectCreateRevert(plan, invalid, "create names no token");
        plan.intent.tokenId = 0;

        plan.intent.pool.dex = DominoV2Types.DEX_V3;
        _expectCreateRevert(plan, invalid, "a v3 pool on the v4 zap");
        plan.intent.pool.dex = DominoV2Types.DEX_V4;

        plan.intent.feeBps = 64;
        _expectCreateRevert(plan, IDominoPositionActions.FeeMismatch.selector, "fee bps");
        plan.intent.feeBps = DominoV2Types.FEE_ASSISTED_SWAP_BPS;
        plan.intent.feeToken = address(tkn);
        _expectCreateRevert(plan, IDominoPositionActions.FeeMismatch.selector, "fee token");
        plan.intent.feeToken = address(usd);

        // No swap, no fee: terms on a swapless plan are refused too.
        DominoV2Types.TokenAmount[] memory inputs = new DominoV2Types.TokenAmount[](2);
        inputs[0] = DominoV2Types.TokenAmount(address(usd), 1e18);
        inputs[1] = DominoV2Types.TokenAmount(address(tkn), 1e18);
        IDominoPositionActions.CreatePlan memory swapless = _createPlan(pool, inputs, _noLegs(), ETH, 1, owner, 0);
        swapless.intent.feeBps = DominoV2Types.FEE_ASSISTED_SWAP_BPS;
        _expectCreateRevert(swapless, IDominoPositionActions.FeeMismatch.selector, "fee without swap");
    }

    function testIncreaseAndExitNameThePositionsRange() public {
        uint256 id = _mintFor(owner, 50e18);
        _approveZapOn(owner, id);
        IDominoPositionActions.IncreasePlan memory plan = _increasePlan(id, 2e18, owner, 0);
        plan.intent.tickUpper = UPPER + 60;
        vm.prank(owner);
        vm.expectRevert(IDominoPositionActions.InvalidPlan.selector);
        zap.increase(plan);
        plan.intent.tickUpper = UPPER;
        plan.intent.tickLower = LOWER - 60;
        vm.prank(owner);
        vm.expectRevert(IDominoPositionActions.InvalidPlan.selector);
        zap.increase(plan);

        IDominoPositionActions.ExitPlan memory exitPlan = _exitPlan(id, 1, _noLegs(), ETH, false);
        exitPlan.intent.tickLower = LOWER - 60;
        vm.prank(owner);
        vm.expectRevert(IDominoPositionActions.InvalidPlan.selector);
        zap.exit(exitPlan);
    }

    function testAPositionOfAnotherPoolIsRefused() public {
        uint256 id = _mintFor(owner, 50e18);
        _approveZapOn(owner, id);
        IDominoPositionActions.ExitPlan memory plan = _exitPlan(id, 1, _noLegs(), ETH, false);
        plan.intent.pool = swapPool;
        vm.prank(owner);
        vm.expectPartialRevert(DominoV4Positions.PositionPoolMismatch.selector);
        zap.exit(plan);
    }

    function testHookedPoolsAreRefusedByDefault() public view {
        _check(!zap.hookedPoolsAllowed(), "policy: refuse");
        _check(zap.positionManager() == positions, "position manager");
    }

    function testAHookedPoolIsRefusedBeforeAnythingMoves() public {
        IDominoPositionActions.CreatePlan memory plan = _createFromUsd(100e18, owner, 0);
        plan.intent.pool.hooks = address(0x4444000000000000000000000000000000000080);
        _expectCreateRevert(plan, IDominoPositionActions.InvalidPlan.selector, "hooked pool");
    }

    function _expectCreateRevert(IDominoPositionActions.CreatePlan memory plan, bytes4 selector, string memory what)
        internal
    {
        vm.prank(owner);
        (bool ok, bytes memory out) = address(zap).call(abi.encodeCall(IDominoPositionActions.create, (plan)));
        if (ok || out.length < 4 || bytes4(out) != selector) revert Unexpected(what);
    }

    // ============================================================= Permit2

    function testPermitSignaturesBindSignerZapChainAndWitness() public {
        address signer = vm.addr(0xC0FFEE);
        usd.mint(signer, 1000e18);
        vm.prank(signer);
        usd.approve(PERMIT2, type(uint256).max);
        IDominoPositionActions.CreatePlan memory plan = _createFromUsd(100e18, signer, 9);
        (IPermit2Signature.PermitBatchTransferFrom memory permit, bytes memory signature) = _withPermit(plan, 0xC0FFEE);

        // Wrong signer: Bob signs a permit naming the signer as recipient.
        bytes memory bobs = _signature(BOB_KEY, _permitDigest(permit, address(zap), plan.intent));
        vm.expectRevert(INVALID_SIGNER);
        zap.createWithPermit(plan, permit, bobs);

        // The witness is the whole intent: change one field after signing.
        plan.intent.minLiquidity -= 1;
        vm.expectRevert(INVALID_SIGNER);
        zap.createWithPermit(plan, permit, signature);
        plan.intent.minLiquidity += 1;

        // Another zap (spender) cannot use it.
        address other = _deployZap(manager, positions, steps);
        vm.expectRevert(INVALID_SIGNER);
        IZap(other).createWithPermit(plan, permit, signature);

        // Another chain cannot use it.
        vm.chainId(CHAIN + 1);
        vm.expectRevert(INVALID_SIGNER);
        zap.createWithPermit(plan, permit, signature);
        vm.chainId(CHAIN);

        // The permit must carry the intent's nonce and exactly its inputs.
        permit.nonce = 10;
        vm.expectRevert(IDominoPositionActions.InvalidPlan.selector);
        zap.createWithPermit(plan, permit, signature);
        permit.nonce = 9;
        permit.permitted[0].amount += 1;
        vm.expectRevert(IDominoPositionActions.InvalidPlan.selector);
        zap.createWithPermit(plan, permit, signature);
        permit.permitted[0].amount -= 1;
        permit.permitted[0].token = address(tkn);
        vm.expectRevert(IDominoPositionActions.InvalidPlan.selector);
        zap.createWithPermit(plan, permit, signature);
        permit.permitted[0].token = address(usd);

        // Expired.
        vm.warp(DEADLINE + 1);
        vm.expectRevert(IDominoPositionActions.PlanExpired.selector);
        zap.createWithPermit(plan, permit, signature);
        vm.warp(NOW);

        // Once, and only once.
        zap.createWithPermit(plan, permit, signature);
        vm.expectRevert(INVALID_NONCE);
        zap.createWithPermit(plan, permit, signature);
    }

    function testAPermitCannotPullNativeCurrency() public {
        DominoV2Types.TokenAmount[] memory inputs = _inputs(ETH, 1e18);
        IDominoPositionActions.CreatePlan memory plan = _createPlan(nativePool, inputs, _noLegs(), ETH, 1, owner, 1);
        IPermit2Signature.PermitBatchTransferFrom memory permit = _permit(inputs, 1, DEADLINE);
        bytes memory signature = _signature(OWNER_KEY, _permitDigest(permit, address(zap), plan.intent));
        vm.expectRevert(IDominoPositionActions.InvalidPlan.selector);
        zap.createWithPermit(plan, permit, signature);
    }

    // ======================================================== relayed signatures

    function testRelayedSignaturesBindSignerZapChainNonceAndShape() public {
        uint256 id = _mintFor(owner, 50e18);
        _approveZapOn(owner, id);
        // Keep the emptied NFT, so a replay reaches the nonce check.
        IDominoPositionActions.ExitPlan memory plan = _exitPlan(id, _positionLiquidity(id), _noLegs(), ETH, false);
        plan.intent.nonce = 700;
        bytes32 digest = _relayedDigest(address(zap), _relayedExit(plan));
        bytes memory signature = _signature(OWNER_KEY, digest);

        // Another zap.
        address other = _deployZap(manager, positions, steps);
        vm.expectRevert(IDominoZap.InvalidSignature.selector);
        IZap(other).exitWithSignature(plan, signature);
        // Another chain.
        vm.chainId(CHAIN + 1);
        vm.expectRevert(IDominoZap.InvalidSignature.selector);
        zap.exitWithSignature(plan, signature);
        vm.chainId(CHAIN);
        // The exit's caps are signed as zero; the burn flag is signed.
        plan.burn = true;
        vm.expectRevert(IDominoZap.InvalidSignature.selector);
        zap.exitWithSignature(plan, signature);
        plan.burn = false;
        // The malleable twin (s' = n - s, v flipped) and malformed signatures.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        bytes32 twin = bytes32(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s));
        vm.expectRevert(IDominoZap.InvalidSignature.selector);
        zap.exitWithSignature(plan, abi.encodePacked(r, twin, v == 27 ? uint8(28) : uint8(27)));
        vm.expectRevert(IDominoZap.InvalidSignature.selector);
        zap.exitWithSignature(plan, abi.encodePacked(r, s));
        vm.expectRevert(IDominoZap.InvalidSignature.selector);
        zap.exitWithSignature(plan, abi.encodePacked(r, s, uint8(29)));
        // Expired.
        vm.warp(DEADLINE + 1);
        vm.expectRevert(IDominoPositionActions.PlanExpired.selector);
        zap.exitWithSignature(plan, signature);
        vm.warp(NOW);
        // The owner can void it before anyone submits it.
        uint256 snapshot = vm.snapshotState();
        vm.prank(owner);
        zap.invalidateNonces(700 >> 8, 1 << (700 & 0xff));
        vm.expectRevert(abi.encodeWithSelector(IDominoZap.NonceUsed.selector, owner, uint256(700)));
        zap.exitWithSignature(plan, signature);
        vm.revertToState(snapshot);
        // Once.
        zap.exitWithSignature(plan, signature);
        vm.expectRevert(abi.encodeWithSelector(IDominoZap.NonceUsed.selector, owner, uint256(700)));
        zap.exitWithSignature(plan, signature);
    }

    function testAfterATransferTheOldOwnersSignatureIsVoid() public {
        uint256 id = _mintFor(owner, 50e18);
        IDominoPositionActions.ExitPlan memory plan = _exitPlan(id, _positionLiquidity(id), _noLegs(), ETH, true);
        plan.intent.nonce = 1;
        bytes memory signature = _signature(OWNER_KEY, _relayedDigest(address(zap), _relayedExit(plan)));
        vm.prank(owner);
        IPositionNft(positions).transferFrom(owner, bob, id);
        _approveZapOn(bob, id);
        vm.expectRevert(IDominoZap.InvalidSignature.selector);
        zap.exitWithSignature(plan, signature);
    }

    // ============================================================ the fee

    function testARecipientThatCannotReceiveNeverBlocksTheAction() public {
        usd.setBlocked(feeRecipient, true);
        IDominoPositionActions.CreatePlan memory plan = _createFromUsd(100e18, owner, 0);
        vm.recordLogs();
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.create(plan);
        _eq(_count(vm.getRecordedLogs(), address(zap), FEE_DEFERRED), 1, "FeeDeferred");
        _eq(zap.owedFees(address(usd)), r.feeAmount, "owed");
        _eq(usd.balanceOf(address(zap)), r.feeAmount, "the zap keeps exactly the owed fee");
        _assertZapEmpty();
        // The owed fee is never the next owner's.
        plan = _createFromUsd(100e18, bob, 0);
        vm.prank(bob);
        zap.create(plan);
        _eq(usd.balanceOf(address(zap)), zap.owedFees(address(usd)), "still only owed");
        usd.setBlocked(feeRecipient, false);
        uint256 owed = zap.owedFees(address(usd));
        zap.flushOwedFees(address(usd));
        _eq(usd.balanceOf(feeRecipient), owed, "flushed to the recipient");
        _eq(usd.balanceOf(address(zap)), 0, "empty");
    }

    function testANativeFeeToARejectingRecipientIsOwed() public {
        registry.setRank(address(usd), 0); // ETH becomes the best-ranked currency in the route
        RejectingRecipient rejecting = new RejectingRecipient();
        registry.setFeeRecipient(address(rejecting));
        DominoV2Types.SwapLeg[] memory legs = _oneLeg(_leg(ETH, address(usd), 5e18, 4.9e18));
        IDominoPositionActions.CreatePlan memory plan = _createPlan(
            nativePool, _inputs(ETH, 10e18), legs, ETH, _liquidityFor(nativePool, LOWER, UPPER, 4.8e18, 4.8e18), owner, 0
        );
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.create{value: 10e18}(plan);
        _check(r.feeToken == ETH && r.feeAmount == 5e18 * 65 / 10_000, "ETH fee on the input");
        _eq(zap.owedFees(ETH), r.feeAmount, "owed");
        _eq(address(zap).balance, r.feeAmount, "only the owed fee stays");
        _assertZapEmpty();
    }

    // ========================================================== reentrancy

    /// A swap leg may cross a hooked pool (F1b); a hook that calls the zap
    /// back mid-swap finds it locked, and the action completes.
    function testAHookCannotReenterTheZap() public {
        address flagged = address(uint160(0x10000 | 0x40)); // AFTER_SWAP permission bit only
        vm.etch(flagged, address(new ReentrantSwapHook(address(zap))).code);
        V4LiquidityHelper liquidity = new V4LiquidityHelper(manager);
        usd.mint(address(liquidity), 1e27);
        tkn.mint(address(liquidity), 1e27);
        DominoV2Types.PoolRef memory hooked =
            DominoV2Types.PoolRef(DominoV2Types.DEX_V4, pool.currency0, pool.currency1, 3000, 60, flagged);
        _openPool(liquidity, hooked, 1e24);
        DominoV2Types.PoolRef[] memory path = new DominoV2Types.PoolRef[](1);
        path[0] = hooked;
        DominoV2Types.SwapLeg[] memory legs = _oneLeg(
            DominoV2Types.SwapLeg(
                DominoV2Types.LEG_V4_POOL, address(0), address(usd), address(tkn), 50e18, 49e18, abi.encode(path)
            )
        );
        IDominoPositionActions.CreatePlan memory plan = _createPlan(
            pool, _inputs(address(usd), 100e18), legs, address(usd), 1, owner, 0
        );
        vm.prank(owner);
        zap.create(plan);
        _check(ReentrantSwapHook(flagged).calls() == 1 && ReentrantSwapHook(flagged).refused(), "the hook was refused");
        _eq(zap.nonceBitmap(flagged, 0), 0, "nothing ran");
        _assertZapEmpty();
    }

    /// A token that calls the zap on every transfer (the leg's output, the
    /// payment to the pool, the refund) finds every entry point locked.
    function testATokenCannotReenterTheZap() public {
        ReenteringRecipient probe = new ReenteringRecipient();
        tkn.setHook(address(probe), "");
        bytes[3] memory calls = [
            abi.encodeCall(IZap.invalidateNonces, (0, 1)),
            abi.encodeCall(IZap.flushOwedFees, (address(usd))),
            abi.encodeCall(IDominoPositionActions.create, (_createFromUsd(1e18, owner, 0)))
        ];
        for (uint256 i; i < calls.length; ++i) {
            probe.arm(address(zap), calls[i]);
            IDominoPositionActions.CreatePlan memory plan = _createFromUsd(100e18, owner, 0);
            vm.prank(owner);
            zap.create(plan);
            _check(probe.reverted() && bytes4(probe.revertData()) == DominoActionLock.ReentrantCall.selector, "locked");
        }
        _eq(zap.nonceBitmap(address(probe), 0), 0, "nothing ran");
        _assertZapEmpty();
    }

    function testARecipientCallingBackIsRefusedAndTheActionCompletes() public {
        ReenteringRecipient back = new ReenteringRecipient();
        back.arm(address(zap), abi.encodeCall(IZap.flushOwedFees, (ETH)));
        DominoV2Types.TokenAmount[] memory inputs = _inputs(ETH, 10e18);
        IDominoPositionActions.CreatePlan memory plan = _createPlan(
            nativePool, inputs, _oneLeg(_leg(ETH, address(usd), 3e18, 2.9e18)), address(usd), 1, address(back), 0
        );
        vm.prank(owner);
        zap.create{value: 10e18}(plan); // the refund of ETH calls the recipient back
        _check(back.reverted() && bytes4(back.revertData()) == DominoActionLock.ReentrantCall.selector, "refused");
        _assertZapEmpty();
    }

    function testCallbacksOnlyFromThePoolManagerAndOnlyWhenAwaited() public {
        vm.expectRevert(IDominoPositionActions.Unauthorized.selector);
        zap.unlockCallback("");
        vm.prank(manager);
        vm.expectRevert(IDominoPositionActions.Unauthorized.selector);
        zap.unlockCallback(abi.encode(uint256(1)));
        (bool ok,) = address(zap).call{value: 1}("");
        _check(!ok, "stray ETH refused");
        DominoZapV4Steps.Call memory c;
        DominoV4Positions.Managers memory m;
        vm.expectRevert(DominoZapV4Steps.DirectCall.selector);
        DominoZapV4Steps(steps).run(m, c);
    }

    function testTheConstructorChecksItsConfiguration() public {
        bytes memory code = vm.getCode(ZAP_ARTIFACT);
        DominoSwapExecutor.RouteConfig memory route =
            DominoSwapExecutor.RouteConfig(IDominoRegistry(address(registry)), PERMIT2, address(0), bytes32(0), manager);
        (bool ok,) = address(this).call(abi.encodeCall(this.deployRaw, (abi.encodePacked(code, abi.encode(route, positions, address(0x1234))))));
        _check(!ok, "steps without code");
        route.v4PoolManager = address(registry); // has code, but is not the PositionManager's PoolManager
        (ok,) = address(this).call(abi.encodeCall(this.deployRaw, (abi.encodePacked(code, abi.encode(route, positions, steps)))));
        _check(!ok, "mismatched managers");
        route.v4PoolManager = manager;
        (ok,) = address(this).call(abi.encodeCall(this.deployRaw, (abi.encodePacked(code, abi.encode(route, positions, steps)))));
        _check(ok, "valid");
    }

    function deployRaw(bytes memory init) external returns (address) {
        return _deploy(init);
    }

    // ========================================================= resumption

    /// An interrupted or stale plan moves nothing; the app reads the nonce,
    /// re-plans and the owner signs again (or voids the old signature).
    function testAStalePlanMovesNothingAndAFreshOneCompletes() public {
        address signer = vm.addr(0xC0FFEE);
        usd.mint(signer, 1000e18);
        vm.prank(signer);
        usd.approve(PERMIT2, type(uint256).max);
        IDominoPositionActions.CreatePlan memory plan = _createFromUsd(100e18, signer, 21);
        (IPermit2Signature.PermitBatchTransferFrom memory permit, bytes memory signature) = _withPermit(plan, 0xC0FFEE);
        trader.swap(_key(pool), true, 2e21); // the price moved after the owner signed
        uint256 before = usd.balanceOf(signer);
        vm.expectPartialRevert(DominoV4Positions.InsufficientLiquidity.selector);
        zap.createWithPermit(plan, permit, signature);
        _eq(usd.balanceOf(signer), before, "nothing moved");
        _eq(IPermit2Views(PERMIT2).nonceBitmap(signer, 0) & (1 << 21), 0, "the nonce is still unused");
        vm.prank(signer);
        IPermit2Views(PERMIT2).invalidateUnorderedNonces(0, 1 << 21); // the owner voids it
        vm.expectRevert(INVALID_NONCE);
        zap.createWithPermit(plan, permit, signature);

        plan = _createFromUsd(100e18, signer, 22);
        plan.intent.minLiquidity = 1;
        (permit, signature) = _withPermit(plan, 0xC0FFEE);
        zap.createWithPermit(plan, permit, signature);
        _assertZapEmpty();
    }

    // ========================================================= more guards

    /// A relayed exit may pay someone else: the owner signs the recipient.
    function testARelayedExitMayPayAnotherRecipient() public {
        uint256 id = _mintFor(owner, 50e18);
        _approveZapOn(owner, id);
        address carol = address(0xCA201);
        IDominoPositionActions.ExitPlan memory plan = _exitPlan(id, _positionLiquidity(id), _noLegs(), ETH, true);
        (plan.intent.recipient, plan.intent.nonce) = (carol, 8);
        bytes memory signature = _signature(OWNER_KEY, _relayedDigest(address(zap), _relayedExit(plan)));
        vm.prank(bob);
        IDominoPositionActions.ActionResult memory r = zap.exitWithSignature(plan, signature);
        _check(usd.balanceOf(carol) + tkn.balanceOf(carol) == r.amount0 + r.amount1 && r.amount0 > 0, "carol paid");
        _assertZapEmpty();
    }

    function testASignatureOfAnotherLengthIsRefused() public {
        uint256 id = _mintFor(owner, 50e18);
        _approveZapOn(owner, id);
        IDominoPositionActions.ExitPlan memory plan = _exitPlan(id, _positionLiquidity(id), _noLegs(), ETH, true);
        bytes memory signature = _signature(OWNER_KEY, _relayedDigest(address(zap), _relayedExit(plan)));
        vm.expectRevert(IDominoZap.InvalidSignature.selector);
        zap.exitWithSignature(plan, bytes.concat(signature, hex"00"));
    }

    function testInvalidatingNoncesAddsBitsToTheWord() public {
        vm.recordLogs();
        vm.startPrank(owner);
        zap.invalidateNonces(3, 1 << 4);
        zap.invalidateNonces(3, 1 << 9);
        vm.stopPrank();
        _eq(zap.nonceBitmap(owner, 3), (1 << 4) | (1 << 9), "both voided");
        _eq(zap.nonceBitmap(bob, 3), 0, "per owner");
        _eq(_count(vm.getRecordedLogs(), address(zap), keccak256("NoncesInvalidated(address,uint256,uint256)")), 2, "logged");
    }

    /// A pull that fails reverts: it is never made up by tokens the zap
    /// happens to hold (here a stray donation).
    function testAnInputWithoutAllowanceIsRefused() public {
        IDominoPositionActions.CreatePlan memory plan = _createFromUsd(100e18, owner, 0);
        usd.mint(address(zap), 100e18);
        vm.prank(owner);
        usd.approve(address(zap), 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("TokenCallFailed(address)")), address(usd)));
        zap.create(plan);
    }

    /// An exit may convert into a token outside the pool; it is delivered too.
    function testAConversionIntoAThirdTokenIsDelivered() public {
        TestToken third = new TestToken();
        third.mint(address(this), 1e30);
        usd.mint(address(this), 1e30);
        V4LiquidityHelper liquidity = new V4LiquidityHelper(manager);
        third.transfer(address(liquidity), 1e27);
        usd.transfer(address(liquidity), 1e27);
        (address c0, address c1) = _sorted(address(usd), address(third));
        DominoV2Types.PoolRef memory thirdPool = DominoV2Types.PoolRef(DominoV2Types.DEX_V4, c0, c1, 500, 10, address(0));
        _openPool(liquidity, thirdPool, 1e25);
        uint256 id = _mintFor(owner, 50e18);
        _approveZapOn(owner, id);
        DominoV2Types.PoolRef[] memory path = new DominoV2Types.PoolRef[](1);
        path[0] = thirdPool;
        DominoV2Types.SwapLeg[] memory legs = _oneLeg(
            DominoV2Types.SwapLeg(
                DominoV2Types.LEG_V4_POOL, address(0), address(usd), address(third), 40e18, 39e18, abi.encode(path)
            )
        );
        IDominoPositionActions.ExitPlan memory plan = _exitPlan(id, _positionLiquidity(id), legs, address(usd), true);
        vm.prank(owner);
        zap.exit(plan);
        _check(third.balanceOf(owner) > 39e18, "the third token delivered");
        _eq(third.balanceOf(address(zap)), 0, "not kept");
        _assertZapEmpty();
    }

    /// An input the plan does not use still comes back in the same transaction.
    function testAnUnusedInputIsRefunded() public {
        TestToken extra = new TestToken();
        extra.mint(owner, 5e18);
        vm.prank(owner);
        extra.approve(address(zap), 5e18);
        IDominoPositionActions.CreatePlan memory plan = _createFromUsd(100e18, owner, 0);
        DominoV2Types.TokenAmount[] memory inputs = new DominoV2Types.TokenAmount[](2);
        (inputs[0], inputs[1]) = (plan.inputs[0], DominoV2Types.TokenAmount(address(extra), 5e18));
        plan.inputs = inputs;
        vm.prank(owner);
        zap.create(plan);
        _eq(extra.balanceOf(owner), 5e18, "returned");
        _eq(extra.balanceOf(address(zap)), 0, "not kept");
    }

    // ================================================================= gas

    function testGasPerFlow() public {
        IDominoPositionActions.CreatePlan memory created = _createFromUsd(100e18, owner, 0);
        uint256 gas = gasleft();
        vm.prank(owner);
        uint256 id = zap.create(created).tokenId;
        _logGas("v4 create with swap (plain)", gas - gasleft());
        _approveZapOn(owner, id);
        IDominoPositionActions.IncreasePlan memory increased = _increasePlan(id, 20e18, owner, 0);
        gas = gasleft();
        vm.prank(owner);
        zap.increase(increased);
        _logGas("v4 increase with swap (plain)", gas - gasleft());
        IDominoPositionActions.ChangeRangePlan memory change = _changePlan(id, _positionLiquidity(id), -1200, 1200, owner);
        gas = gasleft();
        vm.prank(owner);
        uint256 next = zap.changeRange(change).tokenId;
        _logGas("v4 change range, no swap", gas - gasleft());
        _approveZapOn(owner, next);
        DominoV2Types.SwapLeg[] memory legs = _oneLeg(_leg(address(tkn), address(usd), 30e18, 29e18));
        IDominoPositionActions.ExitPlan memory exitPlan =
            _exitPlan(next, _positionLiquidity(next), legs, address(usd), true);
        exitPlan.intent.tickLower = -1200;
        exitPlan.intent.tickUpper = 1200;
        gas = gasleft();
        vm.prank(owner);
        zap.exit(exitPlan);
        _logGas("v4 exit with conversion", gas - gasleft());
        address signer = vm.addr(0xC0FFEE);
        usd.mint(signer, 1000e18);
        vm.prank(signer);
        usd.approve(PERMIT2, type(uint256).max);
        IDominoPositionActions.CreatePlan memory plan = _createFromUsd(100e18, signer, 1);
        (IPermit2Signature.PermitBatchTransferFrom memory permit, bytes memory signature) = _withPermit(plan, 0xC0FFEE);
        gas = gasleft();
        zap.createWithPermit(plan, permit, signature);
        _logGas("v4 create with swap (Permit2 witness)", gas - gasleft());
    }
}
