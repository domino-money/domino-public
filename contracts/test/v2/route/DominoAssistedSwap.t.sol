// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {IV4PoolManagerMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {DominoFeeLedger} from "../../../src/v2/fees/DominoFeeLedger.sol";
import {DominoSwapExecutor} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {RobinhoodPermit2} from "./fixtures/RobinhoodPermit2.sol";
import {
    AcceptingRecipient,
    AssistedSwapHarness,
    IV4PoolManagerTest,
    MockDominoRegistry,
    RejectingRecipient,
    TestToken,
    V2TestBase,
    V2Vm,
    V4LiquidityHelper
} from "./V2RouteTestKit.sol";
import {V2VendoredFixtures} from "./V2VendoredFixtures.sol";

/// The assisted swap of a manual action, end to end on the vendored
/// PoolManager: the intent's fee terms, the legs accepted by effect, then
/// 65 bps of the swapped amount in the token the charge-currency rule selects,
/// paid at once or owed when the recipient cannot receive.
contract DominoAssistedSwapTest is V2TestBase {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant ETH = address(0);
    address internal constant PAYER = address(0xB0B);
    bytes32 internal constant REF = keccak256("intent hash");
    uint160 internal constant PRICE_ONE = uint160(1 << 96);
    int24 internal constant FULL = 887220;
    uint16 internal constant TARIFF = DominoV2Types.FEE_ASSISTED_SWAP_BPS;
    bytes32 internal constant FEE_CHARGED = keccak256("FeeCharged(uint8,address,address,uint256,bytes32)");

    MockDominoRegistry internal registry;
    AssistedSwapHarness internal host;
    TestToken internal usd; // the chain's rank-1 charge currency (USDG / USDC)
    TestToken internal x; // not a charge currency
    TestToken internal y; // not a charge currency
    address internal recipient = address(0xFEE);

    function setUp() public {
        vm.etch(PERMIT2, RobinhoodPermit2.RUNTIME);
        IV4PoolManagerTest manager = IV4PoolManagerTest(address(V2VendoredFixtures.deployPoolManager(address(this))));
        registry = new MockDominoRegistry();
        registry.setFeeRecipient(recipient);
        host = new AssistedSwapHarness(DominoSwapExecutor.RouteConfig(
            IDominoRegistry(address(registry)), PERMIT2, address(0), bytes32(0), address(manager)));
        (usd, x, y) = (new TestToken(), new TestToken(), new TestToken());
        registry.setRank(address(usd), 1);
        registry.setRank(ETH, 2);
        V4LiquidityHelper liquidity = new V4LiquidityHelper(address(manager));
        TestToken[3] memory tokens = [usd, x, y];
        for (uint256 i; i < 3; ++i) {
            tokens[i].mint(address(liquidity), 1e30);
            tokens[i].mint(address(host), 100e18);
        }
        vm.deal(address(liquidity), 1e27);
        vm.deal(address(host), 100 ether);
        _pool(manager, liquidity, address(usd), address(x));
        _pool(manager, liquidity, address(usd), address(y));
        _pool(manager, liquidity, address(x), address(y));
        _pool(manager, liquidity, ETH, address(x));
    }

    function _sorted(address a, address b) internal pure returns (address, address) {
        return a < b ? (a, b) : (b, a);
    }

    function _pool(IV4PoolManagerTest manager, V4LiquidityHelper liquidity, address a, address b) internal {
        (address c0, address c1) = _sorted(a, b);
        IV4PoolManagerMinimal.PoolKey memory key = IV4PoolManagerMinimal.PoolKey(c0, c1, 3000, 60, address(0));
        manager.initialize(key, PRICE_ONE);
        liquidity.add(key, -FULL, FULL, 1e24);
    }

    function _leg(address tokenIn, address tokenOut, uint128 amountIn) internal pure returns (DominoV2Types.SwapLeg memory) {
        (address c0, address c1) = _sorted(tokenIn, tokenOut);
        DominoV2Types.PoolRef[] memory pools = new DominoV2Types.PoolRef[](1);
        pools[0] = DominoV2Types.PoolRef(DominoV2Types.DEX_V4, c0, c1, 3000, 60, address(0));
        return DominoV2Types.SwapLeg(DominoV2Types.LEG_V4_POOL, address(0), tokenIn, tokenOut, amountIn,
            uint128(amountIn) * 99 / 100, abi.encode(pools));
    }

    function _one(DominoV2Types.SwapLeg memory leg) internal pure returns (DominoV2Types.SwapLeg[] memory legs) {
        legs = new DominoV2Types.SwapLeg[](1);
        legs[0] = leg;
    }

    function _swap(DominoV2Types.SwapLeg[] memory legs, address feeToken)
        internal
        returns (uint256[] memory amountsOut, uint256 fee)
    {
        return host.assistedSwap(legs, new address[](0), TARIFF, feeToken, PAYER, REF);
    }

    function _balance(address token, address account) internal view returns (uint256) {
        return token == ETH ? account.balance : TestToken(token).balanceOf(account);
    }

    // ------------------------------------------------------------ where
    function testTheStableInputPays() public {
        vm.recordLogs();
        (, uint256 fee) = _swap(_one(_leg(address(usd), address(x), 10e18)), address(usd));
        _eq(fee, 0.065e18, "65 bps of the 10 swapped");
        _eq(usd.balanceOf(recipient), fee, "paid in the same transaction");
        _eq(usd.balanceOf(address(host)), 100e18 - 10e18 - fee, "on top of the swapped amount");
        V2Vm.Log memory charged = _first(vm.getRecordedLogs(), address(host), FEE_CHARGED);
        _check(charged.topics[1] == bytes32(uint256(DominoV2Types.FEE_KIND_ASSISTED_SWAP))
            && charged.topics[2] == bytes32(uint256(uint160(address(usd))))
            && charged.topics[3] == bytes32(uint256(uint160(PAYER))), "FeeCharged kind, token, payer");
        (uint256 amount, bytes32 ref) = abi.decode(charged.data, (uint256, bytes32));
        _check(amount == fee && ref == REF, "FeeCharged amount and intent");
    }

    function testTheStableOutputPaysWhenTheInputIsNoCharge() public {
        (uint256[] memory out, uint256 fee) = _swap(_one(_leg(address(x), address(usd), 10e18)), address(usd));
        _eq(fee, out[0] * TARIFF / 10_000, "65 bps of what came out");
        _eq(usd.balanceOf(recipient), fee, "paid from the output");
        _eq(usd.balanceOf(address(host)), 100e18 + out[0] - fee, "the owner keeps the rest");
    }

    /// The owner's example: only TSLA, creating TSLA/MANY, pays in the USDG
    /// in the middle of TSLA -> USDG -> MANY, on what the hop carried.
    function testARouteHopPaysOnWhatItCarried() public {
        DominoV2Types.SwapLeg[] memory legs = new DominoV2Types.SwapLeg[](2);
        legs[0] = _leg(address(x), address(usd), 10e18);
        legs[1] = _leg(address(usd), address(y), 9.8e18);
        (uint256[] memory out, uint256 fee) = _swap(legs, address(usd));
        _eq(fee, out[0] * TARIFF / 10_000, "65 bps of the USD the hop carried");
        _eq(usd.balanceOf(recipient), fee, "paid from the hop");
        _eq(usd.balanceOf(address(host)), 100e18 + out[0] - 9.8e18 - fee, "the hop's remainder stays");
    }

    function testWithoutAChargeCurrencyTheInputPays() public {
        (, uint256 fee) = _swap(_one(_leg(address(x), address(y), 10e18)), address(x));
        _eq(fee, 0.065e18, "65 bps of X");
        _eq(x.balanceOf(recipient), fee, "paid in X");
    }

    function testNativeEthIsAChargeCurrency() public {
        uint256 before = recipient.balance;
        (, uint256 fee) = _swap(_one(_leg(ETH, address(x), 1e18)), ETH);
        _eq(fee, 0.0065e18, "65 bps of the ETH swapped");
        _eq(recipient.balance - before, fee, "paid in ETH");
    }

    // ------------------------------------------------------------- terms
    function testTheTermsAreCheckedBeforeAnySwap() public {
        DominoV2Types.SwapLeg[] memory legs = _one(_leg(address(usd), address(x), 10e18));
        _expectRevert(address(host),
            abi.encodeCall(AssistedSwapHarness.assistedSwap, (legs, new address[](0), TARIFF, address(x), PAYER, REF)),
            IDominoPositionActions.FeeMismatch.selector, "the output token instead of the stable input");
        _expectRevert(address(host),
            abi.encodeCall(AssistedSwapHarness.assistedSwap, (legs, new address[](0), 0, address(usd), PAYER, REF)),
            IDominoPositionActions.FeeMismatch.selector, "a swap without the tariff");
    }

    function testNoSwapNoFee() public {
        vm.recordLogs();
        (uint256[] memory out, uint256 fee) =
            host.assistedSwap(new DominoV2Types.SwapLeg[](0), new address[](0), 0, address(0), PAYER, REF);
        _check(out.length == 0 && fee == 0, "nothing swapped, nothing charged");
        _eq(_count(vm.getRecordedLogs(), address(host), FEE_CHARGED), 0, "no FeeCharged");
        _expectRevert(address(host), abi.encodeCall(AssistedSwapHarness.assistedSwap,
            (new DominoV2Types.SwapLeg[](0), new address[](0), TARIFF, address(usd), PAYER, REF)),
            IDominoPositionActions.FeeMismatch.selector, "a fee without a swap");
    }

    // ------------------------------------------------------- settlement
    function testARecipientThatCannotReceiveNeverBlocksTheSwap() public {
        usd.setBlocked(recipient, true); // the issuer froze Domino's recipient
        (uint256[] memory out, uint256 fee) = _swap(_one(_leg(address(usd), address(x), 10e18)), address(usd));
        _check(out[0] > 9.9e18, "the swap went through");
        _eq(host.owedFees(address(usd)), fee, "the fee is owed");
        _eq(host.unowedBalance(address(usd)), 100e18 - 10e18 - fee, "and not spendable");
        registry.setFeeRecipient(address(0xFEE2)); // rotated by governance
        _eq(host.flushOwedFees(address(usd)), fee, "anyone flushes");
        _eq(usd.balanceOf(address(0xFEE2)), fee, "to the recipient in force");
    }

    function testANativeRecipientWithoutReceiveNeverBlocksTheSwap() public {
        registry.setFeeRecipient(address(new RejectingRecipient()));
        (, uint256 fee) = _swap(_one(_leg(ETH, address(x), 1e18)), ETH);
        _eq(host.owedFees(ETH), fee, "owed in ETH");
        AcceptingRecipient next = new AcceptingRecipient();
        registry.setFeeRecipient(address(next));
        host.flushOwedFees(ETH);
        _eq(next.received(), fee, "flushed to the new recipient");
    }

    /// The action must bring the fee: an input fee comes on top of amountIn.
    function testTheFeeMustBeBacked() public {
        vm.deal(address(host), 1e18);
        _expectRevertData(address(host),
            abi.encodeCall(AssistedSwapHarness.assistedSwap, (_one(_leg(ETH, address(x), 1e18)), new address[](0), TARIFF,
            ETH, PAYER, REF)), abi.encodeWithSelector(DominoFeeLedger.FeeNotBacked.selector, ETH),
            "all the ETH went into the swap");
    }
}
