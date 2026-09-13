// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultTypes as T, IPositionManagerE2, IPoolManagerE4, IERC20E2} from "./DominoVaultTypes.sol";
import {IDominoVaultDraft} from "./IDominoVaultDraft.sol";
import {DominoVaultReadHelper} from "./DominoVaultReadHelper.sol";
import {PolicyValidation} from "./PolicyValidation.sol";
import {DominoExecutionTypes as E, IExecutionEngineV4, IPositionManagerV4} from "./DominoExecutionTypes.sol";

/// @notice V4 owner-bound custody with a separately deployed, fixed typed engine.
/// @dev Fixed EIP-1167 implementation; no upgrade, arbitrary call or signer path.
/// The engine proves fee-only general/net/sequence/swap effects atomically.
/// Owner exits remain local and callable without that engine or any operator.
contract DominoVaultV4 {
    error Unauthorized();
    error AlreadyInitialized();
    error InvalidIdentity();
    error InvalidPosition();
    error InvalidLimits();
    error MissingConsent();
    error PermissionUnavailable();
    error ForeignSubscription();
    error UnexpectedCallback();
    error ReentrantCall();
    error NonceExhausted();
    error StaleAuthority();
    error InvalidTransition();
    error UnknownSource();
    error InvalidCurrency();
    error InvalidAmount();
    error InsufficientReserve();
    error TransferFailed();
    error UnbackedReserve();
    error ReadHelperUnavailable();
    error InvalidExecution();

    /// @dev Fixed read-only dependency. Owner recovery never calls it.
    DominoVaultReadHelper public immutable readHelper;
    bytes32 public immutable readHelperCodeHash;
    IExecutionEngineV4 public immutable executionEngine;
    bytes32 public immutable executionEngineCodeHash;
    address public immutable factory;
    address public immutable implementation;
    address public immutable poolManager;
    address public immutable positionManager;
    address public immutable stateView;
    address public immutable serviceFeeRecipient;
    uint64 public constant implementationVersion = 4;
    bytes32 public immutable poolManagerCodeHash;
    bytes32 public immutable positionManagerCodeHash;
    bytes32 public immutable stateViewCodeHash;

    address public owner;
    address public operator;
    bytes32 public sequenceId;
    bytes32 public poolId;
    address public baseCurrency;
    address public quoteCurrency;
    uint256 public rootTokenId;
    uint256 public activePositions;
    uint64 public stateNonce;
    uint64 public authorityGeneration;
    bool public rootArmed;

    bool private _initialized;
    uint256 private _entered;
    bool private _subscriptionTransition;
    bool private _expectingChild;
    uint256 private _expectedChild;
    bytes32 private _sequenceIdentity;
    T.PoolKey private _key;
    IDominoVaultDraft.Policy private _policy;
    T.ExecutionLimits private _limits;
    mapping(uint256 => T.Position) private _positions;
    mapping(uint256 => T.Checkpoint) private _checkpoints;
    mapping(uint256 => T.Checkpoint) private _registrationCheckpoints;
    mapping(bytes32 => T.Source) private _sources;
    mapping(bytes32 => mapping(address => T.FeeBalance)) private _balances;
    mapping(address => uint256) public accountedCurrency;
    mapping(bytes32 => bool) public consumedIntent;
    uint64 public lastExecutionAt;
    uint8 private _executionAction;
    uint256 private _executionParent;
    mapping(uint256 => uint256) public successorOf;
    bool private _compoundActive;
    bool private _expectedModify;
    int256 private _expectedLiquidityChange;
    int256 private _expectedFeesAccrued;

    event CompoundSelfCompleted(bytes32 indexed intentId, uint256 indexed tokenId,
        bytes32 planHash, uint128 liquidityBefore, uint128 liquidityAfter,
        uint64 policyVersion, uint64 authorityGeneration, uint64 stateNonce);

    event Initialized(address indexed owner, bytes32 indexed sequenceId, bytes32 identity, uint256 rootTokenId);
    event PolicyChanged(uint64 indexed version, uint64 stateNonce);
    event ExecutionLimitsChanged(uint64 indexed version, uint64 stateNonce);
    event OperatorChanged(
        address indexed previousOperator, address indexed nextOperator, uint64 generation, uint64 stateNonce
    );
    event AutomationPaused(address indexed actor, uint64 stateNonce);
    event AutomationResumed(address indexed owner, uint64 stateNonce);
    event RootRearmed(bytes32 checkpointId, uint64 generation, uint64 stateNonce);
    event RootInvalidated(uint8 reason, uint64 generation, uint64 stateNonce);
    event PositionRegistered(
        uint256 indexed tokenId, bytes32 indexed identity, bytes32 source0, bytes32 source1, uint64 stateNonce
    );
    event ChildPositionWithdrawn(uint256 indexed tokenId, address indexed owner, uint64 stateNonce);
    event UnmanagedPositionRecovered(uint256 indexed tokenId, address indexed owner, bool isRoot, uint64 stateNonce);
    event FeeReservesWithdrawn(
        bytes32 indexed sourceId,
        address indexed currency,
        address indexed owner,
        uint128 originalAmount,
        uint128 chargedAmount,
        uint64 stateNonce
    );
    event UntrackedCurrencyRecovered(
        address indexed currency, address indexed owner, uint256 amount, uint64 stateNonce
    );
    event TerminalRecovery(bytes4 indexed action, uint64 stateNonce, uint64 authorityGeneration);

    modifier onlyOwner() {
        if (msg.sender != owner || owner == address(0)) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (_entered != 0) revert ReentrantCall();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(
        address factory_,
        address poolManager_,
        address positionManager_,
        address stateView_,
        address feeRecipient_,
        address readHelper_,
        address engine_
    ) {
        if (
            factory_ == address(0) || feeRecipient_ == address(0) || poolManager_.code.length == 0
                || positionManager_.code.length == 0 || stateView_.code.length == 0
        ) revert InvalidIdentity();
        readHelper = DominoVaultReadHelper(readHelper_);
        if (readHelper_.code.length == 0 || engine_.code.length == 0
            || readHelper.positionManager() != positionManager_ || readHelper.stateView() != stateView_
            || IExecutionEngineV4(engine_).factory() != factory_) revert InvalidIdentity();
        readHelperCodeHash = address(readHelper).codehash;
        executionEngine = IExecutionEngineV4(engine_);
        executionEngineCodeHash = address(executionEngine).codehash;
        factory = factory_;
        implementation = address(this);
        poolManager = poolManager_;
        positionManager = positionManager_;
        stateView = stateView_;
        serviceFeeRecipient = feeRecipient_;
        poolManagerCodeHash = poolManager_.codehash;
        positionManagerCodeHash = positionManager_.codehash;
        stateViewCodeHash = stateView_.codehash;
        _initialized = true; // Implementation itself cannot be initialized.
    }

    receive() external payable {} // Unsolicited ETH remains untracked, never fees.

    function initialize(address owner_, bytes32 sequenceId_, T.InitParams calldata params) external nonReentrant {
        if (msg.sender != factory) revert Unauthorized();
        if (_initialized) revert AlreadyInitialized();
        if (block.chainid != 4663 || owner_ == address(0) || sequenceId_ == bytes32(0)) revert InvalidIdentity();
        if (!params.consentToUncollectedFees) revert MissingConsent();
        _initialized = true;
        owner = owner_;
        sequenceId = sequenceId_;
        rootTokenId = params.rootTokenId;
        poolId = params.expectedPoolId;
        _requireReadHelper();
        (T.PoolKey memory key, int24 lo, int24 hi) = readHelper.readInitialPosition(poolId, rootTokenId,
            params.baseCurrency, params.quoteCurrency);
        _key = key;
        baseCurrency = params.baseCurrency;
        quoteCurrency = params.quoteCurrency;
        PolicyValidation.validateInitial(params.policy, 1);
        _validateLimits(params.limits);
        if (params.limits.version != 1) revert InvalidLimits();
        _policy = params.policy;
        _limits = params.limits;
        operator = params.operator;
        stateNonce = 1;
        authorityGeneration = 1;
        activePositions = 1;
        _sequenceIdentity = _computeSequenceIdentity();
        _register(rootTokenId, true, 0, lo, hi);
        _armRoot();
        emit Initialized(owner, sequenceId, _sequenceIdentity, rootTokenId);
        // Zero is an explicitly disabled operator; owner authority is independent.
        if (operator != address(0)) emit OperatorChanged(address(0), operator, authorityGeneration, stateNonce);
    }

    function policy() external view returns (IDominoVaultDraft.Policy memory) {
        return _policy;
    }

    function executionLimits() external view returns (T.ExecutionLimits memory) {
        return _limits;
    }

    function poolKey() external view returns (T.PoolKey memory) {
        return _key;
    }

    function sequenceIdentityHash() external view returns (bytes32) {
        return _sequenceIdentity;
    }

    function position(uint256 id) external view returns (T.Position memory) {
        return _positions[id];
    }

    function checkpoint(uint256 id) external view returns (T.Checkpoint memory) {
        return _checkpoints[id];
    }

    /// @notice Original checkpoint preimage, retained across every root rearm.
    function registrationCheckpoint(uint256 id) external view returns (T.Checkpoint memory) {
        return _registrationCheckpoints[id];
    }

    function source(bytes32 id) external view returns (T.Source memory) {
        return _sources[id];
    }

    function feeBalance(bytes32 id, address currency) external view returns (T.FeeBalance memory) {
        return _balances[id][currency];
    }

    function isOperator(address who) public view returns (bool) {
        return who != address(0) && who == operator;
    }

    /// @notice Authority preview; it does not replace full compound admission.
    function validateAuthority(uint64 policyVersion, uint64 nonce, uint64 generation) external view {
        if (msg.sender != owner && !isOperator(msg.sender)) revert Unauthorized();
        if (_terminal()) revert NonceExhausted();
        if (policyVersion != _policy.version || nonce != stateNonce || generation != authorityGeneration) {
            revert StaleAuthority();
        }
        if (_policy.paused || !rootPermissionValid()) revert PermissionUnavailable();
    }

    function rootPermissionValid() public view returns (bool) {
        if (!rootArmed || !_deploymentUnchanged()) return false;
        try readHelper.rootCustody(rootTokenId, owner, address(this)) returns (address subscriber) {
            return subscriber == address(this);
        } catch { return false; }
    }

    event ExecutionCompleted(bytes32 indexed intentId, bytes32 indexed planHash, uint8 action,
        uint256 parentTokenId, uint256 destinationTokenId, uint64 stateNonce);
    event SuccessorCreated(bytes32 indexed intentId, uint256 indexed parentTokenId, uint256 indexed tokenId);

    function execute(E.Plan calldata plan) external nonReentrant {
        if (msg.sender != owner && !isOperator(msg.sender)) revert Unauthorized();
        if (_terminal()) revert NonceExhausted();
        if (_policy.paused || !rootPermissionValid()) revert PermissionUnavailable();
        _compoundActive = true;
        _executionAction = plan.action;
        _executionParent = plan.authority.tokenId;
        (bytes32 planHash, uint256 destination) = executionEngine.execute(plan);
        if (_expectedModify || !rootPermissionValid()) revert InvalidExecution();
        consumedIntent[plan.authority.intentId] = true;
        _compoundActive = false;
        delete _executionAction;
        delete _executionParent;
        lastExecutionAt = uint64(block.timestamp);
        _advance(false);
        emit ExecutionCompleted(plan.authority.intentId, planHash, plan.action,
            plan.authority.tokenId, destination, stateNonce);
    }

    function _requireExecution() private view {
        if (!_compoundActive || _entered != 1 || msg.sender != address(executionEngine)
            || address(executionEngine).codehash != executionEngineCodeHash) revert UnexpectedCallback();
    }

    /// @dev Only the pinned engine inside one authenticated action can request
    /// the fixed collect/increase/take actions. No principal decrease exists.
    function executionModify(uint256 tokenId, uint128 increase, uint128 fees0, uint128 fees1, bool take) external {
        _requireExecution();
        if (!_positions[tokenId].active || increase > uint128(type(int128).max)) revert InvalidPosition();
        _expectedModify = tokenId == rootTokenId;
        _expectedLiquidityChange = int256(uint256(increase));
        _expectedFeesAccrued = int256((uint256(fees0) << 128) | fees1);
        bytes[] memory params = new bytes[](take ? 2 : 1);
        params[0] = abi.encode(tokenId, uint256(increase), increase == 0 ? uint128(0) : type(uint128).max,
            increase == 0 ? uint128(0) : type(uint128).max, bytes(""));
        if (take) params[1] = abi.encode(_key.currency0, _key.currency1, address(this));
        bytes memory actions = new bytes(take ? 2 : 1);
        actions[0] = increase == 0 ? bytes1(0x01) : bytes1(0x00);
        if (take) actions[1] = bytes1(0x11);
        IPositionManagerE2(positionManager).modifyLiquiditiesWithoutUnlock(actions, params);
        if (_expectedModify) revert UnexpectedCallback();
    }

    function executionCheckpoint(uint256 tokenId, T.Checkpoint calldata point) external {
        _requireExecution();
        if (!_positions[tokenId].active || point.liquidity < _checkpoints[tokenId].liquidity) revert InvalidPosition();
        _checkpoints[tokenId] = point;
    }

    function executionCredit(uint256 tokenId, uint128 amount0, uint128 amount1) external {
        _requireExecution(); _creditOriginalFees(tokenId, amount0, amount1);
    }

    function executionConvert(bytes32 sourceId, address currency, uint128 amount) external {
        _requireExecution(); _creditConvertedFees(sourceId, currency, amount);
    }

    function executionApply(bytes32 sourceId, address currency, T.CompoundAmounts calldata value,
        address debtor, bool netted) external {
        _requireExecution();
        _requireCurrency(currency);
        if (!_sources[sourceId].known || (debtor != positionManager && debtor != address(executionEngine))
            || (netted && (_executionAction != E.NET || debtor != positionManager))
            || (!netted && value.realized != 0)) revert InvalidExecution();
        T.FeeBalance memory previous = _balances[sourceId][currency];
        if (value.originalBefore != previous.original || value.chargedBefore != previous.charged
            || uint256(value.originalAfter) + value.grossOriginalConsumed != uint256(previous.original) + value.realized
            || uint256(value.chargedAfter) + value.chargedConsumed != previous.charged
            || value.serviceFee != uint256(value.grossOriginalConsumed) * _policy.serviceFeeBps / 10000
            || uint256(value.liquidityAdded) + value.serviceFee != uint256(value.grossOriginalConsumed) + value.chargedConsumed)
            revert InvalidAmount();
        _balances[sourceId][currency] = T.FeeBalance(value.originalAfter, value.chargedAfter);
        accountedCurrency[currency] = accountedCurrency[currency] + value.realized - value.grossOriginalConsumed - value.chargedConsumed;
        if (!netted && value.liquidityAdded != 0) {
            IPoolManagerE4 manager = IPoolManagerE4(poolManager);
            manager.sync(currency);
            if (currency != address(0)) _payExact(currency, poolManager, value.liquidityAdded);
            uint256 paid = manager.settleFor{value: currency == address(0) ? value.liquidityAdded : 0}(debtor);
            if (paid != value.liquidityAdded) revert InvalidAmount();
        }
        if (value.serviceFee != 0) _payExact(currency, serviceFeeRecipient, value.serviceFee);
        if (_currencyBalance(currency, address(this)) < accountedCurrency[currency]) revert UnbackedReserve();
    }

    function executionMint(bytes32 intentId, uint256 parent, int24 lo, int24 hi, uint128 liquidity)
        external returns (uint256 tokenId) {
        _requireExecution();
        if (_executionAction != E.MINT || parent != _executionParent || !_positions[parent].active
            || successorOf[parent] != 0 || activePositions >= _policy.maxPositions || liquidity == 0)
            revert InvalidPosition();
        tokenId = IPositionManagerV4(positionManager).nextTokenId();
        if (tokenId == 0 || _positions[tokenId].known) revert InvalidPosition();
        bytes[] memory params = new bytes[](1);
        params[0] = abi.encode(_key, lo, hi, uint256(liquidity), type(uint128).max,
            type(uint128).max, address(this), bytes(""));
        IPositionManagerE2(positionManager).modifyLiquiditiesWithoutUnlock(hex"02", params);
        if (IPositionManagerV4(positionManager).nextTokenId() != tokenId + 1
            || IPositionManagerE2(positionManager).ownerOf(tokenId) != address(this)) revert InvalidPosition();
        _register(tokenId, false, parent, lo, hi);
        activePositions++;
        successorOf[parent] = tokenId;
        emit SuccessorCreated(intentId, parent, tokenId);
    }

    function setPolicy(IDominoVaultDraft.Policy calldata next) external onlyOwner nonReentrant {
        PolicyValidation.validateUpdate(_policy, next, activePositions);
        _advance(false);
        _policy = next;
        emit PolicyChanged(next.version, stateNonce);
    }

    function setExecutionLimits(T.ExecutionLimits calldata next) external onlyOwner nonReentrant {
        _validateLimits(next);
        if (_limits.version == type(uint64).max || next.version != _limits.version + 1) revert InvalidLimits();
        _advance(false);
        _limits = next;
        emit ExecutionLimitsChanged(next.version, stateNonce);
    }

    function setOperator(address next) external onlyOwner nonReentrant {
        if (next == address(0) || next == operator) revert InvalidTransition();
        _advance(false);
        _advanceGeneration();
        address previous = operator;
        operator = next;
        emit OperatorChanged(previous, next, authorityGeneration, stateNonce);
    }

    function revokeOperator() external onlyOwner nonReentrant {
        if (operator == address(0)) revert InvalidTransition();
        _advance(true);
        _advanceGeneration();
        address previous = operator;
        operator = address(0);
        emit OperatorChanged(previous, address(0), authorityGeneration, stateNonce);
    }

    function pause() external nonReentrant {
        if (msg.sender != owner && !isOperator(msg.sender)) revert Unauthorized();
        if (_policy.paused) revert InvalidTransition();
        _advance(true);
        _policy.paused = true;
        emit AutomationPaused(msg.sender, stateNonce);
    }

    function resume() external onlyOwner nonReentrant {
        if (!_policy.paused) revert InvalidTransition();
        if (!rootPermissionValid()) revert PermissionUnavailable();
        _advance(false);
        _policy.paused = false;
        emit AutomationResumed(owner, stateNonce);
    }

    /// @dev Re-arm preserves initial membership/source identity and old reserves.
    /// The new checkpoint is a separate opening/consent observation, not income.
    function rearmRoot(bool consentToUncollectedFees) external onlyOwner nonReentrant {
        if (!consentToUncollectedFees) revert MissingConsent();
        _advance(false);
        _advanceGeneration();
        _armRoot();
    }

    function adoptChild(uint256 tokenId, uint256 parentTokenId, bool consentToUncollectedFees)
        external
        onlyOwner
        nonReentrant
    {
        if (!consentToUncollectedFees) revert MissingConsent();
        if (!rootPermissionValid()) revert PermissionUnavailable();
        if (_positions[tokenId].known || !_positions[parentTokenId].active || successorOf[parentTokenId] != 0 || activePositions >= _policy.maxPositions) {
            revert InvalidPosition();
        }
        (, int24 lo, int24 hi) = _readPosition(tokenId);
        IPositionManagerE2 manager = IPositionManagerE2(positionManager);
        if (manager.ownerOf(tokenId) != owner || manager.getApproved(tokenId) != address(this)) {
            revert PermissionUnavailable();
        }
        // Do not silently evict another protocol's subscription.
        if (manager.subscriber(tokenId) != address(0)) revert ForeignSubscription();
        _advance(false);
        _expectingChild = true;
        _expectedChild = tokenId;
        manager.safeTransferFrom(owner, address(this), tokenId);
        if (_expectingChild || manager.ownerOf(tokenId) != address(this)) revert TransferFailed();
        _expectedChild = 0;
        _register(tokenId, false, parentTokenId, lo, hi);
        successorOf[parentTokenId] = tokenId;
        activePositions++;
    }

    function onERC721Received(address caller, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4)
    {
        if (
            msg.sender != positionManager || !_expectingChild || _entered != 1 || caller != address(this)
                || from != owner || tokenId != _expectedChild || data.length != 0
        ) revert UnexpectedCallback();
        _expectingChild = false;
        return this.onERC721Received.selector;
    }

    function withdrawChildPosition(uint256 tokenId) external onlyOwner nonReentrant {
        T.Position storage member = _positions[tokenId];
        if (!member.active || member.isRoot) revert InvalidPosition();
        _advance(true);
        member.active = false;
        activePositions--;
        // The owner explicitly requested its own NFT. Do not require a receiver
        // hook: immutable contract wallets can hold NFTs without implementing it.
        IPositionManagerE2(positionManager).transferFrom(address(this), owner, tokenId);
        if (IPositionManagerE2(positionManager).ownerOf(tokenId) != owner) revert TransferFailed();
        emit ChildPositionWithdrawn(tokenId, owner, stateNonce);
    }

    /// @notice Recover NFTs sent through unsafe transferFrom, which bypasses the
    /// receiver. This does not adopt them, credit fees or reactivate a withdrawn NFT.
    function recoverUnmanagedPosition(uint256 tokenId) external onlyOwner nonReentrant {
        T.Position storage member = _positions[tokenId];
        if (tokenId == 0 || (member.active && !member.isRoot)) revert InvalidPosition();
        if (IPositionManagerE2(positionManager).ownerOf(tokenId) != address(this)) revert InvalidPosition();
        _advance(true);
        if (tokenId == rootTokenId) {
            rootArmed = false;
            _advanceGeneration();
            emit RootInvalidated(4, authorityGeneration, stateNonce);
        }
        IPositionManagerE2(positionManager).transferFrom(address(this), owner, tokenId);
        if (IPositionManagerE2(positionManager).ownerOf(tokenId) != owner) revert TransferFailed();
        emit UnmanagedPositionRecovered(tokenId, owner, tokenId == rootTokenId, stateNonce);
    }

    function withdrawFeeReserves(bytes32 sourceId, address currency, uint128 originalAmount, uint128 chargedAmount)
        external
        onlyOwner
        nonReentrant
    {
        if (!_sources[sourceId].known) revert UnknownSource();
        _requireCurrency(currency);
        uint256 amount = uint256(originalAmount) + chargedAmount;
        if (amount == 0) revert InvalidAmount();
        T.FeeBalance storage balance = _balances[sourceId][currency];
        if (originalAmount > balance.original || chargedAmount > balance.charged) revert InsufficientReserve();
        _advance(true);
        balance.original -= originalAmount;
        balance.charged -= chargedAmount;
        accountedCurrency[currency] -= amount;
        _payOwner(currency, amount);
        emit FeeReservesWithdrawn(sourceId, currency, owner, originalAmount, chargedAmount, stateNonce);
    }

    /// @notice Recover untracked pair-currency or native surplus, never fees.
    /// Native donations remain recoverable even in an ERC20/ERC20 sequence.
    function recoverUntrackedCurrency(address currency, uint256 amount) external onlyOwner nonReentrant {
        if (currency != address(0)) _requireCurrency(currency);
        uint256 held = _currencyBalance(currency, address(this));
        if (amount == 0) revert InvalidAmount();
        if (held < accountedCurrency[currency] || amount > held - accountedCurrency[currency]) {
            revert InsufficientReserve();
        }
        _advance(true);
        _payOwner(currency, amount);
        emit UntrackedCurrencyRecovered(currency, owner, amount, stateNonce);
    }

    function notifySubscribe(uint256 tokenId, bytes calldata data) external view {
        if (
            msg.sender != positionManager || !_subscriptionTransition || _entered != 1 || tokenId != rootTokenId
                || keccak256(data) != keccak256(abi.encode(_sequenceIdentity, authorityGeneration))
        ) revert UnexpectedCallback();
    }

    function notifyUnsubscribe(uint256 tokenId) external {
        if (msg.sender != positionManager || tokenId != rootTokenId) revert UnexpectedCallback();
        if (_compoundActive) revert UnexpectedCallback();
        if (_subscriptionTransition && _entered == 1) return;
        // Upstream may notify during an owner's receive callback. This path
        // only removes authority, with no external calls or asset movement.
        _invalidateRoot(1);
    }

    function notifyModifyLiquidity(uint256 tokenId, int256 change, int256 fees) external {
        if (msg.sender != positionManager || tokenId != rootTokenId) revert UnexpectedCallback();
        if (_entered != 0) {
            if (!_compoundActive || !_expectedModify || change != _expectedLiquidityChange || fees != _expectedFeesAccrued) {
                revert UnexpectedCallback();
            }
            _expectedModify = false;
            return;
        }
        _invalidateRoot(2); // A callback amount is not proof of earned fees.
    }

    function notifyBurn(uint256 tokenId, address, uint256, uint256, int256) external {
        if (msg.sender != positionManager || tokenId != rootTokenId || _entered != 0) revert UnexpectedCallback();
        _invalidateRoot(3); // ownerOf can already revert; recovery stays available.
    }

    function _armRoot() private {
        if (!_deploymentUnchanged()) revert PermissionUnavailable();
        (, int24 lo, int24 hi) = _readPosition(rootTokenId);
        T.Position storage root = _positions[rootTokenId];
        if (lo != root.tickLower || hi != root.tickUpper) revert InvalidPosition();
        IPositionManagerE2 manager = IPositionManagerE2(positionManager);
        address previous = readHelper.rootCustody(rootTokenId, owner, address(this));
        if (previous != address(0) && previous != address(this)) revert ForeignSubscription();
        rootArmed = false;
        _subscriptionTransition = true;
        if (previous == address(this)) manager.unsubscribe(rootTokenId);
        _checkpoints[rootTokenId] = _readCheckpoint(rootTokenId, lo, hi);
        manager.subscribe(rootTokenId, address(this), abi.encode(_sequenceIdentity, authorityGeneration));
        _subscriptionTransition = false;
        if (readHelper.rootCustody(rootTokenId, owner, address(this)) != address(this)) revert PermissionUnavailable();
        rootArmed = true;
        emit RootRearmed(_checkpoints[rootTokenId].commitment, authorityGeneration, stateNonce);
    }

    function _invalidateRoot(uint8 reason) private {
        if (!rootArmed) return;
        rootArmed = false;
        _advance(true);
        _advanceGeneration();
        emit RootInvalidated(reason, authorityGeneration, stateNonce);
    }

    function _readPosition(uint256 tokenId) private view returns (T.PoolKey memory key, int24 lo, int24 hi) {
        _requireReadHelper();
        return readHelper.readPosition(poolId, tokenId);
    }

    function _readCheckpoint(uint256 tokenId, int24 lo, int24 hi) private view returns (T.Checkpoint memory point) {
        _requireReadHelper();
        return readHelper.readCheckpoint(poolId, _sequenceIdentity, tokenId, lo, hi);
    }

    function _register(uint256 tokenId, bool isRoot, uint256 parent, int24 lo, int24 hi) private {
        T.Position storage member = _positions[tokenId];
        if (member.known) revert InvalidPosition();
        T.Checkpoint memory point = _readCheckpoint(tokenId, lo, hi);
        _checkpoints[tokenId] = point;
        _registrationCheckpoints[tokenId] = point;
        member.known = true;
        member.active = true;
        member.isRoot = isRoot;
        member.parentTokenId = parent;
        member.generation = 1;
        member.tickLower = lo;
        member.tickUpper = hi;
        member.registrationBaselineId = point.commitment;
        member.identity = _positionIdentity(tokenId, member);
        member.source0 = _sourceIdentity(member.identity, _key.currency0);
        member.source1 = _sourceIdentity(member.identity, _key.currency1);
        _sources[member.source0] = T.Source(true, tokenId, _key.currency0, member.identity);
        _sources[member.source1] = T.Source(true, tokenId, _key.currency1, member.identity);
        emit PositionRegistered(tokenId, member.identity, member.source0, member.source1, stateNonce);
    }

    function _positionIdentity(uint256 tokenId, T.Position storage member) private view returns (bytes32) {
        _requireReadHelper();
        return readHelper.positionIdentity(_sequenceIdentity, tokenId, member);
    }

    function _sourceIdentity(bytes32 positionId, address currency) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("FeeSourceIdentity(bytes32 sequence,bytes32 position,address currency)"),
                _sequenceIdentity,
                positionId,
                currency
            )
        );
    }

    function _computeSequenceIdentity() private view returns (bytes32) {
        _requireReadHelper();
        DominoVaultReadHelper.SequenceContext memory context;
        context.owner = owner;
        context.sequenceId = sequenceId;
        context.factory = factory;
        context.implementation = implementation;
        context.implementationVersion = implementationVersion;
        context.poolManager = poolManager;
        context.poolId = poolId;
        context.baseCurrency = baseCurrency;
        context.quoteCurrency = quoteCurrency;
        context.serviceFeeRecipient = serviceFeeRecipient;
        context.key = _key;
        return readHelper.sequenceIdentity(context);
    }

    function _requireReadHelper() private view {
        if (address(readHelper).codehash != readHelperCodeHash) revert ReadHelperUnavailable();
    }

    function _validateLimits(T.ExecutionLimits memory limits) private pure {
        if (
            limits.version == 0 || limits.upsideBps == 0 || limits.upsideBps > 1_000_000
                || limits.maxSlippageBps >= 10000 || limits.maxPriceImpactBps >= 10000 || limits.maxGasCostWei == 0
                || limits.maxObservationAgeSeconds == 0 || limits.forecastHorizonSeconds == 0
        ) revert InvalidLimits();
    }

    function _terminal() private view returns (bool) {
        return stateNonce == type(uint64).max || authorityGeneration == type(uint64).max;
    }

    function _advance(bool recovery) private {
        if (_terminal()) {
            if (!recovery) revert NonceExhausted();
            emit TerminalRecovery(msg.sig, stateNonce, authorityGeneration);
        }
        if (stateNonce != type(uint64).max) stateNonce++;
    }

    function _advanceGeneration() private {
        if (authorityGeneration != type(uint64).max) authorityGeneration++;
    }

    function _deploymentUnchanged() private view returns (bool) {
        return block.chainid == 4663 && poolManager.codehash == poolManagerCodeHash
            && positionManager.codehash == positionManagerCodeHash && stateView.codehash == stateViewCodeHash
            && address(readHelper).codehash == readHelperCodeHash
            && address(executionEngine).codehash == executionEngineCodeHash;
    }

    function _requireCurrency(address currency) private view {
        if (currency != _key.currency0 && currency != _key.currency1) revert InvalidCurrency();
    }

    function _currencyBalance(address currency, address holder) private view returns (uint256) {
        if (currency == address(0)) return holder.balance;
        return IERC20E2(currency).balanceOf(holder);
    }

    function _payOwner(address currency, uint256 amount) private {
        _payExact(currency, owner, amount);
    }

    function _payExact(address currency, address recipient, uint256 amount) private {
        if (currency == address(0)) {
            uint256 beforeVault = address(this).balance;
            uint256 beforeRecipient = recipient.balance;
            (bool paid,) = payable(recipient).call{value: amount}("");
            if (!paid) revert TransferFailed();
            // Preserve E2 owner-recovery callbacks; the financial path requires
            // exact receipts even for a native fee recipient.
            if (_compoundActive && (address(this).balance != beforeVault - amount || recipient.balance != beforeRecipient + amount)) {
                revert TransferFailed();
            }
        } else {
            uint256 beforeVault = _currencyBalance(currency, address(this));
            uint256 beforeOwner = _currencyBalance(currency, recipient);
            (bool ok, bytes memory result) = currency.call(abi.encodeCall(IERC20E2.transfer, (recipient, amount)));
            if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) {
                revert TransferFailed();
            }
            uint256 afterVault = _currencyBalance(currency, address(this));
            uint256 afterOwner = _currencyBalance(currency, recipient);
            if (
                afterVault > beforeVault || beforeVault - afterVault != amount || afterOwner < beforeOwner
                    || afterOwner - beforeOwner != amount
            ) revert TransferFailed();
        }
    }

    /// @dev Protected accounting sinks for E4 measured collection/E7 conversion.
    /// Backing excludes insolvency; it does NOT distinguish donations from fees.
    /// No external E2 function exposes these sinks or accepts caller credit data.
    function _creditOriginalFees(uint256 tokenId, uint128 amount0, uint128 amount1) internal {
        T.Position storage member = _positions[tokenId];
        if (!member.active) revert InvalidPosition();
        if (amount0 != 0) _credit(member.source0, _key.currency0, amount0, false);
        if (amount1 != 0) _credit(member.source1, _key.currency1, amount1, false);
    }

    function _creditConvertedFees(bytes32 sourceId, address currency, uint128 amount) internal {
        _credit(sourceId, currency, amount, true);
    }

    function _credit(bytes32 sourceId, address currency, uint128 amount, bool charged) private {
        if (!_sources[sourceId].known) revert UnknownSource();
        _requireCurrency(currency);
        T.FeeBalance storage balance = _balances[sourceId][currency];
        if (charged) balance.charged += amount;
        else balance.original += amount;
        if (uint256(balance.original) + balance.charged > type(uint128).max) revert InvalidAmount();
        accountedCurrency[currency] += amount;
        if (_currencyBalance(currency, address(this)) < accountedCurrency[currency]) revert UnbackedReserve();
    }
}
