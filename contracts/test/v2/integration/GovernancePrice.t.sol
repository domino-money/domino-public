// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AnchorMath} from "../../../src/v2/anchor/AnchorMath.sol";
import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IUniswapV3PoolMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {IDominoPriceAnchor} from "../../../src/v2/interfaces/IDominoPriceAnchor.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {IIntegrationAnchor, IIntegrationV4Initializer, IntegrationRegistryConfig} from "./IntegrationInterfaces.sol";
import {IntegrationWorld} from "./IntegrationWorld.sol";

/// @notice The registry and price anchor, wired, on the deployed Base factory,
/// pools, PoolManager and StateView. The v3 history comes from real swaps and
/// elapsed time; no oracle observation or pool state is injected. Whether the
/// registry's changes reach the zap, the vault and the auto-exit module is
/// asserted in their own journeys (router, charge currencies, operators,
/// publishers, the halt).
contract GovernancePriceTest is IntegrationWorld {
    DominoV2Types.PoolRef internal pool3;
    DominoV2Types.PoolRef internal pool4;

    function _dex() internal pure override returns (uint8) {
        return DominoV2Types.DEX_V3;
    }

    function _zapArtifact() internal pure override returns (string memory) {
        return "DominoZapV3.sol:DominoZapV3";
    }

    function _vaultArtifact() internal pure override returns (string memory) {
        return "DominoV2VaultV3.sol:DominoV2VaultV3";
    }

    function _executorArtifact() internal pure override returns (string memory) {
        return "DominoV2VaultV3.sol:DominoV2VaultExecutorV3";
    }

    function setUp() public override {
        super.setUp();
        pool3 = main.pool;
        pool4 = DominoV2Types.PoolRef(DominoV2Types.DEX_V4, address(base), address(quote), 3000, 60, address(0));
        IIntegrationV4Initializer(chain.v4PoolManager).initialize(_key(pool4), PRICE_ONE);
    }

    function testRealWiringAndTimelockedAdmission() public {
        _check(priceAnchor.registry() == address(registry), "anchor registry");
        _check(priceAnchor.v3Factory() == chain.v3Factory, "anchor factory");
        _check(priceAnchor.v4StateView() == chain.v4StateView, "anchor StateView");
        _check(registry.isOperator(OPERATOR) && registry.isPublisher(vm.addr(PUBLISHER_KEY)), "roles");
        _eq(registry.routerVersion(chain.router), 212, "router version");
        _eq(registry.chargeCurrencyRank(address(quote)), 1, "stable rank");
        _eq(registry.chargeCurrencyRank(address(second)), 2, "second rank");
        _eq(registry.chargeCurrencyRank(chain.weth9), 2, "wrapped rank");
        _eq(registry.chargeCurrencyRank(address(0)), 2, "native rank");
        _eq(registry.chargeCurrencyRank(address(base)), 0, "unlisted");
        _eq(priceAnchor.spotSqrtPrice(pool3), PRICE_ONE, "v3 spot from the factory-created pool");
        _eq(priceAnchor.spotSqrtPrice(pool4), PRICE_ONE, "v4 spot through the deployed StateView");

        bytes32 change = registry.scheduleChange(DominoV2Types.REGISTRY_OPERATOR, abi.encode(NEXT_OPERATOR, true));
        _check(!registry.isOperator(NEXT_OPERATOR), "scheduled is not admitted");
        vm.expectRevert(IDominoRegistry.ChangeNotReady.selector);
        registry.executeChange(change);
        _advance(TIMELOCK - 1);
        vm.expectRevert(IDominoRegistry.ChangeNotReady.selector);
        registry.executeChange(change);
        _advance(1);
        registry.executeChange(change);
        _check(registry.isOperator(NEXT_OPERATOR), "admitted after the full timelock");
    }

    function testTimelockedPublisherReachesTheAnchor() public {
        address nextPublisher = vm.addr(NEXT_PUBLISHER_KEY);
        bytes32 change = registry.scheduleChange(DominoV2Types.REGISTRY_PUBLISHER, abi.encode(nextPublisher, true));
        DominoV2Types.PriceObservation memory point = _observation(pool4, PRICE_ONE);
        bytes memory signature = _signature(NEXT_PUBLISHER_KEY, priceAnchor.hashObservation(point));
        vm.expectRevert(IDominoPriceAnchor.InvalidObservation.selector);
        priceAnchor.verifyObservation(point, signature, ANCHOR_MAX_AGE);
        _advance(TIMELOCK);
        registry.executeChange(change);
        point = _observation(pool4, PRICE_ONE);
        signature = _signature(NEXT_PUBLISHER_KEY, priceAnchor.hashObservation(point));
        (uint160 anchored, uint160 spot) = priceAnchor.anchor(pool4, abi.encode(point, signature), ANCHOR_MAX_AGE, 0);
        _eq(anchored, PRICE_ONE, "the new publisher reaches the anchor");
        _eq(spot, PRICE_ONE, "the deployed lens is unchanged");
    }

    function testSignedV3AndV4PricesRevocationEpochAndPublisherRemoval() public {
        DominoV2Types.PriceObservation memory point3 = _observation(pool3, PRICE_ONE);
        DominoV2Types.PriceObservation memory point4 = _observation(pool4, PRICE_ONE);
        bytes memory signature3 = _signature(PUBLISHER_KEY, priceAnchor.hashObservation(point3));
        bytes memory signature4 = _signature(PUBLISHER_KEY, priceAnchor.hashObservation(point4));
        priceAnchor.anchor(pool3, abi.encode(point3, signature3), ANCHOR_MAX_AGE, 0);
        priceAnchor.anchor(pool4, abi.encode(point4, signature4), ANCHOR_MAX_AGE, 0);

        bytes32 revoked = priceAnchor.hashObservation(point3);
        vm.prank(GUARDIAN);
        priceAnchor.revokeObservation(revoked);
        _check(priceAnchor.isRevoked(revoked), "revocation recorded");
        vm.expectRevert(IDominoPriceAnchor.ObservationRevoked.selector);
        priceAnchor.anchor(pool3, abi.encode(point3, signature3), ANCHOR_MAX_AGE, 0);
        priceAnchor.anchor(pool4, abi.encode(point4, signature4), ANCHOR_MAX_AGE, 0);

        _advance(1);
        vm.prank(GUARDIAN);
        registry.raiseObservationEpoch(uint64(clock));
        vm.expectRevert(IDominoPriceAnchor.ObservationRevoked.selector);
        priceAnchor.anchor(pool4, abi.encode(point4, signature4), ANCHOR_MAX_AGE, 0);
        bytes memory fresh = _evidence(pool4, PRICE_ONE);
        priceAnchor.anchor(pool4, fresh, ANCHOR_MAX_AGE, 0);
        vm.prank(GUARDIAN);
        registry.removePublisher(vm.addr(PUBLISHER_KEY));
        vm.expectRevert(IDominoPriceAnchor.InvalidObservation.selector);
        priceAnchor.anchor(pool4, fresh, ANCHOR_MAX_AGE, 0);
    }

    function testV3TwapUsesRealCardinalityElapsedTimeAndSwaps() public {
        IUniswapV3PoolMinimal v3Pool = IUniswapV3PoolMinimal(main.v3Pool);
        vm.expectRevert(IDominoPriceAnchor.TwapUnavailable.selector);
        priceAnchor.anchor(pool3, abi.encode(uint32(120)), ANCHOR_MAX_AGE, 500);
        v3Pool.increaseObservationCardinalityNext(8);
        (,,,, uint16 next,,) = v3Pool.slot0();
        _eq(next, 8, "cardinality provisioned through the pool");

        _advance(30);
        _trade(main, true, 1e20);
        (, int24 first,,,,,) = v3Pool.slot0();
        _check(first < 0, "the first swap moves the price");
        _advance(40);
        _trade(main, false, 5e19);
        (, int24 second_,, uint16 cardinality,,,) = v3Pool.slot0();
        _check(second_ > first && cardinality > 1, "real observations and a second price");
        _advance(50);
        // [now-120, now]: 30 seconds at tick 0, 40 at the first price, 50 at the second.
        int56 cumulative = int56(first) * 40 + int56(second_) * 50;
        int56 mean = cumulative / 120;
        if (cumulative < 0 && cumulative % 120 != 0) --mean;
        uint160 expected = AnchorMath.getSqrtPriceAtTick(int24(mean));
        _eq(priceAnchor.twapSqrtPrice(pool3, 120), expected, "time-weighted history from swaps");
        (uint160 anchored,) = priceAnchor.anchor(pool3, abi.encode(uint32(120)), ANCHOR_MAX_AGE, 500);
        _eq(anchored, expected, "TWAP evidence accepted");

        // A same-block swap moves the spot, but earns no seconds in the oracle.
        _trade(main, true, 5e20);
        _eq(priceAnchor.twapSqrtPrice(pool3, 120), expected, "a same-block spot does not move the TWAP");
        vm.expectRevert(IDominoPriceAnchor.SpotOutsideBand.selector);
        priceAnchor.anchor(pool3, abi.encode(uint32(120)), ANCHOR_MAX_AGE, 50);
    }

    /// A unit-level negative control at the anchor; the journey-level one is a
    /// vault wired to the wrong auto-exit module (AutoExitJourney).
    function testWrongRegistryWiringRejectsOtherwiseValidPublisherEvidence() public {
        IntegrationRegistryConfig memory config;
        config.governance = address(this);
        config.guardian = GUARDIAN;
        config.timelockSeconds = TIMELOCK;
        config.feeRecipient = FEE_RECIPIENT;
        address wrongRegistry = _deploy(abi.encodePacked(vm.getCode("DominoRegistry.sol:DominoRegistry"), abi.encode(config)));
        IIntegrationAnchor wrongAnchor = IIntegrationAnchor(
            _deploy(
                abi.encodePacked(
                    vm.getCode("DominoPriceAnchor.sol:DominoPriceAnchor"),
                    abi.encode(wrongRegistry, chain.v3Factory, BASE_V3_INIT_CODE_HASH, chain.v4StateView, ANCHOR_MIN_TWAP)
                )
            )
        );
        DominoV2Types.PriceObservation memory point = _observation(pool4, PRICE_ONE);
        // Signed for this anchor's own domain: the refusal is the registry
        // wiring, not an EIP-712 verifyingContract mismatch.
        bytes memory signature = _signature(PUBLISHER_KEY, wrongAnchor.hashObservation(point));
        vm.expectRevert(IDominoPriceAnchor.InvalidObservation.selector);
        wrongAnchor.anchor(pool4, abi.encode(point, signature), ANCHOR_MAX_AGE, 0);
        priceAnchor.anchor(pool4, _evidence(pool4, PRICE_ONE), ANCHOR_MAX_AGE, 0);
    }

    function testGasOfGovernedChangeAndSignedPoolReads() public {
        uint256 gas = gasleft();
        _governed(DominoV2Types.REGISTRY_OPERATOR, abi.encode(NEXT_OPERATOR, true));
        _logGas("integration registry schedule + execute", gas - gasleft());
        bytes memory evidence3 = _evidence(pool3, PRICE_ONE);
        bytes memory evidence4 = _evidence(pool4, PRICE_ONE);
        gas = gasleft();
        priceAnchor.anchor(pool3, evidence3, ANCHOR_MAX_AGE, 0);
        _logGas("integration signed v3 anchor", gas - gasleft());
        gas = gasleft();
        priceAnchor.anchor(pool4, evidence4, ANCHOR_MAX_AGE, 0);
        _logGas("integration signed v4 anchor", gas - gasleft());
    }
}
