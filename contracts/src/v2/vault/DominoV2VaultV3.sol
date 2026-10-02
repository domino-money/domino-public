// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {IDominoVault} from "../interfaces/IDominoVault.sol";
import {IDominoRegistry} from "../interfaces/IDominoRegistry.sol";
import {IDominoVaultLedger} from "../interfaces/IDominoVaultLedger.sol";
import {IUniswapV3FactoryMinimal, IUniswapV3PositionManagerMinimal} from "../external/IUniswapV3Minimal.sol";
import {DominoFeeLedger} from "../fees/DominoFeeLedger.sol";
import {DominoV3Positions} from "../positions/DominoV3Positions.sol";
import {FullMath} from "../positions/uniswap/FullMath.sol";
import {DominoV2VaultStorage} from "./DominoV2VaultStorage.sol";
import {DominoV2VaultBase} from "./DominoV2VaultBase.sol";
import {DominoV2VaultExecutor} from "./DominoV2VaultExecutor.sol";

/// @notice Uniswap v3 custody: the root stays in the owner's wallet with an
/// individual approval to the vault, which re-verifies it on every execution.
/// @dev v3 has no subscriber. After each of its own steps on the root the
/// vault records a checkpoint of it in the NonfungiblePositionManager
/// (liquidity, both fee-growth checkpoints, both tokensOwed); an execution
/// that needs the root compares it first, and any difference means someone
/// else changed the position: the root is disarmed and nothing is spent.
/// increaseLiquidity is open to anyone on v3, so a third party can add dust
/// to the root and disarm it: a registry operator may then rearm it, when the
/// only change is more liquidity (operatorRearm); anything else waits for the
/// owner. Each checkpoint is emitted (RootCheckpointed) for that purpose.
/// Position steps are F1c's DominoV3Positions, for the vault itself.
abstract contract DominoV2VaultV3Hooks is DominoV2VaultStorage {
    /// The position manager's own factory, so the two always match.
    IUniswapV3FactoryMinimal internal immutable V3_FACTORY;

    constructor() {
        V3_FACTORY = IUniswapV3FactoryMinimal(IUniswapV3PositionManagerMinimal(POSITION_MANAGER).factory());
    }

    function _readRoot(uint256 tokenId)
        internal
        view
        override
        returns (DominoV2Types.PoolRef memory pool, int24 tickLower, int24 tickUpper)
    {
        // Reverts for a token that does not exist; an existing position's fee
        // tier is enabled, so its spacing is positive.
        DominoV3Positions.Position memory root = DominoV3Positions.position(_managers(), tokenId);
        return (root.pool, root.tickLower, root.tickUpper);
    }

    /// Whatever the manager already owes the root may be principal from an
    /// owner's decrease: when there is any, everything owed and accrued goes
    /// to the owner untouched, and only fee growth from the checkpoint on
    /// becomes automation fees.
    function _arm() internal override {
        if (!_rootApproved()) revert IDominoVault.AutomationUnavailable();
        uint256 tokenId = _rootTokenId;
        DominoV3Positions.Managers memory m = _managers();
        DominoV3Positions.Position memory root = DominoV3Positions.position(m, tokenId);
        if (root.tokensOwed0 != 0 || root.tokensOwed1 != 0) DominoV3Positions.collect(m, tokenId, root.pool, _owner);
        _record();
    }

    function _rootLive() internal view override returns (uint8) {
        if (!_rootApproved()) return DISARM_CUSTODY;
        if (keccak256(abi.encode(_checkpoint())) != _rootCheckpoint) return DISARM_CHECKPOINT;
        return 0;
    }

    function _afterRootStep() internal override {
        _record();
    }

    /// Additions poke the fees accrued at the liquidity of the moment into
    /// tokensOwed and move both fee-growth checkpoints. So with fee growth g
    /// since `previous`, what the root is owed must have grown by at least
    /// g x previous liquidity (no collect) and at most g x current liquidity
    /// (no principal from a decrease).
    function _onlyLiquidityAdded(IDominoVaultLedger.RootCheckpoint calldata previous)
        internal
        view
        override
        returns (bool)
    {
        if (keccak256(abi.encode(previous)) != _rootCheckpoint || !_rootApproved()) return false;
        IDominoVaultLedger.RootCheckpoint memory current = _checkpoint();
        uint256 growth0;
        uint256 growth1;
        unchecked {
            growth0 = current.feeGrowthInside0LastX128 - previous.feeGrowthInside0LastX128;
            growth1 = current.feeGrowthInside1LastX128 - previous.feeGrowthInside1LastX128;
        }
        return current.liquidity > previous.liquidity
            && _onlyFeesPoked(previous.tokensOwed0, current.tokensOwed0, growth0, previous.liquidity, current.liquidity)
            && _onlyFeesPoked(previous.tokensOwed1, current.tokensOwed1, growth1, previous.liquidity, current.liquidity);
    }

    function _liquidity(uint256 tokenId) internal view override returns (uint128 liquidity) {
        (,,,,,,, liquidity,,,,) = IUniswapV3PositionManagerMinimal(POSITION_MANAGER).positions(tokenId);
    }

    /// A v3 protocol fee is a share of the LP fee, not an addition to it.
    function _swapFeePips(bool) internal view override returns (uint24) {
        return _fee;
    }

    /// increaseLiquidity pokes fees into tokensOwed; it never settles them.
    function _feesSettleOnModify() internal pure override returns (bool) {
        return false;
    }

    function _stepCollect(DominoV2Types.PoolRef memory pool, uint256 tokenId) internal override {
        DominoV3Positions.collect(_managers(), tokenId, pool, address(this));
    }

    function _stepIncrease(
        DominoV2Types.PoolRef memory pool,
        uint256 tokenId,
        uint128 amount0Max,
        uint128 amount1Max,
        uint128 minLiquidity
    ) internal override returns (uint128) {
        return DominoV3Positions.increase(_managers(), tokenId, pool, amount0Max, amount1Max, minLiquidity).liquidity;
    }

    function _stepMint(
        DominoV2Types.PoolRef memory pool,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Max,
        uint128 amount1Max,
        uint128 minLiquidity
    ) internal override returns (uint256, uint128) {
        DominoV3Positions.Result memory r = DominoV3Positions.mint(
            _managers(), pool, tickLower, tickUpper, amount0Max, amount1Max, minLiquidity, address(this)
        );
        return (r.tokenId, r.liquidity);
    }

    function _stepWithdraw(
        DominoV2Types.PoolRef memory pool,
        uint256 tokenId,
        uint128 liquidity,
        uint128 amount0Min,
        uint128 amount1Min
    ) internal override {
        DominoV3Positions.withdraw(_managers(), tokenId, pool, liquidity, amount0Min, amount1Min, address(this), false);
    }

    function _managers() private view returns (DominoV3Positions.Managers memory) {
        return DominoV3Positions.Managers(IUniswapV3PositionManagerMinimal(POSITION_MANAGER), V3_FACTORY);
    }

    /// The raw read, one call, on every execution that needs the root.
    function _checkpoint() private view returns (IDominoVaultLedger.RootCheckpoint memory c) {
        (,,,,,,, c.liquidity, c.feeGrowthInside0LastX128, c.feeGrowthInside1LastX128, c.tokensOwed0, c.tokensOwed1) =
            IUniswapV3PositionManagerMinimal(POSITION_MANAGER).positions(_rootTokenId);
    }

    /// Stores the checkpoint's hash and emits the checkpoint, which an
    /// operator needs to rearm after a third party's addition.
    function _record() private {
        IDominoVaultLedger.RootCheckpoint memory c = _checkpoint();
        _rootCheckpoint = keccak256(abi.encode(c));
        emit IDominoVaultLedger.RootCheckpointed(c);
    }

    function _onlyFeesPoked(uint128 owedBefore, uint128 owedNow, uint256 growth, uint128 liquidityBefore, uint128 liquidityNow)
        private
        pure
        returns (bool)
    {
        if (owedNow < owedBefore) return false;
        uint256 poked = owedNow - owedBefore;
        return poked >= FullMath.mulDiv(growth, liquidityBefore, 1 << 128)
            && poked <= FullMath.mulDiv(growth, liquidityNow, 1 << 128);
    }
}

