// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {DominoFeeRules} from "../../../src/v2/fees/DominoFeeRules.sol";
import {MockDominoRegistry, V2TestBase} from "../route/V2RouteTestKit.sol";

/// The library's internal rules, callable from outside so reverts can be checked.
contract FeeRulesProbe {
    IDominoRegistry public immutable registry;

    constructor(IDominoRegistry registry_) {
        registry = registry_;
    }

    function select(DominoV2Types.SwapLeg[] calldata legs) external view returns (address token, uint8 source) {
        return DominoFeeRules.assistedSwapFeeToken(registry, legs);
    }

    function terms(DominoV2Types.SwapLeg[] calldata legs, uint16 feeBps, address feeToken) external view {
        DominoFeeRules.requireAssistedSwapTerms(registry, legs, feeBps, feeToken);
    }

    function swapped(DominoV2Types.SwapLeg[] calldata legs, uint256[] calldata amountsOut, address token)
        external
        pure
        returns (uint256)
    {
        return DominoFeeRules.swappedAmount(legs, amountsOut, token);
    }

    function feeOf(uint256 amount, uint16 bps) external pure returns (uint256) {
        return DominoFeeRules.feeOf(amount, bps);
    }

    function automationFeeBps(uint8 mode) external pure returns (uint16) {
        return DominoFeeRules.automationFeeBps(mode);
    }
}

