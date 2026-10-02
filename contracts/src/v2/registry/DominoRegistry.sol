// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {IDominoRegistry} from "../interfaces/IDominoRegistry.sol";

/// @title Domino V2 registry
/// @notice The per-chain roles and lists every Domino V2 contract reads:
/// operators, price publishers, admitted Universal Routers, charge-currency
/// ranks, the fee recipient, the observation epoch and the automation halt.
/// @dev Trust model (docs/v2/F1_REGISTRY_ANCHOR.md):
/// - Governance changes the registry only through scheduleChange and
///   executeChange, after the timelock; every pending change is public
///   (ChangeScheduled) for the whole delay.
/// - The guardian acts at once and only narrows trust: it removes an
///   operator, a publisher or a router, raises the observation epoch, halts
///   automation, and cancels any pending change except a guardian change.
///   Governance may do the same, since it can already do more.
/// - A narrowing is undone only by a change scheduled after it. Re-admitting a
///   removed role or resuming a halt needs a change scheduled later than the
///   removal or the halt, so the guardian always has one full timelock to
///   cancel the undo, and a change queued earlier cannot quietly reverse an
///   emergency action.
/// - Operators and publishers are disjoint: the key that executes never
///   attests the price that bounds its own execution.
/// - The guardian cannot cancel a guardian change, so governance can always
///   replace a lost or compromised guardian, one timelock later.
/// - Nothing an owner needs to exit reads this contract.
contract DominoRegistry is IDominoRegistry {
    /// The lowest Universal Router version admitted: 2.1.2, written 212
    /// (major * 100 + minor * 10 + patch, so 2.2.0 is 220). 2.0 and 2.1.1 are
    /// sunset by Uniswap on 21 Oct 2026 and stay refused; a later version is
    /// admitted through the same timelocked change, without a new registry.
    uint16 public constant MIN_UNIVERSAL_ROUTER_VERSION = 212;
    /// Bounds on the timelock. The floor gives the guardian time to veto a
    /// change; the ceiling keeps a mistaken value from freezing governance.
    uint32 public constant MIN_TIMELOCK_SECONDS = 1 hours;
    uint32 public constant MAX_TIMELOCK_SECONDS = 30 days;

    struct ChargeCurrency {
        address token;
        uint8 rank;
    }

    /// The configuration in force at deployment, applied without a delay
    /// because the deployment itself is the governance act that sets it.
    /// Routers are admitted at MIN_UNIVERSAL_ROUTER_VERSION (2.1.2).
    struct Config {
        address governance;
        address guardian;
        uint32 timelockSeconds;
        address feeRecipient;
        address[] operators;
        address[] publishers;
        address[] routers;
        ChargeCurrency[] chargeCurrencies;
    }

    struct Member {
        bool admitted;
        uint64 removedAt;
    }

    struct RouterEntry {
        uint16 version;
        uint64 removedAt;
    }

    struct Change {
        bytes32 kind;
        uint64 scheduledAt;
        uint64 executableAt;
        bytes data;
    }

    address public governance;
    address public pendingGovernance;
    address public guardian;
    address public feeRecipient;

    // One slot: the values operator executions and price checks read together.
    uint64 public observationEpoch;
    bool public automationHalted;
    /// When automation was last halted; a resume must be scheduled after it.
    uint64 public haltedAt;
    uint32 public timelockSeconds;
    uint64 private _changeNonce;

    mapping(address => Member) private _operators;
    mapping(address => Member) private _publishers;
    mapping(address => RouterEntry) private _routers;
    mapping(address => uint8) public chargeCurrencyRank;
    mapping(bytes32 => Change) private _changes;

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized();
        _;
    }

    modifier onlyNarrowing() {
        if (msg.sender != guardian && msg.sender != governance) revert Unauthorized();
        _;
    }

    constructor(Config memory config) {
        _nonzero(config.governance);
        _nonzero(config.guardian);
        _nonzero(config.feeRecipient);
        _timelock(config.timelockSeconds);
        governance = config.governance;
        emit GovernanceTransferred(address(0), config.governance);
        guardian = config.guardian;
        emit GuardianChanged(address(0), config.guardian);
        timelockSeconds = config.timelockSeconds;
        feeRecipient = config.feeRecipient;
        emit FeeRecipientSet(config.feeRecipient);
        for (uint256 i; i < config.operators.length; ++i) {
            address operator = config.operators[i];
            _nonzero(operator);
            _operators[operator].admitted = true;
            emit OperatorSet(operator, true);
        }
        for (uint256 i; i < config.publishers.length; ++i) {
            address publisher = config.publishers[i];
            _nonzero(publisher);
            if (_operators[publisher].admitted) revert InvalidChange();
            _publishers[publisher].admitted = true;
            emit PublisherSet(publisher, true);
        }
        for (uint256 i; i < config.routers.length; ++i) {
            address router = config.routers[i];
            _router(router, MIN_UNIVERSAL_ROUTER_VERSION);
            _routers[router].version = MIN_UNIVERSAL_ROUTER_VERSION;
            emit RouterSet(router, MIN_UNIVERSAL_ROUTER_VERSION);
        }
        for (uint256 i; i < config.chargeCurrencies.length; ++i) {
            ChargeCurrency memory currency = config.chargeCurrencies[i];
            if (currency.rank == 0) revert InvalidChange();
            _currency(currency.token);
            chargeCurrencyRank[currency.token] = currency.rank;
            emit ChargeCurrencySet(currency.token, currency.rank);
        }
    }

    // ---------------------------------------------------------------- views
    function isOperator(address account) external view returns (bool) {
        return _operators[account].admitted;
    }

    function isPublisher(address account) external view returns (bool) {
        return _publishers[account].admitted;
    }

    function routerVersion(address router) external view returns (uint16 version) {
        return _routers[router].version;
    }

    /// @notice A pending change, for monitoring; executableAt is 0 when none.
    function pendingChange(bytes32 id)
        external
        view
        returns (bytes32 kind, bytes memory data, uint64 scheduledAt, uint64 executableAt)
    {
        Change storage change = _changes[id];
        return (change.kind, change.data, change.scheduledAt, change.executableAt);
    }

    /// @notice When `subject` last lost the role of `kind` (REGISTRY_OPERATOR,
    /// REGISTRY_PUBLISHER or REGISTRY_ROUTER), 0 if never. A pending change
    /// that re-admits it executes only if it was scheduled after this time.
    function removedAt(bytes32 kind, address subject) external view returns (uint64) {
        if (kind == DominoV2Types.REGISTRY_OPERATOR) return _operators[subject].removedAt;
        if (kind == DominoV2Types.REGISTRY_PUBLISHER) return _publishers[subject].removedAt;
        if (kind == DominoV2Types.REGISTRY_ROUTER) return _routers[subject].removedAt;
        revert InvalidChange();
    }

    // ------------------------------------------------------- governance
    /// @notice Starts a governance transfer; address(0) withdraws a pending one.
    function transferGovernance(address pending) external onlyGovernance {
        pendingGovernance = pending;
        emit GovernanceTransferStarted(governance, pending);
    }

    function acceptGovernance() external {
        if (msg.sender != pendingGovernance) revert Unauthorized();
        emit GovernanceTransferred(governance, msg.sender);
        governance = msg.sender;
        pendingGovernance = address(0);
    }

    /// @notice Queues a change; it executes no earlier than the current
    /// timelock from now. `data` must be the canonical abi encoding listed
    /// with each REGISTRY_* kind in DominoV2Types, and is validated here.
    function scheduleChange(bytes32 kind, bytes calldata data) external onlyGovernance returns (bytes32 id) {
        _validate(kind, data);
        uint64 scheduledAt = uint64(block.timestamp);
        uint64 executableAt = scheduledAt + timelockSeconds;
        id = keccak256(abi.encode(kind, data, ++_changeNonce));
        _changes[id] = Change({kind: kind, scheduledAt: scheduledAt, executableAt: executableAt, data: data});
        emit ChangeScheduled(id, kind, data, executableAt);
    }

    function executeChange(bytes32 id) external onlyGovernance {
        Change memory change = _changes[id];
        if (change.executableAt == 0) revert InvalidChange();
        if (block.timestamp < change.executableAt) revert ChangeNotReady();
        delete _changes[id];
        _apply(change.kind, change.data, change.scheduledAt);
        emit ChangeExecuted(id, change.kind, change.data);
    }

    /// @notice Governance cancels any pending change; the guardian any but a
    /// guardian change.
    function cancelChange(bytes32 id) external onlyNarrowing {
        Change storage change = _changes[id];
        if (change.executableAt == 0) revert InvalidChange();
        if (msg.sender != governance && change.kind == DominoV2Types.REGISTRY_GUARDIAN) revert Unauthorized();
        delete _changes[id];
        emit ChangeCancelled(id);
    }

    // ---------------------------------------------- guardian, immediate
    function removeOperator(address operator) external onlyNarrowing {
        _remove(_operators[operator]);
        emit OperatorSet(operator, false);
    }

    function removePublisher(address publisher) external onlyNarrowing {
        _remove(_publishers[publisher]);
        emit PublisherSet(publisher, false);
    }

    function removeRouter(address router) external onlyNarrowing {
        _routers[router] = RouterEntry({version: 0, removedAt: uint64(block.timestamp)});
        emit RouterSet(router, 0);
    }

    /// @notice Voids every observation with observedAt below `epoch`. The
    /// epoch only rises and never passes the current time, so it can void the
    /// past but never block observations made from now on.
    function raiseObservationEpoch(uint64 epoch) external onlyNarrowing {
        if (epoch <= observationEpoch || epoch > block.timestamp) revert InvalidChange();
        observationEpoch = epoch;
        emit ObservationEpochRaised(epoch);
    }

    /// @notice Stops operator executions on every vault. Calling it again
    /// while halted restarts the clock: a resume scheduled before the latest
    /// halt cannot execute.
    function haltAutomation() external onlyNarrowing {
        automationHalted = true;
        haltedAt = uint64(block.timestamp);
        emit AutomationHaltSet(true);
    }

    // ------------------------------------------------------------ internal
    function _remove(Member storage member) private {
        member.admitted = false;
        member.removedAt = uint64(block.timestamp);
    }

    /// @dev A re-admission scheduled at or before the subject's last removal
    /// would undo that removal without a fresh veto window.
    function _readmit(uint64 removed, uint64 scheduledAt) private pure {
        if (scheduledAt <= removed) revert InvalidChange();
    }

    function _apply(bytes32 kind, bytes memory data, uint64 scheduledAt) private {
        if (kind == DominoV2Types.REGISTRY_OPERATOR) {
            (address operator, bool allowed) = abi.decode(data, (address, bool));
            if (allowed) {
                _readmit(_operators[operator].removedAt, scheduledAt);
                if (_publishers[operator].admitted) revert InvalidChange();
                _operators[operator].admitted = true;
            } else {
                _remove(_operators[operator]);
            }
            emit OperatorSet(operator, allowed);
        } else if (kind == DominoV2Types.REGISTRY_PUBLISHER) {
            (address publisher, bool allowed) = abi.decode(data, (address, bool));
            if (allowed) {
                _readmit(_publishers[publisher].removedAt, scheduledAt);
                if (_operators[publisher].admitted) revert InvalidChange();
                _publishers[publisher].admitted = true;
            } else {
                _remove(_publishers[publisher]);
            }
            emit PublisherSet(publisher, allowed);
        } else if (kind == DominoV2Types.REGISTRY_ROUTER) {
            (address router, uint16 version) = abi.decode(data, (address, uint16));
            if (version != 0) {
                _readmit(_routers[router].removedAt, scheduledAt);
                _routers[router].version = version;
            } else {
                _routers[router] = RouterEntry({version: 0, removedAt: uint64(block.timestamp)});
            }
            emit RouterSet(router, version);
        } else if (kind == DominoV2Types.REGISTRY_CHARGE_CURRENCY) {
            (address token, uint8 rank) = abi.decode(data, (address, uint8));
            chargeCurrencyRank[token] = rank;
            emit ChargeCurrencySet(token, rank);
        } else if (kind == DominoV2Types.REGISTRY_FEE_RECIPIENT) {
            address recipient = abi.decode(data, (address));
            feeRecipient = recipient;
            emit FeeRecipientSet(recipient);
        } else if (kind == DominoV2Types.REGISTRY_GUARDIAN) {
            address next = abi.decode(data, (address));
            emit GuardianChanged(guardian, next);
            guardian = next;
        } else if (kind == DominoV2Types.REGISTRY_TIMELOCK) {
            timelockSeconds = abi.decode(data, (uint32));
        } else if (kind == DominoV2Types.REGISTRY_RESUME_AUTOMATION) {
            _readmit(haltedAt, scheduledAt);
            automationHalted = false;
            emit AutomationHaltSet(false);
        }
        // _validate admitted no other kind, so nothing else is ever stored.
    }

    /// @dev Stateless checks, at scheduling: the kind is known, `data` is its
    /// canonical encoding (exact length, no dirty bits) and the value is
    /// admissible. State-dependent checks run at execution.
    function _validate(bytes32 kind, bytes calldata data) private view {
        if (kind == DominoV2Types.REGISTRY_OPERATOR || kind == DominoV2Types.REGISTRY_PUBLISHER) {
            _words(data, 2);
            _nonzero(_address(data, 0));
            _uint(data, 1, 1);
        } else if (kind == DominoV2Types.REGISTRY_ROUTER) {
            _words(data, 2);
            address router = _address(data, 0);
            uint256 version = _uint(data, 1, type(uint16).max);
            if (version == 0) _nonzero(router);
            else _router(router, uint16(version));
        } else if (kind == DominoV2Types.REGISTRY_CHARGE_CURRENCY) {
            _words(data, 2);
            address token = _address(data, 0);
            if (_uint(data, 1, type(uint8).max) != 0) _currency(token);
        } else if (kind == DominoV2Types.REGISTRY_FEE_RECIPIENT || kind == DominoV2Types.REGISTRY_GUARDIAN) {
            _words(data, 1);
            _nonzero(_address(data, 0));
        } else if (kind == DominoV2Types.REGISTRY_TIMELOCK) {
            _words(data, 1);
            _timelock(_uint(data, 0, type(uint32).max));
        } else if (kind == DominoV2Types.REGISTRY_RESUME_AUTOMATION) {
            _words(data, 0);
        } else {
            revert InvalidChange();
        }
    }

    function _words(bytes calldata data, uint256 count) private pure {
        if (data.length != count * 32) revert InvalidChange();
    }

    function _uint(bytes calldata data, uint256 index, uint256 max) private pure returns (uint256 value) {
        value = uint256(bytes32(data[index * 32:index * 32 + 32]));
        if (value > max) revert InvalidChange();
    }

    function _address(bytes calldata data, uint256 index) private pure returns (address) {
        return address(uint160(_uint(data, index, type(uint160).max)));
    }

    function _nonzero(address account) private pure {
        if (account == address(0)) revert InvalidChange();
    }

    /// @dev Version 2.1.2 or later, and only an address with code. The version
    /// is governance's label: governance checks the address and code hash
    /// against the chain profile, and the guardian has the timelock to object.
    function _router(address router, uint16 version) private view {
        if (version < MIN_UNIVERSAL_ROUTER_VERSION || router.code.length == 0) revert InvalidChange();
    }

    /// @dev address(0) is the native currency; any other charge currency must
    /// be a deployed token.
    function _currency(address token) private view {
        if (token != address(0) && token.code.length == 0) revert InvalidChange();
    }

    function _timelock(uint256 secondsValue) private pure {
        if (secondsValue < MIN_TIMELOCK_SECONDS || secondsValue > MAX_TIMELOCK_SECONDS) revert InvalidChange();
    }
}
