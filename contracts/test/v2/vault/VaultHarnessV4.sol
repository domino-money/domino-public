// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {IV4PoolManagerMinimal, IV4PositionManagerMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {DominoV4Positions} from "../../../src/v2/positions/DominoV4Positions.sol";
import {DominoSwapExecutor} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {UniswapBase8453} from "../positions/fixtures/UniswapBase8453.sol";
import {RobinhoodPermit2} from "../route/fixtures/RobinhoodPermit2.sol";
import {MockToken} from "./VaultMocks.sol";
import {VaultHarness} from "./VaultHarness.sol";

/// The PoolManager calls the tests make beyond F0's minimal surface.
interface IV4PoolManagerTest {
    function initialize(IV4PoolManagerMinimal.PoolKey memory key, uint160 sqrtPriceX96) external returns (int24);
    function donate(IV4PoolManagerMinimal.PoolKey memory key, uint256 amount0, uint256 amount1, bytes calldata hookData)
        external
        returns (int256);
    function setProtocolFeeController(address controller) external;
    function setProtocolFee(IV4PoolManagerMinimal.PoolKey memory key, uint24 newProtocolFee) external;
}

/// The PositionManager's ERC721 calls the tests make.
interface IV4PositionManagerTest {
    function approve(address spender, uint256 id) external;
    function setApprovalForAll(address operator, bool approved) external;
    function transferFrom(address from, address to, uint256 id) external;
}

