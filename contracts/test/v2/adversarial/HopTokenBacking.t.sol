// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IUniswapV3PositionManagerMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {IV3PoolInitializerMinimal} from "../../../src/v2/positions/DominoV3Positions.sol";
import {DominoSwapExecutor} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {UniswapBase8453} from "../positions/fixtures/UniswapBase8453.sol";
import {RobinhoodPermit2} from "../route/fixtures/RobinhoodPermit2.sol";
import {MockDominoRegistry, TestToken} from "../route/V2RouteTestKit.sol";
import {ZapBaseFixtures} from "../zap/ZapBaseFixtures.sol";
import {IZap} from "../zap/ZapTestKit.sol";
import {BuyTaxToken} from "./BuyTaxToken.sol";

/// Attack map gap 7 (F-03): a direct v3 leg's intermediate hop token is not
/// one of the action's tokens. The executor paid each hop the amount the
/// previous pool reported, so a hop token that delivers less than reported
/// (a tax on what pools send) was made up from this contract's own balance
/// of it, owed fees included. Each hop now pays forward what arrived.
/// The v3 zap on Base's deployed factory and NonfungiblePositionManager.
contract HopTokenBackingTest is ZapBaseFixtures {
    string internal constant ZAP_ARTIFACT = "DominoZapV3.sol:DominoZapV3";
    bytes32 internal constant POOL_INIT_CODE_HASH = 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
    address internal constant FEE_RECIPIENT = address(0xFEE);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    MockDominoRegistry internal registry;
    IZap internal zap;
    IUniswapV3PositionManagerMinimal internal npm = IUniswapV3PositionManagerMinimal(UniswapBase8453.V3_POSITION_MANAGER);
    TestToken internal usd;
    TestToken internal tkn;
    TestToken internal hop;
    DominoV2Types.PoolRef internal pool;

    function setUp() public {
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
        (usd, tkn, hop) = (new TestToken(), new TestToken(), new TestToken());
        registry.setRank(address(usd), 1);
        address[3] memory funded = [address(this), ALICE, BOB];
        for (uint256 i; i < funded.length; ++i) {
            usd.mint(funded[i], 1e30);
            tkn.mint(funded[i], 1e30);
            hop.mint(funded[i], 1e30);
        }
        (address c0, address c1) = _sorted(address(usd), address(tkn));
        pool = DominoV2Types.PoolRef(DominoV2Types.DEX_V3, c0, c1, 3000, 60, address(0));
        _openPool(address(usd), address(tkn), 3000, 887220, 1e22);
        _openPool(address(usd), address(hop), 500, 887270, 1e25);
        _openPool(address(hop), address(tkn), 500, 887270, 1e25);
        address[2] memory users = [ALICE, BOB];
        for (uint256 i; i < users.length; ++i) {
            vm.startPrank(users[i]);
            usd.approve(address(zap), type(uint256).max);
            tkn.approve(address(zap), type(uint256).max);
            hop.approve(address(zap), type(uint256).max);
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

    function _create(address user, DominoV2Types.TokenAmount[] memory inputs, DominoV2Types.SwapLeg memory leg, address feeToken)
        internal
        returns (bool ok, bytes memory reason)
    {
        IDominoPositionActions.CreatePlan memory plan;
        DominoV2Types.SwapLeg[] memory legs = _oneLeg(leg);
        plan.intent = _intent(DominoV2Types.ACTION_CREATE, pool, 0, -600, 600, 1, legs, feeToken, user, 0);
        (plan.inputs, plan.legs, plan.amount0Max, plan.amount1Max) = (inputs, legs, type(uint128).max, type(uint128).max);
        vm.prank(user);
        (ok, reason) = address(zap).call(abi.encodeCall(IDominoPositionActions.create, (plan)));
    }

    /// Alice's swap through hop alone has no ranked currency, so its fee is
    /// charged in hop (the fallback, its input); the recipient cannot receive
    /// hop, so the fee stays owed.
    function _owedHop() internal returns (uint256 owed) {
        hop.setBlocked(FEE_RECIPIENT, true);
        DominoV2Types.TokenAmount[] memory inputs = new DominoV2Types.TokenAmount[](2);
        inputs[0] = DominoV2Types.TokenAmount(address(hop), 4e18);
        inputs[1] = DominoV2Types.TokenAmount(address(usd), 2e18);
        DominoV2Types.SwapLeg memory leg = DominoV2Types.SwapLeg(
            DominoV2Types.LEG_V3_POOL, address(0), address(hop), address(tkn), 2e18, 1.9e18,
            abi.encodePacked(address(hop), uint24(500), address(tkn))
        );
        (bool ok,) = _create(ALICE, inputs, leg, address(hop));
        _check(ok, "alice's create");
        owed = zap.owedFees(address(hop));
        _eq(owed, 2e18 * 65 / 10_000, "the fee in hop is owed");
        _eq(hop.balanceOf(address(zap)), owed, "and held");
    }

    /// Bob's usd -> hop -> tkn leg, after hop starts taxing 1% of every transfer.
    function _bobsTaxedHopLeg(uint128 amountIn) internal returns (bool ok, bytes memory reason) {
        hop.setTax(100);
        DominoV2Types.SwapLeg memory leg = DominoV2Types.SwapLeg(
            DominoV2Types.LEG_V3_POOL, address(0), address(usd), address(tkn), amountIn, amountIn * 95 / 100,
            abi.encodePacked(address(usd), uint24(500), address(hop), uint24(500), address(tkn))
        );
        (ok, reason) = _create(BOB, _inputs(address(usd), amountIn * 2), leg, address(usd));
    }

    /// The hop's 1% shortfall (1e16) is smaller than what the zap owes in hop
    /// (1.3e16), so only the owed fee could make it up.
    function testATaxedHopTokenNeverSpendsAnOwedFeeInIt() public {
        uint256 owed = _owedHop();
        _bobsTaxedHopLeg(1e18);
        _check(hop.balanceOf(address(zap)) >= zap.owedFees(address(hop)), "the owed fee in hop is still backed");
        _eq(zap.owedFees(address(hop)), owed, "and still owed in full");
    }

    /// A buy-tax hop: the pools' transfers out are taxed, payments into a pool
    /// are not, so the second pool would accept a payment made up from the
    /// zap's own balance of the hop token.
    function testABuyTaxedHopTokenNeverSpendsAnOwedFeeInIt() public {
        BuyTaxToken bhop = new BuyTaxToken();
        address[3] memory funded = [address(this), ALICE, BOB];
        for (uint256 i; i < funded.length; ++i) {
            bhop.mint(funded[i], 1e30);
            vm.prank(funded[i]);
            bhop.approve(address(zap), type(uint256).max);
        }
        address first = _openPool(address(usd), address(bhop), 500, 887270, 1e25);
        address second = _openPool(address(bhop), address(tkn), 500, 887270, 1e25);
        bhop.setTaxedSender(first, true);
        bhop.setTaxedSender(second, true);
        // Alice's bhop -> tkn swap is charged in bhop (no ranked currency), owed.
        bhop.setBlocked(FEE_RECIPIENT, true);
        DominoV2Types.TokenAmount[] memory inputs = new DominoV2Types.TokenAmount[](2);
        inputs[0] = DominoV2Types.TokenAmount(address(bhop), 4e18);
        inputs[1] = DominoV2Types.TokenAmount(address(usd), 2e18);
        (bool ok,) = _create(
            ALICE,
            inputs,
            DominoV2Types.SwapLeg(
                DominoV2Types.LEG_V3_POOL, address(0), address(bhop), address(tkn), 2e18, 1.9e18,
                abi.encodePacked(address(bhop), uint24(500), address(tkn))
            ),
            address(bhop)
        );
        _check(ok, "alice's create");
        uint256 owed = zap.owedFees(address(bhop));
        _eq(owed, 2e18 * 65 / 10_000, "the fee in bhop is owed");
        // Bob's usd -> bhop -> tkn: the first pool's 1% tax (1e16) is less than the owed 1.3e16.
        (ok,) = _create(
            BOB,
            _inputs(address(usd), 2e18),
            DominoV2Types.SwapLeg(
                DominoV2Types.LEG_V3_POOL, address(0), address(usd), address(tkn), 1e18, 0.95e18,
                abi.encodePacked(address(usd), uint24(500), address(bhop), uint24(500), address(tkn))
            ),
            address(usd)
        );
        _check(bhop.balanceOf(address(zap)) >= zap.owedFees(address(bhop)), "the owed fee in bhop is still backed");
        _eq(zap.owedFees(address(bhop)), owed, "and still owed in full");
    }

    /// Without anything held in hop, the taxed hop simply cannot pay its next pool.
    function testATaxedHopWithNothingHeldFails() public {
        (bool ok,) = _bobsTaxedHopLeg(1e18);
        _check(!ok, "the second hop cannot be paid");
    }
}
