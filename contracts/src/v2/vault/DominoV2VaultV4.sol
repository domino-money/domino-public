// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {IDominoVault} from "../interfaces/IDominoVault.sol";
import {IDominoRegistry} from "../interfaces/IDominoRegistry.sol";
import {IDominoVaultLedger} from "../interfaces/IDominoVaultLedger.sol";
import {IV4PoolManagerMinimal, IV4PositionManagerMinimal} from "../external/IUniswapV4Minimal.sol";
import {DominoFeeLedger} from "../fees/DominoFeeLedger.sol";
import {DominoV4Positions} from "../positions/DominoV4Positions.sol";
import {DominoSwapFloor} from "../route/DominoSwapFloor.sol";
import {DominoV2VaultStorage} from "./DominoV2VaultStorage.sol";
import {DominoV2VaultBase} from "./DominoV2VaultBase.sol";
import {DominoV2VaultExecutor} from "./DominoV2VaultExecutor.sol";

/// @notice Uniswap v4 custody: the root stays in the owner's wallet with an
/// individual approval to the vault, and the vault is the root's subscriber.
/// Position steps are F1c's DominoV4Positions, run inside a PoolManager unlock
/// the vault itself holds.
abstract contract DominoV2VaultV4Hooks is DominoV2VaultStorage {
    error ForeignSubscriber(address subscriber);
    error HookedPool(address hooks);

    /// Whether a root in a pool with hooks is accepted: no (owner decisions of
    /// 2 and 3 Oct 2026), so such a pool is refused at creation; a registry list
    /// of approved hooks may come with a new implementation. Successors share
    /// the root's pool.
    bool internal constant ACCEPT_HOOKED_POOLS = false;

    bytes32 internal constant T_SUBSCRIBING = keccak256("domino.vault.subscribing");

    uint8 private constant STEP_COLLECT = 0;
    uint8 private constant STEP_INCREASE = 1;
    uint8 private constant STEP_MINT = 2;
    uint8 private constant STEP_WITHDRAW = 3;

    /// One position step, carried through the PoolManager's unlock.
    struct Step {
        uint8 kind;
        DominoV2Types.PoolRef pool;
        uint256 tokenId;
        int24 tickLower;
        int24 tickUpper;
        /// Maxima to pay (increase, mint) or minima to receive (withdraw).
        uint128 amount0;
        uint128 amount1;
        /// The minimum to add (increase, mint) or the amount to remove (withdraw).
        uint128 liquidity;
    }

    /// The PositionManager's own PoolManager, so the two always match.
    IV4PoolManagerMinimal internal immutable POOL_MANAGER;

    constructor() {
        POOL_MANAGER = IV4PoolManagerMinimal(IV4PositionManagerMinimal(POSITION_MANAGER).poolManager());
    }

    function _readRoot(uint256 tokenId)
        internal
        view
        override
        returns (DominoV2Types.PoolRef memory pool, int24 tickLower, int24 tickUpper)
    {
        // Reverts for a token that was never minted or was burned.
        DominoV4Positions.Position memory root = DominoV4Positions.position(_managers(), tokenId);
        if (!ACCEPT_HOOKED_POOLS && root.pool.hooks != address(0)) revert HookedPool(root.pool.hooks);
        return (root.pool, root.tickLower, root.tickUpper);
    }

    /// Subscribes the vault to the root, or keeps the subscription it has.
    function _arm() internal override {
        if (!_rootApproved()) revert IDominoVault.AutomationUnavailable();
        uint256 tokenId = _rootTokenId;
        IV4PositionManagerMinimal manager = IV4PositionManagerMinimal(POSITION_MANAGER);
        address current = manager.subscriber(tokenId);
        if (current == address(this)) return;
        if (current != address(0)) revert ForeignSubscriber(current);
        bytes32 slot = T_SUBSCRIBING;
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
        manager.subscribe(tokenId, address(this), "");
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    function _rootLive() internal view override returns (uint8) {
        if (!_rootApproved() || IV4PositionManagerMinimal(POSITION_MANAGER).subscriber(_rootTokenId) != address(this)) {
            return DISARM_CUSTODY;
        }
        return 0;
    }

    function _liquidity(uint256 tokenId) internal view override returns (uint128) {
        return IV4PositionManagerMinimal(POSITION_MANAGER).getPositionLiquidity(tokenId);
    }

    /// The direction's protocol fee plus the LP fee, as v4-core charges them
    /// (F1b's DominoSwapFloor, from the PoolManager's slot0).
    function _swapFeePips(bool zeroForOne) internal view override returns (uint24 fee) {
        (, fee) = DominoSwapFloor.v4SpotAndFee(address(POOL_MANAGER), _pool(), zeroForOne);
    }

    function _afterRootStep() internal override {}

    /// v4 has no open increase: every change reaches the subscriber, and only
    /// the owner rearms.
    function _onlyLiquidityAdded(IDominoVaultLedger.RootCheckpoint calldata)
        internal
        pure
        override
        returns (bool)
    {
        return false;
    }

    function _feesSettleOnModify() internal pure override returns (bool) {
        return true;
    }

    function _stepCollect(DominoV2Types.PoolRef memory pool, uint256 tokenId) internal override {
        _unlocked(Step(STEP_COLLECT, pool, tokenId, 0, 0, 0, 0, 0));
    }

    function _stepIncrease(
        DominoV2Types.PoolRef memory pool,
        uint256 tokenId,
        uint128 amount0Max,
        uint128 amount1Max,
        uint128 minLiquidity
    ) internal override returns (uint128 liquidity) {
        (, liquidity) = _unlocked(Step(STEP_INCREASE, pool, tokenId, 0, 0, amount0Max, amount1Max, minLiquidity));
    }

    function _stepMint(
        DominoV2Types.PoolRef memory pool,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Max,
        uint128 amount1Max,
        uint128 minLiquidity
    ) internal override returns (uint256, uint128) {
        return _unlocked(Step(STEP_MINT, pool, 0, tickLower, tickUpper, amount0Max, amount1Max, minLiquidity));
    }

    function _stepWithdraw(
        DominoV2Types.PoolRef memory pool,
        uint256 tokenId,
        uint128 liquidity,
        uint128 amount0Min,
        uint128 amount1Min
    ) internal override {
        _unlocked(Step(STEP_WITHDRAW, pool, tokenId, 0, 0, amount0Min, amount1Min, liquidity));
    }

    /// Holds the PoolManager unlock for one step; the vault's unlockCallback
    /// sees the flag and runs the step in the executor (_runStep).
    function _unlocked(Step memory step) private returns (uint256 tokenId, uint128 liquidity) {
        bytes32 slot = T_UNLOCK;
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
        bytes memory result = POOL_MANAGER.unlock(abi.encode(step));
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
        return abi.decode(result, (uint256, uint128));
    }

    /// The step, inside the vault's own unlock, for the vault itself: fees and
    /// principal come to the vault, payments leave its balance, a mint is its.
    function _runStep(bytes calldata data) internal returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER) || !_unlocking()) revert UnexpectedCallback();
        Step memory step = abi.decode(data, (Step));
        DominoV4Positions.Managers memory m = _managers();
        DominoV4Positions.Result memory r;
        if (step.kind == STEP_COLLECT) {
            r = DominoV4Positions.collect(m, step.tokenId, step.pool, address(this));
        } else if (step.kind == STEP_INCREASE) {
            r = DominoV4Positions.increase(m, step.tokenId, step.pool, step.amount0, step.amount1, step.liquidity);
        } else if (step.kind == STEP_MINT) {
            r = DominoV4Positions.mint(
                m, step.pool, step.tickLower, step.tickUpper, step.amount0, step.amount1, step.liquidity, address(this)
            );
        } else {
            r = DominoV4Positions.withdraw(
                m, step.tokenId, step.pool, step.liquidity, step.amount0, step.amount1, address(this), false
            );
        }
        return abi.encode(r.tokenId, r.liquidity);
    }

    function _managers() private view returns (DominoV4Positions.Managers memory) {
        return DominoV4Positions.Managers(POOL_MANAGER, IV4PositionManagerMinimal(POSITION_MANAGER));
    }
}

