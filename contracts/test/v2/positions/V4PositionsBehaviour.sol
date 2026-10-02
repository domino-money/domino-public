// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {
    IV4PoolManagerMinimal,
    IV4PositionManagerMinimal,
    IV4StateViewMinimal
} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {DominoPositionMath} from "../../../src/v2/positions/DominoPositionMath.sol";
import {DominoV4Positions} from "../../../src/v2/positions/DominoV4Positions.sol";
import {TickMath} from "../../../src/v2/positions/uniswap/TickMath.sol";
import {PositionTestKit, PositionTestToken, PositionsVm, V4SwapDriver, V4TestSubscriber} from "./PositionTestKit.sol";
import {V4PositionsHarness, V4Steps} from "./V4PositionsHarness.sol";

/// @notice Owner, ERC721 and protocol-fee calls only the tests make.
interface IV4TestSurface {
    function setProtocolFeeController(address controller) external;
    function setProtocolFee(IV4PoolManagerMinimal.PoolKey memory key, uint24 newProtocolFee) external;
    function protocolFeesAccrued(address currency) external view returns (uint256);
    function approve(address spender, uint256 id) external;
    function setApprovalForAll(address operator, bool approved) external;
    function transferFrom(address from, address to, uint256 id) external;
}

/// @notice DominoV4Positions against a real PoolManager and PositionManager.
/// Two suites run it: V4PositionsDeployed.t.sol on the bytecode deployed on
/// Base, and V4PositionsVendored.t.sol on the newer vendored build.
abstract contract V4PositionsBehaviour is PositionTestKit {
    uint160 internal constant PRICE_ONE = 79228162514264337593543950336;
    int24 internal constant LOWER = -600;
    int24 internal constant UPPER = 600;
    address internal constant BOB = address(0xB0B);
    address internal constant RECIPIENT = address(0xBEEF);
    bytes4 internal constant NOT_APPROVED = bytes4(keccak256("NotApproved(address)"));
    bytes4 internal constant WRAPPED_ERROR = bytes4(keccak256("WrappedError(address,bytes4,bytes,bytes)"));
    bytes4 internal constant MINIMUM_AMOUNT = bytes4(keccak256("MinimumAmountInsufficient(uint128,uint128)"));
    bytes4 internal constant MAXIMUM_AMOUNT = bytes4(keccak256("MaximumAmountExceeded(uint128,uint128)"));
    bytes32 internal constant MODIFY_POSITION = keccak256("ModifyPosition(bytes32,address,int24,int24,int256,bytes32)");

    IV4PoolManagerMinimal internal manager;
    IV4PositionManagerMinimal internal positions;
    IV4StateViewMinimal internal stateView;
    V4PositionsHarness internal harness;
    V4SwapDriver internal trader;
    PositionTestToken internal token0;
    PositionTestToken internal token1;
    DominoV2Types.PoolRef internal pool;
    DominoV2Types.PoolRef internal nativePool;

    /// The PoolManager (owned by this test), PositionManager (unsubscribe gas
    /// limit 300,000) and StateView under test.
    function _deployStack() internal virtual returns (address manager_, address positions_, address stateView_);

    /// Whether this PositionManager build emits ModifyPosition (deployed: no).
    function _emitsModifyPosition() internal pure virtual returns (bool);

    function setUp() public {
        (address manager_, address positions_, address stateView_) = _deployStack();
        manager = IV4PoolManagerMinimal(manager_);
        positions = IV4PositionManagerMinimal(positions_);
        stateView = IV4StateViewMinimal(stateView_);
        harness = new V4PositionsHarness(manager, positions);
        trader = new V4SwapDriver(manager);
        (token0, token1) = _tokens();
        pool = _pool(address(token0), address(token1), 3000, 60);
        nativePool = _pool(address(0), address(token1), 500, 10);
        harness.initialize(pool, PRICE_ONE);
        harness.initialize(nativePool, PRICE_ONE);
        _fund(address(harness));
        _fund(address(trader));
    }

    // --------------------------------------------------------------- helpers

    function _pool(address currency0, address currency1, uint24 fee, int24 spacing)
        internal
        pure
        returns (DominoV2Types.PoolRef memory)
    {
        return DominoV2Types.PoolRef(DominoV2Types.DEX_V4, currency0, currency1, fee, spacing, address(0));
    }

    function _key(DominoV2Types.PoolRef memory ref) internal pure returns (IV4PoolManagerMinimal.PoolKey memory) {
        return IV4PoolManagerMinimal.PoolKey(ref.currency0, ref.currency1, ref.fee, ref.tickSpacing, ref.hooks);
    }

    function _fund(address account) internal {
        token0.mint(account, 1e30);
        token1.mint(account, 1e30);
        vm.deal(account, 1e30);
    }

    function _price(DominoV2Types.PoolRef memory ref) internal view returns (uint160 price) {
        (price,,,) = harness.slot0(ref);
    }

    function _trade(DominoV2Types.PoolRef memory ref, uint256 amount) internal {
        trader.swap(_key(ref), true, amount);
        trader.swap(_key(ref), false, amount);
    }

    function _mintToHarness(DominoV2Types.PoolRef memory ref, uint128 amount)
        internal
        returns (DominoV4Positions.Result memory)
    {
        return harness.mint(ref, LOWER, UPPER, amount, amount, 0, address(harness));
    }

    function _mintToSelf(uint128 amount) internal returns (uint256 id) {
        id = harness.mint(pool, LOWER, UPPER, amount, amount, 0, address(this)).tokenId;
    }

    function _step(uint8 op, bytes memory args) internal pure returns (V4PositionsHarness.Step memory) {
        return V4PositionsHarness.Step(op, args);
    }

    /// DECREASE_LIQUIDITY of zero sent straight to the PositionManager: it
    /// credits the fees and leaves them open.
    function _rawCollect(uint256 id) internal pure returns (V4PositionsHarness.Step memory) {
        bytes[] memory params = new bytes[](1);
        params[0] = abi.encode(id, uint256(0), uint128(0), uint128(0), bytes(""));
        return _step(V4Steps.RAW, abi.encode(abi.encodePacked(uint8(0x01)), params));
    }

    function _balances(address account) internal view returns (uint256, uint256) {
        return (token0.balanceOf(account), token1.balanceOf(account));
    }

    // -------------------------------------------------------------- the stack

    function testStackIsWiredAsDeployed() public view {
        _eqAddress(positions.poolManager(), address(manager), "position manager's pool manager");
        _eq(positions.unsubscribeGasLimit(), 300_000, "unsubscribe gas limit");
        _eq(_price(pool), PRICE_ONE, "initialized price");
    }

    function testCheckManagersRefusesAMismatchedPair() public {
        harness.checkManagers(manager, positions);
        vm.expectRevert(DominoV4Positions.ManagerMismatch.selector);
        harness.checkManagers(IV4PoolManagerMinimal(address(0x1234)), positions);
    }

    function testModifyPositionEventMatchesTheBuild() public {
        vm.recordLogs();
        _mintToHarness(pool, 1e18);
        PositionsVm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(positions) && logs[i].topics.length != 0 && logs[i].topics[0] == MODIFY_POSITION) {
                seen = true;
            }
        }
        _true(seen == _emitsModifyPosition(), "ModifyPosition only from the newer vendored build");
    }

    // ------------------------------------------------------------- exactness

    function testFuzzMintPaysExactlyWhatThePoolCharges(uint256 priceSeed, uint128 amount0, uint128 amount1) public {
        uint160 price = uint160(_bound(priceSeed, TickMath.getSqrtPriceAtTick(-1200), TickMath.getSqrtPriceAtTick(1200)));
        DominoV2Types.PoolRef memory fresh = _pool(address(token0), address(token1), 3001, 60);
        harness.initialize(fresh, price);
        amount0 = uint128(_bound(amount0, 0, 1e24));
        amount1 = uint128(_bound(amount1, 0, 1e24));
        uint128 liquidity = DominoPositionMath.liquidityForAmounts(price, LOWER, UPPER, amount0, amount1);
        vm.assume(liquidity > 0);
        (uint256 owed0, uint256 owed1) = DominoPositionMath.amountsForLiquidity(price, LOWER, UPPER, liquidity, true);
        _true(owed0 <= amount0 && owed1 <= amount1, "charge within the desired amounts");
        (uint256 before0, uint256 before1) = _balances(address(harness));
        DominoV4Positions.Result memory r = harness.mint(fresh, LOWER, UPPER, amount0, amount1, liquidity, BOB);
        (uint256 after0, uint256 after1) = _balances(address(harness));
        _eq(r.liquidity, liquidity, "liquidity");
        _eqInt(r.delta0, -int256(owed0), "delta0");
        _eqInt(r.delta1, -int256(owed1), "delta1");
        _eq(before0 - after0, owed0, "paid0");
        _eq(before1 - after1, owed1, "paid1");
        _eqAddress(positions.ownerOf(r.tokenId), BOB, "owner");
        _eq(positions.getPositionLiquidity(r.tokenId), liquidity, "position liquidity");
        _eq(positions.nextTokenId(), r.tokenId + 1, "token id");
    }

    function testFuzzWithdrawPaysThePrincipalRoundedDown(uint256 priceSeed, uint128 liquidity, uint128 removed)
        public
    {
        uint160 price = uint160(_bound(priceSeed, TickMath.getSqrtPriceAtTick(-1200), TickMath.getSqrtPriceAtTick(1200)));
        DominoV2Types.PoolRef memory fresh = _pool(address(token0), address(token1), 3001, 60);
        harness.initialize(fresh, price);
        liquidity = uint128(_bound(liquidity, 1e6, 1e24));
        removed = uint128(_bound(removed, 1, liquidity));
        uint256 id = harness.mintLiquidity(fresh, LOWER, UPPER, liquidity, type(uint128).max, type(uint128).max, address(harness))
            .tokenId;
        (uint256 out0, uint256 out1) = DominoPositionMath.amountsForLiquidity(price, LOWER, UPPER, removed, false);
        DominoV4Positions.Result memory r =
            harness.withdraw(id, fresh, removed, 0, 0, RECIPIENT, removed == liquidity);
        _eqInt(r.delta0, int256(out0), "principal0");
        _eqInt(r.delta1, int256(out1), "principal1");
        (uint256 got0, uint256 got1) = _balances(RECIPIENT);
        _eq(got0, out0, "delivered0");
        _eq(got1, out1, "delivered1");
    }

    function testExplicitLiquidityIsBoundedByTheMaxima() public {
        uint256 id = _mintToHarness(pool, 1e20).tokenId;
        uint128 liquidity = 1e18;
        (uint256 owed0, uint256 owed1) = DominoPositionMath.amountsForLiquidity(PRICE_ONE, LOWER, UPPER, liquidity, true);
        vm.expectRevert(abi.encodeWithSelector(MAXIMUM_AMOUNT, uint128(owed0 - 1), uint128(owed0)));
        harness.increaseLiquidity(id, pool, liquidity, uint128(owed0 - 1), uint128(owed1));
        DominoV4Positions.Result memory r = harness.increaseLiquidity(id, pool, liquidity, uint128(owed0), uint128(owed1));
        _eqInt(r.delta0, -int256(owed0), "increase paid0");
        _eqInt(r.delta1, -int256(owed1), "increase paid1");
        vm.expectRevert(abi.encodeWithSelector(MAXIMUM_AMOUNT, uint128(owed1 - 1), uint128(owed1)));
        harness.mintLiquidity(pool, LOWER, UPPER, liquidity, uint128(owed0), uint128(owed1 - 1), BOB);
        r = harness.mintLiquidity(pool, LOWER, UPPER, liquidity, uint128(owed0), uint128(owed1), BOB);
        _eq(positions.getPositionLiquidity(r.tokenId), liquidity, "minted liquidity");
    }

    // ---------------------------------------------------------------- guards

    function testMintAndIncreaseRefuseTooLittleLiquidity() public {
        uint128 expected = DominoPositionMath.liquidityForAmounts(PRICE_ONE, LOWER, UPPER, 1e18, 1e18);
        vm.expectRevert(abi.encodeWithSelector(DominoV4Positions.InsufficientLiquidity.selector, expected, expected + 1));
        harness.mint(pool, LOWER, UPPER, 1e18, 1e18, expected + 1, BOB);
        vm.expectRevert(abi.encodeWithSelector(DominoV4Positions.InsufficientLiquidity.selector, uint128(0), uint128(0)));
        harness.mint(pool, LOWER, UPPER, 0, 0, 0, BOB);
        uint256 id = _mintToHarness(pool, 1e18).tokenId;
        vm.expectRevert(abi.encodeWithSelector(DominoV4Positions.InsufficientLiquidity.selector, expected, expected + 1));
        harness.increase(id, pool, 1e18, 1e18, expected + 1);
        vm.expectRevert(abi.encodeWithSelector(DominoV4Positions.InsufficientLiquidity.selector, uint128(0), uint128(0)));
        harness.increase(id, pool, 0, 0, 0);
    }

    function testReservedRecipientsAreRefused() public {
        uint256 id = _mintToHarness(pool, 1e18).tokenId;
        for (uint160 reserved; reserved <= 2; ++reserved) {
            vm.expectRevert(abi.encodeWithSelector(DominoV4Positions.InvalidRecipient.selector, address(reserved)));
            harness.mint(pool, LOWER, UPPER, 1e18, 1e18, 0, address(reserved));
            vm.expectRevert(abi.encodeWithSelector(DominoV4Positions.InvalidRecipient.selector, address(reserved)));
            harness.withdraw(id, pool, 1, 0, 0, address(reserved), false);
        }
        harness.withdraw(id, pool, 1, 0, 0, address(3), false);
    }

    function testInvalidRangesPoolsAndUninitializedPoolsAreRefused() public {
        vm.expectRevert(abi.encodeWithSelector(DominoPositionMath.InvalidRange.selector, int24(-601), UPPER, int24(60)));
        harness.mint(pool, -601, UPPER, 1e18, 1e18, 0, BOB);
        vm.expectRevert(abi.encodeWithSelector(DominoPositionMath.InvalidRange.selector, LOWER, int24(601), int24(60)));
        harness.mintLiquidity(pool, LOWER, 601, 1e18, 1e20, 1e20, BOB);
        DominoV2Types.PoolRef memory v3 = pool;
        v3.dex = DominoV2Types.DEX_V3;
        vm.expectRevert(DominoV4Positions.InvalidPool.selector);
        harness.mint(v3, LOWER, UPPER, 1e18, 1e18, 0, BOB);
        vm.expectRevert(DominoV4Positions.InvalidPool.selector);
        harness.mintLiquidity(v3, LOWER, UPPER, 1e18, 1e20, 1e20, BOB);
        vm.expectRevert(DominoPositionMath.PoolNotInitialized.selector);
        harness.mint(_pool(address(token0), address(token1), 3002, 60), LOWER, UPPER, 1e18, 1e18, 0, BOB);
    }

    function testActionsRefuseAPositionOfAnotherPool() public {
        uint256 id = _mintToHarness(pool, 1e18).tokenId;
        DominoV2Types.PoolRef[5] memory others;
        for (uint256 i; i < 5; ++i) {
            others[i] = pool;
        }
        others[0].currency0 = address(0);
        others[1].currency1 = address(0x1234);
        others[2].fee = 500;
        others[3].tickSpacing = 10;
        others[4].hooks = address(0x1234);
        for (uint256 i; i < 5; ++i) {
            bytes memory mismatch = abi.encodeWithSelector(DominoV4Positions.PositionPoolMismatch.selector, id);
            vm.expectRevert(mismatch);
            harness.increase(id, others[i], 1e18, 1e18, 0);
            vm.expectRevert(mismatch);
            harness.increaseLiquidity(id, others[i], 1e18, 1e20, 1e20);
            vm.expectRevert(mismatch);
            harness.withdraw(id, others[i], 1, 0, 0, RECIPIENT, false);
        }
        DominoV2Types.PoolRef memory v3 = pool;
        v3.dex = DominoV2Types.DEX_V3;
        vm.expectRevert(DominoV4Positions.InvalidPool.selector);
        harness.withdraw(id, v3, 1, 0, 0, RECIPIENT, false);
    }

    function testActionsRefuseAnOpenPositionManagerDelta() public {
        uint256 id = _mintToHarness(pool, 1e20).tokenId;
        trader.swap(_key(pool), true, 1e19);
        (uint256 fees0, uint256 fees1) = harness.collectable(id);
        _true(fees0 > 0 && fees1 == 0, "fees in currency0 only");
        bytes memory open0 = abi.encodeWithSelector(DominoV4Positions.OpenDelta.selector, int256(fees0), int256(0));
        V4PositionsHarness.Step[] memory steps = new V4PositionsHarness.Step[](2);
        steps[0] = _rawCollect(id);
        steps[1] = _step(V4Steps.INCREASE, abi.encode(id, pool, uint128(1e18), uint128(1e18), uint128(0)));
        vm.expectRevert(open0);
        harness.run(steps);
        steps[1] = _step(V4Steps.WITHDRAW, abi.encode(id, pool, uint128(1), uint128(0), uint128(0), RECIPIENT, false));
        vm.expectRevert(open0);
        harness.run(steps);
        steps[1] = _step(V4Steps.MINT, abi.encode(pool, LOWER, UPPER, uint128(1e18), uint128(1e18), uint128(0), BOB));
        vm.expectRevert(open0);
        harness.run(steps);

        DominoV2Types.PoolRef memory other = _pool(address(token0), address(token1), 3003, 60);
        harness.initialize(other, PRICE_ONE);
        uint256 otherId = _mintToHarness(other, 1e20).tokenId;
        trader.swap(_key(other), false, 1e19);
        (fees0, fees1) = harness.collectable(otherId);
        _true(fees0 == 0 && fees1 > 0, "fees in currency1 only");
        steps[0] = _rawCollect(otherId);
        steps[1] = _step(V4Steps.INCREASE, abi.encode(otherId, other, uint128(1e18), uint128(1e18), uint128(0)));
        vm.expectRevert(abi.encodeWithSelector(DominoV4Positions.OpenDelta.selector, int256(0), int256(fees1)));
        harness.run(steps);
    }

    function testTokenTransferFailuresAndShortfallsAreRefused() public {
        PositionTestToken quirky = new PositionTestToken("QRK");
        (address c0, address c1) =
            address(quirky) < address(token1) ? (address(quirky), address(token1)) : (address(token1), address(quirky));
        DominoV2Types.PoolRef memory ref = _pool(c0, c1, 3000, 60);
        harness.initialize(ref, PRICE_ONE);
        uint128 liquidity = DominoPositionMath.liquidityForAmounts(PRICE_ONE, LOWER, UPPER, 1e18, 1e18);
        (uint256 owed,) = DominoPositionMath.amountsForLiquidity(PRICE_ONE, LOWER, UPPER, liquidity, true);

        // No balance: the transfer reverts.
        vm.expectRevert(abi.encodeWithSelector(DominoV4Positions.TransferFailed.selector, address(quirky)));
        harness.mint(ref, LOWER, UPPER, 1e18, 1e18, 0, BOB);
        quirky.mint(address(harness), 1e30);
        // A transfer that returns false.
        quirky.setQuirks(quirky.TRANSFER_FALSE(), 0);
        vm.expectRevert(abi.encodeWithSelector(DominoV4Positions.TransferFailed.selector, address(quirky)));
        harness.mint(ref, LOWER, UPPER, 1e18, 1e18, 0, BOB);
        // A fee on transfer: the PoolManager receives less than the debt.
        quirky.setQuirks(0, 100);
        vm.expectRevert(
            abi.encodeWithSelector(DominoV4Positions.SettlementMismatch.selector, address(quirky), owed, owed - owed / 100)
        );
        harness.mint(ref, LOWER, UPPER, 1e18, 1e18, 0, BOB);
        // No return data at all (USDT style) is a success.
        quirky.setQuirks(quirky.NO_RETURN_DATA(), 0);
        DominoV4Positions.Result memory r = harness.mint(ref, LOWER, UPPER, 1e18, 1e18, 0, BOB);
        _eq(r.liquidity, liquidity, "minted with a token that returns nothing");
    }

    /// A pair token that, while being paid, asks the PositionManager for every
    /// open credit finds none: credits are taken first, inside the
    /// PositionManager's lock, and only then are debts paid.
    function testAHostileTokenBeingPaidFindsNoCreditToTake() public {
        PositionTestToken hostile = new PositionTestToken("HST");
        hostile.mint(address(harness), 1e30);
        hostile.mint(address(trader), 1e30);
        bool hostileFirst = address(hostile) < address(token1);
        DominoV2Types.PoolRef memory ref = hostileFirst
            ? _pool(address(hostile), address(token1), 3000, 60)
            : _pool(address(token1), address(hostile), 3000, 60);
        harness.initialize(ref, PRICE_ONE);
        uint256 id = _mintToHarness(ref, 1e20).tokenId;
        // token1 is the swaps' input, so the fees accrue in token1 only.
        trader.swap(_key(ref), !hostileFirst, 2e19);
        bytes[] memory params = new bytes[](1);
        params[0] = abi.encode(address(token1), address(hostile), uint256(0));
        hostile.setHook(
            address(positions),
            abi.encodeCall(
                IV4PositionManagerMinimal.modifyLiquiditiesWithoutUnlock, (abi.encodePacked(uint8(0x0e)), params)
            )
        );
        uint256 before = token1.balanceOf(address(harness));
        DominoV4Positions.Result memory r = harness.increase(id, ref, 1e14, 1e14, 0);
        _eq(hostile.hookCalls(), 1, "the hostile token called the PositionManager while being paid");
        _eq(token1.balanceOf(address(hostile)), 0, "and found no credit to take");
        int256 credit = hostileFirst ? r.delta1 : r.delta0;
        _true(credit > 0, "the fee surplus is a credit");
        _eq(token1.balanceOf(address(harness)) - before, uint256(credit), "delivered to the caller");
    }

    // ------------------------------------------------------- fees and payouts

    function testIncreaseDeliversTheOwnersAccruedFeesToTheCaller() public {
        uint256 id = _mintToSelf(1e20);
        IV4TestSurface(address(positions)).approve(address(harness), id);
        _trade(pool, 1e19);
        (uint256 fees0, uint256 fees1) = harness.collectable(id);
        _true(fees0 > 0 && fees1 > 0, "fees accrued");
        uint160 price = _price(pool);
        uint128 added = DominoPositionMath.liquidityForAmounts(price, LOWER, UPPER, 1e18, 1e18);
        (uint256 principal0, uint256 principal1) =
            DominoPositionMath.amountsForLiquidity(price, LOWER, UPPER, added, true);
        (uint256 owner0, uint256 owner1) = _balances(address(this));
        (uint256 before0, uint256 before1) = _balances(address(harness));
        uint128 liquidityBefore = positions.getPositionLiquidity(id);
        DominoV4Positions.Result memory r = harness.increase(id, pool, 1e18, 1e18, added);
        _eq(r.liquidity, added, "added");
        _eqInt(r.delta0, int256(fees0) - int256(principal0), "net0");
        _eqInt(r.delta1, int256(fees1) - int256(principal1), "net1");
        (uint256 after0, uint256 after1) = _balances(address(harness));
        _eqInt(int256(after0) - int256(before0), r.delta0, "caller received fees0 net");
        _eqInt(int256(after1) - int256(before1), r.delta1, "caller received fees1 net");
        (uint256 now0, uint256 now1) = _balances(address(this));
        _eq(now0, owner0, "owner untouched0");
        _eq(now1, owner1, "owner untouched1");
        (fees0, fees1) = harness.collectable(id);
        _eq(fees0 + fees1, 0, "fees settled by the increase");
        _eq(positions.getPositionLiquidity(id), liquidityBefore + added, "liquidity");
    }

    function testIncreaseTakesTheFeeSurplusAndPaysTheShortfall() public {
        uint256 id = _mintToHarness(pool, 1e20).tokenId;
        trader.swap(_key(pool), true, 1e20);
        (uint256 fees0, uint256 fees1) = harness.collectable(id);
        _true(fees0 > 1e15 && fees1 == 0, "fees in currency0 only");
        uint160 price = _price(pool);
        uint128 added = DominoPositionMath.liquidityForAmounts(price, LOWER, UPPER, 1e14, 1e14);
        (uint256 principal0, uint256 principal1) =
            DominoPositionMath.amountsForLiquidity(price, LOWER, UPPER, added, true);
        (uint256 before0, uint256 before1) = _balances(address(harness));
        DominoV4Positions.Result memory r = harness.increase(id, pool, 1e14, 1e14, 0);
        _true(r.delta0 > 0 && r.delta1 < 0, "credit in currency0, debt in currency1");
        _eqInt(r.delta0, int256(fees0 - principal0), "surplus taken");
        _eqInt(r.delta1, -int256(principal1), "shortfall paid");
        (uint256 after0, uint256 after1) = _balances(address(harness));
        _eq(after0 - before0, fees0 - principal0, "surplus delivered");
        _eq(before1 - after1, principal1, "shortfall settled");
    }

    function testIncreaseAndWithdrawNeedTheCallersApproval() public {
        uint256 id = _mintToSelf(1e18);
        bytes memory refused = abi.encodeWithSelector(NOT_APPROVED, address(harness));
        vm.expectRevert(refused);
        harness.increase(id, pool, 1e18, 1e18, 0);
        vm.expectRevert(refused);
        harness.withdraw(id, pool, 1, 0, 0, RECIPIENT, false);
        IV4TestSurface(address(positions)).approve(address(harness), id);
        harness.increase(id, pool, 1e18, 1e18, 0);
        harness.withdraw(id, pool, 1, 0, 0, RECIPIENT, false);
    }

    function testWithdrawDeliversThePrincipalAndEveryAccruedFee() public {
        DominoV4Positions.Result memory minted = _mintToHarness(pool, 1e20);
        _trade(pool, 1e19);
        (uint256 fees0, uint256 fees1) = harness.collectable(minted.tokenId);
        uint128 half = minted.liquidity / 2;
        (uint256 out0, uint256 out1) = DominoPositionMath.amountsForLiquidity(_price(pool), LOWER, UPPER, half, false);
        vm.expectRevert(abi.encodeWithSelector(MINIMUM_AMOUNT, uint128(out0 + 1), uint128(out0)));
        harness.withdraw(minted.tokenId, pool, half, uint128(out0 + 1), uint128(out1), RECIPIENT, false);
        (uint256 before0, uint256 before1) = _balances(address(harness));
        DominoV4Positions.Result memory r =
            harness.withdraw(minted.tokenId, pool, half, uint128(out0), uint128(out1), RECIPIENT, false);
        _eqInt(r.delta0, int256(out0 + fees0), "principal and fees0");
        _eqInt(r.delta1, int256(out1 + fees1), "principal and fees1");
        (uint256 got0, uint256 got1) = _balances(RECIPIENT);
        _eq(got0, out0 + fees0, "recipient0");
        _eq(got1, out1 + fees1, "recipient1");
        (uint256 after0, uint256 after1) = _balances(address(harness));
        _eq(after0, before0, "nothing kept0");
        _eq(after1, before1, "nothing kept1");
        _eq(positions.getPositionLiquidity(minted.tokenId), minted.liquidity - half, "remaining liquidity");
    }

    function testWithdrawWithBurnTakesEverythingAndBurns() public {
        DominoV4Positions.Result memory minted = _mintToHarness(pool, 1e20);
        _trade(pool, 1e19);
        (uint256 fees0, uint256 fees1) = harness.collectable(minted.tokenId);
        vm.expectRevert(
            abi.encodeWithSelector(
                DominoV4Positions.PartialBurn.selector, minted.tokenId, minted.liquidity - 1, minted.liquidity
            )
        );
        harness.withdraw(minted.tokenId, pool, minted.liquidity - 1, 0, 0, RECIPIENT, true);
        (uint256 out0, uint256 out1) =
            DominoPositionMath.amountsForLiquidity(_price(pool), LOWER, UPPER, minted.liquidity, false);
        DominoV4Positions.Result memory r =
            harness.withdraw(minted.tokenId, pool, minted.liquidity, 0, 0, RECIPIENT, true);
        _eqInt(r.delta0, int256(out0 + fees0), "everything0");
        _eqInt(r.delta1, int256(out1 + fees1), "everything1");
        vm.expectRevert();
        positions.ownerOf(minted.tokenId);
    }

    function testCollectDeliversOnlyTheFees() public {
        DominoV4Positions.Result memory minted = _mintToHarness(pool, 1e20);
        _trade(pool, 1e19);
        (uint256 fees0, uint256 fees1) = harness.collectable(minted.tokenId);
        DominoV4Positions.Result memory r = harness.collect(minted.tokenId, pool, RECIPIENT);
        _eqInt(r.delta0, int256(fees0), "fees0");
        _eqInt(r.delta1, int256(fees1), "fees1");
        _eq(r.liquidity, 0, "no liquidity removed");
        _eq(positions.getPositionLiquidity(minted.tokenId), minted.liquidity, "liquidity kept");
        r = harness.collect(minted.tokenId, pool, RECIPIENT);
        _eqInt(r.delta0 + r.delta1, 0, "nothing left to collect");
    }

    function testCollectOnAnEmptyPositionDeliversNothing() public {
        DominoV4Positions.Result memory minted = _mintToHarness(pool, 1e20);
        _trade(pool, 1e19);
        harness.withdraw(minted.tokenId, pool, minted.liquidity, 0, 0, RECIPIENT, false);
        (uint256 got0, uint256 got1) = _balances(RECIPIENT);
        DominoV4Positions.Result memory r = harness.collect(minted.tokenId, pool, RECIPIENT);
        _eqInt(r.delta0 + r.delta1, 0, "empty position");
        (uint256 now0, uint256 now1) = _balances(RECIPIENT);
        _eq(now0 + now1, got0 + got1, "nothing delivered");
    }

    function testZeroLiquidityWithdrawIgnoresTheMinimums() public {
        DominoV4Positions.Result memory minted = _mintToHarness(pool, 1e20);
        _trade(pool, 1e19);
        (uint256 fees0, uint256 fees1) = harness.collectable(minted.tokenId);
        DominoV4Positions.Result memory r = harness.withdraw(minted.tokenId, pool, 0, 1, 1, RECIPIENT, false);
        _eqInt(r.delta0, int256(fees0), "fees0");
        _eqInt(r.delta1, int256(fees1), "fees1");
    }

    function testNativeCurrencyRoundTrip() public {
        uint256 ethBefore = address(harness).balance;
        uint256 tokenBefore = token1.balanceOf(address(harness));
        DominoV4Positions.Result memory minted = _mintToHarness(nativePool, 1e18);
        (uint256 owed0, uint256 owed1) =
            DominoPositionMath.amountsForLiquidity(PRICE_ONE, LOWER, UPPER, minted.liquidity, true);
        _eq(ethBefore - address(harness).balance, owed0, "ether paid with settleFor");
        _eq(tokenBefore - token1.balanceOf(address(harness)), owed1, "token paid");
        _trade(nativePool, 1e17);
        (uint256 fees0, uint256 fees1) = harness.collectable(minted.tokenId);
        _true(fees0 > 0 && fees1 > 0, "fees in ether and token");
        DominoV4Positions.Result memory r = harness.collect(minted.tokenId, nativePool, RECIPIENT);
        _eq(RECIPIENT.balance, fees0, "ether fees delivered");
        _eqInt(r.delta1, int256(fees1), "token fees");
        (uint256 out0,) =
            DominoPositionMath.amountsForLiquidity(_price(nativePool), LOWER, UPPER, minted.liquidity, false);
        harness.withdraw(minted.tokenId, nativePool, minted.liquidity, 0, 0, RECIPIENT, true);
        _eq(RECIPIENT.balance, fees0 + out0, "ether principal delivered");
    }

    function testProtocolFeeComesOutBeforeTheLpFees() public {
        DominoV2Types.PoolRef memory twin = _pool(address(token0), address(token1), 3000, 30);
        harness.initialize(twin, PRICE_ONE);
        IV4TestSurface(address(manager)).setProtocolFeeController(address(this));
        uint24 protocolFee = 500 | (800 << 12);
        IV4TestSurface(address(manager)).setProtocolFee(_key(pool), protocolFee);
        (,, uint24 readFee, uint24 lpFee) = harness.slot0(pool);
        _eq(readFee, protocolFee, "protocol fee read from slot0");
        _eq(lpFee, 3000, "lp fee read from slot0");
        uint256 id = _mintToHarness(pool, 1e20).tokenId;
        uint256 twinId = _mintToHarness(twin, 1e20).tokenId;
        _trade(pool, 1e19);
        _trade(twin, 1e19);
        (uint256 fees0, uint256 fees1) = harness.collectable(id);
        (uint256 twin0, uint256 twin1) = harness.collectable(twinId);
        _true(fees0 < twin0 && fees1 < twin1, "the protocol share is not the LPs'");
        _true(IV4TestSurface(address(manager)).protocolFeesAccrued(address(token0)) > 0, "protocol fees accrued");
        DominoV4Positions.Result memory r = harness.collect(id, pool, RECIPIENT);
        _eqInt(r.delta0, int256(fees0), "collectable0 is what collect pays");
        _eqInt(r.delta1, int256(fees1), "collectable1 is what collect pays");
    }

    // -------------------------------------------------------------- custody

    function testSubscriberNotificationsBlockChangesAndCarryTheFees() public {
        uint256 id = _mintToSelf(1e20);
        IV4TestSurface(address(positions)).approve(address(harness), id);
        V4TestSubscriber subscriber = new V4TestSubscriber();
        positions.subscribe(id, address(subscriber), "");
        _trade(pool, 1e19);
        subscriber.configure(true, false, false);
        vm.expectPartialRevert(WRAPPED_ERROR);
        harness.withdraw(id, pool, 1, 0, 0, RECIPIENT, false);
        vm.expectPartialRevert(WRAPPED_ERROR);
        harness.increase(id, pool, 1e18, 1e18, 0);
        subscriber.configure(false, true, false);
        uint128 liquidity = positions.getPositionLiquidity(id);
        vm.expectPartialRevert(WRAPPED_ERROR);
        harness.withdraw(id, pool, liquidity, 0, 0, RECIPIENT, true);
        subscriber.configure(false, false, false);
        (uint256 fees0, uint256 fees1) = harness.collectable(id);
        harness.collect(id, pool, RECIPIENT);
        _eq(subscriber.modifications(), 1, "one notification");
        _eqInt(subscriber.lastLiquidityChange(), 0, "collect changes no liquidity");
        _eqInt(subscriber.lastFeesAccrued(), int256((fees0 << 128) | fees1), "the notification carries the fees");
    }

    function testTransferClearsTheApprovalAndTheSubscription() public {
        uint256 id = _mintToSelf(1e18);
        IV4TestSurface(address(positions)).approve(address(harness), id);
        V4TestSubscriber subscriber = new V4TestSubscriber();
        positions.subscribe(id, address(subscriber), "");
        _true(harness.isAuthorized(id, address(harness)), "approved before");
        IV4TestSurface(address(positions)).transferFrom(address(this), BOB, id);
        _eqAddress(positions.getApproved(id), address(0), "approval cleared");
        _eqAddress(positions.subscriber(id), address(0), "subscription cleared");
        _true(subscriber.unsubscribeGas() > 280_000 && subscriber.unsubscribeGas() <= 300_000, "notified with 300k gas");
        _true(!harness.isAuthorized(id, address(harness)), "authority lost");
        DominoV4Positions.Position memory p = harness.position(id);
        _eqAddress(p.owner, BOB, "new owner");
        _eqAddress(p.subscriber, address(0), "no subscriber");
        vm.expectRevert(abi.encodeWithSelector(NOT_APPROVED, address(harness)));
        harness.collect(id, pool, RECIPIENT);
    }

    function testUnsubscribeIsBestEffort() public {
        uint256 id = _mintToSelf(1e18);
        V4TestSubscriber subscriber = new V4TestSubscriber();
        subscriber.configure(false, false, true);
        positions.subscribe(id, address(subscriber), "");
        _eqAddress(harness.position(id).subscriber, address(subscriber), "subscribed");
        positions.unsubscribe(id);
        _eqAddress(positions.subscriber(id), address(0), "a subscriber that burns its gas cannot block");
    }

    function testIsAuthorizedFollowsOwnerApprovalAndOperator() public {
        uint256 id = _mintToSelf(1e18);
        _true(harness.isAuthorized(id, address(this)), "owner");
        _true(!harness.isAuthorized(id, address(harness)), "stranger");
        IV4TestSurface(address(positions)).approve(address(harness), id);
        _true(harness.isAuthorized(id, address(harness)), "approved");
        IV4TestSurface(address(positions)).approve(address(0), id);
        _true(!harness.isAuthorized(id, address(harness)), "approval revoked");
        IV4TestSurface(address(positions)).setApprovalForAll(address(harness), true);
        _true(harness.isAuthorized(id, address(harness)), "operator");
    }

    // ----------------------------------------------------- reads and set-up

    function testReadsMatchStateView() public {
        uint256 inRange = _mintToHarness(pool, 1e20).tokenId;
        harness.mint(pool, -1200, -600, 1e20, 1e20, 0, address(harness));
        harness.mint(pool, 600, 1200, 1e20, 1e20, 0, address(harness));
        trader.swap(_key(pool), true, 5e20);
        trader.swap(_key(pool), false, 8e20);
        trader.swap(_key(pool), true, 1e20);
        bytes32 id = harness.poolId(pool);
        {
            (uint160 price, int24 tick, uint24 protocolFee, uint24 lpFee) = harness.slot0(pool);
            (uint160 viewPrice, int24 viewTick, uint24 viewProtocolFee, uint24 viewLpFee) = stateView.getSlot0(id);
            _eq(price, viewPrice, "price");
            _eqInt(tick, viewTick, "tick");
            _eq(protocolFee, viewProtocolFee, "protocol fee");
            _eq(lpFee, viewLpFee, "lp fee");
        }
        int24[4] memory edges = [int24(-1200), int24(-600), int24(600), int24(1200)];
        for (uint256 i; i < 3; ++i) {
            (uint256 inside0, uint256 inside1) = harness.feeGrowthInside(pool, edges[i], edges[i + 1]);
            (uint256 view0, uint256 view1) = stateView.getFeeGrowthInside(id, edges[i], edges[i + 1]);
            _eq(inside0, view0, "fee growth inside0");
            _eq(inside1, view1, "fee growth inside1");
            _true(inside0 + inside1 > 0, "fees grew in every range");
        }
        DominoV4Positions.Position memory p = harness.position(inRange);
        (uint128 liquidity, uint256 last0, uint256 last1) =
            stateView.getPositionInfo(id, address(positions), LOWER, UPPER, bytes32(inRange));
        _eq(p.liquidity, liquidity, "liquidity");
        _eq(p.feeGrowthInside0LastX128, last0, "checkpoint0");
        _eq(p.feeGrowthInside1LastX128, last1, "checkpoint1");
        _eqAddress(p.owner, address(harness), "owner");
        _eqInt(p.tickLower, LOWER, "lower");
        _eqInt(p.tickUpper, UPPER, "upper");
        _true(
            p.pool.dex == DominoV2Types.DEX_V4 && p.pool.currency0 == pool.currency0 && p.pool.currency1 == pool.currency1
                && p.pool.fee == pool.fee && p.pool.tickSpacing == pool.tickSpacing && p.pool.hooks == pool.hooks,
            "pool"
        );
    }

    function testInitializeKeepsAnExistingPrice() public {
        (uint160 current, bool created) = harness.initialize(pool, PRICE_ONE * 2);
        _eq(current, PRICE_ONE, "existing price kept");
        _true(!created, "not initialized again");
        DominoV2Types.PoolRef memory fresh = _pool(address(token0), address(token1), 3004, 60);
        (current, created) = harness.initialize(fresh, PRICE_ONE * 2);
        _eq(current, PRICE_ONE * 2, "new price");
        _true(created, "initialized");
        _eq(_price(fresh), PRICE_ONE * 2, "price in force");
        DominoV2Types.PoolRef memory inside = _pool(address(token0), address(token1), 3005, 60);
        V4PositionsHarness.Step[] memory steps = new V4PositionsHarness.Step[](1);
        steps[0] = _step(V4Steps.INITIALIZE, abi.encode(inside, PRICE_ONE));
        (current, created) = abi.decode(harness.run(steps)[0], (uint160, bool));
        _true(created && current == PRICE_ONE, "initialized inside an unlock");
    }

    // -------------------------------------------------------------- journeys

    function testChangeRangeInOneUnlock() public {
        DominoV4Positions.Result memory minted = _mintToHarness(pool, 1e20);
        _trade(pool, 1e19);
        V4PositionsHarness.Step[] memory steps = new V4PositionsHarness.Step[](2);
        steps[0] = _step(
            V4Steps.WITHDRAW,
            abi.encode(minted.tokenId, pool, minted.liquidity, uint128(0), uint128(0), address(harness), true)
        );
        steps[1] = _step(V4Steps.MINT, abi.encode(pool, int24(-300), int24(900), uint128(5e19), uint128(5e19), uint128(1), BOB));
        bytes[] memory results = harness.run(steps);
        DominoV4Positions.Result memory moved = abi.decode(results[1], (DominoV4Positions.Result));
        _eqAddress(positions.ownerOf(moved.tokenId), BOB, "new range minted");
        vm.expectRevert();
        positions.ownerOf(minted.tokenId);
    }

    function testRoundTripMintIncreaseCollectDecreaseBurn() public {
        DominoV4Positions.Result memory minted = _mintToHarness(pool, 1e20);
        uint256 id = minted.tokenId;
        uint128 liquidity = minted.liquidity;
        _trade(pool, 1e19);
        (uint256 fees0, uint256 fees1) = harness.collectable(id);
        uint160 price = _price(pool);
        uint128 added = DominoPositionMath.liquidityForAmounts(price, LOWER, UPPER, 1e19, 1e19);
        (uint256 in0, uint256 in1) = DominoPositionMath.amountsForLiquidity(price, LOWER, UPPER, added, true);
        DominoV4Positions.Result memory r = harness.increase(id, pool, 1e19, 1e19, added);
        _eqInt(r.delta0, int256(fees0) - int256(in0), "increase net0");
        _eqInt(r.delta1, int256(fees1) - int256(in1), "increase net1");
        liquidity += added;
        _trade(pool, 1e19);
        (fees0, fees1) = harness.collectable(id);
        r = harness.collect(id, pool, RECIPIENT);
        _eqInt(r.delta0, int256(fees0), "collect0");
        _eqInt(r.delta1, int256(fees1), "collect1");
        _trade(pool, 1e19);
        (fees0, fees1) = harness.collectable(id);
        (uint256 out0, uint256 out1) = DominoPositionMath.amountsForLiquidity(_price(pool), LOWER, UPPER, liquidity / 3, false);
        r = harness.withdraw(id, pool, liquidity / 3, 0, 0, RECIPIENT, false);
        _eqInt(r.delta0, int256(out0 + fees0), "decrease0");
        _eqInt(r.delta1, int256(out1 + fees1), "decrease1");
        liquidity -= liquidity / 3;
        _trade(pool, 1e19);
        (fees0, fees1) = harness.collectable(id);
        (out0, out1) = DominoPositionMath.amountsForLiquidity(_price(pool), LOWER, UPPER, liquidity, false);
        r = harness.withdraw(id, pool, liquidity, 0, 0, RECIPIENT, true);
        _eqInt(r.delta0, int256(out0 + fees0), "exit0");
        _eqInt(r.delta1, int256(out1 + fees1), "exit1");
        _eq(token0.allowance(address(harness), address(positions)), 0, "no allowance to the PositionManager");
        _eq(token0.allowance(address(harness), address(manager)), 0, "no allowance to the PoolManager");
    }
}
