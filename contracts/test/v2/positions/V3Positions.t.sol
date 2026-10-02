// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {
    IUniswapV3FactoryMinimal,
    IUniswapV3PoolMinimal,
    IUniswapV3PositionManagerMinimal
} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {DominoPositionMath} from "../../../src/v2/positions/DominoPositionMath.sol";
import {DominoV3Positions} from "../../../src/v2/positions/DominoV3Positions.sol";
import {TickMath} from "../../../src/v2/positions/uniswap/TickMath.sol";
import {UniswapBase8453} from "./fixtures/UniswapBase8453.sol";
import {PositionTestKit, PositionTestToken, V3SwapDriver} from "./PositionTestKit.sol";
import {V3PositionsHarness} from "./V3PositionsHarness.sol";

/// @notice Factory, pool, ERC721 and WETH calls only the tests make.
interface IV3TestSurface {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
    function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external;
    function protocolFees() external view returns (uint128 token0, uint128 token1);
    function approve(address spender, uint256 id) external;
    function setApprovalForAll(address operator, bool approved) external;
    function deposit() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice DominoV3Positions against the factory, NonfungiblePositionManager
/// and WETH9 bytecode deployed on Base (fixtures/base-8453.json); pools come
/// from the factory's own creation code. Robinhood and Arbitrum run the same
/// builds (identical but for immutables).
contract V3PositionsTest is PositionTestKit {
    uint160 internal constant PRICE_ONE = 79228162514264337593543950336;
    bytes32 internal constant POOL_INIT_CODE_HASH = 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
    int24 internal constant LOWER = -600;
    int24 internal constant UPPER = 600;
    address internal constant BOB = address(0xB0B);
    address internal constant RECIPIENT = address(0xBEEF);

    IUniswapV3PositionManagerMinimal internal npm;
    IUniswapV3FactoryMinimal internal factory;
    V3PositionsHarness internal harness;
    V3SwapDriver internal trader;
    PositionTestToken internal token0;
    PositionTestToken internal token1;
    DominoV2Types.PoolRef internal pool;
    address internal poolAddress;

    function setUp() public {
        _installBaseV3();
        // The factory owner (slot 3) may switch a pool's protocol fee on.
        vm.store(UniswapBase8453.V3_FACTORY, bytes32(uint256(3)), bytes32(uint256(uint160(address(this)))));
        npm = IUniswapV3PositionManagerMinimal(UniswapBase8453.V3_POSITION_MANAGER);
        factory = IUniswapV3FactoryMinimal(UniswapBase8453.V3_FACTORY);
        harness = new V3PositionsHarness(npm, factory);
        trader = new V3SwapDriver();
        (token0, token1) = _tokens();
        pool = _pool(address(token0), address(token1), 3000, 60);
        (poolAddress,) = harness.initialize(pool, PRICE_ONE);
        _fund(address(harness));
        _fund(address(trader));
    }

    // --------------------------------------------------------------- helpers

    function _pool(address currency0, address currency1, uint24 fee, int24 spacing)
        internal
        pure
        returns (DominoV2Types.PoolRef memory)
    {
        return DominoV2Types.PoolRef(DominoV2Types.DEX_V3, currency0, currency1, fee, spacing, address(0));
    }

    function _fund(address account) internal {
        token0.mint(account, 1e30);
        token1.mint(account, 1e30);
    }

    function _price(address at) internal view returns (uint160 price) {
        (price,,,,,,) = IUniswapV3PoolMinimal(at).slot0();
    }

    function _trade(address at, uint256 amount) internal {
        trader.swap(at, true, amount);
        trader.swap(at, false, amount);
    }

    function _mintToHarness(uint128 amount) internal returns (DominoV3Positions.Result memory) {
        return harness.mint(pool, LOWER, UPPER, amount, amount, 0, address(harness));
    }

    function _mintToSelf(uint128 amount) internal returns (uint256) {
        return harness.mint(pool, LOWER, UPPER, amount, amount, 0, address(this)).tokenId;
    }

    function _balances(address account) internal view returns (uint256, uint256) {
        return (token0.balanceOf(account), token1.balanceOf(account));
    }

    function _owed(uint256 id) internal view returns (uint128 owed0, uint128 owed1) {
        (,,,,,,,,,, owed0, owed1) = npm.positions(id);
    }

    function _noAllowance(string memory what) internal view {
        _eq(token0.allowance(address(harness), address(npm)), 0, what);
        _eq(token1.allowance(address(harness), address(npm)), 0, what);
    }

    // ------------------------------------------------------------ fixtures

    function testFixturesAreTheProfileBytecodeAndPoolsLandWhereTheManagerLooks() public view {
        _eq(uint256(address(npm).codehash), uint256(UniswapBase8453.V3_POSITION_MANAGER_CODEHASH), "manager code");
        _eq(uint256(address(factory).codehash), uint256(UniswapBase8453.V3_FACTORY_CODEHASH), "factory code");
        _eq(uint256(UniswapBase8453.WETH9.codehash), uint256(UniswapBase8453.WETH9_CODEHASH), "weth code");
        _eqAddress(npm.factory(), address(factory), "manager's factory");
        _eqAddress(npm.WETH9(), UniswapBase8453.WETH9, "manager's WETH9");
        bytes32 salt = keccak256(abi.encode(address(token0), address(token1), uint24(3000)));
        address expected = address(
            uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(factory), salt, POOL_INIT_CODE_HASH))))
        );
        _eqAddress(poolAddress, expected, "pool at the CREATE2 address of the canonical init code hash");
        _eqAddress(harness.poolAddress(pool), expected, "poolAddress");
        _eq(_price(poolAddress), PRICE_ONE, "initialized");
    }

    function testCheckManagersRefusesAMismatchedPair() public {
        harness.checkManagers(npm, factory);
        vm.expectRevert(DominoV3Positions.ManagerMismatch.selector);
        harness.checkManagers(npm, IUniswapV3FactoryMinimal(address(0x1234)));
    }

    // ------------------------------------------------------------- exactness

    function testFuzzMintMatchesTheManagerAndTheMath(uint256 priceSeed, uint128 amount0, uint128 amount1) public {
        uint160 price = uint160(_bound(priceSeed, TickMath.getSqrtPriceAtTick(-1200), TickMath.getSqrtPriceAtTick(1200)));
        DominoV2Types.PoolRef memory fresh = _pool(address(token0), address(token1), 500, 10);
        harness.initialize(fresh, price);
        amount0 = uint128(_bound(amount0, 0, 1e24));
        amount1 = uint128(_bound(amount1, 0, 1e24));
        uint128 liquidity = DominoPositionMath.liquidityForAmounts(price, LOWER, UPPER, amount0, amount1);
        vm.assume(liquidity > 0);
        (uint256 owed0, uint256 owed1) = DominoPositionMath.amountsForLiquidity(price, LOWER, UPPER, liquidity, true);
        (uint256 before0, uint256 before1) = _balances(address(harness));
        DominoV3Positions.Result memory r = harness.mint(fresh, LOWER, UPPER, amount0, amount1, liquidity, BOB);
        (uint256 after0, uint256 after1) = _balances(address(harness));
        _eq(r.liquidity, liquidity, "the manager sizes liquidity as liquidityForAmounts");
        _eqInt(r.delta0, -int256(owed0), "charged0");
        _eqInt(r.delta1, -int256(owed1), "charged1");
        _eq(before0 - after0, owed0, "paid0");
        _eq(before1 - after1, owed1, "paid1");
        _eqAddress(npm.ownerOf(r.tokenId), BOB, "owner");
        _noAllowance("allowance reset after mint");
    }

    function testFuzzWithdrawPaysThePrincipalRoundedDown(uint256 priceSeed, uint128 amount, uint128 removedSeed) public {
        uint160 price = uint160(_bound(priceSeed, TickMath.getSqrtPriceAtTick(-1200), TickMath.getSqrtPriceAtTick(1200)));
        DominoV2Types.PoolRef memory fresh = _pool(address(token0), address(token1), 500, 10);
        harness.initialize(fresh, price);
        amount = uint128(_bound(amount, 1e9, 1e24));
        DominoV3Positions.Result memory minted = harness.mint(fresh, LOWER, UPPER, amount, amount, 0, address(harness));
        uint128 removed = uint128(_bound(removedSeed, 1, minted.liquidity));
        (uint256 out0, uint256 out1) = DominoPositionMath.amountsForLiquidity(price, LOWER, UPPER, removed, false);
        DominoV3Positions.Result memory r =
            harness.withdraw(minted.tokenId, fresh, removed, 0, 0, RECIPIENT, removed == minted.liquidity);
        _eqInt(r.delta0, int256(out0), "principal0");
        _eqInt(r.delta1, int256(out1), "principal1");
        (uint256 got0, uint256 got1) = _balances(RECIPIENT);
        _eq(got0, out0, "delivered0");
        _eq(got1, out1, "delivered1");
    }

    // ---------------------------------------------------------------- guards

    function testMintRefusesBadRecipientsRangesAndLowLiquidity() public {
        vm.expectRevert(abi.encodeWithSelector(DominoV3Positions.InvalidRecipient.selector, address(0)));
        harness.mint(pool, LOWER, UPPER, 1e18, 1e18, 0, address(0));
        vm.expectRevert(abi.encodeWithSelector(DominoPositionMath.InvalidRange.selector, LOWER, int24(630), int24(60)));
        harness.mint(pool, LOWER, 630, 1e18, 1e18, 0, BOB);
        uint128 expected = DominoPositionMath.liquidityForAmounts(PRICE_ONE, LOWER, UPPER, 1e18, 1e18);
        vm.expectRevert(abi.encodeWithSelector(DominoV3Positions.InsufficientLiquidity.selector, expected, expected + 1));
        harness.mint(pool, LOWER, UPPER, 1e18, 1e18, expected + 1, BOB);
        uint256 id = _mintToHarness(1e18).tokenId;
        vm.expectRevert(abi.encodeWithSelector(DominoV3Positions.InsufficientLiquidity.selector, expected, expected + 1));
        harness.increase(id, pool, 1e18, 1e18, expected + 1);
        vm.expectRevert(abi.encodeWithSelector(DominoV3Positions.InvalidRecipient.selector, address(0)));
        harness.withdraw(id, pool, 1, 0, 0, address(0), false);
    }

    function testPoolsTheFactoryDoesNotDescribeAreRefused() public {
        DominoV2Types.PoolRef[9] memory bad;
        for (uint256 i; i < 9; ++i) {
            bad[i] = pool;
        }
        bad[0].dex = DominoV2Types.DEX_V4;
        bad[1].hooks = address(0x1234);
        bad[2].currency0 = address(0);
        (bad[3].currency0, bad[3].currency1) = (address(token1), address(token0));
        bad[4].currency1 = address(token0);
        bad[5].tickSpacing = 0;
        bad[6].tickSpacing = 10;
        bad[7].fee = 1234;
        // A fee the factory never enabled has spacing 0: a zero spacing must not match it.
        (bad[8].fee, bad[8].tickSpacing) = (1234, 0);
        for (uint256 i; i < 9; ++i) {
            vm.expectRevert(DominoV3Positions.InvalidPool.selector);
            harness.poolAddress(bad[i]);
            vm.expectRevert(DominoV3Positions.InvalidPool.selector);
            harness.mint(bad[i], LOWER, UPPER, 1e18, 1e18, 0, BOB);
            vm.expectRevert(DominoV3Positions.InvalidPool.selector);
            harness.initialize(bad[i], PRICE_ONE);
        }
    }

    function testActionsRefuseAPositionOfAnotherPool() public {
        uint256 id = _mintToHarness(1e18).tokenId;
        DominoV2Types.PoolRef[3] memory others;
        for (uint256 i; i < 3; ++i) {
            others[i] = pool;
        }
        others[0].currency0 = address(0x1234);
        others[1].currency1 = address(0x1234);
        others[2].fee = 500;
        for (uint256 i; i < 3; ++i) {
            bytes memory mismatch = abi.encodeWithSelector(DominoV3Positions.PositionPoolMismatch.selector, id);
            vm.expectRevert(mismatch);
            harness.increase(id, others[i], 1e18, 1e18, 0);
            vm.expectRevert(mismatch);
            harness.withdraw(id, others[i], 1, 0, 0, RECIPIENT, false);
        }
        DominoV2Types.PoolRef memory v4 = pool;
        v4.dex = DominoV2Types.DEX_V4;
        vm.expectRevert(DominoV3Positions.InvalidPool.selector);
        harness.increase(id, v4, 1e18, 1e18, 0);
    }

    function testApprovalsThatFailAreRefusedAndNoAllowanceSurvives() public {
        PositionTestToken quirky = new PositionTestToken("QRK");
        quirky.mint(address(harness), 1e30);
        (address c0, address c1) =
            address(quirky) < address(token1) ? (address(quirky), address(token1)) : (address(token1), address(quirky));
        DominoV2Types.PoolRef memory ref = _pool(c0, c1, 3000, 60);
        harness.initialize(ref, PRICE_ONE);
        quirky.setQuirks(quirky.APPROVE_FALSE(), 0);
        vm.expectRevert(abi.encodeWithSelector(DominoV3Positions.ApprovalFailed.selector, address(quirky)));
        harness.mint(ref, LOWER, UPPER, 1e18, 1e18, 0, BOB);
        quirky.setQuirks(quirky.APPROVE_REVERTS(), 0);
        vm.expectRevert(abi.encodeWithSelector(DominoV3Positions.ApprovalFailed.selector, address(quirky)));
        harness.mint(ref, LOWER, UPPER, 1e18, 1e18, 0, BOB);
        // A token that returns nothing (USDT style) works, and keeps no allowance.
        quirky.setQuirks(quirky.NO_RETURN_DATA(), 0);
        DominoV3Positions.Result memory r = harness.mint(ref, LOWER, UPPER, 1e18, 3e18, 0, BOB);
        _true(r.liquidity > 0, "minted");
        _eq(quirky.allowance(address(harness), address(npm)), 0, "quirky allowance reset");
        _eq(token1.allowance(address(harness), address(npm)), 0, "token1 allowance reset");
        harness.increase(r.tokenId, ref, 1e18, 3e18, 0);
        _eq(quirky.allowance(address(harness), address(npm)), 0, "quirky allowance reset after increase");
        _eq(token1.allowance(address(harness), address(npm)), 0, "token1 allowance reset after increase");
    }

    // ------------------------------------------------------- fees and payouts

    function testIncreaseIsOpenToAnyoneAndLeavesTheFeesOwed() public {
        uint256 id = _mintToSelf(1e20);
        _trade(poolAddress, 1e19);
        (uint256 fees0, uint256 fees1) = harness.collectable(id);
        _true(fees0 > 0 && fees1 > 0, "fees accrued");
        _true(!harness.isAuthorized(id, address(harness)), "the harness is a stranger");
        uint160 price = _price(poolAddress);
        uint128 added = DominoPositionMath.liquidityForAmounts(price, LOWER, UPPER, 1e18, 1e18);
        (uint256 principal0, uint256 principal1) =
            DominoPositionMath.amountsForLiquidity(price, LOWER, UPPER, added, true);
        DominoV3Positions.Result memory r = harness.increase(id, pool, 1e18, 1e18, added);
        _eqInt(r.delta0, -int256(principal0), "a stranger pays only the principal0");
        _eqInt(r.delta1, -int256(principal1), "a stranger pays only the principal1");
        (uint256 still0, uint256 still1) = harness.collectable(id);
        _eq(still0, fees0, "fees0 stay owed to the position");
        _eq(still1, fees1, "fees1 stay owed to the position");
        (uint128 owed0, uint128 owed1) = _owed(id);
        _eq(owed0, fees0, "moved into tokensOwed0");
        _eq(owed1, fees1, "moved into tokensOwed1");
        _noAllowance("allowance reset after increase");
    }

    function testWithdrawAndCollectNeedTheOwnersApproval() public {
        uint256 id = _mintToSelf(1e18);
        vm.expectRevert(bytes("Not approved"));
        harness.withdraw(id, pool, 1, 0, 0, RECIPIENT, false);
        vm.expectRevert(bytes("Not approved"));
        harness.collect(id, pool, RECIPIENT);
        IV3TestSurface(address(npm)).approve(address(harness), id);
        _true(harness.isAuthorized(id, address(harness)), "approved");
        harness.withdraw(id, pool, 1, 0, 0, RECIPIENT, false);
        harness.collect(id, pool, RECIPIENT);
    }

    function testWithdrawDeliversThePrincipalAndEveryOwedFee() public {
        DominoV3Positions.Result memory minted = _mintToHarness(1e20);
        _trade(poolAddress, 1e19);
        (uint256 fees0, uint256 fees1) = harness.collectable(minted.tokenId);
        uint128 half = minted.liquidity / 2;
        (uint256 out0, uint256 out1) =
            DominoPositionMath.amountsForLiquidity(_price(poolAddress), LOWER, UPPER, half, false);
        vm.expectRevert(bytes("Price slippage check"));
        harness.withdraw(minted.tokenId, pool, half, uint128(out0 + 1), uint128(out1), RECIPIENT, false);
        DominoV3Positions.Result memory r =
            harness.withdraw(minted.tokenId, pool, half, uint128(out0), uint128(out1), RECIPIENT, false);
        _eqInt(r.delta0, int256(out0 + fees0), "principal and fees0");
        _eqInt(r.delta1, int256(out1 + fees1), "principal and fees1");
        (uint256 got0, uint256 got1) = _balances(RECIPIENT);
        _eq(got0, out0 + fees0, "recipient0");
        _eq(got1, out1 + fees1, "recipient1");
        (uint128 owed0, uint128 owed1) = _owed(minted.tokenId);
        _eq(owed0 + owed1, 0, "nothing left owed");
    }

    function testWithdrawWithBurnTakesEverythingAndBurns() public {
        DominoV3Positions.Result memory minted = _mintToHarness(1e20);
        _trade(poolAddress, 1e19);
        (uint256 fees0, uint256 fees1) = harness.collectable(minted.tokenId);
        vm.expectRevert(
            abi.encodeWithSelector(
                DominoV3Positions.PartialBurn.selector, minted.tokenId, minted.liquidity - 1, minted.liquidity
            )
        );
        harness.withdraw(minted.tokenId, pool, minted.liquidity - 1, 0, 0, RECIPIENT, true);
        (uint256 out0, uint256 out1) =
            DominoPositionMath.amountsForLiquidity(_price(poolAddress), LOWER, UPPER, minted.liquidity, false);
        DominoV3Positions.Result memory r =
            harness.withdraw(minted.tokenId, pool, minted.liquidity, 0, 0, RECIPIENT, true);
        _eqInt(r.delta0, int256(out0 + fees0), "everything0");
        _eqInt(r.delta1, int256(out1 + fees1), "everything1");
        vm.expectRevert(bytes("ERC721: owner query for nonexistent token"));
        npm.ownerOf(minted.tokenId);
    }

    function testCollectDeliversWhatIsOwedWithoutChangingLiquidity() public {
        DominoV3Positions.Result memory minted = _mintToHarness(1e20);
        _trade(poolAddress, 1e19);
        (uint256 fees0, uint256 fees1) = harness.collectable(minted.tokenId);
        DominoV3Positions.Result memory r = harness.collect(minted.tokenId, pool, RECIPIENT);
        _eqInt(r.delta0, int256(fees0), "fees0");
        _eqInt(r.delta1, int256(fees1), "fees1");
        _eq(harness.position(minted.tokenId).liquidity, minted.liquidity, "liquidity kept");
        // Liquidity removed without a burn and collected later: zero liquidity, minimums ignored.
        harness.withdraw(minted.tokenId, pool, minted.liquidity, 0, 0, RECIPIENT, false);
        r = harness.withdraw(minted.tokenId, pool, 0, 1, 1, RECIPIENT, true);
        _eqInt(r.delta0 + r.delta1, 0, "nothing left");
        vm.expectRevert(bytes("ERC721: owner query for nonexistent token"));
        npm.ownerOf(minted.tokenId);
    }

    function testProtocolFeeComesOutBeforeTheLpFees() public {
        (PositionTestToken twin0, PositionTestToken twin1) = _tokens();
        twin0.mint(address(harness), 1e30);
        twin1.mint(address(harness), 1e30);
        twin0.mint(address(trader), 1e30);
        twin1.mint(address(trader), 1e30);
        DominoV2Types.PoolRef memory twin = _pool(address(twin0), address(twin1), 3000, 60);
        (address twinAddress,) = harness.initialize(twin, PRICE_ONE);
        IV3TestSurface(poolAddress).setFeeProtocol(4, 4);
        (,,,,, uint8 feeProtocol,) = IUniswapV3PoolMinimal(poolAddress).slot0();
        _eq(feeProtocol, 4 | (4 << 4), "a quarter of the fee to the protocol");
        uint256 id = _mintToHarness(1e20).tokenId;
        uint256 twinId = harness.mint(twin, LOWER, UPPER, 1e20, 1e20, 0, address(harness)).tokenId;
        _trade(poolAddress, 1e19);
        _trade(twinAddress, 1e19);
        (uint256 fees0, uint256 fees1) = harness.collectable(id);
        (uint256 full0, uint256 full1) = harness.collectable(twinId);
        _true(fees0 < full0 && fees1 < full1, "the protocol share is not the LPs'");
        (uint128 protocol0, uint128 protocol1) = IV3TestSurface(poolAddress).protocolFees();
        _true(protocol0 > 0 && protocol1 > 0, "protocol fees accrued");
        DominoV3Positions.Result memory r = harness.collect(id, pool, RECIPIENT);
        _eqInt(r.delta0, int256(fees0), "collectable0 is what collect pays");
        _eqInt(r.delta1, int256(fees1), "collectable1 is what collect pays");
    }

    function testWrappedNativeIsAPlainToken() public {
        address weth = UniswapBase8453.WETH9;
        vm.deal(address(this), 1e21);
        IV3TestSurface(weth).deposit{value: 1e21}();
        IV3TestSurface(weth).transfer(address(harness), 1e21);
        (address c0, address c1) = weth < address(token1) ? (weth, address(token1)) : (address(token1), weth);
        DominoV2Types.PoolRef memory ref = _pool(c0, c1, 500, 10);
        harness.initialize(ref, PRICE_ONE);
        uint256 ethBefore = address(harness).balance;
        DominoV3Positions.Result memory minted = harness.mint(ref, LOWER, UPPER, 1e20, 1e20, 0, address(harness));
        int256 paidWeth = weth == c0 ? minted.delta0 : minted.delta1;
        _eq(IV3TestSurface(weth).balanceOf(address(harness)), uint256(int256(1e21) + paidWeth), "paid in WETH");
        DominoV3Positions.Result memory r =
            harness.withdraw(minted.tokenId, ref, minted.liquidity, 0, 0, RECIPIENT, true);
        int256 outWeth = weth == c0 ? r.delta0 : r.delta1;
        _eq(IV3TestSurface(weth).balanceOf(RECIPIENT), uint256(outWeth), "delivered in WETH");
        _eq(address(harness).balance, ethBefore, "no ether involved");
        _eq(RECIPIENT.balance, 0, "no ether delivered");
    }

    // ----------------------------------------------------- reads and set-up

    function testReadsMatchTheManager() public {
        uint256 inRange = _mintToHarness(1e20).tokenId;
        uint256 below = harness.mint(pool, -1200, -600, 1e20, 1e20, 0, address(harness)).tokenId;
        uint256 above = harness.mint(pool, 600, 1200, 1e20, 1e20, 0, address(harness)).tokenId;
        trader.swap(poolAddress, true, 5e20);
        trader.swap(poolAddress, false, 8e20);
        trader.swap(poolAddress, true, 1e20);
        uint256[3] memory ids = [below, inRange, above];
        for (uint256 i; i < 3; ++i) {
            (uint256 fees0, uint256 fees1) = harness.collectable(ids[i]);
            _true(fees0 + fees1 > 0, "fees accrued in every range");
            DominoV3Positions.Result memory r = harness.collect(ids[i], pool, RECIPIENT);
            _eqInt(r.delta0, int256(fees0), "collectable0");
            _eqInt(r.delta1, int256(fees1), "collectable1");
            // collect checkpoints the position at the pool's current fee growth inside.
            DominoV3Positions.Position memory p = harness.position(ids[i]);
            (uint256 inside0, uint256 inside1) = harness.feeGrowthInside(poolAddress, p.tickLower, p.tickUpper);
            _eq(inside0, p.feeGrowthInside0LastX128, "fee growth inside0");
            _eq(inside1, p.feeGrowthInside1LastX128, "fee growth inside1");
        }
        DominoV3Positions.Position memory q = harness.position(inRange);
        (,,,,,,, uint128 liquidity,,,,) = npm.positions(inRange);
        _eq(q.liquidity, liquidity, "liquidity");
        _eqAddress(q.owner, address(harness), "owner");
        _eqAddress(q.approved, address(0), "approval");
        _eqInt(q.tickLower, LOWER, "lower");
        _eqInt(q.tickUpper, UPPER, "upper");
        _true(
            q.pool.dex == DominoV2Types.DEX_V3 && q.pool.currency0 == pool.currency0 && q.pool.currency1 == pool.currency1
                && q.pool.fee == pool.fee && q.pool.tickSpacing == pool.tickSpacing && q.pool.hooks == address(0),
            "pool"
        );
    }

    function testInitializeCreatesInitializesOrKeepsThePrice() public {
        (address existing, uint160 current) = harness.initialize(pool, PRICE_ONE * 2);
        _eqAddress(existing, poolAddress, "existing pool");
        _eq(current, PRICE_ONE, "existing price kept");
        DominoV2Types.PoolRef memory fresh = _pool(address(token0), address(token1), 500, 10);
        _eqAddress(harness.poolAddress(fresh), address(0), "not created yet");
        (address created, uint160 price) = harness.initialize(fresh, PRICE_ONE * 2);
        _eqAddress(harness.poolAddress(fresh), created, "created");
        _eq(price, PRICE_ONE * 2, "initialized");
        DominoV2Types.PoolRef memory bare = _pool(address(token0), address(token1), 10000, 200);
        address uninitialized = IV3TestSurface(address(factory)).createPool(address(token0), address(token1), 10000);
        (address same, uint160 set) = harness.initialize(bare, PRICE_ONE);
        _eqAddress(same, uninitialized, "created by someone else");
        _eq(set, PRICE_ONE, "initialized now");
    }

    function testIsAuthorizedFollowsOwnerApprovalAndOperator() public {
        uint256 id = _mintToSelf(1e18);
        _true(harness.isAuthorized(id, address(this)), "owner");
        _true(!harness.isAuthorized(id, address(harness)), "stranger");
        IV3TestSurface(address(npm)).approve(address(harness), id);
        _true(harness.isAuthorized(id, address(harness)), "approved");
        _eqAddress(harness.position(id).approved, address(harness), "approval read from the manager");
        IV3TestSurface(address(npm)).approve(address(0), id);
        _true(!harness.isAuthorized(id, address(harness)), "approval revoked");
        IV3TestSurface(address(npm)).setApprovalForAll(address(harness), true);
        _true(harness.isAuthorized(id, address(harness)), "operator");
    }

    // -------------------------------------------------------------- journeys

    function testRoundTripMintIncreaseCollectDecreaseBurn() public {
        DominoV3Positions.Result memory minted = _mintToHarness(1e20);
        uint256 id = minted.tokenId;
        uint128 liquidity = minted.liquidity;
        _trade(poolAddress, 1e19);
        uint160 price = _price(poolAddress);
        uint128 added = DominoPositionMath.liquidityForAmounts(price, LOWER, UPPER, 1e19, 1e19);
        (uint256 in0, uint256 in1) = DominoPositionMath.amountsForLiquidity(price, LOWER, UPPER, added, true);
        DominoV3Positions.Result memory r = harness.increase(id, pool, 1e19, 1e19, added);
        _eqInt(r.delta0, -int256(in0), "increase0");
        _eqInt(r.delta1, -int256(in1), "increase1");
        liquidity += added;
        _trade(poolAddress, 1e19);
        (uint256 fees0, uint256 fees1) = harness.collectable(id);
        r = harness.collect(id, pool, RECIPIENT);
        _eqInt(r.delta0, int256(fees0), "collect0");
        _eqInt(r.delta1, int256(fees1), "collect1");
        _trade(poolAddress, 1e19);
        (fees0, fees1) = harness.collectable(id);
        (uint256 out0, uint256 out1) =
            DominoPositionMath.amountsForLiquidity(_price(poolAddress), LOWER, UPPER, liquidity / 3, false);
        r = harness.withdraw(id, pool, liquidity / 3, 0, 0, RECIPIENT, false);
        _eqInt(r.delta0, int256(out0 + fees0), "decrease0");
        _eqInt(r.delta1, int256(out1 + fees1), "decrease1");
        liquidity -= liquidity / 3;
        _trade(poolAddress, 1e19);
        (fees0, fees1) = harness.collectable(id);
        (out0, out1) = DominoPositionMath.amountsForLiquidity(_price(poolAddress), LOWER, UPPER, liquidity, false);
        r = harness.withdraw(id, pool, liquidity, 0, 0, RECIPIENT, true);
        _eqInt(r.delta0, int256(out0 + fees0), "exit0");
        _eqInt(r.delta1, int256(out1 + fees1), "exit1");
        _noAllowance("no allowance after the journey");
    }
}