/// @notice The v4 vault's executor; see DominoV2VaultExecutor.
contract DominoV2VaultExecutorV4 is DominoV2VaultExecutor, DominoV2VaultV4Hooks {
    constructor(Deployment memory deployment)
        DominoV2VaultStorage(DominoV2Types.DEX_V4, deployment)
        DominoFeeLedger(IDominoRegistry(deployment.registry))
    {}

    /// Reached by DELEGATECALL from the vault's unlockCallback while the vault
    /// holds the unlock for a position step; refused otherwise.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        return _runStep(data);
    }
}

/// @notice The Uniswap v4 vault implementation (component vault.v4).
/// @dev The position manager notifies the subscriber of every change to the
/// root. Modify and burn notifications block the owner's change if the
/// subscriber reverts, so the vault never reverts on one: it disarms the root.
/// A transfer unsubscribes (best effort, within the manager's
/// unsubscribeGasLimit, 300,000 on the deployed chains) and clears the
/// approval; either way the root is disarmed and its automation stops until
/// the owner rearms.
contract DominoV2VaultV4 is DominoV2VaultBase, DominoV2VaultV4Hooks {
    constructor(Deployment memory deployment)
        DominoV2VaultStorage(DominoV2Types.DEX_V4, deployment)
        DominoFeeLedger(IDominoRegistry(deployment.registry))
        DominoV2VaultBase(address(new DominoV2VaultExecutorV4(deployment)))
    {}

    /// Accepted only while the vault itself subscribes to its root: the flag
    /// is set around that one PositionManager call, which makes this one call
    /// back, for the root, and nothing else runs in between.
    function notifySubscribe(uint256, bytes calldata) external view {
        bytes32 slot = T_SUBSCRIBING;
        bool subscribing;
        assembly ("memory-safe") {
            subscribing := tload(slot)
        }
        if (!subscribing) revert UnexpectedCallback();
    }

    function notifyUnsubscribe(uint256 tokenId) external {
        _notified(tokenId, DISARM_UNSUBSCRIBED, false);
    }

    /// The vault's own steps on the root are expected; any other change is the
    /// owner's, or that of an operator the owner approved, and disarms the root.
    function notifyModifyLiquidity(uint256 tokenId, int256, int256) external {
        _notified(tokenId, DISARM_MODIFIED, _inRootStep());
    }

    function notifyBurn(uint256 tokenId, address, uint256, uint256, int256) external {
        _notified(tokenId, DISARM_BURNED, false);
    }

    /// No liquidity left. A burn clears the token's position info, and the
    /// PositionManager then reads its liquidity as zero, so a burned root and
    /// one decreased to zero are both closed.
    function _rootClosed() internal view override returns (bool) {
        return _liquidity(_rootTokenId) == 0;
    }

    /// Never reverts for the position manager, whose notification would then
    /// block the owner's own change; only another caller is refused.
    function _notified(uint256 tokenId, uint8 reason, bool ownStep) private {
        if (msg.sender != POSITION_MANAGER) revert UnexpectedCallback();
        if (tokenId != _rootTokenId || ownStep || !_rootArmed) return;
        _disarm(reason);
    }
}
