// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IUniswapV3PoolMinimal, IUniswapV3PositionManagerMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {DominoPositionMath} from "../../../src/v2/positions/DominoPositionMath.sol";
import {IV3PoolInitializerMinimal} from "../../../src/v2/positions/DominoV3Positions.sol";
import {UniswapBase8453} from "../positions/fixtures/UniswapBase8453.sol";
import {V3SwapDriver} from "../positions/PositionTestKit.sol";
import {VaultHarness} from "./VaultHarness.sol";

/// The NonfungiblePositionManager's ERC721 calls the tests make.
interface IV3PositionManagerTest {
    function approve(address spender, uint256 tokenId) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// The v3 world on the factory, NonfungiblePositionManager and WETH9 bytecode
/// deployed on Base (F1c's fixtures, hash-checked against the chain profile),
/// etched at their addresses with the storage their constructors set. The
/// pool comes from the deployed factory's own creation code, at price one.
/// Fees are real: swaps through the pool, which credits them to in-range
/// positions. This test contract pays for the positions it mints, and its
/// swap driver for the swaps. HarnessV3 (VaultHarness.sol) is the exact-number
/// unit model; this harness is the deployed build the vault meets on chain.
abstract contract HarnessV3Base is VaultHarness {
    IUniswapV3PositionManagerMinimal internal v3Manager;
    V3SwapDriver internal trader;
    address internal v3Pool;

    function _dex() internal pure override returns (uint8) {
        return DominoV2Types.DEX_V3;
    }

    function _artifact() internal pure override returns (string memory) {
        return "DominoV2VaultV3.sol:DominoV2VaultV3";
    }

    function _deployDex() internal override {
        _etchFixture(UniswapBase8453.V3_FACTORY, UniswapBase8453.V3_FACTORY_ARTIFACT, UniswapBase8453.V3_FACTORY_CODEHASH);
        _etchFixture(
            UniswapBase8453.V3_POSITION_MANAGER,
            UniswapBase8453.V3_POSITION_MANAGER_ARTIFACT,
            UniswapBase8453.V3_POSITION_MANAGER_CODEHASH
        );
        _etchFixture(UniswapBase8453.WETH9, UniswapBase8453.WETH9_ARTIFACT, UniswapBase8453.WETH9_CODEHASH);
        (address[] memory accounts, bytes32[] memory slots, bytes32[] memory values) =
            UniswapBase8453.constructorStorage();
        for (uint256 i; i < accounts.length; ++i) {
            vm.store(accounts[i], slots[i], values[i]);
        }
        v3Manager = IUniswapV3PositionManagerMinimal(UniswapBase8453.V3_POSITION_MANAGER);
        manager = address(v3Manager);
        _deployVault(address(swaps));
        trader = new V3SwapDriver();
        token0.mint(address(this), 1e30);
        token1.mint(address(this), 1e30);
        token0.mint(address(trader), 1e30);
        token1.mint(address(trader), 1e30);
        token0.approve(address(v3Manager), type(uint256).max);
        token1.approve(address(v3Manager), type(uint256).max);
    }

    function _etchFixture(address target, string memory artifact, bytes32 codehash) private {
        bytes memory init = vm.getCode(artifact);
        address holder;
        assembly ("memory-safe") {
            holder := create(0, add(init, 0x20), mload(init))
        }
        require(holder != address(0) && holder.codehash == codehash, "fixture code hash");
        vm.etch(target, holder.code);
    }

    function _currency0() internal view override returns (address) {
        return address(token0);
    }

    function _ensurePool() internal {
        if (v3Pool != address(0)) return;
        v3Pool = IV3PoolInitializerMinimal(address(v3Manager)).createAndInitializePoolIfNecessary(
            address(token0), address(token1), poolFee, PRICE_ONE
        );
    }

    /// Mints at least `liquidity` to `owner` at the pool's price: the manager
    /// sizes the liquidity from the amounts, rounded down, so the amounts are
    /// those of one unit more.
    function _mintPosition(address owner, int24 lower, int24 upper, uint128 liquidity)
        internal
        override
        returns (uint256 tokenId)
    {
        _ensurePool();
        (uint160 price,,,,,,) = IUniswapV3PoolMinimal(v3Pool).slot0();
        (uint256 amount0, uint256 amount1) =
            DominoPositionMath.amountsForLiquidity(price, lower, upper, liquidity + 1, true);
        (tokenId,,,) = v3Manager.mint(
            IUniswapV3PositionManagerMinimal.MintParams(
                address(token0), address(token1), poolFee, lower, upper, amount0, amount1, 0, 0, owner, block.timestamp
            )
        );
    }

    function _approveNft(address owner, uint256 tokenId, address spender) internal override {
        vm.prank(owner);
        IV3PositionManagerTest(address(v3Manager)).approve(spender, tokenId);
    }

    /// Swaps through the pool, one way then the other, so that the pool earns
    /// about fee0 and fee1 (amountIn x the LP fee); an in-range position earns
    /// its share of them.
    function _accrue(uint256, uint256 fee0, uint256 fee1) internal override {
        _ensurePool();
        if (fee0 != 0) trader.swap(v3Pool, true, fee0 * 1_000_000 / poolFee);
        if (fee1 != 0) trader.swap(v3Pool, false, fee1 * 1_000_000 / poolFee);
    }

    function _liquidityOf(uint256 tokenId) internal view override returns (uint128 liquidity) {
        (,,,,,,, liquidity,,,,) = v3Manager.positions(tokenId);
    }

    function _ownerOfNft(uint256 tokenId) internal view override returns (address) {
        return v3Manager.ownerOf(tokenId);
    }

    /// The owner removes a little liquidity: principal waits in tokensOwed.
    function _ownerChangesRoot() internal override {
        vm.prank(OWNER);
        v3Manager.decreaseLiquidity(
            IUniswapV3PositionManagerMinimal.DecreaseLiquidityParams(rootId, 1, 0, 0, block.timestamp)
        );
    }

    function _transferNft(address from, address to, uint256 tokenId) internal override {
        vm.prank(from);
        IV3PositionManagerTest(address(v3Manager)).transferFrom(from, to, tokenId);
    }

    /// The owner removes all of a position's liquidity, as through the Uniswap
    /// app; with `collectAll` it also takes everything owed, and with `burn`
    /// it burns the emptied NFT.
    function _ownerEmpties(uint256 tokenId, bool collectAll, bool burn) internal {
        uint128 liquidity = _liquidityOf(tokenId);
        vm.startPrank(OWNER);
        if (liquidity != 0) {
            v3Manager.decreaseLiquidity(
                IUniswapV3PositionManagerMinimal.DecreaseLiquidityParams(tokenId, liquidity, 0, 0, block.timestamp)
            );
        }
        if (collectAll || burn) {
            v3Manager.collect(
                IUniswapV3PositionManagerMinimal.CollectParams(tokenId, OWNER, type(uint128).max, type(uint128).max)
            );
        }
        if (burn) v3Manager.burn(tokenId);
        vm.stopPrank();
    }
}