/// @notice The v3 vault's executor; see DominoV2VaultExecutor.
contract DominoV2VaultExecutorV3 is DominoV2VaultExecutor, DominoV2VaultV3Hooks {
    constructor(Deployment memory deployment)
        DominoV2VaultStorage(DominoV2Types.DEX_V3, deployment)
        DominoFeeLedger(IDominoRegistry(deployment.registry))
    {}
}

/// @notice The Uniswap v3 vault implementation (component vault.v3).
contract DominoV2VaultV3 is DominoV2VaultBase, DominoV2VaultV3Hooks {
    /// keccak256 of the NonfungiblePositionManager's refusal of a token that
    /// does not exist, Error("Invalid token ID"): positions() of v3-periphery
    /// 1.0.0, the build deployed on Robinhood, Base and Arbitrum.
    bytes32 private constant NO_SUCH_TOKEN = 0x0c8d4288bb9236adbada2de6e0bf1807631966685254b486e230ac9d8f0a9426;

    constructor(Deployment memory deployment)
        DominoV2VaultStorage(DominoV2Types.DEX_V3, deployment)
        DominoFeeLedger(IDominoRegistry(deployment.registry))
        DominoV2VaultBase(address(new DominoV2VaultExecutorV3(deployment)))
    {}

    /// No liquidity left, or the NFT no longer exists: a burn deletes the
    /// position, and positions() then refuses the token by name. Any other
    /// failure of the read (out of gas, say) leaves the root open.
    function _rootClosed() internal view override returns (bool) {
        (bool ok, bytes memory data) =
            POSITION_MANAGER.staticcall(abi.encodeCall(IUniswapV3PositionManagerMinimal.positions, (_rootTokenId)));
        if (!ok) return keccak256(data) == NO_SUCH_TOKEN;
        (,,,,,,, uint128 liquidity) =
            abi.decode(data, (uint96, address, address, address, uint24, int24, int24, uint128));
        return liquidity == 0;
    }
}
