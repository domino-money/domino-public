// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolManager} from "../../reference/official-v4/v4-core/src/PoolManager.sol";
import {StateView} from "../../reference/official-v4/v4-periphery/src/lens/StateView.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {AnchorMath} from "../../../src/v2/anchor/AnchorMath.sol";
import {DominoPriceAnchor} from "../../../src/v2/anchor/DominoPriceAnchor.sol";
import {IDominoPriceAnchor} from "../../../src/v2/interfaces/IDominoPriceAnchor.sol";
import {CodeStub} from "../registry/RegistryFixtures.sol";
import {AnchorFixtures} from "./AnchorFixtures.sol";

/// @notice The anchor's v4 spot read against the vendored PoolManager and
/// StateView (v4-core 59d3ecf, v4-periphery dce236d): the PoolRef-to-PoolId
/// derivation and the getSlot0 reading are Uniswap's, not a double's. This
/// file news the vendored contracts, so it compiles them through IR; it is
/// kept apart from the fast anchor suite on purpose.
contract DominoPriceAnchorV4OfficialTest is AnchorFixtures {
    using PoolIdLibrary for PoolKey;

    PoolManager internal manager;
    StateView internal lens;

    function setUp() public {
        _warpTo(START);
        _deployRegistry();
        manager = new PoolManager(address(this));
        lens = new StateView(IPoolManager(address(manager)));
        factory = address(new CodeStub());
        anchor = new DominoPriceAnchor(address(registry), factory, MOCK_INIT_CODE_HASH, address(lens), MIN_TWAP);
    }

    function _key(DominoV2Types.PoolRef memory pool) internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(pool.currency0),
            currency1: Currency.wrap(pool.currency1),
            fee: pool.fee,
            tickSpacing: pool.tickSpacing,
            hooks: IHooks(pool.hooks)
        });
    }

    function _ref(uint24 fee, int24 spacing) internal pure returns (DominoV2Types.PoolRef memory pool) {
        pool = _pool4();
        pool.fee = fee;
        pool.tickSpacing = spacing;
    }

    function testPoolIdIsTheOfficialPoolId() public pure {
        DominoV2Types.PoolRef memory hooked = _ref(0x800000, 1);
        hooked.currency0 = TOKEN_A;
        hooked.currency1 = TOKEN_B;
        hooked.hooks = address(0x4444000000000000000000000000000000000080);
        DominoV2Types.PoolRef[4] memory pools = [_pool4(), _ref(500, 10), _ref(10000, 32767), hooked];
        for (uint256 i; i < pools.length; ++i) {
            _check(_poolId(pools[i]) == PoolId.unwrap(_key(pools[i]).toId()), "PoolIdLibrary.toId");
        }
    }

    function testAnchorReadsTheOfficialStateView() public {
        DominoV2Types.PoolRef[3] memory pools = [_pool4(), _ref(500, 10), _ref(10000, 200)];
        uint160[3] memory prices =
            [PRICE, AnchorMath.getSqrtPriceAtTick(-201060), AnchorMath.getSqrtPriceAtTick(69080) + 12345];
        for (uint256 i; i < pools.length; ++i) {
            manager.initialize(_key(pools[i]), prices[i]);
            (uint160 official,,,) = lens.getSlot0(_key(pools[i]).toId());
            _eq(official, prices[i], "official reading");
            _eq(anchor.spotSqrtPrice(pools[i]), prices[i], "anchor reading");
        }
    }

    function testAnchorBandsAnObservationAgainstTheOfficialPool() public {
        manager.initialize(_key(_pool4()), PRICE);
        uint160 attested = PRICE + PRICE / 1000;
        bytes memory evidence = _signed(_observation(_pool4(), attested));
        (uint160 anchored, uint160 spot) = anchor.anchor(_pool4(), evidence, MAX_AGE, 21);
        _check(anchored == attested && spot == PRICE, "anchor and official spot");
        vm.expectRevert(IDominoPriceAnchor.SpotOutsideBand.selector);
        anchor.anchor(_pool4(), evidence, MAX_AGE, 20);
    }

    function testUninitializedOfficialPoolIsRefused() public {
        vm.expectRevert(DominoPriceAnchor.PoolUnavailable.selector);
        anchor.spotSqrtPrice(_pool4());
        manager.initialize(_key(_ref(500, 10)), PRICE);
        vm.expectRevert(DominoPriceAnchor.PoolUnavailable.selector);
        anchor.spotSqrtPrice(_pool4());
    }
}