/// The v4 world: the PoolManager and PositionManager bytecode deployed on Base
/// (F1c's fixtures, hash-checked against the chain profile), etched at their
/// addresses. The vault's own steps, the owner's changes and the subscriber
/// notifications are all the deployed build's. Fees are real: donations to
/// the pool, credited to in-range positions by the PoolManager. This test
/// contract owns the PoolManager and pays for the positions it mints.
abstract contract HarnessV4 is VaultHarness {
    uint8 internal constant INCREASE = 0x00;
    uint8 internal constant DECREASE = 0x01;
    uint8 internal constant MINT = 0x02;
    uint8 internal constant BURN = 0x03;
    uint8 internal constant SETTLE = 0x0b;
    uint8 internal constant TAKE_PAIR = 0x11;
    uint8 internal constant SWEEP = 0x14;

    IV4PoolManagerMinimal internal poolManager;
    IV4PositionManagerMinimal internal pm;
    /// The pool's currency0 is native ETH; set before creating the root.
    bool internal nativePair;
    /// The pool's hooks; set (with a dynamic fee) before creating the root.
    address internal hooks;
    mapping(bytes32 => bool) internal _poolReady;

    receive() external payable {}

    function _dex() internal pure override returns (uint8) {
        return DominoV2Types.DEX_V4;
    }

    function _artifact() internal pure override returns (string memory) {
        return "DominoV2VaultV4.sol:DominoV2VaultV4";
    }

    function _deployDex() internal override {
        _etchFixture(
            UniswapBase8453.V4_POOL_MANAGER, UniswapBase8453.V4_POOL_MANAGER_ARTIFACT, UniswapBase8453.V4_POOL_MANAGER_CODEHASH
        );
        _etchFixture(
            UniswapBase8453.V4_POSITION_MANAGER,
            UniswapBase8453.V4_POSITION_MANAGER_ARTIFACT,
            UniswapBase8453.V4_POSITION_MANAGER_CODEHASH
        );
        (address[] memory accounts, bytes32[] memory slots, bytes32[] memory values) =
            UniswapBase8453.constructorStorage();
        for (uint256 i; i < accounts.length; ++i) {
            vm.store(accounts[i], slots[i], values[i]);
        }
        // The PoolManager's owner (slot 0) sets the protocol fee controller.
        vm.store(UniswapBase8453.V4_POOL_MANAGER, bytes32(0), bytes32(uint256(uint160(address(this)))));
        poolManager = IV4PoolManagerMinimal(UniswapBase8453.V4_POOL_MANAGER);
        pm = IV4PositionManagerMinimal(UniswapBase8453.V4_POSITION_MANAGER);
        manager = address(pm);
        _deployVault(address(swaps));
        token0.mint(address(this), 1e30);
        token1.mint(address(this), 1e30);
        vm.deal(address(this), 1e30);
        vm.deal(address(venue), 1e30);
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
        return nativePair ? address(0) : address(token0);
    }

    function _key() internal view returns (IV4PoolManagerMinimal.PoolKey memory) {
        return IV4PoolManagerMinimal.PoolKey(_currency0(), address(token1), poolFee, 60, hooks);
    }

    function _poolRef() internal view returns (DominoV2Types.PoolRef memory) {
        return DominoV2Types.PoolRef(DominoV2Types.DEX_V4, _currency0(), address(token1), poolFee, 60, hooks);
    }

    function _managers() internal view returns (DominoV4Positions.Managers memory) {
        return DominoV4Positions.Managers(poolManager, pm);
    }

    /// What a collect of `tokenId` would deliver now, as the PoolManager credits it.
    function _collectable(uint256 tokenId) internal view returns (uint256, uint256) {
        return DominoV4Positions.collectable(_managers(), tokenId);
    }

    function _ensurePool(IV4PoolManagerMinimal.PoolKey memory key) internal {
        bytes32 id = keccak256(abi.encode(key));
        if (_poolReady[id]) return;
        IV4PoolManagerTest(address(poolManager)).initialize(key, PRICE_ONE);
        _poolReady[id] = true;
    }

    /// Mints exactly `liquidity` to `owner` in the vault's pool.
    function _mintPosition(address owner, int24 lower, int24 upper, uint128 liquidity)
        internal
        override
        returns (uint256 tokenId)
    {
        return _mintIn(_key(), owner, lower, upper, liquidity);
    }

    /// Mints exactly `liquidity` to `owner` in `key`'s pool (initialized at
    /// price one), paid by this contract through the PositionManager's own
    /// balance (SETTLE from it, SWEEP the rest back).
    function _mintIn(IV4PoolManagerMinimal.PoolKey memory key, address owner, int24 lower, int24 upper, uint128 liquidity)
        internal
        returns (uint256 tokenId)
    {
        _ensurePool(key);
        tokenId = pm.nextTokenId();
        // Liquidity L never costs more than L of either token in any range at price one.
        uint128 budget = liquidity + 1;
        bytes[] memory params = new bytes[](5);
        params[0] = abi.encode(key, lower, upper, uint256(liquidity), budget, budget, owner, bytes(""));
        _paid(address(this), params, budget, MINT);
    }

    /// A deep full-range 0.05% pool of the vault's currencies, for swap legs
    /// that should not move the vault's own pool.
    function _deepPool() internal returns (DominoV2Types.PoolRef memory deep) {
        deep = DominoV2Types.PoolRef(DominoV2Types.DEX_V4, _currency0(), address(token1), 500, 10, address(0));
        _mintIn(
            IV4PoolManagerMinimal.PoolKey(deep.currency0, deep.currency1, 500, 10, address(0)),
            address(this),
            -887270,
            887270,
            1e24
        );
    }

    /// Rebuilds the implementation and factory with the production swap
    /// module (F1b's executor) on the deployed PoolManager, with Robinhood's
    /// deployed Permit2 in place for router legs. v3 legs are off (no factory).
    function _useSwapModule() internal returns (address module) {
        vm.etch(RobinhoodPermit2.ADDRESS, RobinhoodPermit2.RUNTIME);
        module = vm.deployCode(
            "DominoV2VaultSwapModule.sol:DominoV2VaultSwapModule",
            abi.encode(
                DominoSwapExecutor.RouteConfig(
                    IDominoRegistry(address(registry)), RobinhoodPermit2.ADDRESS, address(0), bytes32(0), address(poolManager)
                )
            )
        );
        _deployVault(module);
    }

    /// `actor` runs `action` (params[0]) followed by SETTLE, SETTLE, SWEEP,
    /// SWEEP: this contract funds the PositionManager with `budget` of each
    /// currency, which pays the debts from its own balance and sweeps the rest
    /// back here.
    function _paid(address actor, bytes[] memory params, uint128 budget, uint8 action) internal {
        address currency0 = _currency0();
        params[1] = abi.encode(currency0, uint256(0), false);
        params[2] = abi.encode(address(token1), uint256(0), false);
        params[3] = abi.encode(currency0, address(this));
        params[4] = abi.encode(address(token1), address(this));
        if (!nativePair) token0.transfer(address(pm), budget);
        token1.transfer(address(pm), budget);
        uint256 value = nativePair ? budget : 0;
        if (actor != address(this)) {
            vm.deal(actor, actor.balance + value);
            vm.prank(actor);
        }
        pm.modifyLiquidities{value: value}(
            abi.encode(abi.encodePacked(action, SETTLE, SETTLE, SWEEP, SWEEP), params), block.timestamp
        );
    }

    function _approveNft(address owner, uint256 tokenId, address spender) internal override {
        vm.prank(owner);
        IV4PositionManagerTest(address(pm)).approve(spender, tokenId);
    }

    /// The pool earns fee0/fee1 for its in-range liquidity (a donation); the
    /// positions' shares follow the PoolManager's fee growth, rounded down.
    function _accrue(uint256, uint256 fee0, uint256 fee1) internal override {
        donateFees(fee0, fee1);
    }

    /// Reached also from a swap step double, mid-execution.
    function donateFees(uint256 fee0, uint256 fee1) public {
        poolManager.unlock(abi.encode(fee0, fee1));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "pool manager only");
        (uint256 fee0, uint256 fee1) = abi.decode(data, (uint256, uint256));
        IV4PoolManagerTest(address(poolManager)).donate(_key(), fee0, fee1, "");
        _settle(_currency0(), fee0);
        _settle(address(token1), fee1);
        return "";
    }

    function _settle(address currency, uint256 amount) private {
        if (amount == 0) return;
        poolManager.sync(currency);
        if (currency == address(0)) {
            poolManager.settle{value: amount}();
        } else {
            MockToken(currency).transfer(address(poolManager), amount);
            poolManager.settle();
        }
    }

    function _liquidityOf(uint256 tokenId) internal view override returns (uint128) {
        return pm.getPositionLiquidity(tokenId);
    }

    function _ownerOfNft(uint256 tokenId) internal view override returns (address) {
        return pm.ownerOf(tokenId);
    }

    /// The owner removes a little liquidity: the subscriber is notified.
    function _ownerChangesRoot() internal override {
        _modify(OWNER, rootId, -1);
    }

    /// `actor` changes a position through the PositionManager, as the Uniswap
    /// app does: a decrease (or 0, a fee collection) takes everything to the
    /// actor; an increase is paid by this contract.
    function _modify(address actor, uint256 tokenId, int256 delta) internal {
        if (delta > 0) {
            uint128 budget = uint128(uint256(delta)) + 1;
            bytes[] memory params = new bytes[](5);
            params[0] = abi.encode(tokenId, uint256(delta), budget, budget, bytes(""));
            _paid(actor, params, budget, INCREASE);
            return;
        }
        bytes[] memory taken = new bytes[](2);
        taken[0] = abi.encode(tokenId, uint256(-delta), uint128(0), uint128(0), bytes(""));
        taken[1] = abi.encode(_currency0(), address(token1), actor);
        vm.prank(actor);
        pm.modifyLiquidities(abi.encode(abi.encodePacked(DECREASE, TAKE_PAIR), taken), block.timestamp);
    }

    /// The owner burns the root, taking everything.
    function _burnRoot() internal {
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(rootId, uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(_currency0(), address(token1), OWNER);
        vm.prank(OWNER);
        pm.modifyLiquidities(abi.encode(abi.encodePacked(BURN, TAKE_PAIR), params), block.timestamp);
    }

    function _transferNft(address from, address to, uint256 tokenId) internal override {
        vm.prank(from);
        IV4PositionManagerTest(address(pm)).transferFrom(from, to, tokenId);
    }
}
