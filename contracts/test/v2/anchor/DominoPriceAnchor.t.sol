// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {AnchorMath} from "../../../src/v2/anchor/AnchorMath.sol";
import {DominoPriceAnchor} from "../../../src/v2/anchor/DominoPriceAnchor.sol";
import {IDominoPriceAnchor} from "../../../src/v2/interfaces/IDominoPriceAnchor.sol";
import {DominoV2Goldens} from "../DominoV2Goldens.sol";
import {AnchorFixtures, MockV3Pool, PermissiveRegistry} from "./AnchorFixtures.sol";

/// @notice DominoPriceAnchor: signed observations (who signs, what the
/// signature binds, how long it lives, how it dies), v3 TWAPs, the spot read
/// and the band. Refusals first; each pins one guard.
contract DominoPriceAnchorTest is AnchorFixtures {
    /// The F0 EIP-712 goldens' domain (api-contracts/v2/eip712-goldens.json).
    address internal constant GOLDEN_VERIFIER = 0x000000000000000000000000000000000000d0D0;
    uint256 internal constant GOLDEN_CHAIN = 4663;
    uint160 internal constant GOLDEN_PRICE = 4339505179874779672736325173248;
    /// The golden PriceObservation signed by eth_account 0.13.7 with the key
    /// keccak256("domino.v2.f1.publisher") (PUBLISHER_KEY, a public test
    /// label): Account.from_key(key).sign_message(encode_typed_data(
    /// full_message=<the golden typed data>)). Its digest equals the golden.
    address internal constant GOLDEN_SIGNER = 0x925c7da025742a60c6941Ab2d00644f729eb4D94;
    bytes32 internal constant GOLDEN_R = 0x0eac49cca27b42cf9ab7750c14ae87d37a05b9c6589305a57785cf13d1062585;
    bytes32 internal constant GOLDEN_S = 0x22d963d49ef3f626f72952e25b02f775dd3c24485f81c2190140dc34fabc5017;
    uint8 internal constant GOLDEN_V = 28;

    function setUp() public {
        _warpTo(START);
        _deployRegistry();
        _deployAnchor();
        _setV4Spot(_pool4(), PRICE);
    }

    function _goldenObservation() internal pure returns (DominoV2Types.PriceObservation memory) {
        return DominoV2Types.PriceObservation({
            pool: _pool4(),
            sqrtPriceX96: GOLDEN_PRICE,
            observedAt: 1790870000,
            validUntil: 1790870060,
            nonce: 7
        });
    }

    function _publisher() internal pure returns (address) {
        return vm.addr(PUBLISHER_KEY);
    }

    // ------------------------------------------------------------ goldens
    function testDomainAndDigestAreTheF0Goldens() public {
        vm.chainId(GOLDEN_CHAIN);
        vm.etch(GOLDEN_VERIFIER, address(anchor).code);
        DominoPriceAnchor golden = DominoPriceAnchor(GOLDEN_VERIFIER);
        _check(golden.domainSeparator() == DominoV2Goldens.DOMAIN_SEPARATOR, "domain separator");
        _check(golden.hashObservation(_goldenObservation()) == DominoV2Goldens.PRICE_OBSERVATION_DIGEST, "digest");
    }

    function testEthAccountSignatureOfTheGoldenVerifies() public {
        vm.chainId(GOLDEN_CHAIN);
        vm.etch(GOLDEN_VERIFIER, address(anchor).code);
        _check(_publisher() == GOLDEN_SIGNER, "the same test key");
        _warpTo(1790870030);
        bytes memory signature = abi.encodePacked(GOLDEN_R, GOLDEN_S, GOLDEN_V);
        uint160 price = DominoPriceAnchor(GOLDEN_VERIFIER).verifyObservation(_goldenObservation(), signature, 60);
        _eq(price, GOLDEN_PRICE, "golden price");
        // RFC 6979 on both sides: Forge's signer gives eth_account's bytes.
        bytes memory forge = _signDigest(PUBLISHER_KEY, DominoV2Goldens.PRICE_OBSERVATION_DIGEST);
        _check(keccak256(forge) == keccak256(signature), "deterministic signatures agree");
    }

    /// The same code at another address on the same chain is another domain.
    function testDomainFollowsTheContractAddressOnTheSameChain() public {
        vm.etch(GOLDEN_VERIFIER, address(anchor).code);
        DominoPriceAnchor copy = DominoPriceAnchor(GOLDEN_VERIFIER);
        bytes32 copied = copy.domainSeparator();
        _check(copied == DominoV2Types.domainSeparator(block.chainid, GOLDEN_VERIFIER), "recomputed for the copy");
        _check(copied != anchor.domainSeparator(), "not the original's");
        DominoV2Types.PriceObservation memory point = _observation(_pool4(), PRICE);
        bytes memory signature = _sign(PUBLISHER_KEY, point);
        vm.expectRevert(IDominoPriceAnchor.InvalidObservation.selector);
        copy.verifyObservation(point, signature, MAX_AGE);
    }

    // ------------------------------------------------- what a signature binds
    function testSignatureBindsEveryField() public {
        DominoV2Types.PriceObservation memory point = _observation(_pool4(), PRICE);
        bytes memory signature = _sign(PUBLISHER_KEY, point);
        _eq(anchor.verifyObservation(point, signature, MAX_AGE), PRICE, "as signed");
        for (uint256 field; field < 10; ++field) {
            DominoV2Types.PriceObservation memory changed = _observation(_pool4(), PRICE);
            if (field == 0) changed.pool.dex = DominoV2Types.DEX_V3;
            else if (field == 1) changed.pool.currency0 = TOKEN_A;
            else if (field == 2) changed.pool.currency1 = TOKEN_B;
            else if (field == 3) changed.pool.fee = 500;
            else if (field == 4) changed.pool.tickSpacing = 10;
            else if (field == 5) changed.pool.hooks = address(0x4444);
            else if (field == 6) changed.sqrtPriceX96 = PRICE + 1;
            else if (field == 7) changed.observedAt -= 1;
            else if (field == 8) changed.validUntil -= 1;
            else changed.nonce = 2;
            vm.expectRevert(IDominoPriceAnchor.InvalidObservation.selector);
            anchor.verifyObservation(changed, signature, MAX_AGE);
        }
    }

    function testSignatureBindsTheContractAndTheChain() public {
        DominoV2Types.PriceObservation memory point = _observation(_pool4(), PRICE);
        bytes memory signature = _sign(PUBLISHER_KEY, point);
        DominoPriceAnchor other =
            new DominoPriceAnchor(address(registry), factory, MOCK_INIT_CODE_HASH, address(stateView), MIN_TWAP);
        vm.expectRevert(IDominoPriceAnchor.InvalidObservation.selector);
        other.verifyObservation(point, signature, MAX_AGE);
        bytes32 local = anchor.domainSeparator();
        vm.chainId(8453);
        bytes32 moved = anchor.domainSeparator();
        _check(moved != local && moved == DominoV2Types.domainSeparator(8453, address(anchor)), "domain follows the chain");
        vm.expectRevert(IDominoPriceAnchor.InvalidObservation.selector);
        anchor.verifyObservation(point, signature, MAX_AGE);
        bytes memory resigned = _sign(PUBLISHER_KEY, point);
        _eq(anchor.verifyObservation(point, resigned, MAX_AGE), PRICE, "signed for this chain");
    }

    function testOnlyAdmittedPublishersAttest() public {
        DominoV2Types.PriceObservation memory point = _observation(_pool4(), PRICE);
        bytes memory outsider = _sign(OUTSIDER_KEY, point);
        bytes memory operator = _sign(OPERATOR_KEY, point);
        bytes memory second = _sign(SECOND_PUBLISHER_KEY, point);
        bytes memory first = _sign(PUBLISHER_KEY, point);
        vm.expectRevert(IDominoPriceAnchor.InvalidObservation.selector);
        anchor.verifyObservation(point, outsider, MAX_AGE);
        vm.expectRevert(IDominoPriceAnchor.InvalidObservation.selector);
        anchor.verifyObservation(point, operator, MAX_AGE);
        _eq(anchor.verifyObservation(point, second, MAX_AGE), PRICE, "second publisher");
        vm.prank(GUARDIAN);
        registry.removePublisher(_publisher());
        vm.expectRevert(IDominoPriceAnchor.InvalidObservation.selector);
        anchor.verifyObservation(point, first, MAX_AGE);
        _eq(anchor.verifyObservation(point, second, MAX_AGE), PRICE, "the other publisher still attests");
    }

    function testMalformedSignaturesRecoverNoOne() public {
        DominoV2Types.PriceObservation memory point = _observation(_pool4(), PRICE);
        bytes32 digest = anchor.hashObservation(point);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PUBLISHER_KEY, digest);
        bytes[5] memory refused = [
            abi.encodePacked(r, s),
            // The valid signature with one trailing byte.
            abi.encodePacked(r, s, v, uint8(0)),
            bytes(""),
            // The malleated twin: same signer, s above half the curve order.
            abi.encodePacked(r, bytes32(CURVE_ORDER - uint256(s)), v == 27 ? uint8(28) : uint8(27)),
            abi.encodePacked(r, s, uint8(v + 2))
        ];
        for (uint256 i; i < refused.length; ++i) {
            vm.expectRevert(IDominoPriceAnchor.InvalidObservation.selector);
            anchor.verifyObservation(point, refused[i], MAX_AGE);
        }
        _eq(anchor.verifyObservation(point, abi.encodePacked(r, s, v), MAX_AGE), PRICE, "canonical form");
    }

    function testSignatureRecoveringNoOneIsRefusedWhateverTheRegistry() public {
        DominoPriceAnchor lax = new DominoPriceAnchor(
            address(new PermissiveRegistry()), factory, MOCK_INIT_CODE_HASH, address(stateView), MIN_TWAP
        );
        DominoV2Types.PriceObservation memory point = _observation(_pool4(), PRICE);
        bytes memory anyone = _signDigest(OUTSIDER_KEY, lax.hashObservation(point));
        _eq(lax.verifyObservation(point, anyone, MAX_AGE), PRICE, "this registry admits anyone");
        vm.expectRevert(IDominoPriceAnchor.InvalidObservation.selector);
        lax.verifyObservation(point, abi.encodePacked(bytes32(0), bytes32(0), uint8(27)), MAX_AGE);
    }

    // ---------------------------------------------------------- freshness
    function testObservationDatedInTheFutureIsRefused() public {
        DominoV2Types.PriceObservation memory point = _observation(_pool4(), PRICE);
        point.observedAt = uint64(clock) + 1;
        point.validUntil = uint64(clock) + 30;
        bytes memory signature = _sign(PUBLISHER_KEY, point);
        vm.expectRevert(IDominoPriceAnchor.InvalidObservation.selector);
        anchor.verifyObservation(point, signature, MAX_AGE);
        _advance(1);
        _eq(anchor.verifyObservation(point, signature, MAX_AGE), PRICE, "valid from its own second");
    }

    function testObservationExpiresAfterValidUntil() public {
        DominoV2Types.PriceObservation memory point = _observation(_pool4(), PRICE);
        bytes memory signature = _sign(PUBLISHER_KEY, point);
        _warpTo(point.validUntil);
        _eq(anchor.verifyObservation(point, signature, MAX_AGE), PRICE, "valid through validUntil");
        _warpTo(uint256(point.validUntil) + 1);
        vm.expectRevert(IDominoPriceAnchor.ObservationExpired.selector);
        anchor.verifyObservation(point, signature, MAX_AGE);
    }

    function testWindowLongerThanMaxAgeIsRefused() public {
        DominoV2Types.PriceObservation memory point = _observation(_pool4(), PRICE);
        bytes memory signature = _sign(PUBLISHER_KEY, point);
        uint32 window = uint32(point.validUntil - point.observedAt);
        vm.expectRevert(IDominoPriceAnchor.ObservationExpired.selector);
        anchor.verifyObservation(point, signature, window - 1);
        _eq(anchor.verifyObservation(point, signature, window), PRICE, "window equal to max age");
    }

    function testPriceOutsideTheTickRangeIsRefused() public {
        uint160[2] memory outside = [AnchorMath.MIN_SQRT_PRICE - 1, AnchorMath.MAX_SQRT_PRICE + 1];
        uint160[2] memory edges = [AnchorMath.MIN_SQRT_PRICE, AnchorMath.MAX_SQRT_PRICE];
        for (uint256 i; i < 2; ++i) {
            DominoV2Types.PriceObservation memory point = _observation(_pool4(), outside[i]);
            bytes memory signature = _sign(PUBLISHER_KEY, point);
            vm.expectRevert(IDominoPriceAnchor.InvalidObservation.selector);
            anchor.verifyObservation(point, signature, MAX_AGE);
            point = _observation(_pool4(), edges[i]);
            signature = _sign(PUBLISHER_KEY, point);
            _eq(anchor.verifyObservation(point, signature, MAX_AGE), edges[i], "range edge");
        }
    }

    // -------------------------------------------------- revocation, epoch
    function testPublisherRevokesAnObservation() public {
        DominoV2Types.PriceObservation memory point = _observation(_pool4(), PRICE);
        DominoV2Types.PriceObservation memory sibling = _observation(_pool4(), PRICE);
        sibling.nonce = 2;
        bytes memory signature = _sign(PUBLISHER_KEY, point);
        bytes memory siblingSignature = _sign(PUBLISHER_KEY, sibling);
        bytes32 hash = anchor.hashObservation(point);
        _check(!anchor.isRevoked(hash), "not yet");
        vm.expectEmit(true, true, false, false, address(anchor));
        emit IDominoPriceAnchor.ObservationRevokedBy(hash, _publisher());
        vm.prank(_publisher());
        anchor.revokeObservation(hash);
        _check(anchor.isRevoked(hash), "revoked");
        vm.expectRevert(IDominoPriceAnchor.ObservationRevoked.selector);
        anchor.verifyObservation(point, signature, MAX_AGE);
        _eq(anchor.verifyObservation(sibling, siblingSignature, MAX_AGE), PRICE, "revocation is per observation");
    }

    function testGuardianGovernanceAndAnyPublisherRevoke() public {
        address[3] memory revokers = [GUARDIAN, GOVERNANCE, vm.addr(SECOND_PUBLISHER_KEY)];
        for (uint256 i; i < revokers.length; ++i) {
            DominoV2Types.PriceObservation memory point = _observation(_pool4(), PRICE);
            point.nonce = uint64(10 + i);
            bytes memory signature = _sign(PUBLISHER_KEY, point);
            bytes32 hash = anchor.hashObservation(point);
            vm.prank(revokers[i]);
            anchor.revokeObservation(hash);
            vm.expectRevert(IDominoPriceAnchor.ObservationRevoked.selector);
            anchor.verifyObservation(point, signature, MAX_AGE);
        }
    }

    function testOutsidersCannotRevoke() public {
        bytes32 hash = anchor.hashObservation(_observation(_pool4(), PRICE));
        address[4] memory callers = [STRANGER, vm.addr(OPERATOR_KEY), vm.addr(OUTSIDER_KEY), RECIPIENT];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(DominoPriceAnchor.Unauthorized.selector);
            anchor.revokeObservation(hash);
        }
        vm.prank(GUARDIAN);
        registry.removePublisher(_publisher());
        vm.prank(_publisher());
        vm.expectRevert(DominoPriceAnchor.Unauthorized.selector);
        anchor.revokeObservation(hash);
        _check(!anchor.isRevoked(hash), "untouched");
    }

    function testRevokingTwiceIsRefused() public {
        bytes32 hash = keccak256("observation");
        vm.prank(GUARDIAN);
        anchor.revokeObservation(hash);
        vm.prank(GUARDIAN);
        vm.expectRevert(IDominoPriceAnchor.ObservationRevoked.selector);
        anchor.revokeObservation(hash);
    }

    function testObservationRevokedBeforeItsFirstUse() public {
        DominoV2Types.PriceObservation memory point = _observation(_pool4(), PRICE);
        bytes memory evidence = _signed(point);
        bytes32 hash = anchor.hashObservation(point);
        vm.prank(GUARDIAN);
        anchor.revokeObservation(hash);
        vm.expectRevert(IDominoPriceAnchor.ObservationRevoked.selector);
        anchor.anchor(_pool4(), evidence, MAX_AGE, 100);
    }

    function testEpochVoidsEveryEarlierObservation() public {
        DominoV2Types.PriceObservation memory point = _observation(_pool4(), PRICE);
        bytes memory first = _sign(PUBLISHER_KEY, point);
        bytes memory second = _sign(SECOND_PUBLISHER_KEY, point);
        DominoV2Types.PriceObservation memory atEpoch = _observation(_pool4(), PRICE);
        atEpoch.observedAt = point.observedAt + 1;
        bytes memory atEpochSignature = _sign(PUBLISHER_KEY, atEpoch);
        vm.prank(GUARDIAN);
        registry.raiseObservationEpoch(point.observedAt + 1);
        vm.expectRevert(IDominoPriceAnchor.ObservationRevoked.selector);
        anchor.verifyObservation(point, first, MAX_AGE);
        vm.expectRevert(IDominoPriceAnchor.ObservationRevoked.selector);
        anchor.verifyObservation(point, second, MAX_AGE);
        _eq(anchor.verifyObservation(atEpoch, atEpochSignature, MAX_AGE), PRICE, "made at the epoch");
    }

    /// An observation is an attestation, not an authorization: anyone may
    /// present it again while it is valid. Replay across pools, contracts
    /// and chains is what the signature binds.
    function testObservationIsReusableWithinItsWindow() public view {
        bytes memory evidence = _signed(_observation(_pool4(), PRICE));
        (uint160 firstAnchor, uint160 firstSpot) = anchor.anchor(_pool4(), evidence, MAX_AGE, 100);
        (uint160 againAnchor, uint160 againSpot) = anchor.anchor(_pool4(), evidence, MAX_AGE, 100);
        _check(firstAnchor == againAnchor && firstSpot == againSpot && firstAnchor == PRICE, "same reading");
    }

    // --------------------------------------------- anchor with observations
    function testAnchorReturnsTheObservationAndTheV4Spot() public {
        uint160 spot = PRICE + PRICE / 1000;
        _setV4Spot(_pool4(), spot);
        bytes memory evidence = _signed(_observation(_pool4(), PRICE));
        // (1.001)^2 = 1.002001: 20.01 bps on the price.
        (uint160 anchored, uint160 read) = anchor.anchor(_pool4(), evidence, MAX_AGE, 21);
        _check(anchored == PRICE && read == spot, "anchor and spot");
        vm.expectRevert(IDominoPriceAnchor.SpotOutsideBand.selector);
        anchor.anchor(_pool4(), evidence, MAX_AGE, 20);
    }

    function testAnchorReadsAV3SpotForAnObservation() public {
        _placeV3Pool(_pool3(), PRICE);
        bytes memory evidence = _signed(_observation(_pool3(), PRICE));
        (uint160 anchored, uint160 spot) = anchor.anchor(_pool3(), evidence, MAX_AGE, 0);
        _check(anchored == PRICE && spot == PRICE, "v3 observation");
    }

    function testAnchorRefusesAnObservationForAnotherPool() public {
        bytes memory evidence = _signed(_observation(_pool4(), PRICE));
        for (uint256 field; field < 6; ++field) {
            DominoV2Types.PoolRef memory requested = _pool4();
            if (field == 0) requested.dex = DominoV2Types.DEX_V3;
            else if (field == 1) requested.currency0 = TOKEN_A;
            else if (field == 2) requested.currency1 = TOKEN_B;
            else if (field == 3) requested.fee = 500;
            else if (field == 4) requested.tickSpacing = 10;
            else requested.hooks = address(0x4444);
            // The requested pool exists at the signed price: only the pool check can refuse.
            if (requested.dex == DominoV2Types.DEX_V3) _placeV3Pool(requested, PRICE);
            else _setV4Spot(requested, PRICE);
            vm.expectRevert(IDominoPriceAnchor.InvalidObservation.selector);
            anchor.anchor(requested, evidence, MAX_AGE, 100);
        }
    }

    function testAnchorAppliesTheObservationRules() public {
        DominoV2Types.PriceObservation memory point = _observation(_pool4(), PRICE);
        bytes memory outsider = _evidence(point, _sign(OUTSIDER_KEY, point));
        vm.expectRevert(IDominoPriceAnchor.InvalidObservation.selector);
        anchor.anchor(_pool4(), outsider, MAX_AGE, 100);
        bytes memory evidence = _signed(point);
        vm.expectRevert(IDominoPriceAnchor.ObservationExpired.selector);
        anchor.anchor(_pool4(), evidence, 59, 100);
        _warpTo(uint256(point.validUntil) + 1);
        vm.expectRevert(IDominoPriceAnchor.ObservationExpired.selector);
        anchor.anchor(_pool4(), evidence, MAX_AGE, 100);
    }

    // ---------------------------------------------------------------- band
    function testBandEdgesInBothDirections() public {
        uint160 unit = 1 << 90;
        // (101/100)^2 = 1.0201: a 201 bps band ends exactly 1% away in sqrt price.
        _band(100 * unit, 101 * unit, 201, true);
        _band(100 * unit, 101 * unit + 1, 201, false);
        _band(101 * unit, 100 * unit, 201, true);
        _band(101 * unit, 100 * unit - 1, 201, false);
        _band(100 * unit, 101 * unit, 200, false);
        _band(101 * unit, 100 * unit, 200, false);
        _band(PRICE, PRICE, 0, true);
        _band(PRICE, PRICE + 1, 0, false);
        _band(PRICE, PRICE - 1, 0, false);
    }

    function _band(uint160 anchorPrice, uint160 spot, uint16 deviation, bool inside) internal {
        _setV4Spot(_pool4(), spot);
        bytes memory evidence = _signed(_observation(_pool4(), anchorPrice));
        if (!inside) vm.expectRevert(IDominoPriceAnchor.SpotOutsideBand.selector);
        anchor.anchor(_pool4(), evidence, MAX_AGE, deviation);
    }

    // ---------------------------------------------------------------- TWAP
    function _twapPool(int24 tick, uint32 window) internal returns (MockV3Pool pool) {
        pool = _placeV3Pool(_pool3(), AnchorMath.getSqrtPriceAtTick(tick));
        pool.setCumulative(window, 1_000_000);
        pool.setCumulative(0, 1_000_000 + int56(tick) * int56(uint56(window)));
    }

    function testTwapAnchorsAV3Pool() public {
        int24 tick = -201060;
        _twapPool(tick, 120);
        uint160 expected = AnchorMath.getSqrtPriceAtTick(tick);
        (uint160 anchored, uint160 spot) = anchor.anchor(_pool3(), abi.encode(uint32(120)), MAX_AGE, 0);
        _check(anchored == expected && spot == expected, "TWAP anchor");
        _eq(anchor.twapSqrtPrice(_pool3(), 120), expected, "raw TWAP");
    }

    function testTwapMeanTickRoundsTowardNegativeInfinity() public {
        MockV3Pool pool = _placeV3Pool(_pool3(), PRICE);
        pool.setCumulative(120, 0);
        int56[4] memory ends = [int56(-121), -120, 121, 239];
        int24[4] memory means = [int24(-2), -1, 1, 1];
        for (uint256 i; i < ends.length; ++i) {
            pool.setCumulative(0, ends[i]);
            _eq(anchor.twapSqrtPrice(_pool3(), 120), AnchorMath.getSqrtPriceAtTick(means[i]), "mean tick");
        }
    }

    /// The pool's accumulator wraps in int56; the difference must wrap with it.
    function testTwapDifferenceWrapsInInt56() public {
        MockV3Pool pool = _placeV3Pool(_pool3(), PRICE);
        pool.setCumulative(120, type(int56).max - 9);
        pool.setCumulative(0, type(int56).min + 110);
        _eq(anchor.twapSqrtPrice(_pool3(), 120), AnchorMath.getSqrtPriceAtTick(1), "wrapped difference");
    }

    function testTwapWindowStaysBetweenTheFloorAndMaxAge() public {
        // A flat history at tick 0, readable over every window tried.
        MockV3Pool pool = _twapPool(0, MIN_TWAP);
        uint32[4] memory windows = [MIN_TWAP - 1, MIN_TWAP, MAX_AGE, MAX_AGE + 1];
        for (uint256 i; i < windows.length; ++i) {
            pool.setCumulative(windows[i], 0);
        }
        pool.setCumulative(0, 0);
        vm.expectRevert(IDominoPriceAnchor.TwapUnavailable.selector);
        anchor.anchor(_pool3(), abi.encode(MIN_TWAP - 1), MAX_AGE, 0);
        anchor.anchor(_pool3(), abi.encode(MIN_TWAP), MAX_AGE, 0);
        anchor.anchor(_pool3(), abi.encode(MAX_AGE), MAX_AGE, 0);
        vm.expectRevert(IDominoPriceAnchor.TwapUnavailable.selector);
        anchor.anchor(_pool3(), abi.encode(MAX_AGE + 1), MAX_AGE, 0);
        vm.expectRevert(IDominoPriceAnchor.TwapUnavailable.selector);
        anchor.anchor(_pool3(), abi.encode((uint256(1) << 32) + MIN_TWAP), MAX_AGE, 0);
    }

    function testTwapIsUnavailableOnV4() public {
        vm.expectRevert(IDominoPriceAnchor.TwapUnavailable.selector);
        anchor.anchor(_pool4(), abi.encode(uint32(120)), MAX_AGE, 100);
        vm.expectRevert(IDominoPriceAnchor.TwapUnavailable.selector);
        anchor.twapSqrtPrice(_pool4(), 120);
    }

    function testTwapIsUnavailableWithoutHistory() public {
        MockV3Pool pool = _twapPool(0, 120);
        pool.setHistoryTooShort(true);
        vm.expectRevert(IDominoPriceAnchor.TwapUnavailable.selector);
        anchor.twapSqrtPrice(_pool3(), 120);
        vm.expectRevert(IDominoPriceAnchor.TwapUnavailable.selector);
        anchor.anchor(_pool3(), abi.encode(uint32(120)), MAX_AGE, 100);
    }

    function testTwapOfAMissingPoolOrWindowIsUnavailable() public {
        vm.expectRevert(IDominoPriceAnchor.TwapUnavailable.selector);
        anchor.twapSqrtPrice(_pool3(), 120);
        _twapPool(0, 120);
        vm.expectRevert(IDominoPriceAnchor.TwapUnavailable.selector);
        anchor.twapSqrtPrice(_pool3(), 0);
    }

    function testTwapOutsideTheTickRangeIsUnavailable() public {
        MockV3Pool pool = _placeV3Pool(_pool3(), PRICE);
        pool.setCumulative(1, 0);
        pool.setCumulative(0, int56(AnchorMath.MAX_TICK) + 1);
        vm.expectRevert(IDominoPriceAnchor.TwapUnavailable.selector);
        anchor.twapSqrtPrice(_pool3(), 1);
        pool.setCumulative(0, int56(AnchorMath.MIN_TICK) - 1);
        vm.expectRevert(IDominoPriceAnchor.TwapUnavailable.selector);
        anchor.twapSqrtPrice(_pool3(), 1);
        pool.setCumulative(0, int56(AnchorMath.MAX_TICK));
        _eq(anchor.twapSqrtPrice(_pool3(), 1), AnchorMath.MAX_SQRT_PRICE, "top tick");
        pool.setCumulative(0, int56(AnchorMath.MIN_TICK));
        _eq(anchor.twapSqrtPrice(_pool3(), 1), AnchorMath.MIN_SQRT_PRICE, "bottom tick");
    }

    function testTwapAnchorIsBandChecked() public {
        MockV3Pool pool = _twapPool(0, 120);
        pool.setSlot0(AnchorMath.getSqrtPriceAtTick(101), true);
        // 101 ticks is about 1.0101 on the price: outside 100 bps, inside 102.
        vm.expectRevert(IDominoPriceAnchor.SpotOutsideBand.selector);
        anchor.anchor(_pool3(), abi.encode(uint32(120)), MAX_AGE, 100);
        anchor.anchor(_pool3(), abi.encode(uint32(120)), MAX_AGE, 102);
    }

    // ---------------------------------------------------------------- spot
    function testV3SpotNeedsAnInitializedUnlockedPoolWithItsSpacing() public {
        MockV3Pool pool = _placeV3Pool(_pool3(), PRICE);
        _eq(anchor.spotSqrtPrice(_pool3()), PRICE, "spot");
        pool.setSlot0(PRICE, false);
        vm.expectRevert(DominoPriceAnchor.PoolUnavailable.selector);
        anchor.spotSqrtPrice(_pool3());
        pool.setSlot0(0, true);
        vm.expectRevert(DominoPriceAnchor.PoolUnavailable.selector);
        anchor.spotSqrtPrice(_pool3());
        pool.setSlot0(PRICE, true);
        pool.setTickSpacing(10);
        vm.expectRevert(DominoPriceAnchor.PoolUnavailable.selector);
        anchor.spotSqrtPrice(_pool3());
        pool.setTickSpacing(60);
        pool.setSlotReverts(true);
        vm.expectRevert(DominoPriceAnchor.PoolUnavailable.selector);
        anchor.spotSqrtPrice(_pool3());
    }

    function testLockedV3PoolIsRefusedByAnchor() public {
        MockV3Pool pool = _placeV3Pool(_pool3(), PRICE);
        bytes memory evidence = _signed(_observation(_pool3(), PRICE));
        pool.setSlot0(PRICE, false);
        vm.expectRevert(DominoPriceAnchor.PoolUnavailable.selector);
        anchor.anchor(_pool3(), evidence, MAX_AGE, 100);
    }

    function testV3ReferenceWithAHookOrUnknownDexIsRefused() public {
        _placeV3Pool(_pool3(), PRICE);
        DominoV2Types.PoolRef memory hooked = _pool3();
        hooked.hooks = address(0x4444);
        vm.expectRevert(DominoPriceAnchor.PoolUnavailable.selector);
        anchor.spotSqrtPrice(hooked);
        uint8[3] memory unknown = [uint8(0), 2, 5];
        for (uint256 i; i < unknown.length; ++i) {
            DominoV2Types.PoolRef memory odd = _pool3();
            odd.dex = unknown[i];
            vm.expectRevert(DominoPriceAnchor.PoolUnavailable.selector);
            anchor.spotSqrtPrice(odd);
            vm.expectRevert(IDominoPriceAnchor.TwapUnavailable.selector);
            anchor.twapSqrtPrice(odd, 120);
        }
    }

    function testMissingOrUninitializedPoolsAreRefused() public {
        vm.expectRevert(DominoPriceAnchor.PoolUnavailable.selector);
        anchor.spotSqrtPrice(_pool3());
        DominoV2Types.PoolRef memory fresh = _pool4();
        fresh.fee = 500;
        vm.expectRevert(DominoPriceAnchor.PoolUnavailable.selector);
        anchor.spotSqrtPrice(fresh);
        bytes memory evidence = _signed(_observation(fresh, PRICE));
        vm.expectRevert(DominoPriceAnchor.PoolUnavailable.selector);
        anchor.anchor(fresh, evidence, MAX_AGE, 100);
    }

    function testDisabledVersionsAreRefused() public {
        DominoPriceAnchor v4Only =
            new DominoPriceAnchor(address(registry), address(0), bytes32(0), address(stateView), MIN_TWAP);
        // A pool where a zero factory and hash would point, so only the guard refuses.
        address phantom = _v3Address(address(0), bytes32(0), _pool3());
        vm.etch(phantom, address(new MockV3Pool()).code);
        MockV3Pool(phantom).setSlot0(PRICE, true);
        MockV3Pool(phantom).setTickSpacing(60);
        vm.expectRevert(DominoPriceAnchor.PoolUnavailable.selector);
        v4Only.spotSqrtPrice(_pool3());
        _eq(v4Only.spotSqrtPrice(_pool4()), PRICE, "v4 still served");
        DominoPriceAnchor v3Only =
            new DominoPriceAnchor(address(registry), factory, MOCK_INIT_CODE_HASH, address(0), MIN_TWAP);
        vm.expectRevert(DominoPriceAnchor.PoolUnavailable.selector);
        v3Only.spotSqrtPrice(_pool4());
        _placeV3Pool(_pool3(), PRICE);
        _eq(v3Only.spotSqrtPrice(_pool3()), PRICE, "v3 still served");
    }

    /// The CREATE2 derivation names the pools Uniswap actually deployed: the
    /// factories, init code hash and pool addresses are from the chain
    /// profiles (getPool == CREATE2, read on-chain on 1 Oct 2026).
    function testV3AddressesMatchTheDeployedPools() public {
        bytes32 initCodeHash = 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
        _derives( // Robinhood WETH/USDG 0.3%
            0x1f7d7550B1b028f7571E69A784071F0205FD2EfA,
            initCodeHash,
            0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73,
            USDG,
            3000,
            60,
            0xa9188730Fe85Be88ad499D7d52B099e800fB0334
        );
        _derives( // Base WETH/USDC 0.05%
            0x33128a8fC17869897dcE68Ed026d694621f6FDfD,
            initCodeHash,
            0x4200000000000000000000000000000000000006,
            0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
            500,
            10,
            0xd0b53D9277642d899DF5C87A3966A349A798F224
        );
        _derives( // Arbitrum WETH/USDC 0.05%
            0x1F98431c8aD98523631AE4a59f267346ea31F984,
            initCodeHash,
            0x82aF49447D8a07e3bd95BD0d56f35241523fBab1,
            0xaf88d065e77c8cC2239327C5EDb3A432268e5831,
            500,
            10,
            0xC6962004f452bE9203591991D15f6b388e09E8D0
        );
    }

    function _derives(
        address v3Factory,
        bytes32 initCodeHash,
        address tokenX,
        address tokenY,
        uint24 fee,
        int24 spacing,
        address expected
    ) internal {
        (address token0, address token1) = tokenX < tokenY ? (tokenX, tokenY) : (tokenY, tokenX);
        vm.etch(v3Factory, factory.code);
        DominoPriceAnchor chain =
            new DominoPriceAnchor(address(registry), v3Factory, initCodeHash, address(stateView), MIN_TWAP);
        vm.etch(expected, address(new MockV3Pool()).code);
        MockV3Pool(expected).setSlot0(PRICE, true);
        MockV3Pool(expected).setTickSpacing(spacing);
        DominoV2Types.PoolRef memory ref = DominoV2Types.PoolRef({
            dex: DominoV2Types.DEX_V3, currency0: token0, currency1: token1, fee: fee, tickSpacing: spacing, hooks: address(0)
        });
        _eq(chain.spotSqrtPrice(ref), PRICE, "derived the deployed pool");
    }

    // --------------------------------------------------------- deployment
    function testConstructorRefusesAnInvalidConfiguration() public {
        address view_ = address(stateView);
        address reg = address(registry);
        _refuseAnchor(address(0xDEAD), factory, MOCK_INIT_CODE_HASH, view_, MIN_TWAP);
        _refuseAnchor(reg, factory, bytes32(0), view_, MIN_TWAP);
        _refuseAnchor(reg, address(0), MOCK_INIT_CODE_HASH, view_, MIN_TWAP);
        _refuseAnchor(reg, address(0), bytes32(0), address(0), MIN_TWAP);
        _refuseAnchor(reg, address(0xDEAD), MOCK_INIT_CODE_HASH, view_, MIN_TWAP);
        _refuseAnchor(reg, factory, MOCK_INIT_CODE_HASH, address(0xDEAD), MIN_TWAP);
        _refuseAnchor(reg, factory, MOCK_INIT_CODE_HASH, view_, 0);
        _refuseAnchor(reg, factory, MOCK_INIT_CODE_HASH, view_, 1 days + 1);
        _eq(new DominoPriceAnchor(reg, factory, MOCK_INIT_CODE_HASH, view_, 1 days).minTwapSeconds(), 1 days, "max");
        _eq(new DominoPriceAnchor(reg, factory, MOCK_INIT_CODE_HASH, view_, 1).minTwapSeconds(), 1, "min");
    }

    function _refuseAnchor(address reg, address v3Factory, bytes32 initCodeHash, address view_, uint32 minTwap)
        internal
    {
        vm.expectRevert(DominoPriceAnchor.InvalidConfig.selector);
        new DominoPriceAnchor(reg, v3Factory, initCodeHash, view_, minTwap);
    }

    function testDeploymentRecordsItsConfiguration() public view {
        _check(anchor.registry() == address(registry) && anchor.v3Factory() == factory, "registry and factory");
        _check(anchor.v3PoolInitCodeHash() == MOCK_INIT_CODE_HASH, "init code hash");
        _check(anchor.v4StateView() == address(stateView), "state view");
        _eq(anchor.minTwapSeconds(), MIN_TWAP, "TWAP floor");
        _check(anchor.domainSeparator() == DominoV2Types.domainSeparator(block.chainid, address(anchor)), "domain");
    }

    function testRuntimeFitsTheContractSizeLimit() public view {
        _check(address(anchor).code.length <= 24_576, "runtime size");
    }
}
