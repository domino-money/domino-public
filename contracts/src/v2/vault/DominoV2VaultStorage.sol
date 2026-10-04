// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {IDominoVault} from "../interfaces/IDominoVault.sol";
import {IDominoVaultLedger} from "../interfaces/IDominoVaultLedger.sol";
import {IDominoRegistry} from "../interfaces/IDominoRegistry.sol";
import {IDominoPriceAnchor} from "../interfaces/IDominoPriceAnchor.sol";
import {DominoActionLock} from "../route/DominoActionLock.sol";
import {DominoTokenOps} from "../route/DominoTokenOps.sol";

interface IERC721Minimal {
    function transferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
}

/// @notice The storage layout, wiring and shared internals of a Domino V2
/// vault, common to the vault implementation (DominoV2VaultBase) and its
/// executor (DominoV2VaultExecutor), which runs by DELEGATECALL in the vault's
/// storage. Both inherit this contract and nothing else that declares state,
/// so their layouts are the same by construction.
/// @dev The fee ledger (members, lots, idle reserves) is described in
/// IDominoVaultLedger. Fees the owner withdraws are never charged. Domino's
/// tariff that the fee recipient could not receive is owed in F1b's
/// DominoFeeLedger (ERC-7201 storage, clear of this layout). Every entry point
/// takes F1b's one transient lock (DominoActionLock), which the swap-leg
/// executor requires and flushOwedFees shares.
abstract contract DominoV2VaultStorage is DominoActionLock {
    error InvalidInit();
    error InvalidPlan();
    error PlanExpired();
    error StaleNonce();
    error TooSoon();
    error InvalidPosition();
    error InvalidRoute();
    error InvalidAmount();
    error InsufficientReserves();
    error InvalidRecipient();
    error StepUnavailable();
    error InvalidInstruction();
    error UnexpectedCallback();

    /// Chain-level wiring; identical for an implementation, its executor and
    /// every clone.
    struct Deployment {
        address factory;
        address registry;
        address priceAnchor;
        address positionManager;
        /// The chain's DominoV2VaultSwapModule (F1b's swap-leg executor),
        /// reached by DELEGATECALL; zero leaves swaps unavailable.
        address swapModule;
        address autoExit;
    }

    /// Why the root stopped being armed (RootDisarmed.reason).
    uint8 internal constant DISARM_UNSUBSCRIBED = 1;
    uint8 internal constant DISARM_MODIFIED = 2;
    uint8 internal constant DISARM_BURNED = 3;
    uint8 internal constant DISARM_CUSTODY = 4;
    uint8 internal constant DISARM_CHECKPOINT = 5;
    uint8 internal constant DISARM_EXITED = 6;
    uint8 internal constant DISARM_EXIT_ALL = 7;

    /// Set while the vault itself holds a v4 PoolManager unlock for a position step.
    bytes32 internal constant T_UNLOCK = keccak256("domino.vault.unlock");
    /// Set while a step changes the root, so its v4 notification is the vault's own.
    bytes32 private constant T_ROOT_STEP = keccak256("domino.vault.rootStep");

    uint8 internal immutable DEX;
    address internal immutable FACTORY;
    IDominoRegistry internal immutable REGISTRY;
    IDominoPriceAnchor internal immutable PRICE_ANCHOR;
    address internal immutable POSITION_MANAGER;
    address internal immutable SWAP_MODULE;
    address internal immutable AUTO_EXIT;

    // slot 0
    address internal _owner;
    uint64 internal _stateNonce;
    bool internal _paused;
    bool internal _rootArmed;
    /// The quote currency of the Domino geometry is currency0, so prices are
    /// read as currency0 per currency1. Fixed at initialization.
    bool internal _inverse;
    bool internal _initialized;
    // slot 1: policy, limits, the last execution and the last disarm reason
    uint8 internal _mode;
    uint16 internal _triggerDistanceBps;
    uint16 internal _maxOverlapBps;
    uint32 internal _minimumIntervalSeconds;
    uint8 internal _maxPositions;
    uint16 internal _maxSlippageBps;
    uint16 internal _maxPriceImpactBps;
    uint32 internal _maxObservationAgeSeconds;
    uint32 internal _upsideBps;
    uint64 internal _lastExecutionAt;
    /// Why the root was last disarmed (a DISARM_* reason); stale while armed.
    uint8 internal _disarmReason;
    // slots 2-4: the pool; slot 4 also holds the root token id, packed
    // after the hooks
    address internal _currency0;
    uint24 internal _fee;
    int24 internal _tickSpacing;
    address internal _currency1;
    address internal _hooks;
    uint96 internal _rootTokenId;
    // slot 5
    address internal _exitModule;
    // slot 6: the v3 root checkpoint (unused on v4)
    bytes32 internal _rootCheckpoint;

    uint256[] internal _members;
    mapping(uint256 tokenId => IDominoVaultLedger.Member) internal _member;
    mapping(uint256 tokenId => mapping(address token => IDominoVaultLedger.Lot)) internal _lots;
    mapping(address token => uint256) internal _idle;

    constructor(uint8 dex, Deployment memory deployment) {
        if (
            deployment.factory == address(0) || deployment.registry == address(0)
                || deployment.priceAnchor == address(0) || deployment.positionManager == address(0)
        ) revert InvalidInit();
        DEX = dex;
        FACTORY = deployment.factory;
        REGISTRY = IDominoRegistry(deployment.registry);
        PRICE_ANCHOR = IDominoPriceAnchor(deployment.priceAnchor);
        POSITION_MANAGER = deployment.positionManager;
        SWAP_MODULE = deployment.swapModule;
        AUTO_EXIT = deployment.autoExit;
        // An implementation or an executor is never itself a vault.
        _initialized = true;
    }

    // ===================================================== DEX-specific hooks

    /// The root's pool and range, read from its position manager.
    function _readRoot(uint256 tokenId)
        internal
        view
        virtual
        returns (DominoV2Types.PoolRef memory pool, int24 tickLower, int24 tickUpper);

    /// Takes custody of the root (v4: subscribe; v3: checkpoint). Reverts
    /// unless the owner holds the root and the vault has its individual approval.
    function _arm() internal virtual;

    /// Zero while the vault may act on the root; otherwise the DISARM_* reason.
    function _rootLive() internal view virtual returns (uint8 reason);

    /// After the vault itself changed the root (v3: records the new checkpoint).
    function _afterRootStep() internal virtual;

    function _liquidity(uint256 tokenId) internal view virtual returns (uint128);

    /// The pool's whole swap fee in a direction, LP plus protocol, in pips.
    function _swapFeePips(bool zeroForOne) internal view virtual returns (uint24);

    /// Whether changing a position settles its accrued fees into the change (v4).
    function _feesSettleOnModify() internal pure virtual returns (bool);

    /// Whether the only change to the root since `previous` is more liquidity,
    /// under the vault's custody (v3; never on v4). See operatorRearm.
    function _onlyLiquidityAdded(IDominoVaultLedger.RootCheckpoint calldata previous)
        internal
        view
        virtual
        returns (bool);

    /// Position steps, through F1c's DominoV3Positions / DominoV4Positions,
    /// always for the vault itself: fees and principal come to the vault,
    /// payments leave the vault's balance, a mint is owned by the vault. The
    /// vault measures every token movement around them with balances.
    function _stepCollect(DominoV2Types.PoolRef memory pool, uint256 tokenId) internal virtual;

    function _stepIncrease(
        DominoV2Types.PoolRef memory pool,
        uint256 tokenId,
        uint128 amount0Max,
        uint128 amount1Max,
        uint128 minLiquidity
    ) internal virtual returns (uint128 liquidity);

    function _stepMint(
        DominoV2Types.PoolRef memory pool,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Max,
        uint128 amount1Max,
        uint128 minLiquidity
    ) internal virtual returns (uint256 tokenId, uint128 liquidity);

    function _stepWithdraw(
        DominoV2Types.PoolRef memory pool,
        uint256 tokenId,
        uint128 liquidity,
        uint128 amount0Min,
        uint128 amount1Min
    ) internal virtual;

    // ============================================================ internals

    function _wiring() internal view returns (Deployment memory) {
        return Deployment(FACTORY, address(REGISTRY), address(PRICE_ANCHOR), POSITION_MANAGER, SWAP_MODULE, AUTO_EXIT);
    }

    function _pool() internal view returns (DominoV2Types.PoolRef memory) {
        return DominoV2Types.PoolRef(DEX, _currency0, _currency1, _fee, _tickSpacing, _hooks);
    }

    function _disarm(uint8 reason) internal {
        _markDisarmed(reason);
        emit IDominoVault.RootDisarmed(reason, ++_stateNonce);
    }

    function _markDisarmed(uint8 reason) internal {
        _rootArmed = false;
        _disarmReason = reason;
    }

    /// The owner still holds the root and the vault still has its individual
    /// approval. A burned or unknown token counts as not held.
    function _rootApproved() internal view returns (bool) {
        uint256 tokenId = _rootTokenId;
        (bool ok, bytes memory data) = POSITION_MANAGER.staticcall(abi.encodeCall(IERC721Minimal.ownerOf, (tokenId)));
        if (!ok || abi.decode(data, (address)) != _owner) return false;
        return IERC721Minimal(POSITION_MANAGER).getApproved(tokenId) == address(this);
    }

    /// Moves every fee a member has accrued into its own uncharged lots.
    function _collect(DominoV2Types.PoolRef memory pool, uint256 tokenId, bool isRoot) internal {
        uint256 before0 = _balance(pool.currency0);
        uint256 before1 = _balance(pool.currency1);
        _rootStep(isRoot, true);
        _stepCollect(pool, tokenId);
        _rootStep(isRoot, false);
        uint256 amount0 = _balance(pool.currency0) - before0;
        uint256 amount1 = _balance(pool.currency1) - before1;
        _lots[tokenId][pool.currency0].uncharged += _u128(amount0);
        _lots[tokenId][pool.currency1].uncharged += _u128(amount1);
        emit IDominoVaultLedger.FeesCollected(tokenId, amount0, amount1);
    }

    /// Removes a successor from the sequence: its leftovers become idle and
    /// its parent's successor slot frees (A3).
    function _retire(uint256 tokenId) internal {
        IDominoVaultLedger.Member storage retired = _member[tokenId];
        uint256 parent = retired.parent;
        if (_member[parent].successor == tokenId) _member[parent].successor = 0;
        retired.active = false;
        _release(tokenId, _currency0, false);
        _release(tokenId, _currency1, false);
        uint256 last = _members.length - 1;
        for (uint256 i = 1; i < last; ++i) {
            if (_members[i] == tokenId) {
                _members[i] = _members[last];
                break;
            }
        }
        _members.pop();
    }

    /// Empties a member's lot in `token`: paid to the owner when `pay` and the
    /// owner can receive it, otherwise kept as idle reserves.
    function _release(uint256 tokenId, address token, bool pay) internal {
        IDominoVaultLedger.Lot memory entry = _lots[tokenId][token];
        uint256 amount = uint256(entry.uncharged) + entry.charged;
        if (amount == 0) return;
        delete _lots[tokenId][token];
        if (pay && DominoTokenOps.tryTransfer(token, _owner, amount, gasleft())) {
            emit IDominoVault.ReservesWithdrawn(token, amount, _stateNonce);
        } else {
            _idle[token] += amount;
        }
    }

    function _transferPosition(uint256 tokenId, address to) internal {
        IERC721Minimal(POSITION_MANAGER).transferFrom(address(this), to, tokenId);
    }

    /// The swap module, which must exist; its callbacks authenticate themselves
    /// (F1b: the v3 pool being swapped on, the PoolManager with the pending leg).
    function _swapModule() internal view returns (address module) {
        module = SWAP_MODULE;
        if (module.code.length == 0) revert StepUnavailable();
    }

    function _rootStep(bool isRoot, bool active) internal {
        if (!isRoot) return;
        bytes32 slot = T_ROOT_STEP;
        assembly ("memory-safe") {
            tstore(slot, active)
        }
    }

    function _inRootStep() internal view returns (bool active) {
        bytes32 slot = T_ROOT_STEP;
        assembly ("memory-safe") {
            active := tload(slot)
        }
    }

    /// Whether the vault itself holds the PoolManager unlock for a position step.
    function _unlocking() internal view returns (bool active) {
        bytes32 slot = T_UNLOCK;
        assembly ("memory-safe") {
            active := tload(slot)
        }
    }

    function _balance(address token) internal view returns (uint256) {
        return DominoTokenOps.selfBalance(token);
    }

    /// An exact payment. A token that debits the vault more than it moves (a
    /// sender-side fee) would spend what the vault owes or keeps for others,
    /// so it is refused, as F1b refuses it in its own payments. The
    /// best-effort sweeps (_release, exitAll's and returnReserves' idle
    /// payments) keep A8's rule instead and never revert over one token.
    function _pay(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        uint256 held = _balance(token);
        DominoTokenOps.transfer(token, to, amount);
        if (_balance(token) + amount < held) revert DominoTokenOps.TokenCallFailed(token);
    }

    function _u128(uint256 value) internal pure returns (uint128) {
        if (value > type(uint128).max) revert InvalidAmount();
        return uint128(value);
    }
}
