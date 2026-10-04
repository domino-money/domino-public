// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IPermit2Signature} from "../../../src/v2/external/IPermit2Signature.sol";
import {IUniswapV3PoolMinimal, IUniswapV3PositionManagerMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {IDominoZap} from "../../../src/v2/interfaces/IDominoZap.sol";
import {DominoPositionMath} from "../../../src/v2/positions/DominoPositionMath.sol";
import {DominoV3Positions, IV3PoolInitializerMinimal} from "../../../src/v2/positions/DominoV3Positions.sol";
import {DominoSwapExecutor} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {DominoZapV3} from "../../../src/v2/zap/DominoZapV3.sol";
import {UniswapBase8453} from "../positions/fixtures/UniswapBase8453.sol";
import {V3SwapDriver} from "../positions/PositionTestKit.sol";
import {RobinhoodPermit2} from "../route/fixtures/RobinhoodPermit2.sol";
import {ScriptedRouter, scriptedCall} from "../route/RouteAdversaries.sol";
import {MockDominoRegistry, RejectingRecipient, TestToken} from "../route/V2RouteTestKit.sol";
import {ZapBaseFixtures} from "./ZapBaseFixtures.sol";
import {IPositionNft, IZap} from "./ZapTestKit.sol";

interface IWeth9 {
    function deposit() external payable;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice The v3 zap's four flows and their guards against the factory,
/// NonfungiblePositionManager and WETH9 bytecode deployed on Base (F1c
/// fixtures; Robinhood and Arbitrum run the same builds). Pools come from the
/// etched factory; swap legs are direct v3 pool legs (F1b).
contract ZapV3Test is ZapBaseFixtures {
    string internal constant ZAP_ARTIFACT = "DominoZapV3.sol:DominoZapV3";
    bytes32 internal constant POOL_INIT_CODE_HASH = 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant BOB_KEY = 0xB0B;
    int24 internal constant LOWER = -600;
    int24 internal constant UPPER = 600;

    MockDominoRegistry internal registry;
    IZap internal zap;
    IUniswapV3PositionManagerMinimal internal npm = IUniswapV3PositionManagerMinimal(UniswapBase8453.V3_POSITION_MANAGER);
    address internal weth = UniswapBase8453.WETH9;
    TestToken internal usd;
    TestToken internal tkn;
    V3SwapDriver internal trader;
    address internal owner;
    address internal bob;
    address internal feeRecipient = address(0xFEE);
    DominoV2Types.PoolRef internal pool; // positions: usd/tkn 0.3%
    DominoV2Types.PoolRef internal wethPool; // positions: WETH/usd 0.3%
    address internal poolAddress;

    function setUp() public {
        vm.warp(NOW);
        vm.etch(PERMIT2, RobinhoodPermit2.RUNTIME);
        _installBaseV3();
        registry = new MockDominoRegistry();
        registry.setFeeRecipient(feeRecipient);
        zap = IZap(_deployZap());
        (usd, tkn) = (new TestToken(), new TestToken());
        registry.setRank(address(usd), 1);
        registry.setRank(weth, 2);
        registry.setRank(ETH, 2);
        (owner, bob) = (vm.addr(OWNER_KEY), vm.addr(BOB_KEY));
        trader = new V3SwapDriver();
        address[4] memory funded = [address(this), address(trader), owner, bob];
        for (uint256 i; i < funded.length; ++i) {
            usd.mint(funded[i], 1e30);
            tkn.mint(funded[i], 1e30);
            vm.deal(funded[i], 1e27);
        }
        IWeth9(weth).deposit{value: 1e26}();
        (address c0, address c1) = _sorted(address(usd), address(tkn));
        pool = DominoV2Types.PoolRef(DominoV2Types.DEX_V3, c0, c1, 3000, 60, address(0));
        (c0, c1) = _sorted(weth, address(usd));
        wethPool = DominoV2Types.PoolRef(DominoV2Types.DEX_V3, c0, c1, 3000, 60, address(0));
        poolAddress = _openPool(address(usd), address(tkn), 3000, 887220, 1e22);
        _openPool(address(usd), address(tkn), 500, 887270, 1e25); // the legs' pool
        _openPool(weth, address(usd), 3000, 887220, 1e22);
        _openPool(weth, address(usd), 500, 887270, 1e25);
        _allowZap(owner);
        _allowZap(bob);
    }

    function _deployZap() internal returns (address) {
        return _deploy(
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
        );
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

    function _allowZap(address account) internal {
        vm.startPrank(account);
        usd.approve(address(zap), type(uint256).max);
        tkn.approve(address(zap), type(uint256).max);
        usd.approve(PERMIT2, type(uint256).max);
        vm.stopPrank();
    }

    /// An exact-input v3 leg through the 0.05% pool of the pair.
    function _leg(address tokenIn, address tokenOut, uint128 amountIn, uint128 minOut)
        internal
        pure
        returns (DominoV2Types.SwapLeg memory)
    {
        return DominoV2Types.SwapLeg(
            DominoV2Types.LEG_V3_POOL,
            address(0),
            tokenIn,
            tokenOut,
            amountIn,
            minOut,
            abi.encodePacked(tokenIn, uint24(500), tokenOut)
        );
    }

    function _price(address at) internal view returns (uint160 price) {
        (price,,,,,,) = IUniswapV3PoolMinimal(at).slot0();
    }

    function _liquidity(uint256 id) internal view returns (uint128 liquidity) {
        (,,,,,,, liquidity,,,,) = npm.positions(id);
    }

    function _owed(uint256 id) internal view returns (uint128 owed0, uint128 owed1) {
        (,,,,,,,,,, owed0, owed1) = npm.positions(id);
    }

    function _assertZapEmpty() internal view {
        address[4] memory tokens = [address(usd), address(tkn), weth, ETH];
        for (uint256 i; i < tokens.length; ++i) {
            _eq(_balance(tokens[i], address(zap)), zap.owedFees(tokens[i]), "zap holds only owed fees");
            if (tokens[i] != ETH) {
                _eq(_allowance(tokens[i], address(zap), address(npm)), 0, "no allowance to the manager survives");
                _eq(_allowance(tokens[i], address(zap), PERMIT2), 0, "no allowance to Permit2 survives");
            }
        }
    }

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
            DominoPositionMath.liquidityForAmounts(
                _price(poolAddress), LOWER, UPPER, uint256(half) * 98 / 100, uint256(half) * 98 / 100
            ),
            recipient,
            nonce
        );
    }

    function _mintFor(address who, uint128 amount) internal returns (uint256 id) {
        DominoV2Types.TokenAmount[] memory inputs = new DominoV2Types.TokenAmount[](2);
        inputs[0] = DominoV2Types.TokenAmount(address(usd), amount);
        inputs[1] = DominoV2Types.TokenAmount(address(tkn), amount);
        IDominoPositionActions.CreatePlan memory plan = _createPlan(pool, inputs, _noLegs(), ETH, 1, who, 0);
        vm.prank(who);
        id = zap.create(plan).tokenId;
    }

    function _approveZapOn(address who, uint256 id) internal {
        vm.prank(who);
        IPositionNft(address(npm)).approve(address(zap), id);
    }

    function _exitPlan(uint256 id, uint128 liquidity, DominoV2Types.SwapLeg[] memory legs, address feeToken, bool burn)
        internal
        view
        returns (IDominoPositionActions.ExitPlan memory plan)
    {
        plan.intent = _intent(DominoV2Types.ACTION_EXIT, pool, id, LOWER, UPPER, 0, legs, feeToken, owner, 0);
        (plan.liquidityToRemove, plan.legs, plan.burn) = (liquidity, legs, burn);
    }

    // ================================================================ create

    function testCreateFromOneTokenOnV3() public {
        IDominoPositionActions.CreatePlan memory plan = _createFromUsd(100e18, owner, 0);
        uint256 usd0 = usd.balanceOf(owner);
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.create(plan);
        _check(IPositionNft(address(npm)).ownerOf(r.tokenId) == owner, "the NFT is the owner's");
        _check(r.liquidity >= plan.intent.minLiquidity && r.liquidity == _liquidity(r.tokenId), "liquidity");
        _eq(r.feeAmount, 50e18 * 65 / 10_000, "65 bps of the swapped amount");
        _eq(usd.balanceOf(feeRecipient), r.feeAmount, "fee paid at once");
        (uint256 paidUsd,) = pool.currency0 == address(usd) ? (r.amount0, r.amount1) : (r.amount1, r.amount0);
        _eq(usd0 - usd.balanceOf(owner), 50e18 + r.feeAmount + paidUsd, "debits close");
        _assertZapEmpty();
    }

    function testCreateWithPermitOnV3() public {
        address signer = vm.addr(0xC0FFEE);
        usd.mint(signer, 100e18);
        vm.prank(signer);
        usd.approve(PERMIT2, type(uint256).max);
        IDominoPositionActions.CreatePlan memory plan = _createFromUsd(100e18, signer, 5);
        IPermit2Signature.PermitBatchTransferFrom memory permit = _permit(plan.inputs, 5, DEADLINE);
        bytes memory signature = _signature(0xC0FFEE, _permitDigest(permit, address(zap), plan.intent));
        vm.prank(bob);
        IDominoPositionActions.ActionResult memory r = zap.createWithPermit(plan, permit, signature);
        _check(IPositionNft(address(npm)).ownerOf(r.tokenId) == signer, "the NFT is the signer's");
        _assertZapEmpty();
    }

    /// v3 pools hold WETH: native ETH sent with the call is wrapped before it
    /// is added, and what is left comes back as WETH.
    function testNativeEthIsWrappedForAWethPool() public {
        DominoV2Types.TokenAmount[] memory inputs = new DominoV2Types.TokenAmount[](2);
        inputs[0] = DominoV2Types.TokenAmount(ETH, 5e18);
        inputs[1] = DominoV2Types.TokenAmount(address(usd), 4e18);
        IDominoPositionActions.CreatePlan memory plan = _createPlan(wethPool, inputs, _noLegs(), ETH, 1, owner, 0);
        uint256 eth0 = owner.balance;
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.create{value: 5e18}(plan);
        (uint256 paidWeth, uint256 paidUsd) =
            wethPool.currency0 == weth ? (r.amount0, r.amount1) : (r.amount1, r.amount0);
        _eq(eth0 - owner.balance, 5e18, "ETH sent");
        _eq(IWeth9(weth).balanceOf(owner), 5e18 - paidWeth, "the rest back as WETH");
        _check(paidUsd > 3.9e18 && paidWeth > 3.9e18, "both added");
        _assertZapEmpty();
    }

    /// Native ETH is wrapped only for a WETH pool; elsewhere it comes back as ETH.
    function testNativeEthIsNotWrappedForAnotherPool() public {
        DominoV2Types.TokenAmount[] memory inputs = new DominoV2Types.TokenAmount[](3);
        inputs[0] = DominoV2Types.TokenAmount(address(usd), 5e18);
        inputs[1] = DominoV2Types.TokenAmount(address(tkn), 5e18);
        inputs[2] = DominoV2Types.TokenAmount(ETH, 1e18);
        IDominoPositionActions.CreatePlan memory plan = _createPlan(pool, inputs, _noLegs(), ETH, 1, owner, 0);
        uint256 eth0 = owner.balance;
        vm.prank(owner);
        zap.create{value: 1e18}(plan);
        _eq(owner.balance, eth0, "the ETH came back as ETH");
        _assertZapEmpty();
    }

    /// A create may initialize a pool that has no price yet (#282 A11: only if uninitialized).
    function testCreateInitializesANewV3Pool() public {
        (address c0, address c1) = _sorted(address(usd), address(tkn));
        DominoV2Types.PoolRef memory fresh = DominoV2Types.PoolRef(DominoV2Types.DEX_V3, c0, c1, 10_000, 200, address(0));
        DominoV2Types.TokenAmount[] memory inputs = new DominoV2Types.TokenAmount[](2);
        inputs[0] = DominoV2Types.TokenAmount(address(usd), 10e18);
        inputs[1] = DominoV2Types.TokenAmount(address(tkn), 10e18);
        IDominoPositionActions.CreatePlan memory plan = _createPlan(fresh, inputs, _noLegs(), ETH, 1, owner, 0);
        (plan.intent.tickLower, plan.intent.tickUpper, plan.initSqrtPriceX96) = (-2000, 2000, PRICE_ONE);
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.create(plan);
        _check(IPositionNft(address(npm)).ownerOf(r.tokenId) == owner, "minted in the new pool");
        _assertZapEmpty();
    }

    function testTheV3ConstructorChecksTheFactory() public {
        bytes memory init = abi.encodePacked(
            vm.getCode(ZAP_ARTIFACT),
            abi.encode(
                DominoSwapExecutor.RouteConfig(
                    IDominoRegistry(address(registry)), PERMIT2, address(registry), POOL_INIT_CODE_HASH, address(0)
                ),
                npm
            )
        );
        (bool ok,) = address(this).call(abi.encodeCall(this.deployRaw, (init)));
        _check(!ok, "a factory that is not the manager's");
    }

    function deployRaw(bytes memory init) external returns (address) {
        return _deploy(init);
    }

    /// An ETH fee the recipient refuses stays owed as ETH: wrapping native for
    /// a WETH pool never touches it.
    function testAnOwedNativeFeeIsNeverWrapped() public {
        ScriptedRouter router = new ScriptedRouter(PERMIT2);
        registry.setRouter(address(router), 1);
        registry.setRank(address(usd), 0); // ETH becomes the fee currency of an ETH -> USDG leg
        registry.setFeeRecipient(address(new RejectingRecipient()));
        usd.mint(address(router), 1e18);
        ScriptedRouter.Script memory script;
        (script.tokenIn, script.tokenOut, script.pay) = (ETH, address(usd), 1e18);
        DominoV2Types.SwapLeg[] memory legs = _oneLeg(
            DominoV2Types.SwapLeg(
                DominoV2Types.LEG_UNIVERSAL_ROUTER,
                address(router),
                ETH,
                address(usd),
                1e18,
                1e18,
                scriptedCall(script)
            )
        );
        IDominoPositionActions.CreatePlan memory plan = _createPlan(wethPool, _inputs(ETH, 3e18), legs, ETH, 1, owner, 0);
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.create{value: 3e18}(plan);
        _check(r.feeToken == ETH && r.feeAmount == 1e18 * 65 / 10_000, "the ETH fee");
        _eq(zap.owedFees(ETH), r.feeAmount, "owed");
        _eq(address(zap).balance, r.feeAmount, "kept as ETH");
        _assertZapEmpty();
    }

    function testAV3PoolRefMustBeTheFactorysPool() public {
        IDominoPositionActions.CreatePlan memory plan = _createFromUsd(100e18, owner, 0);
        plan.intent.pool.hooks = address(1);
        _expectCreate(plan, IDominoPositionActions.InvalidPlan.selector, "hooks on v3");
        plan.intent.pool.hooks = address(0);
        plan.intent.pool.dex = DominoV2Types.DEX_V4;
        _expectCreate(plan, IDominoPositionActions.InvalidPlan.selector, "a v4 pool on the v3 zap");
        plan.intent.pool.dex = DominoV2Types.DEX_V3;
        plan.intent.pool.tickSpacing = 10;
        _expectCreate(plan, DominoV3Positions.InvalidPool.selector, "spacing not the factory's");
        _check(!zap.hookedPoolsAllowed() && zap.positionManager() == address(npm), "views");
    }

    function _expectCreate(IDominoPositionActions.CreatePlan memory plan, bytes4 selector, string memory what) internal {
        vm.prank(owner);
        (bool ok, bytes memory out) = address(zap).call(abi.encodeCall(IDominoPositionActions.create, (plan)));
        if (ok || out.length < 4 || bytes4(out) != selector) revert Unexpected(what);
    }

    // ============================================================== increase

    function testIncreaseOnV3LeavesTheFeesOwedToThePosition() public {
        uint256 id = _mintFor(owner, 50e18);
        trader.swap(poolAddress, true, 5e19);
        trader.swap(poolAddress, false, 5e19);
        IDominoPositionActions.CreatePlan memory shape = _createFromUsd(20e18, owner, 0);
        IDominoPositionActions.IncreasePlan memory plan;
        plan.intent = shape.intent;
        (plan.intent.action, plan.intent.tokenId) = (DominoV2Types.ACTION_INCREASE, id);
        (plan.inputs, plan.legs, plan.amount0Max, plan.amount1Max) =
            (shape.inputs, shape.legs, type(uint128).max, type(uint128).max);
        uint128 before = _liquidity(id);
        // No approval is needed on v3, but only the owner may use the zap.
        vm.prank(bob);
        vm.expectRevert(IDominoPositionActions.Unauthorized.selector);
        zap.increase(plan);
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.increase(plan);
        _eq(_liquidity(id), before + r.liquidity, "added");
        (uint128 owed0, uint128 owed1) = _owed(id);
        _check(owed0 > 0 && owed1 > 0, "v3 keeps the fees owed in the position");
        _assertZapEmpty();
    }

    // ========================================================== change range

    function testChangeRangeOnV3() public {
        uint256 id = _mintFor(owner, 50e18);
        _approveZapOn(owner, id);
        DominoV2Types.SwapLeg[] memory legs = _oneLeg(_leg(address(usd), address(tkn), 1e18, 0.98e18));
        IDominoPositionActions.ChangeRangePlan memory plan;
        plan.intent =
            _intent(DominoV2Types.ACTION_CHANGE_RANGE, pool, id, -1200, 1200, 1, legs, address(usd), owner, 0);
        (plan.liquidityToRemove, plan.legs, plan.burnOld, plan.amount0Max, plan.amount1Max) =
            (_liquidity(id), legs, true, type(uint128).max, type(uint128).max);
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.changeRange(plan);
        _check(IPositionNft(address(npm)).ownerOf(r.tokenId) == owner && r.tokenId != id, "new NFT to the owner");
        (bool exists,) = address(npm).staticcall(abi.encodeCall(IPositionNft.ownerOf, (id)));
        _check(!exists, "old NFT burned");
        _check(r.feeAmount > 0, "the swap pays 65 bps");
        _assertZapEmpty();
    }

    function testChangeRangeNeedsTheZapApproved() public {
        uint256 id = _mintFor(owner, 50e18);
        IDominoPositionActions.ChangeRangePlan memory plan;
        plan.intent = _intent(
            DominoV2Types.ACTION_CHANGE_RANGE, pool, id, -1200, 1200, 1, _noLegs(), ETH, owner, 0
        );
        (plan.liquidityToRemove, plan.burnOld, plan.amount0Max, plan.amount1Max) =
            (_liquidity(id), true, type(uint128).max, type(uint128).max);
        vm.prank(owner);
        vm.expectRevert(bytes("Not approved"));
        zap.changeRange(plan);
    }

    // ================================================================= exit

    function testExitOnV3BothTokensAndWithConversion() public {
        uint256 id = _mintFor(owner, 50e18);
        trader.swap(poolAddress, true, 5e19);
        trader.swap(poolAddress, false, 5e19);
        _approveZapOn(owner, id);
        uint128 liquidity = _liquidity(id);
        // Half to both tokens, fees included (v3: collect takes everything owed).
        IDominoPositionActions.ExitPlan memory plan = _exitPlan(id, liquidity / 2, _noLegs(), ETH, false);
        (uint256 usd0, uint256 tkn0) = (usd.balanceOf(owner), tkn.balanceOf(owner));
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.exit(plan);
        (uint256 gotUsd, uint256 gotTkn) = pool.currency0 == address(usd) ? (r.amount0, r.amount1) : (r.amount1, r.amount0);
        _eq(usd.balanceOf(owner) - usd0, gotUsd, "usd delivered");
        _eq(tkn.balanceOf(owner) - tkn0, gotTkn, "tkn delivered");
        (uint128 owed0, uint128 owed1) = _owed(id);
        _check(owed0 == 0 && owed1 == 0, "nothing left owed");
        // The rest, converted to USDG and burned.
        DominoV2Types.SwapLeg[] memory legs = _oneLeg(_leg(address(tkn), address(usd), 20e18, 19e18));
        plan = _exitPlan(id, _liquidity(id), legs, address(usd), true);
        vm.prank(owner);
        r = zap.exit(plan);
        _check(r.feeToken == address(usd) && r.feeAmount > 0, "65 bps on the converted output");
        _assertZapEmpty();
    }

    function testExitOnV3RelayedAndTheLingeringApproval() public {
        uint256 id = _mintFor(owner, 50e18);
        _approveZapOn(owner, id);
        IDominoPositionActions.ExitPlan memory plan = _exitPlan(id, _liquidity(id), _noLegs(), ETH, false);
        plan.intent.nonce = 11;
        // Bob, with the approval the owner left on the zap, gets nothing.
        IDominoPositionActions.ExitPlan memory theft = _exitPlan(id, _liquidity(id), _noLegs(), ETH, false);
        theft.intent.recipient = bob;
        vm.prank(bob);
        vm.expectRevert(IDominoPositionActions.Unauthorized.selector);
        zap.exit(theft);
        vm.expectRevert(IDominoZap.InvalidSignature.selector);
        zap.exitWithSignature(theft, _signature(BOB_KEY, _relayedDigest(address(zap), _relayedExit(theft))));

        bytes memory signature = _signature(OWNER_KEY, _relayedDigest(address(zap), _relayedExit(plan)));
        uint256 usd0 = usd.balanceOf(owner);
        vm.prank(bob);
        zap.exitWithSignature(plan, signature);
        _check(usd.balanceOf(owner) > usd0 + 49e18, "the owner is paid");
        vm.expectRevert(abi.encodeWithSelector(IDominoZap.NonceUsed.selector, owner, uint256(11)));
        zap.exitWithSignature(plan, signature);
        _assertZapEmpty();
    }

    function testTheV3ZapRefusesStrayEth() public {
        (bool ok,) = address(zap).call{value: 1}("");
        _check(!ok, "refused");
    }

    // ================================================================= gas

    function testGasPerFlowOnV3() public {
        IDominoPositionActions.CreatePlan memory created = _createFromUsd(100e18, owner, 0);
        uint256 gas = gasleft();
        vm.prank(owner);
        uint256 id = zap.create(created).tokenId;
        _logGas("v3 create with swap (plain)", gas - gasleft());
        IDominoPositionActions.CreatePlan memory shape = _createFromUsd(20e18, owner, 0);
        IDominoPositionActions.IncreasePlan memory increased;
        increased.intent = shape.intent;
        (increased.intent.action, increased.intent.tokenId) = (DominoV2Types.ACTION_INCREASE, id);
        (increased.inputs, increased.legs, increased.amount0Max, increased.amount1Max) =
            (shape.inputs, shape.legs, type(uint128).max, type(uint128).max);
        increased.intent.minLiquidity = 1;
        gas = gasleft();
        vm.prank(owner);
        zap.increase(increased);
        _logGas("v3 increase with swap (plain)", gas - gasleft());
        _approveZapOn(owner, id);
        IDominoPositionActions.ChangeRangePlan memory change;
        change.intent = _intent(DominoV2Types.ACTION_CHANGE_RANGE, pool, id, -1200, 1200, 1, _noLegs(), ETH, owner, 0);
        (change.liquidityToRemove, change.burnOld, change.amount0Max, change.amount1Max) =
            (_liquidity(id), true, type(uint128).max, type(uint128).max);
        gas = gasleft();
        vm.prank(owner);
        uint256 next = zap.changeRange(change).tokenId;
        _logGas("v3 change range, no swap", gas - gasleft());
        _approveZapOn(owner, next);
        DominoV2Types.SwapLeg[] memory legs = _oneLeg(_leg(address(tkn), address(usd), 30e18, 29e18));
        IDominoPositionActions.ExitPlan memory exitPlan = _exitPlan(next, _liquidity(next), legs, address(usd), true);
        (exitPlan.intent.tickLower, exitPlan.intent.tickUpper) = (-1200, 1200);
        gas = gasleft();
        vm.prank(owner);
        zap.exit(exitPlan);
        _logGas("v3 exit with conversion", gas - gasleft());
    }
}