/// The charge-currency rule of 1 Oct 2026 (#283) as a table: inputs, outputs,
/// route hops and the fallback, native ETH against WETH, on Robinhood's and
/// Base's ranks; then the fee base, the rounding and the intent's terms.
contract DominoFeeRulesTest is V2TestBase {
    // Robinhood's charge currencies (api-contracts/v2/chains/robinhood-4663.json).
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant ETH = address(0);
    // Base's stable.
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    // Tokens that are not charge currencies.
    address internal constant TSLA = address(0x7514);
    address internal constant MANY = address(0x3a27);
    address internal constant NVDA = address(0x47da);

    MockDominoRegistry internal registry;
    FeeRulesProbe internal probe;

    function setUp() public {
        registry = new MockDominoRegistry();
        registry.setRank(USDG, 1);
        registry.setRank(ETH, 2);
        registry.setRank(WETH, 2);
        probe = new FeeRulesProbe(IDominoRegistry(address(registry)));
    }

    function _leg(address tokenIn, address tokenOut, uint128 amountIn) internal pure returns (DominoV2Types.SwapLeg memory) {
        return DominoV2Types.SwapLeg({
            kind: DominoV2Types.LEG_UNIVERSAL_ROUTER,
            router: address(0xA11),
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: 1,
            data: ""
        });
    }

    function _legs1(address a, address b) internal pure returns (DominoV2Types.SwapLeg[] memory legs) {
        legs = new DominoV2Types.SwapLeg[](1);
        legs[0] = _leg(a, b, 100);
    }

    function _legs2(address a, address b, address c, address d) internal pure returns (DominoV2Types.SwapLeg[] memory legs) {
        legs = new DominoV2Types.SwapLeg[](2);
        legs[0] = _leg(a, b, 100);
        legs[1] = _leg(c, d, 100);
    }

    function _select(DominoV2Types.SwapLeg[] memory legs, address token, uint8 source, string memory what) internal view {
        (address selected, uint8 place) = probe.select(legs);
        if (selected != token || place != source) revert Unexpected(what);
    }

    // ------------------------------------------------------------ the table
    function testTheInputWhenItIsACharge() public view {
        _select(_legs1(USDG, MANY), USDG, DominoFeeRules.FROM_INPUT, "USDG -> MANY charges the USDG input");
        _select(_legs1(ETH, MANY), ETH, DominoFeeRules.FROM_INPUT, "native ETH -> MANY charges native ETH");
        _select(_legs1(WETH, MANY), WETH, DominoFeeRules.FROM_INPUT, "WETH -> MANY charges WETH, not ETH");
    }

    function testTheOutputWhenOnlyItIsACharge() public view {
        _select(_legs1(MANY, USDG), USDG, DominoFeeRules.FROM_OUTPUT, "MANY -> USDG charges the USDG output");
        _select(_legs1(MANY, WETH), WETH, DominoFeeRules.FROM_OUTPUT, "MANY -> WETH charges WETH");
        _select(_legs1(MANY, ETH), ETH, DominoFeeRules.FROM_OUTPUT, "MANY -> ETH charges native ETH");
    }

    /// The owner's example: whoever holds only TSLA and creates TSLA/MANY
    /// pays in the USDG in the middle of TSLA -> USDG -> MANY.
    function testARouteHopWhenNeitherEndIsACharge() public view {
        _select(_legs2(TSLA, USDG, USDG, MANY), USDG, DominoFeeRules.FROM_HOP, "TSLA -> USDG -> MANY charges the hop");
        _select(_legs2(TSLA, WETH, WETH, MANY), WETH, DominoFeeRules.FROM_HOP, "a WETH hop");
    }

    function testTheInputTokenWhenNoChargeCurrencyAppears() public view {
        _select(_legs1(TSLA, MANY), TSLA, DominoFeeRules.FROM_FALLBACK, "TSLA -> MANY charges TSLA");
        _select(_legs2(TSLA, MANY, NVDA, MANY), TSLA, DominoFeeRules.FROM_FALLBACK, "the first leg's input");
        _select(_legs2(NVDA, TSLA, TSLA, MANY), NVDA, DominoFeeRules.FROM_FALLBACK, "never a hop that is no charge");
    }

    /// The list is ordered: a better-ranked currency wins wherever it appears.
    function testTheBetterRankWinsOverAnEarlierPlace() public view {
        _select(_legs1(WETH, USDG), USDG, DominoFeeRules.FROM_OUTPUT, "WETH -> USDG charges USDG");
        _select(_legs1(ETH, USDG), USDG, DominoFeeRules.FROM_OUTPUT, "ETH -> USDG charges USDG");
        _select(_legs2(WETH, USDG, USDG, MANY), USDG, DominoFeeRules.FROM_HOP, "a USDG hop beats a WETH input");
    }

    /// ETH and WETH share a rank: the earlier place wins, then the earlier leg.
    function testEqualRanksGoToTheEarlierPlaceThenTheEarlierLeg() public view {
        _select(_legs1(ETH, WETH), ETH, DominoFeeRules.FROM_INPUT, "ETH -> WETH: the input");
        _select(_legs1(WETH, ETH), WETH, DominoFeeRules.FROM_INPUT, "WETH -> ETH: the input");
        // An output beats a hop of the same rank, even from a later leg.
        DominoV2Types.SwapLeg[] memory legs = new DominoV2Types.SwapLeg[](3);
        legs[0] = _leg(TSLA, WETH, 100);
        legs[1] = _leg(WETH, MANY, 100);
        legs[2] = _leg(NVDA, ETH, 100);
        _select(legs, ETH, DominoFeeRules.FROM_OUTPUT, "an ETH output beats a WETH hop");
        // Two hops of the same rank: the earlier leg.
        legs = new DominoV2Types.SwapLeg[](4);
        legs[0] = _leg(TSLA, WETH, 100);
        legs[1] = _leg(WETH, MANY, 100);
        legs[2] = _leg(NVDA, ETH, 100);
        legs[3] = _leg(ETH, MANY, 100);
        _select(legs, WETH, DominoFeeRules.FROM_HOP, "the earlier hop");
        // Two outputs of the same rank: the earlier leg.
        _select(_legs2(TSLA, WETH, NVDA, ETH), WETH, DominoFeeRules.FROM_OUTPUT, "the earlier output");
        _select(_legs2(TSLA, ETH, NVDA, WETH), ETH, DominoFeeRules.FROM_OUTPUT, "the earlier output, native");
        // Two inputs of the same rank: the earlier leg.
        _select(_legs2(WETH, MANY, ETH, TSLA), WETH, DominoFeeRules.FROM_INPUT, "the earlier input");
    }

    /// A token a leg spends before any leg delivers it is an input, not a hop;
    /// one a leg delivers that no later leg spends is an output.
    function testPlacesFollowTheLegOrder() public view {
        _select(_legs2(USDG, MANY, TSLA, USDG), USDG, DominoFeeRules.FROM_INPUT, "spent before delivered");
        _select(_legs2(MANY, WETH, WETH, TSLA), WETH, DominoFeeRules.FROM_HOP, "delivered then spent");
        _select(_legs2(WETH, TSLA, MANY, WETH), WETH, DominoFeeRules.FROM_INPUT, "spent, then delivered later");
    }

    function testBaseAndArbitrumChargeUsdcFirst() public {
        MockDominoRegistry base = new MockDominoRegistry();
        base.setRank(USDC, 1);
        base.setRank(ETH, 2);
        base.setRank(address(0x4200000000000000000000000000000000000006), 2);
        FeeRulesProbe baseProbe = new FeeRulesProbe(IDominoRegistry(address(base)));
        (address token, uint8 place) = baseProbe.select(_legs1(ETH, USDC));
        _check(token == USDC && place == DominoFeeRules.FROM_OUTPUT, "ETH -> USDC charges USDC on Base");
        (token, place) = baseProbe.select(_legs1(USDG, MANY));
        _check(token == USDG && place == DominoFeeRules.FROM_FALLBACK, "USDG is no charge currency on Base");
    }

    function testNoSwapHasNoFeeToken() public {
        _expectRevert(
            address(probe),
            abi.encodeCall(FeeRulesProbe.select, (new DominoV2Types.SwapLeg[](0))),
            IDominoPositionActions.InvalidPlan.selector,
            "an empty route selects nothing"
        );
    }

    /// The rule against a reference model, over random routes and ranks.
    function testFuzzSelectionMatchesTheModel(uint256 seed) public {
        address[6] memory tokens = [USDG, ETH, WETH, TSLA, MANY, NVDA];
        MockDominoRegistry random = new MockDominoRegistry();
        for (uint256 i; i < 6; ++i) random.setRank(tokens[i], uint8(uint256(keccak256(abi.encode(seed, i))) % 4));
        FeeRulesProbe randomProbe = new FeeRulesProbe(IDominoRegistry(address(random)));
        uint256 count = 1 + seed % 5;
        DominoV2Types.SwapLeg[] memory legs = new DominoV2Types.SwapLeg[](count);
        for (uint256 i; i < count; ++i) {
            uint256 word = uint256(keccak256(abi.encode(seed, "leg", i)));
            address a = tokens[word % 6];
            address b = tokens[(word >> 8) % 6];
            if (a == b) b = tokens[((word >> 8) + 1) % 6];
            legs[i] = _leg(a, b, 100);
        }
        (address expected, uint8 expectedPlace) = _model(random, legs);
        (address token, uint8 place) = randomProbe.select(legs);
        _check(token == expected && place == expectedPlace, "selection differs from the model");
    }

    /// Straightforward restatement: list every (place, leg, side) occurrence in
    /// scan order, keep the first with the lowest nonzero rank.
    function _model(MockDominoRegistry ranks, DominoV2Types.SwapLeg[] memory legs)
        internal
        view
        returns (address best, uint8 bestPlace)
    {
        uint256 bestRank;
        for (uint8 place = 1; place <= 3; ++place) {
            for (uint256 i; i < legs.length; ++i) {
                for (uint256 side; side < 2; ++side) {
                    address token = side == 0 ? legs[i].tokenIn : legs[i].tokenOut;
                    bool hop;
                    if (side == 0) {
                        for (uint256 j; j < i; ++j) hop = hop || legs[j].tokenOut == token;
                    } else {
                        for (uint256 j = i + 1; j < legs.length; ++j) hop = hop || legs[j].tokenIn == token;
                    }
                    uint8 at = hop ? 3 : (side == 0 ? 1 : 2);
                    uint256 rank = ranks.chargeCurrencyRank(token);
                    if (at == place && rank != 0 && (bestRank == 0 || rank < bestRank)) {
                        (best, bestPlace, bestRank) = (token, place, rank);
                    }
                }
            }
        }
        if (bestRank == 0) (best, bestPlace) = (legs[0].tokenIn, 4);
    }

    // ------------------------------------------------------------ the fee
    function testTheSwappedAmountIsWhatEnteredOrWhatCameOut() public view {
        uint256[] memory out = new uint256[](2);
        // Input: what the legs spent.
        DominoV2Types.SwapLeg[] memory legs = _legs2(USDG, MANY, USDG, TSLA);
        legs[1].amountIn = 50;
        (out[0], out[1]) = (7, 9);
        _eq(probe.swapped(legs, out, USDG), 150, "input: 100 + 50 spent");
        // Output: what the legs delivered, measured.
        legs = _legs2(MANY, USDG, TSLA, USDG);
        (out[0], out[1]) = (70, 30);
        _eq(probe.swapped(legs, out, USDG), 100, "output: 70 + 30 delivered");
        // A hop the plan barely spends is charged on what it carried.
        legs = _legs2(TSLA, USDG, USDG, MANY);
        legs[1].amountIn = 1;
        (out[0], out[1]) = (1000, 5);
        _eq(probe.swapped(legs, out, USDG), 1000, "hop: 1000 carried, 1 spent");
        // A hop topped up from the inputs: what entered the second swap.
        legs[1].amountIn = 1400;
        _eq(probe.swapped(legs, out, USDG), 1400, "hop: 1400 spent, 1000 carried");
    }

    function testTheSwappedAmountNeedsOneAmountPerLeg() public {
        _expectRevert(
            address(probe),
            abi.encodeCall(FeeRulesProbe.swapped, (_legs1(USDG, MANY), new uint256[](2), USDG)),
            IDominoPositionActions.InvalidPlan.selector,
            "one measured amount per leg"
        );
    }

    function testFeesRoundDownInThePayersFavour() public view {
        _eq(probe.feeOf(10_000, 65), 65, "65 bps of 10000");
        _eq(probe.feeOf(9_999, 65), 64, "64.99 rounds down");
        _eq(probe.feeOf(153, 65), 0, "below one unit is free");
        _eq(probe.feeOf(1e6, DominoV2Types.FEE_AUTOMATION_DOMINO_BPS), 40_000, "4% of 1e6");
        _eq(probe.feeOf(uint256(type(uint128).max) * 8, 65), uint256(type(uint128).max) * 8 * 65 / 10_000, "no overflow");
    }

    function testAutomationTariffFollowsTheMode() public {
        _eq(probe.automationFeeBps(DominoV2Types.MODE_SIMPLE), 200, "Auto-compound 2%");
        _eq(probe.automationFeeBps(DominoV2Types.MODE_DOMINO), 400, "Domino-compound 4%");
        _expectRevert(address(probe), abi.encodeCall(FeeRulesProbe.automationFeeBps, (0)),
            DominoFeeRules.InvalidFeeMode.selector, "mode 0");
        _expectRevert(address(probe), abi.encodeCall(FeeRulesProbe.automationFeeBps, (3)),
            DominoFeeRules.InvalidFeeMode.selector, "mode 3");
    }

    // ---------------------------------------------------------- the terms
    function testNoSwapMeansNoFeeTerms() public {
        DominoV2Types.SwapLeg[] memory none = new DominoV2Types.SwapLeg[](0);
        probe.terms(none, 0, address(0));
        _expectRevert(address(probe), abi.encodeCall(FeeRulesProbe.terms, (none, 65, address(0))),
            IDominoPositionActions.FeeMismatch.selector, "a fee without a swap");
        _expectRevert(address(probe), abi.encodeCall(FeeRulesProbe.terms, (none, 0, USDG)),
            IDominoPositionActions.FeeMismatch.selector, "a fee token without a swap");
    }

    function testASwapNeedsTheTariffAndTheRulesToken() public {
        DominoV2Types.SwapLeg[] memory legs = _legs2(TSLA, USDG, USDG, MANY);
        probe.terms(legs, 65, USDG);
        _expectRevert(address(probe), abi.encodeCall(FeeRulesProbe.terms, (legs, 64, USDG)),
            IDominoPositionActions.FeeMismatch.selector, "a discounted tariff");
        _expectRevert(address(probe), abi.encodeCall(FeeRulesProbe.terms, (legs, 66, USDG)),
            IDominoPositionActions.FeeMismatch.selector, "a raised tariff");
        _expectRevert(address(probe), abi.encodeCall(FeeRulesProbe.terms, (legs, 65, TSLA)),
            IDominoPositionActions.FeeMismatch.selector, "the input instead of the hop");
        _expectRevert(address(probe), abi.encodeCall(FeeRulesProbe.terms, (legs, 0, address(0))),
            IDominoPositionActions.FeeMismatch.selector, "a swap signed as feeless");
        // Native ETH is a fee token like any other: address(0) with the tariff.
        probe.terms(_legs1(ETH, MANY), 65, ETH);
        _expectRevert(address(probe), abi.encodeCall(FeeRulesProbe.terms, (_legs1(ETH, MANY), 65, WETH)),
            IDominoPositionActions.FeeMismatch.selector, "WETH for a native input");
    }
}
