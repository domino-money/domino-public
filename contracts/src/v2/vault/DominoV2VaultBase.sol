// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {IDominoVault, IDominoVaultExecution} from "../interfaces/IDominoVault.sol";
import {IDominoVaultLedger} from "../interfaces/IDominoVaultLedger.sol";
import {DominoFeeLedger} from "../fees/DominoFeeLedger.sol";
import {DominoTokenOps} from "../route/DominoTokenOps.sol";
import {DominoV2VaultStorage} from "./DominoV2VaultStorage.sol";

/// @notice One owner's automated position sequence on one Uniswap pool: the
/// root position, which stays in the owner's wallet, and, in Domino-compound,
/// the successors the vault mints and holds.
/// @dev Deployed once per DEX as the implementation behind EIP-1167 clones
/// (DominoV2VaultFactory); each clone is one owner's vault. The owner surface,
/// custody and fee settlement (F1b's DominoFeeLedger: owedFees,
/// flushOwedFees) live here; the operator's execute and the exit module's
/// executeExit run in the executor this implementation creates, and swaps in
/// the chain's swap module, both by DELEGATECALL in the clone's storage.
/// Owner exits (withdrawals, recovery, exitAll, pause) depend on neither the
/// executor, the swap module, the operator, the publisher, the price anchor
/// nor the registry.
abstract contract DominoV2VaultBase is DominoV2VaultStorage, DominoFeeLedger, IDominoVault, IDominoVaultExecution, IDominoVaultLedger {
    uint16 internal constant MAX_TRIGGER_DISTANCE_BPS = 2000;
    uint16 internal constant MAX_OVERLAP_BPS = 2000;
    uint32 internal constant MAX_UPSIDE_BPS = 1_000_000;
    /// The owner's limits have ceilings of their own (owner decision of 3 Oct
    /// 2026), so neither an app nor an operator works under looser ones: a
    /// swap floor at most 10% under the anchor quote, a spot at most 5% off
    /// the anchor, a price observation at most 300 s old, and at least ten
    /// minutes between executions.
    uint16 internal constant MAX_SLIPPAGE_BPS = 1_000;
    uint16 internal constant MAX_ANCHOR_BAND_BPS = 500;
    uint32 internal constant MAX_OBSERVATION_AGE_SECONDS = 300;
    uint32 internal constant MIN_INTERVAL_SECONDS = 600;

    /// The executor this implementation created; same wiring, same layout.
    address internal immutable EXECUTOR;

    constructor(address executor_) {
        EXECUTOR = executor_;
    }

    /// Native currency arrives from the PoolManager, admitted routers and
    /// WETH; anything unsolicited is unaccounted and the owner may recover it.
    receive() external payable {}

    // ================================================================ views

    function owner() external view returns (address) {
        return _owner;
    }

    function factory() external view returns (address) {
        return FACTORY;
    }

    function registry() external view returns (address) {
        return address(REGISTRY);
    }

    function pool() external view returns (DominoV2Types.PoolRef memory) {
        return _pool();
    }

    function root() external view returns (DominoV2Types.PositionRef memory) {
        return DominoV2Types.PositionRef(DEX, POSITION_MANAGER, _rootTokenId);
    }

    function positions() external view returns (uint256[] memory) {
        return _members;
    }

    function policy() external view returns (Policy memory) {
        return Policy(_mode, _triggerDistanceBps, _maxOverlapBps, _minimumIntervalSeconds, _maxPositions);
    }

    function limits() external view returns (Limits memory) {
        return Limits(_maxSlippageBps, _maxPriceImpactBps, _maxObservationAgeSeconds, _upsideBps);
    }

    function paused() external view returns (bool) {
        return _paused;
    }

    /// Live: false as soon as custody is gone, before an execution records it.
    function rootArmed() external view returns (bool) {
        return _rootArmed && _rootLive() == 0;
    }

    function stateNonce() external view returns (uint64) {
        return _stateNonce;
    }

    /// Everything the owner may withdraw in `token`: every member's lots and
    /// the idle reserves.
    function reserves(address token) public view returns (uint256 total) {
        total = _idle[token];
        uint256 count = _members.length;
        for (uint256 i; i < count; ++i) {
            IDominoVaultLedger.Lot memory entry = _lots[_members[i]][token];
            total += uint256(entry.uncharged) + entry.charged;
        }
    }

    function exitModule() external view returns (address) {
        return _exitModule;
    }

    /// A member position: active, its parent and successor, its range.
    function member(uint256 tokenId) external view returns (Member memory) {
        return _member[tokenId];
    }

    /// A member's fee balances in one pool token.
    function lot(uint256 tokenId, address token) external view returns (Lot memory) {
        return _lots[tokenId][token];
    }

    /// Owner reserves no member owns; never spent by automation.
    function idleReserves(address token) external view returns (uint256) {
        return _idle[token];
    }

    /// The quote currency of the Domino geometry (prices are quote per base).
    function quoteCurrency() external view returns (address) {
        return _inverse ? _currency0 : _currency1;
    }

    function lastExecutionAt() external view returns (uint64) {
        return _lastExecutionAt;
    }

    /// This implementation's wiring, shared by its executor and clones.
    function wiring() external view returns (Deployment memory) {
        return _wiring();
    }

    function executor() external view returns (address) {
        return EXECUTOR;
    }

    // ======================================================= initialization

    /// The factory only, once, on a fresh clone; the owner is the creator.
    function initialize(address owner_, Init calldata init) external {
        if (msg.sender != FACTORY || _initialized) revert Unauthorized();
        uint256 rootId = init.root.tokenId;
        if (
            !init.consentToUncollectedFees || init.root.dex != DEX || init.root.positionManager != POSITION_MANAGER
                || rootId == 0 || rootId > type(uint96).max
        ) revert InvalidInit();
        _initialized = true;
        _owner = owner_;
        (DominoV2Types.PoolRef memory pool_, int24 tickLower, int24 tickUpper) = _readRoot(rootId);
        _currency0 = pool_.currency0;
        _currency1 = pool_.currency1;
        _fee = pool_.fee;
        _tickSpacing = pool_.tickSpacing;
        _hooks = pool_.hooks;
        _rootTokenId = uint96(rootId);
        _member[rootId] = IDominoVaultLedger.Member(true, 0, 0, tickLower, tickUpper);
        _members.push(rootId);
        // The quote is the pool's best-ranked charge currency (the chain's
        // stable, then ETH), else currency1; fixed for the sequence's life.
        uint8 rank0 = REGISTRY.chargeCurrencyRank(pool_.currency0);
        uint8 rank1 = REGISTRY.chargeCurrencyRank(pool_.currency1);
        _inverse = rank0 != 0 && (rank1 == 0 || rank0 < rank1);
        _storePolicy(init.policy);
        _storeLimits(init.limits);
        _paused = init.startPaused;
        _arm();
        _rootArmed = true;
        _stateNonce = 1;
        emit Initialized(owner_, DEX, rootId, init.policy.mode);
        emit PolicyChanged(init.policy, 1);
        emit LimitsChanged(init.limits, 1);
        emit RootRearmed(1);
    }

    // ================================================================ owner

    function setPolicy(Policy calldata next) external nonReentrant onlyOwner {
        _storePolicy(next);
        emit PolicyChanged(next, ++_stateNonce);
    }

    function setLimits(Limits calldata next) external nonReentrant onlyOwner {
        _storeLimits(next);
        emit LimitsChanged(next, ++_stateNonce);
    }

    /// The owner, or any operator the registry admits, may stop automation.
    function pause() external nonReentrant {
        if (msg.sender != _owner && !REGISTRY.isOperator(msg.sender)) revert Unauthorized();
        if (!_paused) {
            _paused = true;
            emit AutomationPaused(msg.sender, ++_stateNonce);
        }
    }

    function resume() external nonReentrant onlyOwner {
        if (_paused) {
            _paused = false;
            emit AutomationResumed(++_stateNonce);
        }
    }

    /// Takes custody of the root again after it was disarmed. The fees the
    /// root has accrued and not collected become automation fees, as at
    /// creation, so the owner must consent to that explicitly.
    function rearm(bool consentToUncollectedFees) external nonReentrant onlyOwner {
        if (!consentToUncollectedFees) revert InvalidInit();
        _arm();
        _rootArmed = true;
        emit RootRearmed(++_stateNonce);
    }

    /// See IDominoVaultLedger.operatorRearm: a v3 root that only gained
    /// liquidity (open to anyone on v3) is rearmed without the owner. The
    /// fees the additions poked accrued under the owner's consent already.
    function operatorRearm(RootCheckpoint calldata previous) external nonReentrant {
        if (!REGISTRY.isOperator(msg.sender)) revert Unauthorized();
        if (
            REGISTRY.automationHalted() || !(_rootArmed || _disarmReason == DISARM_CHECKPOINT)
                || !_onlyLiquidityAdded(previous)
        ) revert AutomationUnavailable();
        _afterRootStep();
        _rootArmed = true;
        emit RootRearmed(++_stateNonce);
    }

    /// Without any charge, to the recipient the owner names (V1 audit A8: an
    /// owner that cannot receive, a 7702 account without receive for native
    /// reserves, still gets them out). Spends idle reserves first, then the
    /// members' uncharged fees before their charged units, which stay tariff-free.
    function withdrawReserves(address token, uint256 amount, address recipient) external nonReentrant onlyOwner {
        if (amount == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidRecipient();
        uint256 left = amount;
        uint256 idle = _idle[token];
        uint256 take = idle < left ? idle : left;
        _idle[token] = idle - take;
        left -= take;
        uint256 count = _members.length;
        for (uint256 i; i < count && left != 0; ++i) {
            IDominoVaultLedger.Lot storage entry = _lots[_members[i]][token];
            take = entry.uncharged < left ? entry.uncharged : left;
            entry.uncharged -= uint128(take);
            left -= take;
            take = entry.charged < left ? entry.charged : left;
            entry.charged -= uint128(take);
            left -= take;
        }
        if (left != 0) revert InsufficientReserves();
        _pay(token, recipient, amount);
        emit ReservesWithdrawn(token, amount, ++_stateNonce);
    }

    /// A successor goes to the owner without any charge; its leftover fees
    /// stay withdrawable as idle reserves and its parent may get a new one.
    function withdrawChild(uint256 tokenId) external nonReentrant onlyOwner {
        if (tokenId == _rootTokenId || !_member[tokenId].active) revert InvalidPosition();
        _retire(tokenId);
        _transferPosition(tokenId, _owner);
        emit ChildWithdrawn(tokenId, ++_stateNonce);
    }

    /// Anything the vault holds beyond what it accounts for: surplus pool
    /// tokens, donations, other tokens, unsolicited native currency, a swap
    /// route's leftover hop token. Owed fees are never the owner's.
    function recoverToken(address token, uint256 amount) external nonReentrant onlyOwner {
        uint256 held = _unowedBalance(token);
        uint256 accounted = reserves(token);
        if (amount == 0 || held < accounted || amount > held - accounted) revert InsufficientReserves();
        _pay(token, _owner, amount);
        emit TokenRecovered(token, amount);
    }

    /// A position NFT the vault holds but does not manage, sent to it with a
    /// plain transferFrom; the root included (its custody is the owner's
    /// wallet, so holding it means the root is no longer armed).
    function recoverPosition(uint256 tokenId) external nonReentrant onlyOwner {
        bool isRoot = tokenId == _rootTokenId;
        if (!isRoot && _member[tokenId].active) revert InvalidPosition();
        if (isRoot) {
            if (_rootArmed) _disarm(DISARM_CUSTODY);
            else _markDisarmed(DISARM_CUSTODY);
        }
        _transferPosition(tokenId, _owner);
        emit PositionRecovered(tokenId);
    }

    /// Ends the sequence: every child to the owner, every reserve the owner can
    /// receive paid out (one it cannot stays idle), the root disarmed,
    /// automation paused and the exit module disabled (owner decision of 3 Oct
    /// 2026: an active stop no longer fires; setExitModule enables it again).
    function exitAll() external nonReentrant onlyOwner {
        uint64 nonce = ++_stateNonce;
        address owner_ = _owner;
        while (_members.length > 1) {
            uint256 tokenId = _members[_members.length - 1];
            _retire(tokenId);
            _transferPosition(tokenId, owner_);
            emit ChildWithdrawn(tokenId, nonce);
        }
        uint256 rootId = _rootTokenId;
        address currency0 = _currency0;
        address currency1 = _currency1;
        _release(rootId, currency0, false);
        _release(rootId, currency1, false);
        _payIdle(currency0, owner_, nonce);
        _payIdle(currency1, owner_, nonce);
        _paused = true;
        if (_exitModule != address(0)) {
            _exitModule = address(0);
            emit ExitModuleSet(address(0), nonce);
        }
        // Recorded even when already disarmed, so no operator rearms after it.
        if (_rootArmed) emit RootDisarmed(DISARM_EXIT_ALL, nonce);
        _markDisarmed(DISARM_EXIT_ALL);
    }

    /// See IDominoVaultLedger.returnReserves. Anyone may call it: whoever
    /// calls, the owner is paid. The root's closure is read live from its
    /// position manager (_rootClosed), never from a stored flag, and only the
    /// owner can close a root: decreasing a position needs its owner or an
    /// approval the owner gave, and the vault's own approval decreases the
    /// root only for the owner's exit mandate. Like exitAll it never reads the
    /// registry, so neither a pause nor the global halt holds the owner's
    /// money back. It changes nothing but the reserves: no policy, arming or
    /// custody.
    function returnReserves() external nonReentrant returns (uint256 amount0, uint256 amount1) {
        if (_members.length != 1) revert SuccessorActive();
        if (!_rootClosed()) revert RootOpen();
        uint64 nonce = _stateNonce + 1;
        uint256 rootId = _rootTokenId;
        bool moved0;
        bool moved1;
        (amount0, moved0) = _returnReserve(rootId, _currency0, nonce);
        (amount1, moved1) = _returnReserve(rootId, _currency1, nonce);
        // Every state change advances the nonce (B8); nothing to pay changes nothing.
        if (moved0 || moved1) _stateNonce = nonce;
    }

    /// Enables the auto-exit module this implementation was deployed with, or
    /// disables auto-exit with address(0). No other module can be enabled.
    function setExitModule(address module) external nonReentrant onlyOwner {
        if (module != address(0) && module != AUTO_EXIT) revert Unauthorized();
        _exitModule = module;
        emit ExitModuleSet(module, ++_stateNonce);
    }

    // ============================================= executor and callbacks

    /// The operator's entry point; runs in the executor (DominoV2VaultExecutor).
    function execute(bytes calldata) external returns (bytes32) {
        _delegate(EXECUTOR);
    }

    /// The enabled exit module only; runs in the executor (DominoV2VaultExecutor).
    function executeExit(uint256, bytes calldata) external returns (uint256, uint256) {
        _delegate(EXECUTOR);
    }

    /// The v4 PoolManager's unlock callback: the vault's own position step,
    /// which runs in the executor, or else a swap leg of the swap module,
    /// which accepts only the PoolManager with the leg it is waiting for.
    function unlockCallback(bytes calldata) external returns (bytes memory) {
        _delegate(_unlocking() ? EXECUTOR : _swapModule());
    }

    /// A v3 pool's swap callback, for the swap module, which accepts only the
    /// pool it is swapping on, for exactly the hop's input.
    function uniswapV3SwapCallback(int256, int256, bytes calldata) external {
        _delegate(_swapModule());
    }

    /// Runs this call's calldata in `target` by DELEGATECALL and returns its
    /// raw result, reverting with its raw reason.
    function _delegate(address target) private {
        (bool ok, bytes memory result) = target.delegatecall(msg.data);
        assembly ("memory-safe") {
            if iszero(ok) { revert(add(result, 32), mload(result)) }
            return(add(result, 32), mload(result))
        }
    }

    // ============================================================ internals

    function _storePolicy(Policy memory next) private {
        bool simple = next.mode == DominoV2Types.MODE_SIMPLE;
        if (
            (!simple && next.mode != DominoV2Types.MODE_DOMINO) || next.triggerDistanceBps > MAX_TRIGGER_DISTANCE_BPS
                || next.maxOverlapBps > MAX_OVERLAP_BPS || next.minimumIntervalSeconds < MIN_INTERVAL_SECONDS
                || next.maxPositions < _members.length || (simple && next.maxPositions != 1)
        ) revert InvalidPolicy();
        _mode = next.mode;
        _triggerDistanceBps = next.triggerDistanceBps;
        _maxOverlapBps = next.maxOverlapBps;
        _minimumIntervalSeconds = next.minimumIntervalSeconds;
        _maxPositions = next.maxPositions;
    }

    function _storeLimits(Limits memory next) private {
        if (
            next.maxSlippageBps > MAX_SLIPPAGE_BPS || next.maxPriceImpactBps > MAX_ANCHOR_BAND_BPS
                || next.maxObservationAgeSeconds == 0 || next.maxObservationAgeSeconds > MAX_OBSERVATION_AGE_SECONDS
                || next.upsideBps == 0 || next.upsideBps > MAX_UPSIDE_BPS
        ) revert InvalidLimits();
        _maxSlippageBps = next.maxSlippageBps;
        _maxPriceImpactBps = next.maxPriceImpactBps;
        _maxObservationAgeSeconds = next.maxObservationAgeSeconds;
        _upsideBps = next.upsideBps;
    }

    /// The root's lot in `token` becomes idle, then the whole idle reserve goes
    /// to the owner, or stays idle when the owner cannot receive it (exitAll's
    /// A8). The ledger is settled before the transfer. Returns what was paid
    /// and whether anything moved.
    function _returnReserve(uint256 rootId, address token, uint64 nonce) private returns (uint256, bool) {
        IDominoVaultLedger.Lot memory entry = _lots[rootId][token];
        uint256 lots = uint256(entry.uncharged) + entry.charged;
        uint256 amount = _idle[token] + lots;
        if (amount == 0) return (0, false);
        delete _lots[rootId][token];
        _idle[token] = 0;
        if (DominoTokenOps.tryTransfer(token, _owner, amount, gasleft())) {
            emit ReservesWithdrawn(token, amount, nonce);
            return (amount, true);
        }
        _idle[token] = amount;
        return (0, lots != 0);
    }

    /// Whether the root has no liquidity left, or no longer exists (burned),
    /// read live from its position manager. Only the implementation needs it.
    function _rootClosed() internal view virtual returns (bool);

    function _payIdle(address token, address to, uint64 nonce) private {
        uint256 amount = _idle[token];
        if (amount != 0 && DominoTokenOps.tryTransfer(token, to, amount, gasleft())) {
            _idle[token] = 0;
            emit ReservesWithdrawn(token, amount, nonce);
        }
    }

    modifier onlyOwner() {
        if (msg.sender != _owner) revert Unauthorized();
        _;
    }
}
